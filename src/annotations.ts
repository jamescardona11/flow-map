import { lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isBase64 } from "./attachments.ts";
import { RequestError } from "./errors.ts";
import { createQueue, isMissing, writeFileAtomic } from "./fs-util.ts";
import { type MapData, readMap } from "./map-check.ts";
import { PNG_SIGNATURE } from "./png.ts";
import { findRoute } from "./route.ts";
import { mapText } from "./skill-command.ts";

/**
 * Comments on the screens of a map, kept in `<map>/temp/annotations.json` with the crop of each one in
 * `<map>/temp/<id>.png`. The format and the export text are the ones the `/flow-map` skill uses, so the
 * skill can read what the app saves (and the other way round). The code is a port, not an import ([ADR 0001]).
 */

type Rect = { x: number; y: number; w: number; h: number };

export type Annotation = {
  id: string;
  screen: string;
  rect: Rect;
  comment: string;
  crop: string;
  fingerprint: string;
  at: string;
};

type Store = { version: 1; seq: Record<string, number>; annotations: Annotation[] };

const STORE_VERSION = 1;
const EXPORT_PREAMBLE =
  "The user marked areas on screenshots of a flow map and left a comment on each one: treat each comment as the request. " +
  "Open the crop with Read; the full screenshot and the route are context, so work on the marked area, not the whole screen. " +
  "If the screenshots are of another app (a competitor or a reference), they are references, not code to edit.";

// Every read and write of the store goes through this queue: a write is read-modify-write, and two requests at once would lose one.
const inOrder = createQueue();

/** Python's `round(x)`: a half goes to the even neighbour (12.5 is 12), not up as `Math.round` does. */
function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  if (value - floor !== 0.5) return Math.round(value);
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Python's `round(x, 4)`. Only odd multiples of 1/32 are exact halves at the fifth decimal; for the rest `toFixed` agrees with Python. */
function roundToFourDecimals(value: number): number {
  const thirtySeconds = value * 32;
  const isExactHalf = Number.isInteger(thirtySeconds) && thirtySeconds % 2 !== 0;
  return isExactHalf ? roundHalfEven(value * 10_000) / 10_000 : Number(value.toFixed(4));
}

function parseRect(value: unknown): Rect {
  const { x, y, w, h } = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const numbers = [x, y, w, h];
  if (!numbers.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw new RequestError("rect needs numeric x, y, w, h");
  }
  const [px, py, pw, ph] = numbers as number[];
  if (Math.min(px, py) < 0 || Math.min(pw, ph) <= 0 || px + pw > 1 + 1e-6 || py + ph > 1 + 1e-6) {
    throw new RequestError("rect must stay inside the screen (values between 0 and 1, width and height > 0)");
  }
  return { x: roundToFourDecimals(px), y: roundToFourDecimals(py), w: roundToFourDecimals(pw), h: roundToFourDecimals(ph) };
}

function parseComment(value: unknown): string {
  const comment = typeof value === "string" ? value.trim() : "";
  if (!comment) throw new RequestError("the comment cannot be empty");
  return comment;
}

/** The PNG inside a `data:image/png;base64,...` URL, as the viewer sends the crop. */
function parseCrop(value: unknown): Buffer {
  const [, encoded = ""] = typeof value === "string" ? value.split("base64,") : [];
  const bytes = isBase64(encoded) ? Buffer.from(encoded, "base64") : Buffer.alloc(0);
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new RequestError("the crop must be a PNG");
  return bytes;
}

async function readMapData(folder: string): Promise<MapData> {
  const checked = await readMap(folder);
  if ("problem" in checked) throw new RequestError(checked.problem);
  return checked.map;
}

