import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { RequestError } from "./errors.ts";
import { createQueue, isMissing, writeFileAtomic } from "./fs-util.ts";
import { readMap } from "./map-check.ts";

/**
 * Where the designer left the screens and which screens move together, kept in the map folder.
 * `layout.json` has the format the `/flow-map` skill uses ({positions: {id: {x, y}}}), ported and not imported ([ADR 0001]).
 * `groups.json` is the app's own ({version: 1, groups: [...]}): the skill rewrites `layout.json` without keys it does not know,
 * so groups cannot live there, and the skill does not read them.
 */

export type Positions = Record<string, { x: number; y: number }>;
export type Group = { id: string; name: string; members: string[] };

const LAYOUT_FILE = "layout.json";
const GROUPS_FILE = "groups.json";
const GROUPS_VERSION = 1;
const LAYOUT_LIMIT = 1_000_000;
const MAX_ID_LENGTH = 64;
const MAX_NAME_LENGTH = 60;
const MIN_MEMBERS = 2;
const MAX_MEMBERS = 200;
const MAX_GROUPS = 100;

// A write is replace-the-whole-file, but two requests at once must not share a temp file: one queue per file.
const queues = new Map<string, ReturnType<typeof createQueue>>();
function inOrder<T>(file: string, task: () => Promise<T>): Promise<T> {
  let queue = queues.get(file);
  if (!queue) {
    queue = createQueue();
    queues.set(file, queue);
  }
  return queue(task);
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function screenIds(folder: string): Promise<Set<string>> {
  const checked = await readMap(folder);
  if ("problem" in checked) throw new RequestError(checked.problem);
  return new Set(checked.map.screens.map((screen) => screen.id));
}

/** The parsed file, or null when it does not exist. */
async function readJsonFile(folder: string, name: string): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await readFile(join(folder, name), "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RequestError(`${name} is not valid JSON: fix or delete it.`);
  }
  if (!isPlainObject(parsed)) throw new RequestError(`${name} is not a JSON object: fix or delete it.`);
  return parsed;
}

async function writeJsonFile(folder: string, name: string, content: unknown): Promise<void> {
  await writeFileAtomic(join(folder, name), `${JSON.stringify(content, null, 2)}\n`);
}

export function readLayout(folder: string): Promise<{ positions: Positions }> {
  return inOrder(join(folder, LAYOUT_FILE), async () => {
    const stored = await readJsonFile(folder, LAYOUT_FILE);
    if (!stored) return { positions: {} };
    if (stored.positions !== undefined && !isPlainObject(stored.positions)) {
      throw new RequestError(`${LAYOUT_FILE} has positions that are not an object: fix or delete it.`);
    }
    const ids = await screenIds(folder);
    const positions = Object.entries((stored.positions ?? {}) as Positions).filter(([id]) => ids.has(id));
    return { positions: Object.fromEntries(positions) };
  });
}

function parsePositions(value: unknown, ids: Set<string>): Positions {
  if (!isPlainObject(value)) throw new RequestError("positions must be an object {id: {x, y}}");
  const clean: Positions = {};
  for (const [id, position] of Object.entries(value)) {
    if (!ids.has(id)) throw new RequestError(`There is no screen '${id}' in the map`);
    const { x, y } = isPlainObject(position) ? position : { x: undefined, y: undefined };
    const isCoordinate = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= LAYOUT_LIMIT;
    if (!isCoordinate(x) || !isCoordinate(y)) throw new RequestError(`Invalid position for '${id}': x and y must be numbers`);
    clean[id] = { x, y };
  }
  return clean;
}

/** Replaces the saved layout with `positions`, all or nothing. */
export function writeLayout(folder: string, positions: unknown): Promise<{ positions: Positions }> {
  return inOrder(join(folder, LAYOUT_FILE), async () => {
    const clean = parsePositions(positions, await screenIds(folder));
    await writeJsonFile(folder, LAYOUT_FILE, { positions: clean });
    return { positions: clean };
  });
}

/** Back to the automatic layout; fine when nothing was saved. */
export function removeLayout(folder: string): Promise<void> {
  return inOrder(join(folder, LAYOUT_FILE), () => rm(join(folder, LAYOUT_FILE), { force: true }));
}

export function readGroups(folder: string): Promise<{ groups: Group[] }> {
  return inOrder(join(folder, GROUPS_FILE), async () => {
    const stored = await readJsonFile(folder, GROUPS_FILE);
    if (!stored) return { groups: [] };
    if (stored.version !== GROUPS_VERSION || !Array.isArray(stored.groups)) {
      throw new RequestError(`${GROUPS_FILE} is not a groups file this app supports (version ${GROUPS_VERSION}): fix or delete it.`);
    }
    const ids = await screenIds(folder);
    const groups = (stored.groups as unknown[])
      .filter(isPlainObject)
      .map(({ id, name, members }) => ({
        id: String(id),
        name: String(name),
        members: Array.isArray(members) ? members.filter((member): member is string => ids.has(member as string)) : [],
      }))
      .filter((group) => group.members.length >= MIN_MEMBERS);
    return { groups };
  });
}

function parseGroups(value: unknown, ids: Set<string>): Group[] {
  if (!Array.isArray(value)) throw new RequestError("groups must be a list");
  if (value.length > MAX_GROUPS) throw new RequestError(`There can be at most ${MAX_GROUPS} groups`);
  const usedIds = new Set<string>();
  const grouped = new Set<string>();
  return value.map((entry: unknown) => {
    const { id, name, members } = isPlainObject(entry) ? entry : ({} as Record<string, unknown>);
    if (typeof id !== "string" || id === "" || id.length > MAX_ID_LENGTH) {
      throw new RequestError(`A group id must be text of 1 to ${MAX_ID_LENGTH} characters`);
    }
    if (usedIds.has(id)) throw new RequestError(`The group id '${id}' is used twice`);
    usedIds.add(id);
    const cleanName = typeof name === "string" ? name.trim() : "";
    if (cleanName === "" || cleanName.length > MAX_NAME_LENGTH) {
      throw new RequestError(`The name of group '${id}' must have 1 to ${MAX_NAME_LENGTH} characters`);
    }
    if (!Array.isArray(members) || members.length < MIN_MEMBERS || members.length > MAX_MEMBERS) {
      throw new RequestError(`Group '${id}' needs ${MIN_MEMBERS} to ${MAX_MEMBERS} screens`);
    }
    for (const member of members) {
      if (typeof member !== "string" || !ids.has(member)) throw new RequestError(`There is no screen '${String(member)}' in the map`);
      if (grouped.has(member)) throw new RequestError(`Screen '${member}' is in more than one group`);
      grouped.add(member);
    }
    return { id, name: cleanName, members: members as string[] };
  });
}

/** Replaces the saved groups, all or nothing; an empty list removes the file. */
export function writeGroups(folder: string, groups: unknown): Promise<{ groups: Group[] }> {
  return inOrder(join(folder, GROUPS_FILE), async () => {
    const clean = parseGroups(groups, await screenIds(folder));
    if (clean.length === 0) await rm(join(folder, GROUPS_FILE), { force: true });
    else await writeJsonFile(folder, GROUPS_FILE, { version: GROUPS_VERSION, groups: clean });
    return { groups: clean };
  });
}
