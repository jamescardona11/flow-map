import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { readLayout } from "./layout-groups.ts";
import { readMap } from "./map-check.ts";
import { buildNoticePage } from "./notice-page.ts";

const PLACEHOLDER = "/*__FLOWMAP_DATA__*/";
const VIEWER_PATH = join(import.meta.dirname, "viewer", "viewer.html");

/** The viewer page with the map folder's data embedded, as the skill's `build` does; the notice page if the folder is not a usable map. */
export async function buildMapPage(folder: string): Promise<string> {
  const checked = await readMap(folder);
  if ("problem" in checked) return buildNoticePage(checked.problem);
  const { map } = checked;
  const [{ positions: layout }, realFolder, viewer] = await Promise.all([readLayout(folder), realpath(folder), readFile(VIEWER_PATH, "utf8")]);
  const payload = JSON.stringify({ ...map, search: {}, layout, folder: realFolder }).replaceAll("</", "<\\/");
  return viewer.replace(PLACEHOLDER, () => `const DATA = ${payload};`);
}
