import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { readMap } from "./map-check.ts";

const INIT_TIMEOUT_MS = 10_000;
const run = promisify(execFile);

/** Where the app's scratch map lives inside its data dir. */
export function scratchFolderOf(dataDir: string): string {
  return join(dataDir, "scratch", "untitled");
}

async function hasMapJson(folder: string): Promise<boolean> {
  try {
    return (await stat(join(folder, "map.json"))).isFile();
  } catch {
    return false;
  }
}

/**
 * Makes sure `folder` holds a usable map: one that already passes the map check is kept as it is,
 * otherwise the app's own copy of the skill (`skillScript`) creates an empty web map titled "Untitled".
 * A map.json that exists but fails the check is never overwritten: the error tells the owner to delete the folder.
 * Throws an Error with a sentence that says why the map could not be created.
 */
export async function ensureScratchMap(folder: string, skillScript: string): Promise<void> {
  const checked = await readMap(folder);
  if (!("problem" in checked)) return;
  if (await hasMapJson(folder)) {
    throw new Error(`The working map is damaged: ${checked.problem} To start a new one, delete the folder ${folder} and reload.`);
  }
  await mkdir(dirname(folder), { recursive: true });
  try {
    await run("python3", [skillScript, "init", folder, "--title", "Untitled", "--platform", "web"], { timeout: INIT_TIMEOUT_MS });
  } catch (error) {
    const { stderr, message } = error as { stderr?: string; message: string };
    const detail = stderr?.split("\n").find((line) => line.trim() !== "") ?? message;
    throw new Error(`Could not create the scratch map: ${detail}`);
  }
}
