import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { captureRealPath } from "./capture-path.ts";
import { isMissing } from "./fs-util.ts";
import type { MapScreen } from "./map-check.ts";

/**
 * The skill keeps every previous capture of a screen as `history/<id>/<YYYYMMDDTHHMMSSZ>.<png|jpg|jpeg>`: the UTC time the
 * capture was taken; a second capture in the same second gets `-2`, `-3`... before the extension. The app only reads them.
 */
const VERSION_NAME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z(?:-(\d+))?\.(?:png|jpe?g)$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T/;
const MAX_CHANGES = 200;

export type Version = { capturedAt: string | null; image: string; current: boolean };
export type Change = Version & { screen: string; title: string };

/** An ISO 8601 date in UTC with a `Z` and no milliseconds (`2026-10-29T12:23:17Z`), or null when it is absent or not a date. */
function toUtc(value: unknown): string | null {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The versions kept in `history/<id>/`, newest first: the later of two captures in the same second has the higher `-N`. */
async function historyFiles(folder: string, id: string): Promise<Version[]> {
  if (/[\\/]/.test(id)) return [];
  let names: string[];
  try {
    names = await readdir(join(folder, "history", id));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const found: (Version & { time: number; tie: number })[] = [];
  for (const name of names) {
    const match = VERSION_NAME.exec(name);
    if (!match) continue;
    const [, year, month, day, hour, minute, second, tie] = match;
    const capturedAt = toUtc(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
    const image = `history/${id}/${name}`;
    const real = capturedAt && (await captureRealPath(folder, image));
    if (!capturedAt || !real || !(await stat(real)).isFile()) continue;
    found.push({ capturedAt, image, current: false, time: Date.parse(capturedAt), tie: tie ? Number(tie) : 1 });
  }
  found.sort((a, b) => b.time - a.time || b.tie - a.tie);
  return found.map(({ capturedAt, image, current }) => ({ capturedAt, image, current }));
}

/** The screen's current capture (as map.json says it) followed by its history files, newest first. */
export async function listVersions(folder: string, screen: MapScreen): Promise<Version[]> {
  const current: Version = { capturedAt: toUtc(screen.capturedAt), image: screen.image, current: true };
  return [current, ...(await historyFiles(folder, screen.id))];
}

/** Every version of every screen, newest first (undated ones last, in the map's order), at most 200. */
export async function listChanges(folder: string, screens: MapScreen[]): Promise<Change[]> {
  const changes: Change[] = [];
  for (const screen of screens) {
    const title = typeof screen.title === "string" ? screen.title : screen.id;
    for (const version of await listVersions(folder, screen)) changes.push({ screen: screen.id, title, ...version });
  }
  changes.sort((a, b) => {
    if (a.capturedAt === null || b.capturedAt === null) return Number(a.capturedAt === null) - Number(b.capturedAt === null);
    return Date.parse(b.capturedAt) - Date.parse(a.capturedAt);
  });
  return changes.slice(0, MAX_CHANGES);
}
