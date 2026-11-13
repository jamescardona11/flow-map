import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.ts";
import { binaryClient, createFixtures, exists } from "./support.ts";

const RED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);
const asDataUrl = (type: string, bytes: Buffer) => `data:${type};base64,${bytes.toString("base64")}`;
const RED_PNG_URL = asDataUrl("image/png", RED_PNG);

type Reply = { status: number; body: Buffer; contentType: string | undefined };
type Server = Awaited<ReturnType<typeof createServer>>;
type Annotation = {
  id: string;
  screen: string;
  rect: { x: number; y: number; w: number; h: number };
  comment: string;
  crop: string;
  fingerprint: string;
  at: string;
};

let server: Server;
const fixtures = createFixtures();
const { send, fromPage } = binaryClient(() => server.port);

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

const json = (reply: Reply) => JSON.parse(reply.body.toString()) as unknown;

const SCREEN_IDS = ["a1-home", "a2-detail", "a3-orphan"];
const SCREEN_TITLES: Record<string, string> = { "a1-home": "Home", "a2-detail": "Detail", "a3-orphan": "Orphan" };

function demoMap() {
  return {
    version: 1,
    title: "Demo map",
    platform: "web",
    entry: "a1-home",
    meta: { subtitle: "Demo app" },
    flows: [{ id: "main", title: "Main", color: "#5aa9e6" }],
    screens: SCREEN_IDS.map((id) => ({
      id,
      title: SCREEN_TITLES[id],
      flow: "main",
      description: "",
      image: `screens/${id}.png`,
      width: 1,
      height: 1,
      status: "ok",
      fingerprint: `fp-${id}`,
    })),
    edges: [{ from: "a1-home", to: "a2-detail", action: "tap «Open»" }],
    frontier: [],
  };
}

/** A map folder in its real path (the app reports absolute paths, and macOS temp dirs are symlinks). */
const buildDemoMapFolder = () => fixtures.buildMapFolder(demoMap(), { png: RED_PNG, real: true });

function stored(id: string, screen: string, comment: string, extra: Partial<Annotation> = {}): Annotation {
  return {
    id,
    screen,
    rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
    comment,
    crop: `temp/${id}.png`,
    fingerprint: `fp-${screen}`,
    at: "2026-11-01T10:00:00+00:00",
    ...extra,
  };
}

/** Writes temp/annotations.json the way the skill does, plus a crop file for each annotation. */
async function seedAnnotations(folder: string, seq: Record<string, number>, annotations: Annotation[]) {
  await mkdir(join(folder, "temp"), { recursive: true });
  await writeFile(
    join(folder, "temp", "annotations.json"),
    `${JSON.stringify({ version: 1, seq, annotations }, null, 2)}\n`,
  );
  for (const annotation of annotations) await writeFile(join(folder, annotation.crop), RED_PNG);
}

const readStore = async (folder: string) => readFile(join(folder, "temp", "annotations.json"), "utf8");
const tempFiles = async (folder: string) => (await readdir(join(folder, "temp")).catch(() => [])).sort();

