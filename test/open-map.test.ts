import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server.ts";
import { checkoutMap } from "./map-fixtures.ts";
import { binaryClient, createFixtures, linkTo, pause, TOKEN, until, writeLinkFile } from "./support.ts";

const RED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);
const BLUE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC",
  "base64",
);

type Reply = { status: number; body: Buffer; contentType: string | undefined };

type Server = Awaited<ReturnType<typeof createServer>>;

let server: Server;
const fixtures = createFixtures();
const { send } = binaryClient(() => server.port);

beforeEach(async () => {
  server = await createServer({ port: 0 });
});

afterEach(async () => {
  await server.close();
  await fixtures.removeTempDirs();
});

function openFolder(path: string): Promise<Reply> {
  return send("POST", "/__flowmap-app/open", {
    headers: { "X-Flowmap": "1", "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
}

async function buildTitledMapFolder(options: {
  title: string;
  png: Buffer;
  layout?: Record<string, { x: number; y: number }>;
}): Promise<string> {
  const folder = await fixtures.buildMapFolder(checkoutMap({ title: options.title }), { png: options.png });
  if (options.layout) {
    await writeFile(join(folder, "layout.json"), JSON.stringify({ positions: options.layout }));
  }
  return folder;
}

function embeddedData(html: string): Record<string, unknown> {
  const match = html.match(/const DATA = (\{.*?\});/s);
  expect(match, "the page embeds `const DATA = {...};`").not.toBeNull();
  return JSON.parse(match![1]!);
}

describe("opening a map folder", () => {
  it("serves the choose-a-folder screen, and not a viewer, while no map is open", async () => {
    const page = await send("GET", "/");

    const html = page.body.toString();
    expect(page.status).toBe(200);
    expect(html).not.toContain("const DATA");
    expect(html).toContain('id="choose-folder"');
    expect(html).toContain('id="typed-path"');
  });

  it("after a typed path is submitted, serves the viewer with that map's data and its images", async () => {
    const folder = await buildTitledMapFolder({
      title: "Map </script> A",
      png: RED_PNG,
      layout: { "a1-home": { x: 10, y: 20 }, "deleted-screen": { x: 1, y: 2 } },
    });

    const opened = await openFolder(folder);
    const page = await send("GET", "/");
    const image = await send("GET", "/screens/a1-home.png");
    const escapedOut = await send("GET", "/screens/../map.json");

    expect(opened.status).toBe(200);
    const html = page.body.toString();
    expect(page.status).toBe(200);
    expect(html).not.toContain("/*__FLOWMAP_DATA__*/");
    expect(html).not.toContain("Map </script> A");
    const data = embeddedData(html) as {
      title: string;
      screens: { id: string; image: string }[];
      edges: { from: string; to: string; action: string }[];
      search: unknown;
      layout: unknown;
    };
    expect(data.title).toBe("Map </script> A");
    expect(data.screens.map((screen) => [screen.id, screen.image])).toEqual([
      ["a1-home", "screens/a1-home.png"],
      ["a2-detail", "screens/a2-detail.png"],
    ]);
    expect(data.edges).toEqual([{ from: "a1-home", to: "a2-detail", action: "tap «Open»" }]);
    expect(data.search).toEqual({});
    expect(data.layout).toEqual({ "a1-home": { x: 10, y: 20 } });

    expect(image.status).toBe(200);
    expect(image.contentType).toBe("image/png");
    expect(image.body.equals(RED_PNG)).toBe(true);

    expect([403, 404]).toContain(escapedOut.status);
    expect(escapedOut.body.toString()).not.toContain("Map </script> A");
  });

  it("answers 404, with nothing written to stderr, for a served path that does not decode", async () => {
    await openFolder(await buildTitledMapFolder({ title: "Map A", png: RED_PNG }));
    const written: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    let replies: { path: string; reply: Reply }[];
    try {
      replies = [];
      for (const path of ["/screens/%zz", "/screens/a1-home%.png", "/screens/%E0%A4%A"]) replies.push({ path, reply: await send("GET", path) });
    } finally {
      stderr.mockRestore();
    }

    for (const { path, reply } of replies) expect(reply.status, path).toBe(404);
    expect(written).toEqual([]);
  });

  it("answers 500 and writes one stderr line with the error message, and nothing from the folder, when a handler throws something unexpected", async () => {
    const folder = await buildTitledMapFolder({ title: "Map A", png: RED_PNG });
    await mkdir(join(folder, "layout.json")); // reading a directory as a file fails with EISDIR, which no handler turns into an answer
    await writeFile(join(folder, "layout.json", "inside.txt"), "SECRET-FILE-CONTENT");
    await openFolder(folder);
    const written: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    let reply: Reply;
    try {
      reply = await send("GET", "/__flowmap/layout");
    } finally {
      stderr.mockRestore();
    }

    expect(reply.status).toBe(500);
    expect(written).toHaveLength(1);
    expect(written[0]).toContain("EISDIR");
    expect(written[0]!.trimEnd().split("\n"), "one line").toHaveLength(1);
    expect(written[0]).not.toContain("SECRET-FILE-CONTENT");
  });

  it("switches to a second map folder without restarting the server", async () => {
    const first = await buildTitledMapFolder({ title: "First map", png: RED_PNG });
    const second = await buildTitledMapFolder({ title: "Second map", png: BLUE_PNG });

    await openFolder(first);
    await openFolder(second);
    const page = await send("GET", "/");
    const image = await send("GET", "/screens/a1-home.png");

    expect(embeddedData(page.body.toString()).title).toBe("Second map");
    expect(image.body.equals(BLUE_PNG)).toBe(true);
  });

  it("refuses to open a folder for a request that is not from the app's own page", async () => {
    const folder = await buildTitledMapFolder({ title: "Private map", png: RED_PNG });
    const body = JSON.stringify({ path: folder });
    const json = { "Content-Type": "application/json" };

    const withoutHeader = await send("POST", "/__flowmap-app/open", { headers: json, body });
    const foreignHost = await send("POST", "/__flowmap-app/open", {
      headers: { ...json, "X-Flowmap": "1", Host: "evil.example" },
      body,
    });
    const page = await send("GET", "/");

    expect(withoutHeader.status).toBeGreaterThanOrEqual(400);
    expect(foreignHost.status).toBeGreaterThanOrEqual(400);
    expect(page.body.toString()).not.toContain("const DATA");
    expect(page.body.toString()).toContain('id="choose-folder"');
  });

  it("answers 400 naming the folder and keeps the already-open map when the chosen folder has no map.json", async () => {
    const open = await buildTitledMapFolder({ title: "Open map", png: RED_PNG });
    const notAMap = await fixtures.makeTempDir("flow-map-empty-");

    const failedOnFreshServer = await openFolder(notAMap);
    const chooser = (await send("GET", "/")).body.toString();
    await openFolder(open);
    const failedWithMapOpen = await openFolder(notAMap);
    const stillOpen = await send("GET", "/");
    const image = await send("GET", "/screens/a1-home.png");

    for (const failed of [failedOnFreshServer, failedWithMapOpen]) {
      expect(failed.status).toBe(400);
      const { error } = JSON.parse(failed.body.toString()) as { error: string };
      expect(error).toContain(notAMap);
      expect(error).toContain("not a map");
    }
    expect(chooser).not.toContain("const DATA");
    expect(chooser).toContain('id="choose-folder"');
    expect(embeddedData(stillOpen.body.toString()).title).toBe("Open map");
    expect(image.body.equals(RED_PNG)).toBe(true);
  });

  it("answers 400 with the reason when map.json is not valid JSON, lacks the lists a map needs, has no version, has an unsupported version or cannot be read", async () => {
    const valid = { version: 1, title: "Broken", flows: [], screens: [], edges: [], frontier: [] };
    const without = (key: string) =>
      JSON.stringify(Object.fromEntries(Object.entries(valid).filter(([name]) => name !== key)));
    const cases: { name: string; mapJson: string | "DIRECTORY"; fragments: string[] }[] = [
      { name: "not JSON", mapJson: "{not json", fragments: ["JSON"] },
      { name: "no flows", mapJson: without("flows"), fragments: ["flows"] },
      { name: "no screens", mapJson: without("screens"), fragments: ["screens"] },
      { name: "no edges", mapJson: without("edges"), fragments: ["edges"] },
      { name: "no frontier", mapJson: without("frontier"), fragments: ["frontier"] },
      { name: "no title", mapJson: without("title"), fragments: ["title"] },
      { name: "no version", mapJson: without("version"), fragments: ["not a map"] },
      { name: "version 2", mapJson: JSON.stringify({ ...valid, version: 2 }), fragments: ["version", "2", "1"] },
      { name: "version as text", mapJson: JSON.stringify({ ...valid, version: "v1" }), fragments: ["version", "v1", "1"] },
      { name: "map.json is a directory", mapJson: "DIRECTORY", fragments: ["cannot read"] },
    ];

    for (const { name, mapJson, fragments } of cases) {
      const folder = await fixtures.makeTempDir("flow-map-bad-");
      if (mapJson === "DIRECTORY") await mkdir(join(folder, "map.json"));
      else await writeFile(join(folder, "map.json"), mapJson);

      const failed = await openFolder(folder);
      const page = (await send("GET", "/")).body.toString();

      expect(failed.status, name).toBe(400);
      const { error } = JSON.parse(failed.body.toString()) as { error: string };
      for (const fragment of fragments) expect(error, name).toContain(fragment);
      expect(page, name).not.toContain("const DATA");
      expect(page, name).toContain('id="choose-folder"');
    }
  });
});

describe("recent maps", () => {
  let dataDir: string;

  beforeEach(async () => {
    await server.close();
    dataDir = await fixtures.makeTempDir("flow-map-data-");
    server = await createServer({ port: 0, dataDir });
  });

  it("lists the maps opened, most recent first, each once, with title and folder path", async () => {
    const first = await buildTitledMapFolder({ title: "<b>First</b> map", png: RED_PNG });
    const second = await buildTitledMapFolder({ title: "Second map", png: BLUE_PNG });

    await openFolder(first);
    await openFolder(second);
    await openFolder(`${first}/`);
    const html = (await send("GET", "/choose")).body.toString();

    expect(html).not.toContain("<b>First</b>");
    expect(html).toContain("&lt;b&gt;First&lt;/b&gt; map");
    expect(html).toContain(first);
    expect(html).toContain(second);
    // every mention of the first map comes before every mention of the second: most recent first, no duplicates
    expect(html.lastIndexOf("First")).toBeLessThan(html.indexOf("Second map"));
  });

  it("still lists the recent maps after the server is started again with the same data directory", async () => {
    const first = await buildTitledMapFolder({ title: "First map", png: RED_PNG });
    const second = await buildTitledMapFolder({ title: "Second map", png: BLUE_PNG });
    await openFolder(first);
    await openFolder(second);

    await server.close();
    server = await createServer({ port: 0, dataDir });
    const page = await send("GET", "/choose");

    const html = page.body.toString();
    expect(html).not.toContain("const DATA");
    expect(html).toContain('id="choose-folder"');
    expect(html).toContain(first);
    expect(html).toContain(second);
    expect(html.lastIndexOf("Second map")).toBeLessThan(html.indexOf("First map"));
  });

  it("serves the chooser with the recents at /choose while a map is open, keeps that map open until another is chosen, and the viewer links back to it", async () => {
    const first = await buildTitledMapFolder({ title: "First map", png: RED_PNG });
    const second = await buildTitledMapFolder({ title: "Second map", png: BLUE_PNG });
    await openFolder(first);

    const chooser = await send("GET", "/choose");
    const stillOpen = await send("GET", "/");
    const image = await send("GET", "/screens/a1-home.png");
    await openFolder(second);
    const switched = await send("GET", "/");

    const chooserHtml = chooser.body.toString();
    expect(chooser.status).toBe(200);
    expect(chooserHtml).toContain('id="choose-folder"');
    expect(chooserHtml).not.toContain("const DATA");
    expect(chooserHtml).toContain("First map");
    expect(embeddedData(stillOpen.body.toString()).title).toBe("First map");
    expect(stillOpen.body.toString()).toContain('href="/choose"');
    expect(image.body.equals(RED_PNG)).toBe(true);
    expect(embeddedData(switched.body.toString()).title).toBe("Second map");
  });
});

describe("live reload", () => {
  const DEBOUNCE_MS = 200;
  let streams: http.IncomingMessage[] = [];

  beforeEach(async () => {
    await server.close();
    server = await createServer({ port: 0, watchDebounceMs: DEBOUNCE_MS });
  });

  afterEach(() => {
    streams.forEach((stream) => stream.destroy());
    streams = [];
  });

  /** Connects to the update stream, as the open page does; `changes()` counts the `changed` events received. */
  function connectToUpdates(): Promise<{ changes: () => number }> {
    return new Promise((resolve, reject) => {
      const request = http.get({ host: "127.0.0.1", port: server.port, path: "/__flowmap-app/events" }, (response) => {
        streams.push(response);
        if (response.statusCode !== 200) return reject(new Error(`update stream answered ${response.statusCode}`));
        let received = "";
        response.on("data", (chunk: Buffer) => (received += chunk.toString()));
        resolve({ changes: () => (received.match(/^event: changed$/gm) ?? []).length });
      });
      request.on("error", reject);
    });
  }

  async function retitle(folder: string, title: string) {
    const map = JSON.parse(await readFile(join(folder, "map.json"), "utf8")) as object;
    await writeFile(join(folder, "map.json"), JSON.stringify({ ...map, title }));
  }

  it("tells the open page that the map changed when its map.json is rewritten on disk, and the page then serves the new content", async () => {
    const folder = await buildTitledMapFolder({ title: "Before", png: RED_PNG });
    await openFolder(folder);
    const updates = await connectToUpdates();

    await retitle(folder, "After");

    expect(await until(() => updates.changes() >= 1)).toBe(true);
    const html = (await send("GET", "/")).body.toString();
    expect(embeddedData(html).title).toBe("After");
    expect(html).toContain("/__flowmap-app/events");
  });

  it("sends one update, not one per write, when map.json, images and layout.json are written in a burst", async () => {
    const folder = await buildTitledMapFolder({ title: "Before", png: RED_PNG });
    await openFolder(folder);
    const updates = await connectToUpdates();

    await retitle(folder, "Burst");
    await writeFile(join(folder, "screens", "a3-new.png"), BLUE_PNG);
    await mkdir(join(folder, "thumbs"));
    await writeFile(join(folder, "thumbs", "a3-new.png"), BLUE_PNG);
    await writeFile(join(folder, "layout.json"), JSON.stringify({ positions: { "a1-home": { x: 1, y: 2 } } }));
    await retitle(folder, "Burst, again");
    await pause(8 * DEBOUNCE_MS);

    expect(updates.changes()).toBe(1);
  });

  it("stops updating the page for a previous map once another map is opened, and keeps updating for the new one", async () => {
    const previous = await buildTitledMapFolder({ title: "Previous", png: RED_PNG });
    const current = await buildTitledMapFolder({ title: "Current", png: BLUE_PNG });
    await openFolder(previous);
    const updates = await connectToUpdates();
    await openFolder(current);

    await retitle(previous, "Previous, edited");
    await pause(8 * DEBOUNCE_MS);
    const afterPreviousChanged = updates.changes();
    await retitle(current, "Current, edited");

    expect(afterPreviousChanged).toBe(0);
    expect(await until(() => updates.changes() >= 1)).toBe(true);
    expect(updates.changes()).toBe(1);
  });

  it("while the open map's map.json is unusable, answers 200 with the notice and the live-reload hook, and shows the map again by itself when the file is fixed", async () => {
    const folder = await buildTitledMapFolder({ title: "Before", png: RED_PNG });
    await openFolder(folder);
    const updates = await connectToUpdates();
    const goodMapJson = await readFile(join(folder, "map.json"), "utf8");

    await writeFile(join(folder, "map.json"), goodMapJson.slice(0, 40));
    expect(await until(() => updates.changes() >= 1)).toBe(true);
    const notice = await send("GET", "/");
    await writeFile(join(folder, "map.json"), JSON.stringify({ ...JSON.parse(goodMapJson), title: "Fixed" }));
    expect(await until(() => updates.changes() >= 2)).toBe(true);
    const fixed = await send("GET", "/");

    const noticeHtml = notice.body.toString();
    expect(notice.status).toBe(200);
    expect(noticeHtml).toContain("JSON");
    expect(noticeHtml).toContain('href="/choose"');
    expect(noticeHtml).toContain("/__flowmap-app/events");
    expect(noticeHtml).not.toContain("const DATA");
    expect(embeddedData(fixed.body.toString()).title).toBe("Fixed");
  });
});

describe("the linked session of the open map", () => {
  const SOCKET = "/tmp/claude-sessions/claude-123.sock";

  let dataDir: string;

  beforeEach(async () => {
    await server.close();
    dataDir = await fixtures.makeTempDir("flow-map-data-");
    server = await createServer({ port: 0, dataDir });
  });

  it("answers {linked, socket file name} for a linked map and {linked: false} otherwise, 404 with no map open, and never exposes the token", async () => {
    const noMap = await send("GET", "/__flowmap-app/session");
    expect(noMap.status).toBe(404);
    expect(JSON.parse(noMap.body.toString())).toEqual({ error: expect.any(String) });

    const folder = await buildTitledMapFolder({ title: "Linked", png: RED_PNG });
    await openFolder(folder);
    const unlinked = await send("GET", "/__flowmap-app/session");
    expect(unlinked.status).toBe(200);
    expect(JSON.parse(unlinked.body.toString())).toEqual({ linked: false });

    await linkTo(dataDir, folder, SOCKET);
    const linked = await send("GET", "/__flowmap-app/session");
    const asFile = await send("GET", "/session.json");
    expect(linked.status).toBe(200);
    expect(JSON.parse(linked.body.toString())).toEqual({ linked: true, socket: "claude-123.sock", alive: false });
    expect(asFile.status).toBe(404);

    await writeLinkFile(dataDir, folder, "{ not json");
    const broken = await send("GET", "/__flowmap-app/session");
    await writeLinkFile(dataDir, folder, JSON.stringify({ version: 1, socket: SOCKET }));
    const withoutToken = await send("GET", "/__flowmap-app/session");
    expect(JSON.parse(broken.body.toString())).toEqual({ linked: false });
    expect(JSON.parse(withoutToken.body.toString())).toEqual({ linked: false });

    for (const response of [noMap, unlinked, linked, asFile, broken, withoutToken]) {
      expect(response.body.toString()).not.toContain(TOKEN);
      expect(response.body.toString()).not.toContain("/tmp/claude-sessions");
    }
  });
});
