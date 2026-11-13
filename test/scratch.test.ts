import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.ts";
import { checkoutMap } from "./map-fixtures.ts";
import { binaryClient, createFixtures, exists, PNG } from "./support.ts";

const SKILL_SCRIPT = join(import.meta.dirname, "..", "skill", "scripts", "flowmap.py");

type Server = Awaited<ReturnType<typeof createServer>>;

const fixtures = createFixtures();
let servers: Server[] = [];
let current: Server;
const { send } = binaryClient(() => current.port);

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close().catch(() => undefined)));
  servers = [];
  await fixtures.removeTempDirs();
});

async function start(options: { dataDir?: string; skillScript?: string }): Promise<Server> {
  current = await createServer({ port: 0, ...options });
  servers.push(current);
  return current;
}

const page = async (path: string) => (await send("GET", path)).body.toString();

function embeddedData(html: string): { title: string; platform: string; screens: { id: string }[] } {
  const match = html.match(/const DATA = (\{.*?\});/s);
  expect(match, "the page embeds `const DATA = {...};`").not.toBeNull();
  return JSON.parse(match![1]!);
}

describe("the scratch map, open from the start", () => {
  it("serves the viewer of an empty web map titled Untitled when no map is open, reuses that folder with what the skill added to it, and keeps it out of the recents", async () => {
    const dataDir = await fixtures.makeTempDir("flow-map-data-");
    const scratch = join(dataDir, "scratch", "untitled");
    await start({ dataDir });

    const first = await send("GET", "/");
    const session = await send("GET", "/__flowmap-app/session");

    expect(first.status).toBe(200);
    expect(embeddedData(first.body.toString())).toMatchObject({ title: "Untitled", platform: "web", screens: [] });
    expect(session.status, "the scratch map is the open map for the other routes").toBe(200);

    const capture = join(await fixtures.makeTempDir("flow-map-capture-"), "home.png");
    await writeFile(capture, PNG);
    await promisify(execFile)("python3", [SKILL_SCRIPT, "add", scratch, "--id", "a1-home", "--title", "Home", "--flow", "main", "--image", capture]);
    await servers.pop()!.close();
    await start({ dataDir });

    const again = embeddedData(await page("/"));
    expect(again.screens.map((screen) => screen.id), "init is not run again over a map that already holds a screen").toEqual(["a1-home"]);
  });

  it("lists the scratch map first on /choose as the Working map, created by that first request without opening it, so the owner can come back to it, and never inside the recents", async () => {
    const dataDir = await fixtures.makeTempDir("flow-map-data-");
    const scratch = join(dataDir, "scratch", "untitled");
    const folder = await fixtures.buildMapFolder(checkoutMap({ title: "Recent map" }));
    await start({ dataDir });

    expect(await page("/choose"), "the first /choose creates the scratch map and lists it").toContain("Working map");
    expect((await send("GET", "/__flowmap-app/session")).status, "/choose does not open the scratch map").toBe(404);

    await send("GET", "/");
    await send("POST", "/__flowmap-app/open", {
      headers: { "X-Flowmap": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ path: folder }),
    });
    const chooser = await page("/choose");

    const working = chooser.indexOf(`data-path="${scratch}"`);
    const recents = chooser.indexOf('id="recents"');
    expect(working, "the Working map entry opens the scratch folder").toBeGreaterThan(-1);
    expect(recents, "the recents list holds the map opened after it").toBeGreaterThan(-1);
    expect(working, "the Working map entry comes above the recents").toBeLessThan(recents);
    expect(chooser.slice(0, recents)).toContain("Working map");
    expect(chooser.slice(0, recents)).toContain("Untitled");
    expect(chooser.slice(0, recents)).toContain(scratch);
    expect(chooser.slice(recents), "the scratch map is not one of the recents").not.toContain(scratch);
    expect(chooser.slice(recents)).toContain("Recent map");

    for (const path of [scratch, await realpath(scratch)]) {
      await send("POST", "/__flowmap-app/open", {
        headers: { "X-Flowmap": "1", "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const again = await page("/choose");
      const recentsAfter = again.indexOf('id="recents"');
      expect(again.split(`data-path="${scratch}"`), `opening ${path} keeps one Working map entry`).toHaveLength(2);
      expect(again.slice(recentsAfter), `opening ${path} does not add the scratch map to the recents`).not.toContain(scratch);
      expect(again.slice(recentsAfter)).not.toContain(await realpath(scratch));
    }
  });

  it("shows the map the owner opened explicitly at /, creates no scratch map, and without a dataDir still serves the chooser", async () => {
    const dataDir = await fixtures.makeTempDir("flow-map-data-");
    const folder = await fixtures.buildMapFolder(checkoutMap({ title: "Chosen map" }));
    await start({ dataDir });

    const opened = await send("POST", "/__flowmap-app/open", {
      headers: { "X-Flowmap": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ path: folder }),
    });
    const html = await page("/");

    expect(opened.status).toBe(200);
    expect(embeddedData(html).title).toBe("Chosen map");
    expect(await exists(join(dataDir, "scratch"))).toBe(false);

    await start({});
    const inMemory = await page("/");
    expect(inMemory).toContain('id="choose-folder"');
    expect(inMemory).not.toContain("const DATA");
  });

  it("serves the chooser with the recents at /choose while the scratch map is open, and answers 200 with the chooser and a notice at / when the scratch map cannot be created", async () => {
    const dataDir = await fixtures.makeTempDir("flow-map-data-");
    const folder = await fixtures.buildMapFolder(checkoutMap({ title: "Recent map" }));
    await start({ dataDir });
    await send("POST", "/__flowmap-app/open", {
      headers: { "X-Flowmap": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ path: folder }),
    });
    await servers.pop()!.close();
    await start({ dataDir });
    expect(embeddedData(await page("/")).title, "the app starts on the scratch map after a restart").toBe("Untitled");

    const chooser = await send("GET", "/choose");
    expect(chooser.status).toBe(200);
    expect(chooser.body.toString()).toContain('id="choose-folder"');
    expect(chooser.body.toString()).not.toContain("const DATA");
    expect(chooser.body.toString()).toContain("Recent map");

    const missingScript = join(dataDir, "no-such-skill", "flowmap.py");
    await start({ dataDir: await fixtures.makeTempDir("flow-map-data-"), skillScript: missingScript });
    const failed = await send("GET", "/");

    expect(failed.status).toBe(200);
    expect(failed.body.toString()).toContain('id="choose-folder"');
    expect(failed.body.toString()).not.toContain("const DATA");
    expect(failed.body.toString()).toContain(missingScript);
  });

  it("answers 200 with the chooser and an English notice that names the real problem and the folder to delete when the scratch map is damaged, without running init or touching the file", async () => {
    const dataDir = await fixtures.makeTempDir("flow-map-data-");
    const scratch = join(dataDir, "scratch", "untitled");
    await mkdir(scratch, { recursive: true });
    await writeFile(join(scratch, "map.json"), "{ not json");
    const ranMarker = join(dataDir, "init-ran");
    const fakeScript = join(dataDir, "fake-flowmap.py");
    await writeFile(fakeScript, `open(${JSON.stringify(ranMarker)}, "w").close()\n`);
    await start({ dataDir, skillScript: fakeScript });

    const response = await send("GET", "/");
    const html = response.body.toString();

    expect(response.status).toBe(200);
    expect(html).toContain('id="choose-folder"');
    expect(html).not.toContain("const DATA");
    expect(html).toContain("not valid JSON");
    expect(html).toContain(`delete the folder ${scratch}`);
    expect(await readFile(join(scratch, "map.json"), "utf8")).toBe("{ not json");
    expect(await exists(ranMarker), "init is not run over a damaged map").toBe(false);
  });
});