describe("commenting on screens of the open map", () => {
  it("saves a comment on a screen or a zone as temp/annotations.json plus its crop PNG, and refuses a bad comment, screen, rectangle or crop", async () => {
    const folder = await buildDemoMapFolder();
    await openFolder(folder);

    const first = await fromPage("POST", "/__flowmap/annotations", {
      screen: "a1-home",
      rect: { x: 0.123456, y: 0.2, w: 0.5, h: 0.25 },
      comment: "  Make the logo bigger  ",
      png: RED_PNG_URL,
    });
    const second = await fromPage("POST", "/__flowmap/annotations", {
      screen: "a1-home",
      rect: { x: 0, y: 0, w: 1, h: 1 },
      comment: "Whole screen",
      png: RED_PNG_URL,
    });
    const other = await fromPage("POST", "/__flowmap/annotations", {
      screen: "a2-detail",
      rect: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
      comment: "Corner",
      png: RED_PNG_URL,
    });

    expect(first.status).toBe(201);
    const created = json(first) as Annotation;
    expect(created).toEqual({
      id: "a1-home-01",
      screen: "a1-home",
      rect: { x: 0.1235, y: 0.2, w: 0.5, h: 0.25 },
      comment: "Make the logo bigger",
      crop: "temp/a1-home-01.png",
      fingerprint: "fp-a1-home",
      at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/),
    });
    expect((json(second) as Annotation).id).toBe("a1-home-02");
    expect((json(other) as Annotation).id).toBe("a2-detail-01");
    const saved = JSON.parse(await readStore(folder)) as { annotations: Annotation[] };
    const expectedFile = {
      version: 1,
      seq: { "a1-home": 2, "a2-detail": 1 },
      annotations: saved.annotations,
    };
    expect(saved.annotations.map((annotation) => annotation.id)).toEqual(["a1-home-01", "a1-home-02", "a2-detail-01"]);
    expect(saved.annotations[0]).toEqual(created);
    expect(await readStore(folder)).toBe(`${JSON.stringify(expectedFile, null, 2)}\n`);
    expect((await readFile(join(folder, "temp", "a1-home-01.png"))).equals(RED_PNG)).toBe(true);

    const before = { store: await readStore(folder), files: await tempFiles(folder) };
    const valid = { screen: "a1-home", rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, comment: "Fine", png: RED_PNG_URL };
    const refused: Record<string, unknown> = {
      "an empty comment": { ...valid, comment: "" },
      "a blank comment": { ...valid, comment: "   " },
      "an unknown screen": { ...valid, screen: "nope" },
      "a negative x": { ...valid, rect: { x: -0.1, y: 0, w: 0.5, h: 0.5 } },
      "a rectangle that leaves the screen": { ...valid, rect: { x: 0.6, y: 0, w: 0.6, h: 0.5 } },
      "a zero width": { ...valid, rect: { x: 0.1, y: 0.1, w: 0, h: 0.5 } },
      "a rectangle that is not numeric": { ...valid, rect: { x: "left", y: 0, w: 0.5, h: 0.5 } },
      "a crop that is not a PNG": { ...valid, png: asDataUrl("image/png", Buffer.from("hello")) },
      "a crop whose base64 is 6 MB": { ...valid, png: `data:image/png;base64,${"A".repeat(6 * 1024 * 1024)}` },
    };
    for (const [name, body] of Object.entries(refused)) {
      const reply = await fromPage("POST", "/__flowmap/annotations", body);
      expect(reply.status, name).toBe(400);
      expect(typeof (json(reply) as { error: unknown }).error, name).toBe("string");
    }
    expect(await readStore(folder)).toBe(before.store);
    expect(await tempFiles(folder)).toEqual(before.files);
  });

  it("lists the saved comments again after the map is reopened, lets one be edited or deleted, and clears all the comments of one screen", async () => {
    const folder = await buildDemoMapFolder();
    await openFolder(folder);
    const empty = await fromPage("GET", "/__flowmap/annotations");
    const one = stored("a1-home-01", "a1-home", "First");
    const two = stored("a1-home-02", "a1-home", "Second");
    const three = stored("a2-detail-01", "a2-detail", "Third");
    await seedAnnotations(folder, { "a1-home": 2, "a2-detail": 1 }, [one, two, three]);
    await openFolder(folder);

    const listed = await fromPage("GET", "/__flowmap/annotations");
    const edited = await fromPage("PATCH", "/__flowmap/annotations/a1-home-01", { comment: "  Rewritten " });
    const blank = await fromPage("PATCH", "/__flowmap/annotations/a1-home-01", { comment: "  " });
    const editUnknown = await fromPage("PATCH", "/__flowmap/annotations/nope-01", { comment: "x" });
    const deleted = await fromPage("DELETE", "/__flowmap/annotations/a1-home-02");
    const deleteUnknown = await fromPage("DELETE", "/__flowmap/annotations/nope-01");
    const afterDelete = (json(await fromPage("GET", "/__flowmap/annotations")) as Annotation[]).map((a) => a.id);
    const next = await fromPage("POST", "/__flowmap/annotations", {
      screen: "a1-home",
      rect: { x: 0, y: 0, w: 1, h: 1 },
      comment: "Third on home",
      png: RED_PNG_URL,
    });
    const cleared = await fromPage("DELETE", "/__flowmap/annotations?screen=a1-home");

    expect(empty.status).toBe(200);
    expect(json(empty)).toEqual([]);
    expect(json(listed)).toEqual([one, two, three]);
    expect(edited.status).toBe(200);
    expect(json(edited)).toEqual({ ...one, comment: "Rewritten" });
    expect(blank.status).toBe(400);
    expect(editUnknown.status).toBe(400);
    expect(deleted.status).toBe(204);
    expect(deleteUnknown.status).toBe(400);
    expect(afterDelete).toEqual(["a1-home-01", "a2-detail-01"]);
    expect(await exists(join(folder, "temp", "a1-home-02.png"))).toBe(false);
    expect((json(next) as Annotation).id).toBe("a1-home-03");
    expect(cleared.status).toBe(200);
    expect(json(cleared)).toEqual({ deleted: 2 });
    const left = json(await fromPage("GET", "/__flowmap/annotations")) as Annotation[];
    expect(left).toEqual([three]);
    expect(await tempFiles(folder)).toEqual(["a2-detail-01.png", "annotations.json"]);
  });

  it("never removes a file outside the map's own temp/ when a comment is deleted or a screen is cleared, even if the crop points there or temp/ is a symlink out of the map, and a crop that is not a string does not crash", async () => {
    const operations: { name: string; path: string }[] = [
      { name: "deleting a comment", path: "/__flowmap/annotations/a1-home-01" },
      { name: "clearing a screen", path: "/__flowmap/annotations?screen=a1-home" },
    ];
    // Each case seeds the folder and answers the file that must still be there afterwards (null when there is none to protect).
    const hostileCrops: { name: string; storeRefused?: true; seed: (folder: string) => Promise<string | null> }[] = [
      {
        name: "crop climbs out of the folder",
        seed: async (folder) => {
          const outside = `${folder}-outside.png`;
          fixtures.track(outside);
          await seedAnnotations(folder, { "a1-home": 1 }, [stored("a1-home-01", "a1-home", "Hostile crop", { crop: `../${basename(outside)}` })]);
          return outside;
        },
      },
      {
        name: "temp is a symlink to a folder outside the map, with the store and the victim inside it",
        storeRefused: true,
        seed: async (folder) => {
          const outsideDir = fixtures.track(`${folder}-outside-dir`);
          await mkdir(outsideDir);
          await symlink(outsideDir, join(folder, "temp"));
          await seedAnnotations(folder, { "a1-home": 1 }, [stored("a1-home-01", "a1-home", "Hostile temp", { crop: "temp/victim.png" })]);
          return join(outsideDir, "victim.png");
        },
      },
      {
        name: "crop is not a string",
        seed: async (folder) => {
          await seedAnnotations(folder, { "a1-home": 1 }, [stored("a1-home-01", "a1-home", "Odd crop")]);
          const storeFile = join(folder, "temp", "annotations.json");
          const store = JSON.parse(await readFile(storeFile, "utf8")) as { annotations: { crop: unknown }[] };
          store.annotations[0]!.crop = 42;
          await writeFile(storeFile, JSON.stringify(store));
          return null;
        },
      },
    ];

    for (const { name: operation, path } of operations) {
      for (const { name: hostile, storeRefused, seed } of hostileCrops) {
        const label = `${operation}, ${hostile}`;
        const folder = await buildDemoMapFolder();
        const victim = await seed(folder);
        if (victim) expect(await exists(victim), `${label}: the victim exists before`).toBe(true);
        await openFolder(folder);

        const reply = await fromPage("DELETE", path);

        expect(reply.status, label).toBeLessThan(500);
        if (victim) expect(await exists(victim), label).toBe(true);
        const read = await fromPage("GET", "/__flowmap/annotations");
        if (storeRefused) {
          expect(read.status, `${label}: the store is refused`).toBe(400);
          expect((json(read) as { error: string }).error, label).toContain("symlink");
        } else {
          expect(read.status, `${label}: the store is still readable`).toBe(200);
        }
      }
    }
  });

  it("answers 400 and writes nothing through temp/ when it is a symlink, for a new comment and for reading the comments", async () => {
    const folder = await buildDemoMapFolder();
    const outsideDir = fixtures.track(`${folder}-outside-dir`);
    await mkdir(outsideDir);
    await symlink(outsideDir, join(folder, "temp"));
    await openFolder(folder);

    const added = await fromPage("POST", "/__flowmap/annotations", {
      screen: "a1-home",
      rect: { x: 0, y: 0, w: 1, h: 1 },
      comment: "Through the link",
      png: RED_PNG_URL,
    });
    const listed = await fromPage("GET", "/__flowmap/annotations");

    expect(added.status, "POST").toBe(400);
    expect((json(added) as { error: string }).error).toContain("symlink");
    expect(listed.status, "GET").toBe(400);
    expect((json(listed) as { error: string }).error).toContain("symlink");
    expect(await readdir(outsideDir), "nothing written outside the map").toEqual([]);
  });

  it("answers 400 and writes no file when a screen id in map.json is not a safe path segment", async () => {
    const root = await fixtures.makeTempDir("flow-map-annotations-", { real: true });
    const folder = join(root, "map");
    await mkdir(join(folder, "screens"), { recursive: true });
    await writeFile(join(folder, "map.json"), JSON.stringify(demoMap()));
    await openFolder(folder);
    const hostileIds = ["../../evil", "a/b", "a\\b", ".."];

    for (const id of hostileIds) {
      const map = JSON.parse(await readFile(join(folder, "map.json"), "utf8")) as { entry: string; screens: { id: string }[] };
      map.entry = id;
      map.screens = [{ ...map.screens[0]!, id }];
      await writeFile(join(folder, "map.json"), JSON.stringify(map));

      const reply = await fromPage("POST", "/__flowmap/annotations", {
        screen: id,
        rect: { x: 0, y: 0, w: 1, h: 1 },
        comment: "Evil",
        png: RED_PNG_URL,
      });

      expect(reply.status, id).toBe(400);
      expect(typeof (json(reply) as { error: unknown }).error, id).toBe("string");
      expect(await readdir(root), id).toEqual(["map"]);
      expect(await readdir(folder), id).toEqual(["map.json", "screens"]);
    }
  });

  it("exports the comments as the skill's plain text, with the preamble, route, absolute crop and screen paths, and the recapture warning", async () => {
    const folder = await buildDemoMapFolder();
    await openFolder(folder);

    const none = await fromPage("GET", "/__flowmap/export");
    await seedAnnotations(folder, { "a1-home": 1, "a2-detail": 1, "a3-orphan": 1, gone: 1 }, [
      stored("a2-detail-01", "a2-detail", "Make the button bigger", { rect: { x: 0.125, y: 0.25, w: 0.5, h: 0.1 } }),
      stored("a3-orphan-01", "a3-orphan", "Remove this", { rect: { x: 0, y: 0, w: 1, h: 1 } }),
      stored("a1-home-01", "a1-home", "Check the spacing", { fingerprint: "old-fingerprint" }),
      stored("gone-01", "gone", "Where did it go?"),
    ]);
    const exported = await fromPage("GET", "/__flowmap/export");

    expect(none.status).toBe(200);
    expect(none.body.toString()).toBe("No annotations.\n");
    expect(exported.status).toBe(200);
    expect(exported.contentType).toBe("text/markdown; charset=utf-8");
    const expected = [
      "The user marked areas on screenshots of a flow map and left a comment on each one: treat each comment as the request. " +
        "Open the crop with Read; the full screenshot and the route are context, so work on the marked area, not the whole screen. " +
        "If the screenshots are of another app (a competitor or a reference), they are references, not code to edit.",
      "",
      "# Annotations: Demo map",
      `Map: \`${folder}\``,
      "App: Demo app",
      "",
      "## 1. Detail (a2-detail) · flow Main",
      "Route: Home → [tap «Open»] → Detail",
      `Full screen: \`${folder}/screens/a2-detail.png\``,
      `Crop: \`${folder}/temp/a2-detail-01.png\` (area x 12%, y 25%, width 50%, height 10%)`,
      "Comment: Make the button bigger",
      "",
      "## 2. Orphan (a3-orphan) · flow Main",
      "Route: no route recorded from the entry",
      `Full screen: \`${folder}/screens/a3-orphan.png\``,
      `Crop: \`${folder}/temp/a3-orphan-01.png\` (area x 0%, y 0%, width 100%, height 100%)`,
      "Comment: Remove this",
      "",
      "## 3. Home (a1-home) · flow Main",
      "Route: Home",
      `Full screen: \`${folder}/screens/a1-home.png\``,
      `Crop: \`${folder}/temp/a1-home-01.png\` (area x 10%, y 20%, width 30%, height 40%)`,
      "Comment: Check the spacing",
      "Warning: the screen was recaptured after this annotation; the area may have moved.",
      "",
      "## 4. gone (this screen no longer exists in the map)",
      "Comment: Where did it go?",
      "",
    ].join("\n");
    expect(exported.body.toString()).toBe(expected);
  });

  it("refuses to change comments without the X-Flowmap header, from another origin or from a foreign Host, and writes nothing; also refuses reads from a foreign Host and answers 404 when no map is open", async () => {
    const noMapList = await send("GET", "/__flowmap/annotations");
    const noMapCreate = await fromPage("POST", "/__flowmap/annotations", {});
    const folder = await buildDemoMapFolder();
    await seedAnnotations(folder, { "a1-home": 1 }, [stored("a1-home-01", "a1-home", "Keep me")]);
    await openFolder(folder);
    const before = { store: await readStore(folder), files: await tempFiles(folder) };

    const changes: [string, string, unknown][] = [
      ["POST", "/__flowmap/annotations", { screen: "a2-detail", rect: { x: 0, y: 0, w: 1, h: 1 }, comment: "Evil", png: RED_PNG_URL }],
      ["PATCH", "/__flowmap/annotations/a1-home-01", { comment: "Hacked" }],
      ["DELETE", "/__flowmap/annotations/a1-home-01", undefined],
      ["DELETE", "/__flowmap/annotations?screen=a1-home", undefined],
    ];
    const forgeries: Record<string, Record<string, string>> = {
      "without X-Flowmap": {},
      "from another origin": { "X-Flowmap": "1", Origin: "http://evil.example" },
      "from a foreign Host": { "X-Flowmap": "1", Host: "evil.example" },
    };
    for (const [method, path, body] of changes) {
      for (const [how, headers] of Object.entries(forgeries)) {
        const reply = await send(method, path, {
          headers: { "Content-Type": "application/json", ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        expect(reply.status, `${method} ${path} ${how}`).toBe(403);
      }
    }
    const foreignRead = await send("GET", "/__flowmap/annotations", { headers: { Host: "evil.example" } });

    expect(noMapList.status).toBe(404);
    expect(typeof (json(noMapList) as { error: unknown }).error).toBe("string");
    expect(noMapCreate.status).toBe(404);
    expect(foreignRead.status).toBe(403);
    expect(await readStore(folder)).toBe(before.store);
    expect(await tempFiles(folder)).toEqual(before.files);
  });
});
