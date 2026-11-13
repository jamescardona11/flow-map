import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.ts";
import { binaryClient, type BinaryReply, PNG } from "./support.ts";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

type Server = Awaited<ReturnType<typeof createServer>>;
type ScreenSpec = { id: string; title?: string; capturedAt?: string; history?: string[] };

let server: Server | undefined;
let tempDirs: string[] = [];
const { send } = binaryClient(() => server!.port);

afterEach(async () => {
  await server?.close();
  server = undefined;
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

const get = (path: string, headers?: Record<string, string>) => send("GET", path, { headers });
const json = (reply: BinaryReply) => JSON.parse(reply.body.toString());

async function openMap(folder: string) {
  const opened = await send("POST", "/__flowmap-app/open", {
    headers: { "X-Flowmap": "1", "Content-Type": "application/json" },
    body: JSON.stringify({ path: folder }),
  });
  expect(opened.status).toBe(200);
}

/**
 * A map at `<root>/map` (root is a real path: macOS temp dirs are symlinks) and a file outside it, `<root>/outside.png`.
 * Each screen has its capture in screens/ and, when `history` is given, those file names in history/<id>/.
 */
async function buildMap(screens: ScreenSpec[]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flow-map-history-")));
  tempDirs.push(root);
  const folder = join(root, "map");
  await mkdir(join(folder, "screens"), { recursive: true });
  await writeFile(join(root, "outside.png"), PNG);
  for (const { id, history } of screens) {
    await writeFile(join(folder, "screens", `${id}.png`), PNG);
    if (!history) continue;
    await mkdir(join(folder, "history", id), { recursive: true });
    for (const name of history) await writeFile(join(folder, "history", id, name), /\.jpe?g$/i.test(name) ? JPEG : PNG);
  }
  const map = {
    version: 1,
    title: "History flow",
    platform: "web",
    entry: screens[0]!.id,
    flows: [{ id: "main", title: "Main", color: "#5aa9e6" }],
    screens: screens.map(({ id, title, capturedAt }) => ({
      id,
      title: title ?? id,
      flow: "main",
      description: "",
      image: `screens/${id}.png`,
      width: 1,
      height: 1,
      status: "ok",
      fingerprint: `fp-${id}`,
      ...(capturedAt === undefined ? {} : { capturedAt }),
    })),
    edges: [],
    frontier: [],
  };
  await writeFile(join(folder, "map.json"), JSON.stringify(map));
  return { root, folder };
}

describe("the history of a screen", () => {
  it("is answered newest first starting with the current capture, lists only valid real files inside the map folder, serves each listed image, and is refused with a JSON error for a missing or unknown screen, no map open or a foreign Host", async () => {
    server = await createServer({ port: 0 });
    const { root, folder } = await buildMap([
      {
        id: "a1-home",
        capturedAt: "2026-10-29T12:23:17+00:00",
        history: [
          "20261101T090000Z.png",
          "20261102T080000Z.JPG",
          "20261103T101500Z.png",
          "20261103T101500Z-2.png",
          "20261103T101500Z-9.png",
          "20261103T101500Z-10.png",
          "20261104T070000Z.jpeg",
          // not versions: other extensions, malformed names and a directory
          "notes.txt",
          "20261101T090000Z.webp",
          "2026110T09000Z.png",
        ],
      },
      { id: "a2-plain", capturedAt: "2026-10-30T08:00:00Z" },
      { id: "a3-nodate", history: ["20261101T090000Z.png"] },
      { id: "a4-unreadable", capturedAt: "yesterday" },
    ]);
    await mkdir(join(folder, "history", "a1-home", "20261105T000000Z.png"));
    await writeFile(join(folder, "history", "a1-home", "20261105T000000Z.png", "20261105T000001Z.png"), PNG);
    await symlink(join(root, "outside.png"), join(folder, "history", "a1-home", "20261106T000000Z.png"));
    await writeFile(join(folder, "history", "a2-plain.png"), PNG); // the old single "before": not a version
    const history = (query: string, headers?: Record<string, string>) => get(`/__flowmap-app/history${query}`, headers);
    const noMapOpen = await history("?screen=a1-home");

    await openMap(folder);
    const home = await history("?screen=a1-home");
    const plain = await history("?screen=a2-plain");
    const noDate = await history("?screen=a3-nodate");
    const unreadable = await history("?screen=a4-unreadable");
    const refused: { name: string; reply: BinaryReply }[] = [
      { name: "unknown screen", reply: await history("?screen=nope") },
      { name: "no screen given", reply: await history("") },
    ];
    const foreignHost = await history("?screen=a1-home", { Host: "evil.example" });

    expect(noMapOpen.status, "no map open").toBe(404);
    expect(json(noMapOpen)).toEqual({ error: expect.any(String) });
    for (const { name, reply } of refused) {
      expect(reply.status, name).toBe(400);
      expect(json(reply), name).toEqual({ error: expect.any(String) });
    }
    expect(foreignHost.status, "foreign Host").toBe(403);

    const version = (name: string, capturedAt: string) => ({ capturedAt, image: `history/a1-home/${name}`, current: false });
    expect(home.status).toBe(200);
    expect(json(home)).toEqual({
      versions: [
        { capturedAt: "2026-10-29T12:23:17Z", image: "screens/a1-home.png", current: true },
        version("20261104T070000Z.jpeg", "2026-11-04T07:00:00Z"),
        version("20261103T101500Z-10.png", "2026-11-03T10:15:00Z"),
        version("20261103T101500Z-9.png", "2026-11-03T10:15:00Z"),
        version("20261103T101500Z-2.png", "2026-11-03T10:15:00Z"),
        version("20261103T101500Z.png", "2026-11-03T10:15:00Z"),
        version("20261102T080000Z.JPG", "2026-11-02T08:00:00Z"),
        version("20261101T090000Z.png", "2026-11-01T09:00:00Z"),
      ],
    });
    expect(json(plain), "a screen without a history folder").toEqual({
      versions: [{ capturedAt: "2026-10-30T08:00:00Z", image: "screens/a2-plain.png", current: true }],
    });
    expect(json(noDate), "current without a date, then its own history only").toEqual({
      versions: [
        { capturedAt: null, image: "screens/a3-nodate.png", current: true },
        { capturedAt: "2026-11-01T09:00:00Z", image: "history/a3-nodate/20261101T090000Z.png", current: false },
      ],
    });
    expect(json(unreadable).versions[0], "a date that cannot be read").toEqual({
      capturedAt: null,
      image: "screens/a4-unreadable.png",
      current: true,
    });

    const served: { path: string; bytes: Buffer; type: string }[] = [
      { path: "/history/a1-home/20261104T070000Z.jpeg", bytes: JPEG, type: "image/jpeg" },
      { path: "/history/a1-home/20261102T080000Z.JPG", bytes: JPEG, type: "image/jpeg" },
      { path: "/history/a1-home/20261103T101500Z-10.png", bytes: PNG, type: "image/png" },
    ];
    for (const { path, bytes, type } of served) {
      const reply = await get(path);
      expect(reply.status, path).toBe(200);
      expect(reply.headers["content-type"], path).toBe(type);
      expect(reply.body.equals(bytes), path).toBe(true);
    }
    for (const path of [
      "/history/a1-home/20261231T000000Z.png",
      "/history/a1-home/..%2F..%2Fmap.json",
      "/history/a1-home/20261106T000000Z.png",
    ]) {
      const reply = await get(path);
      expect(reply.status, path).toBe(404);
      expect(reply.body.toString(), path).not.toContain("History flow");
    }
  });
});

describe("the changes of a map", () => {
  it("are answered newest first with every current capture and history file, dates in UTC, undated entries last in map order and at most 200, and are refused with no map open or a foreign Host", async () => {
    server = await createServer({ port: 0 });
    const first = await buildMap([
      { id: "s1", title: "Home", capturedAt: "2026-11-02T10:00:00+02:00", history: ["20261101T090000Z.png", "20261103T120000Z.png"] },
      { id: "s2", title: "Detail", capturedAt: "2026-11-05T09:30:00.123Z", history: ["20261104T000000Z.png", "20261030T000000Z.jpg"] },
      { id: "s3", title: "Settings", history: ["20261031T235959Z.png"] },
      { id: "s4", title: "Broken date", capturedAt: "yesterday" },
    ]);
    const second = await buildMap([
      {
        id: "only",
        title: "Only",
        capturedAt: "2026-12-31T00:00:00Z",
        // 201 versions, one second apart from 2026-11-01T00:00:00Z
        history: Array.from({ length: 201 }, (_, i) => `20261101T00${String(Math.floor(i / 60)).padStart(2, "0")}${String(i % 60).padStart(2, "0")}Z.png`),
      },
    ]);
    const changes = (headers?: Record<string, string>) => get("/__flowmap-app/changes", headers);
    const noMapOpen = await changes();

    await openMap(first.folder);
    const small = await changes();
    const foreignHost = await changes({ Host: "evil.example" });
    await openMap(second.folder);
    const capped = await changes();

    expect(noMapOpen.status, "no map open").toBe(404);
    expect(json(noMapOpen)).toEqual({ error: expect.any(String) });
    expect(foreignHost.status, "foreign Host").toBe(403);

    expect(small.status).toBe(200);
    expect(json(small)).toEqual({
      events: [
        { screen: "s2", title: "Detail", capturedAt: "2026-11-05T09:30:00Z", image: "screens/s2.png", current: true },
        { screen: "s2", title: "Detail", capturedAt: "2026-11-04T00:00:00Z", image: "history/s2/20261104T000000Z.png", current: false },
        { screen: "s1", title: "Home", capturedAt: "2026-11-03T12:00:00Z", image: "history/s1/20261103T120000Z.png", current: false },
        { screen: "s1", title: "Home", capturedAt: "2026-11-02T08:00:00Z", image: "screens/s1.png", current: true },
        { screen: "s1", title: "Home", capturedAt: "2026-11-01T09:00:00Z", image: "history/s1/20261101T090000Z.png", current: false },
        { screen: "s3", title: "Settings", capturedAt: "2026-10-31T23:59:59Z", image: "history/s3/20261031T235959Z.png", current: false },
        { screen: "s2", title: "Detail", capturedAt: "2026-10-30T00:00:00Z", image: "history/s2/20261030T000000Z.jpg", current: false },
        { screen: "s3", title: "Settings", capturedAt: null, image: "screens/s3.png", current: true },
        { screen: "s4", title: "Broken date", capturedAt: null, image: "screens/s4.png", current: true },
      ],
    });

    const { events } = json(capped) as { events: { capturedAt: string; current: boolean }[] };
    expect(capped.status).toBe(200);
    expect(events).toHaveLength(200);
    expect(events[0]).toMatchObject({ capturedAt: "2026-12-31T00:00:00Z", current: true });
    expect(events[1]).toMatchObject({ capturedAt: "2026-11-01T00:03:20Z", current: false });
    expect(events[199]).toMatchObject({ capturedAt: "2026-11-01T00:00:02Z", current: false });
  });
});
