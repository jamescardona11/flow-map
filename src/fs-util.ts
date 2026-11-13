import { randomUUID } from "node:crypto";
import { chmod, lstat, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** The path does not exist, or a part of it is not a folder. */
export function isMissing(error: unknown): boolean {
  const { code } = error as NodeJS.ErrnoException;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** What `lstat` answers for `path` (a link is not followed), or undefined when the path does not exist. */
export async function lstatOrUndefined(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

/** True when `path` exists and is a link or a file: the app writes only into real folders of the map. */
export async function isNotPlainFolder(path: string): Promise<boolean> {
  const stats = await lstatOrUndefined(path);
  return stats !== undefined && !stats.isDirectory();
}

/**
 * Temp file plus rename, so a reader never sees half a file. The temp file sits next to the target and its name starts
 * with a dot, so the folder watcher never takes it for a map file. `mode` is applied with chmod: the umask can only remove
 * permissions at creation, never add them.
 */
export async function writeFileAtomic(path: string, content: string | Uint8Array, options: { mode?: number } = {}): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, content, options.mode === undefined ? undefined : { mode: options.mode });
    if (options.mode !== undefined) await chmod(temp, options.mode);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** Runs the tasks it is given one at a time, in order; a task that fails does not stop the ones after it. */
export function createQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const result = tail.then(task);
    tail = result.catch(() => undefined);
    return result;
  };
}
