import { mkdir, readFile, realpath, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  addAnnotation,
  clearScreen,
  deleteAnnotation,
  exportAnnotations,
  listAnnotations,
  NO_ANNOTATIONS,
  updateComment,
} from "./annotations.ts";
import { imagesBlock, parseImages, saveImages } from "./attachments.ts";
import { captureRealPath } from "./capture-path.ts";
import { buildCapturePrompt } from "./capture-new.ts";
import { buildChoosePage } from "./choose-page.ts";
import { MAX_DESIGN_LENGTH, readDesign, writeDesign } from "./design-contract.ts";
import { RequestError } from "./errors.ts";
import { chooseFolderWithDialog } from "./folder-dialog.ts";
import { isMissing, isNotPlainFolder, writeFileAtomic } from "./fs-util.ts";
import { iconPng } from "./icon.ts";
import { listChanges, listVersions } from "./history.ts";
import { readGroups, readLayout, removeLayout, writeGroups, writeLayout } from "./layout-groups.ts";
import { type MapData, type MapScreen, readMap } from "./map-check.ts";
import { buildNewScreenPrompt } from "./new-screen.ts";
import { buildRecapturePrompt } from "./recapture.ts";
import { buildMapPage } from "./map-page.ts";
import { createMapWatcher } from "./map-watcher.ts";
import { createRecents, type Recent } from "./recents.ts";
import { ensureScratchMap, scratchFolderOf } from "./scratch-map.ts";
import { findRoute } from "./route.ts";
import { FfmpegMissingError, MAX_ROUTE_SCREENS, renderRouteVideo, type RouteStep, videoSize, zoneOf } from "./route-video.ts";
import { buildAllowRules, buildNewScreenAllowRules, buildSessionHelp } from "./session-help.ts";
import { describeLink, readSession, removeLegacyLink } from "./session-link.ts";
import { isSessionAlive, sendToSession, SessionClosedError } from "./session-send.ts";
import { mapText } from "./skill-command.ts";
import { createWorker, DEFAULT_WORKER_TIMEOUT_MS } from "./worker.ts";

const DEFAULT_SKILL_SCRIPT = join(import.meta.dirname, "..", "skill", "scripts", "flowmap.py");
const SERVED_FOLDERS = ["screens", "screens-src", "thumbs", "history", "baselines"];
/** Where the HTML mocks of screens live; an .html anywhere else in the map folder is not served. */
const HTML_FOLDERS = ["screens", "screens-src"];
/**
 * Sent with every file of the map folder. The CSP `sandbox` makes an HTML mock or an .svg an opaque origin even when it
 * is opened directly (not in the viewer's iframe), and the other directives leave it no network, so it cannot reach this app's endpoints.
 */
const FILE_SAFETY_HEADERS = {
  "Content-Security-Policy":
    "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:",
  "X-Content-Type-Options": "nosniff",
};
const ANNOTATIONS_PREFIX = "/__flowmap/";
const RUNS_PREFIX = "/__flowmap-app/runs/";
const DECISION_SUFFIX = "/decision";
const CANCEL_SUFFIX = "/cancel";
const MAX_BODY_BYTES = 25 * 1024 * 1024;
const LOCAL_HOSTS = ["127.0.0.1", "localhost"];
const MAX_REQUESTS_PER_WINDOW = 5;
const MAX_REQUEST_TEXT_LENGTH = 20_000;
const MAX_TITLE_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 4_000;
const MAX_ACTION_LENGTH = 200;
const MAX_NOTE_LENGTH = 500;
const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

function isLocalHost(hostHeader: string | undefined): boolean {
  return LOCAL_HOSTS.includes((hostHeader ?? "").replace(/:\d+$/, ""));
}

