import { type FSWatcher, watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import type http from "node:http";
import { join } from "node:path";
import { createQueue, isMissing } from "./fs-util.ts";

/** `fs.watch` returns before macOS has the stream running: writes made in this time are never reported. */
const WATCH_START_MS = 100;

/** What the skill writes into a map folder; `temp/` and anything else is not part of what the page shows. */
const WATCHED_FILES = ["map.json", "layout.json", "groups.json"];
const WATCHED_FOLDERS = ["screens", "thumbs", "history", "baselines"];
const WATCHED_ENTRIES = [...WATCHED_FILES, ...WATCHED_FOLDERS];

/** The watched files, the watched folders and everything inside them, relative to `folder`; a name that does not exist may be listed. */
async function listEntries(folder: string): Promise<string[]> {
  const inFolders = await Promise.all(
    WATCHED_FOLDERS.map(async (dir) => {
      try {
        const names = await readdir(join(folder, dir), { recursive: true });
        return [dir, ...names.map((name) => join(dir, name))];
      } catch (error) {
        if (isMissing(error)) return []; // the folder is not there (or is a file)
        throw error;
      }
    }),
  );
  return [...WATCHED_FILES, ...inFolders.flat()];
}

/** Name, size and modification time of every watched file: two equal snapshots mean nothing the page shows changed. */
async function snapshot(folder: string): Promise<string> {
  const lines = await Promise.all(
    (await listEntries(folder)).map(async (name) => {
      try {
        const { size, mtimeMs } = await stat(join(folder, name));
        return `${name}:${size}:${mtimeMs}`;
      } catch (error) {
        if (isMissing(error)) return ""; // not there, or removed while we were listing
        throw error;
      }
    }),
  );
  return lines.filter((line) => line !== "").sort().join("\n");
}

/**
 * Tells every connected page, with one `changed` event, that the open map folder changed on disk.
 * Writes that come close together (the skill writes `map.json` plus images in a burst) make one event.
 * macOS replays events for files written just before the watch started, so an event only counts when a snapshot differs.
 */
export function createMapWatcher(debounceMs: number) {
  const streams = new Set<http.ServerResponse>();
  let watcher: FSWatcher | null = null;
  let timer: NodeJS.Timeout | null = null;
  let watchedFolder = "";
  let lastSnapshot = "";
  // Checking for changes and the app's own writes take turns: a check that ran in the middle of an own write would report it.
  const inTurn = createQueue();

  function notifyIfChanged() {
    timer = null;
    return inTurn(async () => {
      const folder = watchedFolder;
      const current = await snapshot(folder);
      if (folder !== watchedFolder || current === lastSnapshot) return;
      lastSnapshot = current;
      for (const stream of streams) stream.write("event: changed\ndata: {}\n\n");
    });
  }

  function onChange(filename: string | null) {
    const entry = filename?.split(/[\\/]/)[0];
    if (entry && !WATCHED_ENTRIES.includes(entry)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void notifyIfChanged(), debounceMs);
  }

  function stopWatching() {
    watcher?.close();
    watcher = null;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return {
    /** Watches `folder` from its root, so folders the skill creates later are seen too. */
    async watchFolder(folder: string) {
      stopWatching();
      watchedFolder = folder;
      lastSnapshot = await snapshot(folder);
      watcher = watch(folder, { recursive: true }, (_event, filename) => onChange(filename));
      watcher.on("error", stopWatching);
      await new Promise((done) => setTimeout(done, WATCH_START_MS));
    },
    /**
     * Runs a write the app makes in the open map folder without telling the pages about it: the page that saved already has
     * what it saved, and a reload would drop a drag in progress. Changes made by anyone else are still reported.
     */
    quietly<T>(write: () => Promise<T>): Promise<T> {
      return inTurn(async () => {
        try {
          return await write();
        } finally {
          if (watchedFolder) lastSnapshot = await snapshot(watchedFolder);
        }
      });
    },
    addStream(response: http.ServerResponse) {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      response.write(": connected\n\n");
      streams.add(response);
      response.on("close", () => streams.delete(response));
    },
    close() {
      stopWatching();
      for (const stream of streams) stream.end();
      streams.clear();
    },
  };
}
