import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export const SUPPORTED_VERSION = 1;

const REQUIRED_LISTS = ["flows", "screens", "edges", "frontier"];

/** A screen as map.json lists it. Only `id` and `image` are relied on to exist; the rest is read with a type test where it is used. */
export type MapScreen = {
  id: string;
  image: string;
  title?: unknown;
  flow?: unknown;
  fingerprint?: unknown;
  width?: unknown;
  height?: unknown;
  capturedAt?: unknown;
};

/** The map as `readMap` hands it over: it has the lists and the title checked, not what is inside each entry. */
export type MapData = {
  title: string;
  platform?: unknown;
  meta?: { subtitle?: string };
  entry: string;
  flows: { id: string; title: string }[];
  screens: MapScreen[];
  edges: { from: string; to: string; action: string; at?: unknown }[];
};

/** Either the usable map or, in `problem`, a sentence a designer can read that says why the folder is not one. */
export type MapCheck = { map: MapData } | { problem: string };

async function folderExists(folder: string): Promise<boolean> {
  try {
    return (await stat(folder)).isDirectory();
  } catch {
    return false;
  }
}

async function readMapJson(folder: string): Promise<string | { problem: string }> {
  try {
    return await readFile(join(folder, "map.json"), "utf8");
  } catch (error) {
    const { code, message } = error as NodeJS.ErrnoException;
    // ENOENT only: a map.json under something that is not a folder is a different problem, reported below
    if (code === "ENOENT" && (await folderExists(folder))) {
      return { problem: `${folder} is not a map: it has no map.json.` };
    }
    return { problem: `${folder}: cannot read map.json: ${message}` };
  }
}

/** The problem with a screen's optional `html` (the mock its capture was rendered from), or null when it is fine or absent. */
function htmlProblem(screen: unknown): string | null {
  if (typeof screen !== "object" || screen === null || !("html" in screen)) return null;
  const { id, html } = screen as { id?: unknown; html: unknown };
  const name = `screen "${String(id)}"`;
  if (typeof html !== "string") return `${name} has an html that is not a path (text).`;
  if (isAbsolute(html)) return `${name} has an html that is absolute: it must be relative to the map folder.`;
  if (html.split(/[\\/]/).includes("..")) return `${name} has an html with a ".." segment: it must stay inside the map folder.`;
  if (!html.endsWith(".html")) return `${name} has an html that does not end in .html.`;
  return null;
}

/** The problem with a screen's `id`, which names files in the map folder and is printed in prompts: it must be a single safe path segment with no control characters. */
function idProblem(screen: unknown): string | null {
  const id = typeof screen === "object" && screen !== null ? (screen as { id?: unknown }).id : undefined;
  if (typeof id !== "string" || id === "" || id === "." || id === ".." || /[\\/\p{Cc}]/u.test(id)) {
    return `screen id ${JSON.stringify(id)} is not a safe file name: it cannot be empty, "." or "..", or contain "/", "\\" or control characters.`;
  }
  return null;
}

/** Reads `folder/map.json` and says whether this app can show it. */
export async function readMap(folder: string): Promise<MapCheck> {
  const text = await readMapJson(folder);
  if (typeof text !== "string") return text;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { problem: `${folder}: map.json is not valid JSON (${(error as Error).message}).` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { problem: `${folder} is not a map: map.json is not a JSON object.` };
  }

  const map = parsed as Record<string, unknown>;
  if (!("version" in map)) return { problem: `${folder} is not a map: map.json has no version.` };
  if (map.version !== SUPPORTED_VERSION) {
    return {
      problem: `${folder}: unsupported version ${JSON.stringify(map.version)}, this app supports version ${SUPPORTED_VERSION}.`,
    };
  }
  const missing = [...REQUIRED_LISTS.filter((name) => !Array.isArray(map[name])), ...(typeof map.title === "string" ? [] : ["title"])];
  if (missing.length > 0) return { problem: `${folder} is not a map: map.json is missing ${missing.join(", ")}.` };
  for (const screen of map.screens as unknown[]) {
    const problem = idProblem(screen) ?? htmlProblem(screen);
    if (problem) return { problem: `${folder} is not usable: ${problem}` };
  }
  return { map: map as MapData };
}