/** `temp` may lead anywhere when it is a link: the app neither reads nor writes through it. Every change of the store starts by reading it, so this is the one place that checks. */
async function refuseLinkedTemp(folder: string): Promise<void> {
  try {
    if ((await lstat(join(folder, "temp"))).isSymbolicLink()) throw new RequestError("temp is a symlink, the app will not use it.");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function readStore(folder: string): Promise<Store> {
  await refuseLinkedTemp(folder);
  const file = join(folder, "temp", "annotations.json");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isMissing(error)) return { version: STORE_VERSION, seq: {}, annotations: [] };
    throw error;
  }
  let store: Partial<Store> | null;
  try {
    store = JSON.parse(text) as Partial<Store> | null;
  } catch {
    throw new RequestError(`${file} is not valid JSON.`);
  }
  if (store?.version !== STORE_VERSION || !Array.isArray(store.annotations) || typeof store.seq !== "object") {
    throw new RequestError(`${file} is not an annotations file this app supports (version ${STORE_VERSION}).`);
  }
  return store as Store;
}

async function writeStore(folder: string, store: Store): Promise<void> {
  await mkdir(join(folder, "temp"), { recursive: true });
  await writeFileAtomic(join(folder, "temp", "annotations.json"), `${JSON.stringify(store, null, 2)}\n`);
}

function findAnnotation(store: Store, id: string): Annotation {
  const found = store.annotations.find((annotation) => annotation.id === id);
  if (!found) throw new RequestError(`No annotation '${id}'`);
  return found;
}

/**
 * `crop` comes from a file the map's author may have edited: only a file directly inside the map's own `<folder>/temp/` (not a link out of the map) is removed.
 * Deleting is why it checks both the name (`dirname`) and the real `temp`; reading checks only the real path: `captureRealPath` (capture-path.ts) and `serveMapFile` (server.ts).
 */
