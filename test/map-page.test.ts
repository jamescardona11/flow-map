import { realpath } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { buildMapPage } from "../src/map-page.ts";
import { checkoutMap } from "./map-fixtures.ts";
import { createFixtures } from "./support.ts";

const fixtures = createFixtures();

afterEach(() => fixtures.removeTempDirs());

it("embeds the map folder's absolute real path in the viewer data as DATA.folder", async () => {
  const folder = await fixtures.buildMapFolder(checkoutMap());  // under the macOS temp dir, which is a symlink

  const html = await buildMapPage(folder);

  const data = JSON.parse(html.match(/const DATA = (\{.*?\});/s)![1]!);
  expect(data.folder).toBe(await realpath(folder));
  expect(data.title).toBe("Checkout flow");
});