/** The request target as a URL, or null for a target that is not one (for example `//`): it answers 404. */
function parseUrl(target: string): URL | null {
  try {
    return new URL(target, "http://localhost");
  } catch {
    return null;
  }
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new RequestError("request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString();
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  try {
    return JSON.parse(await readBody(request));
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError("The request is not JSON.");
  }
}

/** A change must come from the app's own page: it carries `X-Flowmap` and, when the browser says where from, that is this server. */
function isFromAppPage(request: http.IncomingMessage): boolean {
  const { origin, host } = request.headers;
  return request.headers["x-flowmap"] === "1" && (!origin || origin === `http://${host}`);
}

function reply(response: http.ServerResponse, status: number, body: string | Buffer = "", type = "text/plain") {
  response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  response.end(body);
}

function replyJson(response: http.ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  response.end(JSON.stringify(payload));
}

type Refuse = (status: number, error: string, headers?: Record<string, string>) => void;

function jsonRefuser(response: http.ServerResponse): Refuse {
  return (status, error, headers) => replyJson(response, status, { error }, headers);
}

/** The path with its %-escapes decoded, or null when they are not valid (`%zz`). */
function decodePath(rawPath: string): string | null {
  try {
    return decodeURIComponent(rawPath);
  } catch {
    return null;
  }
}

const VIA_PROBLEM = 'via must be "worker" or left out.';

/** `via` is either left out (the linked session) or "worker". */
function isValidVia(via: unknown): via is "worker" | undefined {
  return via === undefined || via === "worker";
}

/** The JSON object the page sent, or null after answering 400 because it is not JSON. */
async function readBodyOrRefuse<Body>(request: http.IncomingMessage, refuse: Refuse): Promise<Partial<Body> | null> {
  try {
    return ((await readJsonBody(request)) ?? {}) as Partial<Body>;
  } catch (error) {
    refuse(400, error instanceof RequestError ? error.message : "The request is not JSON.");
    return null;
  }
}

const missingCapture = (screenId: string) => `The capture of screen "${screenId}" is missing from the map folder.`;

/** The screen with this id and the real path of its capture, or null after answering 400 (there is no such screen, or its capture is missing). */
async function screenWithCapture<Screen extends { id: string; image: string }>(
  refuse: Refuse,
  folder: string,
  screens: Screen[],
  screenId: string | null,
  realFolder?: string,
): Promise<{ screen: Screen; capture: string } | null> {
  const screen = screens.find((candidate) => candidate.id === screenId);
  if (!screen) {
    refuse(400, `The map has no screen "${screenId ?? ""}".`);
    return null;
  }
  const capture = await captureRealPath(folder, screen.image, realFolder);
  if (capture === null) {
    refuse(400, missingCapture(screen.id));
    return null;
  }
  return { screen, capture };
}

/** The open map folder and its usable map, or null after answering 404 (no map is open) or 409 (the folder is not a usable map). */
async function openMapOrRefuse(refuse: Refuse, folder: string | null): Promise<{ folder: string; map: MapData } | null> {
  if (!folder) {
    refuse(404, "no map is open");
    return null;
  }
  const checked = await readMap(folder);
  if ("problem" in checked) {
    refuse(409, checked.problem);
    return null;
  }
  return { folder, map: checked.map };
}

const DEFAULT_WATCH_DEBOUNCE_MS = 300;
const DEFAULT_REQUEST_WINDOW_MS = 10_000;

/**
 * What the receiving session (or worker) reads: where the request comes from, the map, the selected screen, the designer's text,
 * the absolute path of the selected screen's capture, the paths of the images the designer pasted and, when asked, the comments export last (it ends with a newline).
 */
async function requestMessage(
  folder: string,
  map: { title: string },
  input: { screen: string | undefined; capture: string | undefined; text: string; attach: boolean; imagePaths: string[] },
): Promise<string> {
  const { screen, capture, text, attach, imagePaths } = input;
  const selected = screen ? `\nSelected screen: ${mapText(screen)}` : "";
  let message = `Request from the Flow Map app for the map "${mapText(map.title)}".${selected}\n\n${text}`;
  if (capture) message += `\n\nFull capture of the selected screen: \`${capture}\``;
  if (imagePaths.length > 0) message += `\n\n${imagesBlock(imagePaths)}`;
  if (attach) {
    const comments = await exportAnnotations(folder, screen);
    if (comments !== NO_ANNOTATIONS) message += `\n\n${comments}`;
  }
  return message;
}

/**
 * `dataDir` is where the recent maps are saved; without it they are kept in memory only.
 * `watchDebounceMs` is how long the open map folder must stay quiet before pages are told it changed.
 * `requestWindowMs` is the window in which at most 5 requests (to the linked session or to the worker) are accepted.
 * `claudeBin` is the command the worker runs (default "claude"); `workerTimeoutMs` is how long a worker run may take.
 * `ffmpegBin` is the command that renders route videos (default "ffmpeg").
 * `skillScript` is the app's own copy of the skill's `flowmap.py`, which creates the scratch map (default: `skill/scripts/flowmap.py` of this repo).
 * With a `dataDir`, `/` opens the scratch map `<dataDir>/scratch/untitled` while no map is open.
 */
export async function createServer(options: {
  port: number;
  dataDir?: string;
  watchDebounceMs?: number;
  requestWindowMs?: number;
  claudeBin?: string;
  workerTimeoutMs?: number;
  ffmpegBin?: string;
  skillScript?: string;
}) {
  let mapFolder: string | null = null;
  let exportRunning = false;
  /** Stops the running route video and answers once its ffmpeg is gone; undefined when none is rendering. */
  let stopExport: (() => Promise<void>) | undefined;
  const requestWindowMs = options.requestWindowMs ?? DEFAULT_REQUEST_WINDOW_MS;
  const requestTimes: number[] = [];
  const worker = createWorker({
    claudeBin: options.claudeBin ?? "claude",
    timeoutMs: options.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS,
  });
  const mapWatcher = createMapWatcher(options.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS);
  const recents = await createRecents(options.dataDir);

  async function serveMapFile(response: http.ServerResponse, rawPath: string) {
    const decoded = decodePath(rawPath);
    if (decoded === null) return reply(response, 404);
    const relative = decoded.slice(1);
    const [folder] = relative.split("/");
    const file = resolve(mapFolder!, relative);
    // Lexical check only (`..` and the folder name); the real path, after symlinks, is checked below by `captureRealPath` (capture-path.ts). Deleting has its own check: `removeCrop` (annotations.ts).
    const inServedFolder = SERVED_FOLDERS.includes(folder!) && file.startsWith(join(mapFolder!, folder!) + sep);
    if (!inServedFolder) return reply(response, 404);
    const extension = file.slice(file.lastIndexOf(".")).toLowerCase();
    const isHtml = extension === ".html";
    if (isHtml && !HTML_FOLDERS.includes(folder!)) return reply(response, 404);
    try {
      // a symlink must not lead out of the served folder (nor out of the map folder)
      const realFolder = await realpath(mapFolder!);
      const realFile = await captureRealPath(mapFolder!, relative, realFolder);
      if (realFile === null || !realFile.startsWith(join(realFolder, folder!) + sep)) return reply(response, 404);
      const body = await readFile(realFile);
      response.writeHead(200, {
        "Content-Type": isHtml ? "text/html; charset=utf-8" : (CONTENT_TYPES[extension] ?? "application/octet-stream"),
        "Cache-Control": "no-store",
        ...FILE_SAFETY_HEADERS,
      });
      response.end(body);
    } catch (error) {
      if (isMissing(error)) return reply(response, 404);
      throw error;
    }
  }

  const scratchFolder = options.dataDir && scratchFolderOf(options.dataDir);
  let scratchMap: Promise<void> | null = null;

  /** Creates the scratch map if it is missing; answers the reason when it cannot be, null otherwise. Two first requests share one creation. */
  async function createScratchMap(): Promise<string | null> {
    if (!scratchFolder) return null;
    scratchMap ??= ensureScratchMap(scratchFolder, options.skillScript ?? DEFAULT_SKILL_SCRIPT);
    try {
      await scratchMap;
    } catch (error) {
      scratchMap = null;
      return (error as Error).message;
    }
    return null;
  }

  /** Opens the scratch map if no map is open; answers the reason when it cannot be created, null otherwise. */
  async function openScratchMap(): Promise<string | null> {
    if (mapFolder || !scratchFolder) return null;
    const problem = await createScratchMap();
    if (problem) return problem;
    if (!mapFolder) {
      mapFolder = scratchFolder;
      await mapWatcher.watchFolder(scratchFolder);
    }
    return null;
  }

  /** The scratch map as a chooser entry, or null when there is no data dir or no valid map there yet. */
  async function readWorkingMap(): Promise<Recent | null> {
    if (!scratchFolder) return null;
    const checked = await readMap(scratchFolder);
    return "problem" in checked ? null : { path: scratchFolder, title: checked.map.title };
  }

  /** True when `folder` is the scratch map, however it is spelled (a symlinked data dir, such as /var and /private/var on macOS, still matches). */
  async function isScratchFolder(folder: string): Promise<boolean> {
    if (!scratchFolder) return false;
    try {
      return (await realpath(folder)) === (await realpath(scratchFolder));
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  async function openMap(request: http.IncomingMessage, response: http.ServerResponse) {
    const refuse = jsonRefuser(response);
    let body: { path?: unknown } | null;
    try {
      body = JSON.parse(await readBody(request)) as { path?: unknown } | null;
    } catch {
      return refuse(400, "The request is not JSON.");
    }
    const path = body?.path;
    if (typeof path !== "string" || !isAbsolute(path)) return refuse(400, "The folder path must be absolute.");
    const folder = resolve(path);
    const checked = await readMap(folder);
    if ("problem" in checked) return refuse(400, checked.problem);
    try {
      await removeLegacyLink(folder);
    } catch (error) {
      if (error instanceof RequestError) return refuse(409, error.message);
      throw error;
    }
    mapFolder = folder;
    await mapWatcher.watchFolder(folder);
    if (!(await isScratchFolder(folder))) await recents.add({ path: folder, title: checked.map.title });
    reply(response, 200);
  }

  async function answerSession(response: http.ServerResponse) {
    if (!mapFolder) return replyJson(response, 404, { error: "no map is open" });
    const session = await readSession(options.dataDir, mapFolder);
    const link = describeLink(session);
    const answer = session ? { ...link, alive: await isSessionAlive(session.socket) } : link;
    replyJson(response, 200, answer);
  }

  function answerSessionHelp(response: http.ServerResponse) {
    if (!mapFolder) return replyJson(response, 404, { error: "no map is open" });
    replyJson(response, 200, buildSessionHelp(mapFolder));
  }

  /** Counts a request in the window. Returns null when accepted, or the seconds to wait when the window is full. */
  function takeRequestSlot(): number | null {
    const now = Date.now();
    while (requestTimes.length > 0 && now - requestTimes[0]! >= requestWindowMs) requestTimes.shift();
    if (requestTimes.length >= MAX_REQUESTS_PER_WINDOW) {
      return Math.max(1, Math.ceil((requestTimes[0]! + requestWindowMs - now) / 1000));
    }
    requestTimes.push(now); // taken before anything is awaited, so a burst of parallel requests cannot all pass
    return null;
  }

  function answerCurrentRun(response: http.ServerResponse) {
    const run = worker.current(mapFolder);
    if (!run) return replyJson(response, 404, { error: "no run in progress" });
    replyJson(response, 200, run);
  }

  function answerRun(response: http.ServerResponse, rawPath: string) {
    const run = worker.get(rawPath.slice(RUNS_PREFIX.length), mapFolder);
    if (!run) return replyJson(response, 404, { error: "unknown run" });
    replyJson(response, 200, run);
  }

  /** The designer's answer to a worker run that waits for approval: resume it with the rules it suggested, or end it. */
  async function answerDecision(request: http.IncomingMessage, response: http.ServerResponse, rawPath: string) {
    const refuse = jsonRefuser(response);
    if (!isFromAppPage(request)) return refuse(403, "request not allowed");
    const body = await readBodyOrRefuse<{ allow: unknown; rules: unknown }>(request, refuse);
    if (!body) return;
    if (typeof body.allow !== "boolean") return refuse(400, "allow must be true or false.");

    const runId = rawPath.slice(RUNS_PREFIX.length, -DECISION_SUFFIX.length);
    const outcome = worker.decide(runId, body.allow ? { allow: true, rules: body.rules } : { allow: false }, mapFolder);
    if (outcome === "unknown-run") return refuse(404, "unknown run");
    if (outcome === "not-waiting") return refuse(409, "This run is not waiting for a decision.");
    if (outcome === "bad-rules") return refuse(400, "rules must be a list of rules this run suggested.");
    replyJson(response, body.allow ? 202 : 200, { runId });
  }

  /** The designer's cancel of a worker run that is running or waiting for approval. */
  function answerCancel(request: http.IncomingMessage, response: http.ServerResponse, rawPath: string) {
    const refuse = jsonRefuser(response);
    if (!isFromAppPage(request)) return refuse(403, "request not allowed");

    const runId = rawPath.slice(RUNS_PREFIX.length, -CANCEL_SUFFIX.length);
    const outcome = worker.cancel(runId, mapFolder);
    if (outcome === "unknown-run") return refuse(404, "unknown run");
    if (outcome === "finished") return refuse(409, "This run is already over.");
    replyJson(response, 200, { runId });
  }

  /** Hands a prompt to the own worker (`via: "worker"`) or to the linked session, with the guard already passed and the input validated. */
  async function deliver(
    response: http.ServerResponse,
    refuse: Refuse,
    delivery: { folder: string; via: "worker" | undefined; message: string; allowedTools: string[] },
  ) {
    const { folder, via, message, allowedTools } = delivery;
    const refuseTooMany = (retryAfterSeconds: number) =>
      refuse(429, "Too many requests in a row.", { "Retry-After": String(retryAfterSeconds) });

    if (via === "worker") {
      if (worker.isBusy()) return refuse(409, "A worker run is already in progress.");
      const retryAfterSeconds = takeRequestSlot();
      if (retryAfterSeconds !== null) return refuseTooMany(retryAfterSeconds);
      const runId = worker.start({ folder, prompt: message, allowedTools });
      return replyJson(response, 202, { runId, via: "worker" });
    }

    const session = await readSession(options.dataDir, folder);
    if (!session) return refuse(409, "This map is not linked to a Claude Code session.");
    const retryAfterSeconds = takeRequestSlot();
    if (retryAfterSeconds !== null) return refuseTooMany(retryAfterSeconds);

    try {
      await sendToSession(session.socket, session.token, message);
    } catch (error) {
      if (error instanceof SessionClosedError) return refuse(409, "The linked Claude Code session is closed.");
      throw error;
    }
    replyJson(response, 200, { sent: true });
  }

  async function sendRequest(request: http.IncomingMessage, response: http.ServerResponse) {
    const refuse = jsonRefuser(response);
    if (!isFromAppPage(request)) return refuse(403, "request not allowed");
    const folder = mapFolder;
    if (!folder) return refuse(404, "no map is open");

    const body = await readBodyOrRefuse<{ text: unknown; screen: unknown; via: unknown; attach: unknown; images: unknown }>(request, refuse);
    if (!body) return;
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (text === "") return refuse(400, "Write the request first.");
    if (text.length > MAX_REQUEST_TEXT_LENGTH) return refuse(400, `The request is too long (the limit is ${MAX_REQUEST_TEXT_LENGTH} characters).`);
    const screen = body.screen;
    if (screen !== undefined && typeof screen !== "string") return refuse(400, "screen must be a screen id.");

    const via = body.via;
    if (!isValidVia(via)) return refuse(400, VIA_PROBLEM);

    const attach = body.attach;
    if (attach !== undefined && typeof attach !== "boolean") return refuse(400, "attach must be true or false.");

    let images: ReturnType<typeof parseImages>;
    try {
      images = parseImages(body.images);
    } catch (error) {
      if (error instanceof RequestError) return refuse(400, error.message);
      throw error;
    }

    const checked = await readMap(folder);
    if ("problem" in checked) return refuse(409, checked.problem);
    let capture: string | undefined;
    if (screen !== undefined) {
      const found = await screenWithCapture(refuse, folder, checked.map.screens, screen);
      if (!found) return;
      capture = found.capture;
    }
    let imagePaths: string[];
    try {
      imagePaths = images.length > 0 ? await saveImages(folder, images) : [];
    } catch (error) {
      if (error instanceof RequestError) return refuse(400, error.message);
      throw error;
    }
    const message = await requestMessage(folder, checked.map, { screen, capture, text, attach: attach === true, imagePaths });
    await deliver(response, refuse, { folder, via, message, allowedTools: buildAllowRules(folder) });
  }

  /** Builds the prompt that asks Claude for a new screen and delivers it like a request; the app never creates the screen itself. */
  async function sendNewScreen(request: http.IncomingMessage, response: http.ServerResponse) {
    const refuse = jsonRefuser(response);
    if (!isFromAppPage(request)) return refuse(403, "request not allowed");
    const folder = mapFolder;
    if (!folder) return refuse(404, "no map is open");

    const body = await readBodyOrRefuse<{ title: unknown; description: unknown; from: unknown; action: unknown; via: unknown }>(request, refuse);
    if (!body) return;
    const { title, description, from, action, via } = body;
    if (typeof title !== "string" || title.trim() === "") return refuse(400, "Give the new screen a title.");
    if (title.trim().length > MAX_TITLE_LENGTH) return refuse(400, `The title is too long (the limit is ${MAX_TITLE_LENGTH} characters).`);
    if (description !== undefined && typeof description !== "string") return refuse(400, "description must be text.");
    if (description !== undefined && description.trim().length > MAX_DESCRIPTION_LENGTH) {
      return refuse(400, `The description is too long (the limit is ${MAX_DESCRIPTION_LENGTH} characters).`);
    }
    if (from !== undefined && typeof from !== "string") return refuse(400, "from must be a screen id.");
    if (action !== undefined && typeof action !== "string") return refuse(400, "action must be text.");
    if (action !== undefined && action.trim().length > MAX_ACTION_LENGTH) {
      return refuse(400, `The action is too long (the limit is ${MAX_ACTION_LENGTH} characters).`);
    }
    if (!isValidVia(via)) return refuse(400, VIA_PROBLEM);

    const checked = await readMap(folder);
    if ("problem" in checked) return refuse(409, checked.problem);
    const fromScreen = checked.map.screens.find((candidate) => candidate.id === from);
    if (from !== undefined && !fromScreen) return refuse(400, `The map has no screen "${from}".`);
    const realFolder = await realpath(folder);
    const captures = await capturesOf(realFolder, checked.map.screens);
    if (fromScreen && !captures.has(fromScreen.id)) return refuse(400, missingCapture(fromScreen.id));

    const design = await readDesign(folder);
    const { prompt } = buildNewScreenPrompt({ folder: realFolder, map: checked.map, captures, title, description, from, action, design });
    await deliver(response, refuse, { folder, via, message: prompt, allowedTools: buildNewScreenAllowRules(folder) });
  }

  /** Builds the prompt that asks Claude to capture a screen again and delivers it like a request; the app never captures anything itself. */
  async function sendRecapture(request: http.IncomingMessage, response: http.ServerResponse) {
    const refuse = jsonRefuser(response);
    if (!isFromAppPage(request)) return refuse(403, "request not allowed");
    const folder = mapFolder;
    if (!folder) return refuse(404, "no map is open");

    const body = await readBodyOrRefuse<{ screen: unknown; note: unknown; via: unknown }>(request, refuse);
    if (!body) return;
    const { screen: screenId, note, via } = body;
    if (typeof screenId !== "string" || screenId.trim() === "") return refuse(400, "Choose the screen to capture again.");
    if (note !== undefined && typeof note !== "string") return refuse(400, "note must be text.");
    if (note !== undefined && note.length > MAX_NOTE_LENGTH) return refuse(400, `The note is too long (the limit is ${MAX_NOTE_LENGTH} characters).`);
    if (!isValidVia(via)) return refuse(400, VIA_PROBLEM);

    const checked = await readMap(folder);
    if ("problem" in checked) return refuse(409, checked.problem);
    const realFolder = await realpath(folder);
    const found = await screenWithCapture(refuse, folder, checked.map.screens, screenId, realFolder);
    if (!found) return;
    const { screen, capture } = found;

    const prompt = buildRecapturePrompt({ folder: realFolder, map: checked.map, screen, capture, note });
    await deliver(response, refuse, { folder, via, message: prompt, allowedTools: buildNewScreenAllowRules(folder) });
  }

  /** Builds the prompt that asks Claude to capture what the app shows now as a new screen and delivers it like a request; the app never captures anything itself. */
  async function sendCapture(request: http.IncomingMessage, response: http.ServerResponse) {
    const refuse = jsonRefuser(response);
    if (!isFromAppPage(request)) return refuse(403, "request not allowed");
    const folder = mapFolder;
    if (!folder) return refuse(404, "no map is open");

    const body = await readBodyOrRefuse<{ title: unknown; from: unknown; action: unknown; note: unknown; via: unknown }>(request, refuse);
    if (!body) return;
    const { title, from, action, note, via } = body;
    if (typeof title !== "string" || title.trim() === "") return refuse(400, "Give the new screen a title.");
    if (title.trim().length > MAX_TITLE_LENGTH) return refuse(400, `The title is too long (the limit is ${MAX_TITLE_LENGTH} characters).`);
    if (from !== undefined && typeof from !== "string") return refuse(400, "from must be a screen id.");
    if (action !== undefined && typeof action !== "string") return refuse(400, "action must be text.");
    if (action !== undefined && action.trim().length > MAX_ACTION_LENGTH) {
      return refuse(400, `The action is too long (the limit is ${MAX_ACTION_LENGTH} characters).`);
    }
    if (note !== undefined && typeof note !== "string") return refuse(400, "note must be text.");
    if (note !== undefined && note.length > MAX_NOTE_LENGTH) return refuse(400, `The note is too long (the limit is ${MAX_NOTE_LENGTH} characters).`);
    if (!isValidVia(via)) return refuse(400, VIA_PROBLEM);

    const checked = await readMap(folder);
    if ("problem" in checked) return refuse(409, checked.problem);
    const realFolder = await realpath(folder);
    let fromScreen: MapScreen | undefined;
    if (from !== undefined) {
      const found = await screenWithCapture(refuse, folder, checked.map.screens, from, realFolder);
      if (!found) return;
      fromScreen = found.screen;
    }

    const prompt = buildCapturePrompt({ folder: realFolder, map: checked.map, title, from: fromScreen, action, note });
    await deliver(response, refuse, { folder, via, message: prompt, allowedTools: buildNewScreenAllowRules(folder) });
  }

  /** Renders the shortest route between two screens as an MP4 in `<map folder>/exports/`; one export runs at a time. */
  async function exportRoute(request: http.IncomingMessage, response: http.ServerResponse) {
    const refuse = jsonRefuser(response);
    if (!isFromAppPage(request)) return refuse(403, "request not allowed");
    const folder = mapFolder;
    if (!folder) return refuse(404, "no map is open");

    const body = await readBodyOrRefuse<{ to: unknown; from: unknown }>(request, refuse);
    if (!body) return;
    const checked = await readMap(folder);
    if ("problem" in checked) return refuse(409, checked.problem);
    const { map } = checked;
    const toId = typeof body.to === "string" ? body.to : "";
    const fromId = body.from === undefined ? map.entry : typeof body.from === "string" ? body.from : "";
    const from = map.screens.find((screen) => screen.id === fromId);
    if (!from) return refuse(400, `The map has no screen "${fromId}".`);
    if (!map.screens.some((screen) => screen.id === toId)) return refuse(400, `The map has no screen "${toId}".`);
    if (fromId === toId) return refuse(400, "Choose a screen other than the starting one.");
    const route = findRoute(map.edges, fromId, toId);
    if (!route) return refuse(404, `There is no route from ${fromId} to ${toId}.`);
    if (route.length + 1 > MAX_ROUTE_SCREENS) return refuse(400, `The route has ${route.length + 1} screens; a video takes at most ${MAX_ROUTE_SCREENS}.`);

    const realFolder = await realpath(folder);
    const steps: RouteStep[] = [];
    const screenIds = [fromId, ...route.map((edge) => edge.to)];
    for (const [index, id] of screenIds.entries()) {
      const found = await screenWithCapture(refuse, folder, map.screens, id, realFolder);
      if (!found) return;
      steps.push({ capture: found.capture, zone: zoneOf(route[index]?.at) });
    }

    const exportsFolder = join(realFolder, "exports");
    if (await isNotPlainFolder(exportsFolder)) return refuse(400, "exports is not a plain folder (a link or a file), the app will not write there.");
    if (exportRunning) return refuse(409, "Another route video is being rendered.");
    exportRunning = true;
    const stopper = new AbortController();
    let rendering: Promise<number> | undefined;
    stopExport = async () => {
      stopper.abort();
      await rendering?.catch(() => undefined);
    };
    try {
      await mkdir(exportsFolder, { recursive: true });
      const output = join(exportsFolder, `route-${fromId}-to-${toId}.mp4`);
      rendering = renderRouteVideo({ ffmpegBin: options.ffmpegBin ?? "ffmpeg", steps, size: videoSize(from), output, signal: stopper.signal });
      const seconds = await rendering;
      replyJson(response, 200, { path: output, screens: screenIds, seconds });
    } catch (error) {
      if (error instanceof FfmpegMissingError) return refuse(409, "ffmpeg is not installed. Install it (for example `brew install ffmpeg`) to export route videos.");
      throw error;
    } finally {
      exportRunning = false;
      stopExport = undefined;
    }
  }

  /** Reads (GET) or replaces (PUT) the map's DESIGN.md; a PUT is a change, so it passes the same guard as the other ones. */
  async function answerDesign(request: http.IncomingMessage, response: http.ServerResponse) {
    const refuse = jsonRefuser(response);
    if (request.method === "PUT" && !isFromAppPage(request)) return refuse(403, "request not allowed");
    const folder = mapFolder;
    if (!folder) return refuse(404, "no map is open");

    if (request.method === "GET") {
      const text = await readDesign(folder);
      return replyJson(response, 200, { exists: text !== null, text: text ?? "" });
    }
    const body = await readBodyOrRefuse<{ text: unknown }>(request, refuse);
    if (!body) return;
    const { text } = body;
    if (typeof text !== "string") return refuse(400, "text must be a string.");
    if (text.length > MAX_DESIGN_LENGTH) return refuse(400, `The design contract is too long (the limit is ${MAX_DESIGN_LENGTH} characters).`);
    replyJson(response, 200, { exists: await writeDesign(folder, text) });
  }

  /** The real path of every capture that exists inside the map folder, by screen id. `realFolder` is the map folder's real path. */
  async function capturesOf(realFolder: string, screens: { id: string; image: string }[]): Promise<Map<string, string>> {
    const captures = await Promise.all(screens.map((screen) => captureRealPath(realFolder, screen.image, realFolder)));
    const found = new Map<string, string>();
    screens.forEach((screen, index) => {
      const capture = captures[index];
      if (capture) found.set(screen.id, capture);
    });
    return found;
  }

  /** The absolute real path of a screen's capture, for the page to show when the browser blocks copying the image. */
  async function answerCapturePath(response: http.ServerResponse, url: URL) {
    const refuse = jsonRefuser(response);
    const open = await openMapOrRefuse(refuse, mapFolder);
    if (!open) return;
    const found = await screenWithCapture(refuse, open.folder, open.map.screens, url.searchParams.get("screen"));
    if (!found) return;
    replyJson(response, 200, { path: found.capture });
  }

  /** The versions of one screen: its current capture and the files in `history/`. */
  async function answerVersions(response: http.ServerResponse, url: URL) {
    const refuse = jsonRefuser(response);
    const open = await openMapOrRefuse(refuse, mapFolder);
    if (!open) return;
    const screenId = url.searchParams.get("screen");
    const screen = open.map.screens.find((candidate) => candidate.id === screenId);
    if (!screen) return refuse(400, `The map has no screen "${screenId ?? ""}".`);
    replyJson(response, 200, { versions: await listVersions(open.folder, screen) });
  }

  /** The versions of every screen of the map, newest first. */
  async function answerChanges(response: http.ServerResponse) {
    const refuse = jsonRefuser(response);
    const open = await openMapOrRefuse(refuse, mapFolder);
    if (!open) return;
    replyJson(response, 200, { events: await listChanges(open.folder, open.map.screens) });
  }

  /** The saved arrangement of the screens; the guard has already passed. */
  async function answerLayout(request: http.IncomingMessage, response: http.ServerResponse, folder: string) {
    if (request.method === "GET") return replyJson(response, 200, await readLayout(folder));
    if (request.method === "PUT") {
      const body = (await readJsonBody(request)) as { positions?: unknown } | null;
      return replyJson(response, 200, await mapWatcher.quietly(() => writeLayout(folder, body?.positions)));
    }
    if (request.method === "DELETE") {
      await mapWatcher.quietly(() => removeLayout(folder));
      return replyJson(response, 200, { positions: {} });
    }
    replyJson(response, 404, { error: "unknown route" });
  }

  /** The groups of screens that move together; the guard has already passed. */
  async function answerGroups(request: http.IncomingMessage, response: http.ServerResponse, folder: string) {
    if (request.method === "GET") return replyJson(response, 200, await readGroups(folder));
    if (request.method === "PUT") {
      const body = (await readJsonBody(request)) as { groups?: unknown } | null;
      return replyJson(response, 200, await mapWatcher.quietly(() => writeGroups(folder, body?.groups)));
    }
    replyJson(response, 404, { error: "unknown route" });
  }

  async function answerAnnotations(request: http.IncomingMessage, response: http.ServerResponse, url: URL) {
    const folder = mapFolder;
    if (!folder) return replyJson(response, 404, { error: "no map is open" });
    const method = request.method;
    if (method !== "GET" && !isFromAppPage(request)) return replyJson(response, 403, { error: "request not allowed" });

    const route = decodePath(url.pathname.slice(ANNOTATIONS_PREFIX.length));
    if (route === null) return replyJson(response, 404, { error: "unknown route" });
    const id = route.startsWith("annotations/") ? route.slice("annotations/".length) : null;
    try {
      if (method === "GET" && route === "annotations") return replyJson(response, 200, await listAnnotations(folder));
      if (method === "GET" && route === "export") {
        return reply(response, 200, await exportAnnotations(folder), "text/markdown; charset=utf-8");
      }
      if (route === "layout") return await answerLayout(request, response, folder);
      if (route === "groups") return await answerGroups(request, response, folder);
      if (method === "POST" && route === "annotations") return replyJson(response, 201, await addAnnotation(folder, await readJsonBody(request)));
      if (method === "DELETE" && route === "annotations") {
        const screen = url.searchParams.get("screen");
        if (!screen) throw new RequestError("screen is required");
        return replyJson(response, 200, { deleted: await clearScreen(folder, screen) });
      }
      if (method === "DELETE" && id) {
        await deleteAnnotation(folder, id);
        return reply(response, 204);
      }
      if (method === "PATCH" && id) {
        const body = (await readJsonBody(request)) as { comment?: unknown } | null;
        return replyJson(response, 200, await updateComment(folder, id, body?.comment));
      }
    } catch (error) {
      if (error instanceof RequestError) return replyJson(response, 400, { error: error.message });
      throw error;
    }
    replyJson(response, 404, { error: "unknown route" });
  }

  async function handle(request: http.IncomingMessage, response: http.ServerResponse) {
    if (!isLocalHost(request.headers.host)) return reply(response, 403);
    const rawPath = (request.url ?? "/").split("?")[0]!;
    const url = parseUrl(request.url ?? "/");
    if (url === null) return reply(response, 404);

    if (rawPath.startsWith(ANNOTATIONS_PREFIX)) return answerAnnotations(request, response, url);

    if (rawPath === "/__flowmap-app/design" && (request.method === "GET" || request.method === "PUT")) {
      return answerDesign(request, response);
    }

    if (request.method === "POST" && rawPath.startsWith("/__flowmap-app/")) {
      if (request.headers["x-flowmap"] !== "1") return reply(response, 403);
      if (rawPath === "/__flowmap-app/open") return openMap(request, response);
      if (rawPath === "/__flowmap-app/request") return sendRequest(request, response);
      if (rawPath === "/__flowmap-app/new-screen") return sendNewScreen(request, response);
      if (rawPath === "/__flowmap-app/recapture") return sendRecapture(request, response);
      if (rawPath === "/__flowmap-app/capture") return sendCapture(request, response);
      if (rawPath === "/__flowmap-app/export-route") return exportRoute(request, response);
      if (rawPath.startsWith(RUNS_PREFIX) && rawPath.endsWith(DECISION_SUFFIX)) return answerDecision(request, response, rawPath);
      if (rawPath.startsWith(RUNS_PREFIX) && rawPath.endsWith(CANCEL_SUFFIX)) return answerCancel(request, response, rawPath);
      if (rawPath === "/__flowmap-app/choose-folder") {
        return replyJson(response, 200, { path: await chooseFolderWithDialog() });
      }
    }
    if (request.method !== "GET") return reply(response, 404);
    if (rawPath === "/__flowmap-app/events") return mapWatcher.addStream(response);
    if (rawPath === "/__flowmap-app/capture-path") return answerCapturePath(response, url);
    if (rawPath === "/__flowmap-app/history") return answerVersions(response, url);
    if (rawPath === "/__flowmap-app/changes") return answerChanges(response);
    if (rawPath === "/__flowmap-app/session") return answerSession(response);
    if (rawPath === "/__flowmap-app/session-help") return answerSessionHelp(response);
    if (rawPath === `${RUNS_PREFIX}current`) return answerCurrentRun(response);
    if (rawPath.startsWith(RUNS_PREFIX)) return answerRun(response, rawPath);

    if (rawPath === "/favicon.png") return reply(response, 200, iconPng(), "image/png");

    if (rawPath === "/" || rawPath === "/choose") {
      if (rawPath === "/choose") await createScratchMap();
      const notice = rawPath === "/" ? await openScratchMap() : null;
      const page =
        rawPath === "/" && mapFolder
          ? await buildMapPage(mapFolder)
          : await buildChoosePage(recents.list(), notice ?? "", await readWorkingMap());
      return reply(response, 200, page, "text/html; charset=utf-8");
    }
    if (mapFolder) return serveMapFile(response, rawPath);
    reply(response, 404);
  }

  const server = http.createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      process.stderr.write(`flow-map: request failed: ${error instanceof Error ? error.message : String(error)}\n`);
      if (response.headersSent) response.end();
      else reply(response, 500);
    });
  });
  await new Promise<void>((done) => server.listen(options.port, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;

  // The announce file lets `flow-map open` find this app; a stale one is detected by asking the address.
  const announceFile = options.dataDir && join(options.dataDir, "app.json");
  if (announceFile) {
    await mkdir(dirname(announceFile), { recursive: true });
    await writeFileAtomic(announceFile, JSON.stringify({ port, pid: process.pid }));
  }

  return {
    port,
    close: async () => {
      if (announceFile) await rm(announceFile, { force: true });
      await stopExport?.();
      await new Promise<void>((done, fail) => {
        mapWatcher.close();
        worker.close();
        server.closeAllConnections();
        server.close((error) => (error ? fail(error) : done()));
      });
    },
  };
}
