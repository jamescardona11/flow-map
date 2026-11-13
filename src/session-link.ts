import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { RequestError } from "./errors.ts";
import { writeFileAtomic } from "./fs-util.ts";

const SESSION_VERSION = 1;
/** A real link is a few hundred bytes: a bigger `session.json` is not one. */
const MAX_LEGACY_LINK_BYTES = 4096;

export type Session = { socket: string; token: string; linkedAt: string };

/**
 * Where the link of a map folder lives: `<dataDir>/sessions/<key>.json`, the key being the first 32 hex characters of the
 * sha256 of the folder's real path. It is not in the map folder, so a map folder (which can come from git) never carries a token and
 * the worker's Read/Edit rules on the folder do not reach it. That does not stop a worker steered by hostile map text from copying
 * it through the commands the app lets it run (those accept paths outside the folder): an accepted residual risk, see ADR 0002.
 */
async function linkFile(dataDir: string, folder: string): Promise<string> {
  const key = createHash("sha256")
    .update(await realpath(folder))
    .digest("hex")
    .slice(0, 32);
  return join(dataDir, "sessions", `${key}.json`);
}

/** The linked session of a map folder, or null when the app has no data dir, there is no link or it is not a valid one. */
export async function readSession(dataDir: string | undefined, folder: string): Promise<Session | null> {
  if (!dataDir) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(await linkFile(dataDir, folder), "utf8"));
  } catch {
    return null;
  }
  if (!isLinkWithToken(parsed)) return null;
  const { socket, token, linkedAt } = parsed;
  if (typeof linkedAt !== "string") return null;
  return { socket, token, linkedAt };
}

/** An object with the version, socket and token of a link: what earlier versions kept in `<map folder>/session.json`. */
function isLinkWithToken(value: unknown): value is { socket: string; token: string; linkedAt?: unknown } {
  if (typeof value !== "object" || value === null) return false;
  const { version, socket, token } = value as Record<string, unknown>;
  return version === SESSION_VERSION && typeof socket === "string" && typeof token === "string";
}

/**
 * Deletes a `session.json` that an earlier version left in the map folder: it still holds a live token that the worker's
 * Read rules on the folder reach. Any other `session.json` (a symlink, a file that is not a small regular one, not JSON,
 * or not a link) belongs to someone else and stays, and is never read beyond the cap.
 * Throws RequestError, naming the file to delete by hand, when the link is there but cannot be deleted.
 */
export async function removeLegacyLink(folder: string): Promise<void> {
  const file = join(folder, "session.json");
  let parsed: unknown;
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > MAX_LEGACY_LINK_BYTES) return;
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return;
  }
  if (!isLinkWithToken(parsed)) return;
  try {
    await rm(file, { force: true });
  } catch (error) {
    throw new RequestError(`${file} holds a session token an earlier version left and cannot be deleted (${(error as Error).message}): delete it by hand.`);
  }
}

/** What the page may know about the link: the socket's file name, never its directory and never the token. */
export function describeLink(session: Session | null): { linked: false } | { linked: true; socket: string } {
  return session ? { linked: true, socket: basename(session.socket) } : { linked: false };
}

/** Replaces the map's link with this session: a file readable only by the user, in the app's data dir. */
export async function writeSession(dataDir: string, folder: string, session: { socket: string; token: string }): Promise<void> {
  const file = await linkFile(dataDir, folder);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const content: Session & { version: number } = { version: SESSION_VERSION, ...session, linkedAt: new Date().toISOString() };
  await writeFileAtomic(file, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
}