async function removeCrop(folder: string, annotation: Annotation): Promise<void> {
  if (typeof annotation.crop !== "string") return;
  const temp = join(folder, "temp");
  const file = join(folder, annotation.crop);
  if (dirname(file) !== temp) return;
  try {
    if ((await realpath(temp)) !== join(await realpath(folder), "temp")) return;
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  await rm(file, { force: true });
}

/** The comments of the map, oldest first. */
export function listAnnotations(folder: string): Promise<Annotation[]> {
  return inOrder(async () => (await readStore(folder)).annotations);
}

/** Saves a comment on a screen (or a zone of it) from the body the viewer posts: `{screen, rect, comment, png}`. */
export function addAnnotation(folder: string, input: unknown): Promise<Annotation> {
  const body = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  return inOrder(async () => {
    const screen = (await readMapData(folder)).screens.find((candidate) => candidate.id === body.screen);
    if (!screen) throw new RequestError(`There is no screen '${String(body.screen)}' in the map`);
    if (typeof screen.fingerprint !== "string") {
      throw new RequestError(`Screen '${screen.id}' has no fingerprint in map.json, so a comment cannot be tied to it.`);
    }
    const rect = parseRect(body.rect);
    const comment = parseComment(body.comment);
    const crop = parseCrop(body.png);

    const store = await readStore(folder);
    const number = (store.seq[screen.id] ?? 0) + 1;
    const id = `${screen.id}-${String(number).padStart(2, "0")}`;
    const annotation: Annotation = {
      id,
      screen: screen.id,
      rect,
      comment,
      crop: `temp/${id}.png`,
      fingerprint: screen.fingerprint,
      at: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"),
    };
    store.seq[screen.id] = number;
    store.annotations.push(annotation);
    await mkdir(join(folder, "temp"), { recursive: true });
    await writeFileAtomic(join(folder, annotation.crop), crop);
    await writeStore(folder, store);
    return annotation;
  });
}

/** Changes only the comment: the crop and the zone describe the capture and stay as they were. */
export function updateComment(folder: string, id: string, comment: unknown): Promise<Annotation> {
  return inOrder(async () => {
    const text = parseComment(comment);
    const store = await readStore(folder);
    const annotation = findAnnotation(store, id);
    annotation.comment = text;
    await writeStore(folder, store);
    return annotation;
  });
}

export function deleteAnnotation(folder: string, id: string): Promise<void> {
  return inOrder(async () => {
    const store = await readStore(folder);
    const annotation = findAnnotation(store, id);
    store.annotations = store.annotations.filter((candidate) => candidate !== annotation);
    await removeCrop(folder, annotation);
    await writeStore(folder, store);
  });
}

/** Deletes the comments of one screen with their crops; says how many there were. */
export function clearScreen(folder: string, screenId: string): Promise<number> {
  return inOrder(async () => {
    const store = await readStore(folder);
    const gone = store.annotations.filter((annotation) => annotation.screen === screenId);
    store.annotations = store.annotations.filter((annotation) => annotation.screen !== screenId);
    await Promise.all(gone.map((annotation) => removeCrop(folder, annotation)));
    await writeStore(folder, store);
    return gone.length;
  });
}

/** A value read from map.json, as one capped line before it enters the message. */
const oneLine = (value: unknown): string => mapText(String(value));

/** A path as it is, so it still points at the file: only control characters (a newline could start a section) become a space. */
const pathText = (path: string): string => path.replace(/\p{Cc}/gu, " ");

/** The shortest way from the entry screen, as `A → [action] → B`; null when no recorded edge leads there. */
function routeTo(map: MapData, screenId: string): string | null {
  const route = findRoute(map.edges, map.entry, screenId);
  if (!route) return null;
  const titles = new Map(map.screens.map((screen) => [screen.id, oneLine(screen.title)]));
  const steps = route.map((edge) => `[${oneLine(edge.action)}] → ${titles.get(edge.to)}`);
  return [titles.get(map.entry), ...steps].join(" → ");
}

function exportBlock(map: MapData, root: string, annotation: Annotation, number: number): string[] {
  const screen = map.screens.find((candidate) => candidate.id === annotation.screen);
  if (!screen) {
    return [`## ${number}. ${oneLine(annotation.screen)} (this screen no longer exists in the map)`, `Comment: ${annotation.comment}`, ""];
  }
  const percent = (fraction: number) => roundHalfEven(fraction * 100);
  const { rect } = annotation;
  const flow = oneLine(map.flows.find((candidate) => candidate.id === screen.flow)?.title ?? screen.flow);
  const lines = [
    `## ${number}. ${oneLine(screen.title)} (${screen.id}) · flow ${flow}`,
    `Route: ${routeTo(map, screen.id) ?? "no route recorded from the entry"}`,
    `Full screen: \`${pathText(join(root, screen.image))}\``,
    `Crop: \`${pathText(join(root, annotation.crop))}\` (area x ${percent(rect.x)}%, y ${percent(rect.y)}%, ` +
      `width ${percent(rect.w)}%, height ${percent(rect.h)}%)`,
    `Comment: ${annotation.comment}`,
  ];
  if (screen.fingerprint !== annotation.fingerprint) {
    lines.push("Warning: the screen was recaptured after this annotation; the area may have moved.");
  }
  return [...lines, ""];
}

export const NO_ANNOTATIONS = "No annotations.\n";

/** The comments (only those of `screen` when given) as Markdown to paste into Claude: what screen, how to reach it, where the crop is and what was asked. */
export function exportAnnotations(folder: string, screen?: string): Promise<string> {
  return inOrder(async () => {
    const root = await realpath(folder);
    const map = await readMapData(root);
    const { annotations: all } = await readStore(root);
    const annotations = screen === undefined ? all : all.filter((annotation) => annotation.screen === screen);
    if (annotations.length === 0) return NO_ANNOTATIONS;
    const subtitle = map.meta?.subtitle;
    const lines = [
      EXPORT_PREAMBLE,
      "",
      `# Annotations: ${oneLine(map.title)}`,
      `Map: \`${root}\``,
      ...(subtitle ? [`App: ${oneLine(subtitle)}`] : []),
      "",
      ...annotations.flatMap((annotation, index) => exportBlock(map, root, annotation, index + 1)),
    ];
    return lines.join("\n");
  });
}
