import { realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { isMissing } from "./fs-util.ts";

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/**
 * The real path of a screen's capture (`image` as map.json writes it, relative to the map folder), or null when the file
 * does not exist, has a control character in its name (it would break the line of a prompt) or, once symlinks are resolved, is not inside the map folder.
 * It checks the real path after symlinks, for reading; the lexical check in `serveMapFile` (server.ts) comes first and `removeCrop` (annotations.ts) guards deleting.
 * A caller that checks several captures resolves the folder once and passes it as `resolvedFolder`.
 */
export async function captureRealPath(folder: string, image: string, resolvedFolder?: string): Promise<string | null> {
  const realFolder = resolvedFolder ?? (await realpath(folder));
  let file: string;
  try {
    file = await realpath(join(realFolder, image));
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  return file.startsWith(realFolder + sep) && !CONTROL_CHARACTER.test(file) ? file : null;
}
