import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { isMissing, writeFileAtomic } from "./fs-util.ts";

/** The design contract of a map is one Markdown file, `DESIGN.md`, in the map folder: the designer's colours, typography and components. */
const DESIGN_FILE = "DESIGN.md";
export const MAX_DESIGN_LENGTH = 50_000;

/** The contract's text, or null when the map has none. */
export async function readDesign(folder: string): Promise<string | null> {
  try {
    return await readFile(join(folder, DESIGN_FILE), "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/** Replaces the contract (temp file + rename, so a reader never sees half of it); blank text removes it. Says whether the file exists afterwards. */
export async function writeDesign(folder: string, text: string): Promise<boolean> {
  const file = join(folder, DESIGN_FILE);
  if (text.trim() === "") {
    await rm(file, { force: true });
    return false;
  }
  await writeFileAtomic(file, text);
  return true;
}
