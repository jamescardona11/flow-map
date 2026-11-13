import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createQueue, isMissing, writeFileAtomic } from "./fs-util.ts";

export type Recent = { path: string; title: string };

/**
 * The maps opened before, most recent first, each folder once.
 * With a `dataDir` the list lives in `recents.json` there; without one it lives only in memory.
 */
export async function createRecents(dataDir?: string) {
  const file = dataDir && join(dataDir, "recents.json");
  let list: Recent[] = [];
  const inOrder = createQueue();

  if (file) {
    try {
      list = JSON.parse(await readFile(file, "utf8")) as Recent[];
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  // Writes go one after another so two opens in a row never write the file at once.
  function save(): Promise<void> {
    if (!file) return Promise.resolve();
    const snapshot = JSON.stringify(list);
    return inOrder(async () => {
      await mkdir(dirname(file), { recursive: true });
      await writeFileAtomic(file, snapshot);
    });
  }

  return {
    list: (): Recent[] => list,
    async add(recent: Recent): Promise<void> {
      list = [recent, ...list.filter((entry) => entry.path !== recent.path)];
      await save();
    },
  };
}
