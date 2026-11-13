import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.ts";
import { PNG_SIGNATURE } from "../src/png.ts";
import { checkoutMap, screenOf } from "./map-fixtures.ts";
import { createFixtures, textClient, waitFor } from "./support.ts";

type Server = Awaited<ReturnType<typeof createServer>>;

const ffmpegInstalled = spawnSync("ffmpeg", ["-version"]).status === 0;
const MISSING_FFMPEG = "/nonexistent/flow-map-test/ffmpeg";

let server: Server | undefined;
const fixtures = createFixtures();
const { send, fromPage } = textClient(() => server!.port);

afterEach(async () => {
  await server?.close();
  server = undefined;
  await fixtures.removeTempDirs();
});

/** A solid-colour PNG of the given size: the captures of a real map are bigger than the 1x1 shared fixture and differ from screen to screen. */
function solidPng(width: number, height: number, [red, green, blue]: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8 bits, RGB, no interlace
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [red, green, blue]).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const CAPTURES: Record<string, { size: [number, number]; colour: [number, number, number] }> = {
  a: { size: [320, 200], colour: [200, 60, 60] },
  b: { size: [200, 300], colour: [60, 200, 60] },
  c: { size: [400, 240], colour: [60, 60, 200] },
  d: { size: [320, 200], colour: [200, 200, 60] },
  e: { size: [320, 200], colour: [60, 200, 200] },
};

/**
 * Screens a, b, c with edges a -> b -> c (each with the zone tapped) and a back edge c -> a, a distractor d reached from a
 * and a screen e that no edge leads to. Every screen has a real capture of its own size. The map folder is a real path.
 */
async function buildRouteMap() {
  const screens = Object.keys(CAPTURES).map((id) => screenOf(id, { width: CAPTURES[id]!.size[0], height: CAPTURES[id]!.size[1] }));
  const map = checkoutMap({
    entry: "a",
    screens,
    edges: [
      { from: "a", to: "b", action: "tap «Open»", at: { x: 0.1, y: 0.2, w: 0.3, h: 0.2 } },
      { from: "b", to: "c", action: "tap «Add»", at: { x: 0.5, y: 0.6, w: 0.4, h: 0.1 } },
      { from: "c", to: "a", action: "tap «Back»", at: { x: 0, y: 0, w: 0.2, h: 0.1 } },
      { from: "a", to: "d", action: "tap «Help»", at: { x: 0.7, y: 0.7, w: 0.2, h: 0.2 } },
    ],
  });
  const folder = await fixtures.buildMapFolder(map, { png: false, real: true });
  await mkdir(join(folder, "screens"));
  for (const [id, { size, colour }] of Object.entries(CAPTURES)) await writeFile(join(folder, "screens", `${id}.png`), solidPng(...size, colour));
  return folder;
}

async function openMap(folder: string) {
  const opened = await send("POST", "/__flowmap-app/open", {
    headers: { "X-Flowmap": "1", "Content-Type": "application/json" },
    body: JSON.stringify({ path: folder }),
  });
  expect(opened.status).toBe(200);
}

const exportRoute = (body: unknown) => fromPage("POST", "/__flowmap-app/export-route", body);
const json = (reply: { body: string }) => JSON.parse(reply.body);

/** The files under `<folder>/exports`, or none when the folder was never made. */
async function exported(folder: string): Promise<string[]> {
  return readdir(join(folder, "exports")).catch(() => []);
}

describe("the walkthrough video of a route", () => {
  it.skipIf(!ffmpegInstalled)("is an MP4 of the shortest route from the entry, written in the map's exports folder and answered with its path", async () => {
    server = await createServer({ port: 0 });
    const folder = await buildRouteMap();
    await openMap(folder);

    const reply = await exportRoute({ to: "c" });

    expect(reply.status, reply.body).toBe(200);
    const { path, screens, seconds } = json(reply);
    expect(screens).toEqual(["a", "b", "c"]);
    expect(path).toBe(join(folder, "exports", "route-a-to-c.mp4"));
    expect(seconds).toBeGreaterThan(0);
    const video = await readFile(path);
    expect(video.subarray(4, 8).toString("latin1")).toBe("ftyp");
    expect((await stat(path)).size).toBeGreaterThan(1000);
  }, 60_000);

  it("stops ffmpeg and removes its partial file when the app closes in the middle of an export", async () => {
    const bin = await fixtures.makeTempDir("flow-map-fake-ffmpeg-", { real: true });
    const pidFile = join(bin, "pid");
    const fakeFfmpeg = join(bin, "ffmpeg");
    // Like ffmpeg: it starts writing its output (the last argument), then keeps running. `exec` makes the pid the sleeper's own.
    await writeFile(fakeFfmpeg, `#!/bin/sh\nfor last; do :; done\n: > "$last"\necho $$ > "${pidFile}"\nexec sleep 60\n`);
    await chmod(fakeFfmpeg, 0o755);
    server = await createServer({ port: 0, ffmpegBin: fakeFfmpeg });
    const folder = await buildRouteMap();
    await openMap(folder);
    let pid: number | undefined;
    const alive = () => {
      try {
        process.kill(pid!, 0);
        return true;
      } catch {
        return false;
      }
    };

    try {
      const pending = exportRoute({ to: "c" }).then(
        (reply) => reply.status,
        () => "connection ended",
      );
      await waitFor(() => readFile(pidFile, "utf8").then((text) => text.trim() !== "", () => false), "the fake ffmpeg to start");
      pid = Number((await readFile(pidFile, "utf8")).trim());
      expect(await exported(folder), "ffmpeg has started its partial file").toEqual([expect.stringMatching(/\.part$/)]);

      const closing = server.close();
      server = undefined;
      const closed = await Promise.race([closing.then(() => "closed"), new Promise((done) => setTimeout(() => done("hung"), 5000))]);
      const settled = await Promise.race([pending, new Promise((done) => setTimeout(() => done("dangling"), 5000))]);
      for (let waited = 0; waited < 2000 && alive(); waited += 50) await new Promise((done) => setTimeout(done, 50));

      expect(closed, "close does not hang").toBe("closed");
      expect(alive(), "the fake ffmpeg is gone").toBe(false);
      expect(await exported(folder), "no partial file is left in exports").toEqual([]);
      expect(settled, "the pending export settles").not.toBe(200);
      expect(settled).not.toBe("dangling");
    } finally {
      if (pid !== undefined && alive()) process.kill(pid, "SIGKILL");
    }
  }, 20_000);

  it("refuses what it cannot route, and writes nothing", async () => {
    server = await createServer({ port: 0 });
    const folder = await buildRouteMap();
    const noMapOpen = await exportRoute({ to: "c" });
    await openMap(folder);

    const cases: { name: string; reply: { status: number; body: string }; status: number; error?: string | RegExp }[] = [
      { name: "unknown target", reply: await exportRoute({ to: "zzz" }), status: 400, error: /The map has no screen "zzz"/ },
      { name: "from equals to", reply: await exportRoute({ from: "b", to: "b" }), status: 400 },
      { name: "no route", reply: await exportRoute({ to: "e" }), status: 404, error: "There is no route from a to e." },
      { name: "no X-Flowmap header", reply: await send("POST", "/__flowmap-app/export-route", { body: JSON.stringify({ to: "c" }) }), status: 403 },
      { name: "another origin", reply: await fromPage("POST", "/__flowmap-app/export-route", { to: "c" }, { Origin: "http://evil.example" }), status: 403 },
    ];

    expect(noMapOpen.status, "no map open").toBe(404);
    expect(noMapOpen.body).toBe(JSON.stringify({ error: "no map is open" }));
    for (const { name, reply, status, error } of cases) {
      expect(reply.status, `${name}: ${reply.body}`).toBe(status);
      if (error !== undefined) expect(json(reply).error, name).toMatch(error);
    }
    expect(await exported(folder), "nothing is written").toEqual([]);
  });

  it("answers 409 telling to install ffmpeg when the command does not exist, and writes no export", async () => {
    server = await createServer({ port: 0, ffmpegBin: MISSING_FFMPEG });
    const folder = await buildRouteMap();
    await openMap(folder);

    const reply = await exportRoute({ to: "c" });

    expect(reply.status, reply.body).toBe(409);
    expect(json(reply)).toEqual({ error: expect.stringContaining("ffmpeg") });
    expect(await exported(folder)).toEqual([]);
  });

  it("is refused with 400, writing nothing outside the map folder, when exports is a symlink", async () => {
    server = await createServer({ port: 0, ffmpegBin: MISSING_FFMPEG });
    const folder = await buildRouteMap();
    const outside = await fixtures.makeTempDir("flow-map-outside-", { real: true });
    await symlink(outside, join(folder, "exports"));
    await openMap(folder);

    const reply = await exportRoute({ to: "c" });

    expect(reply.status, reply.body).toBe(400);
    expect(json(reply)).toEqual({ error: expect.any(String) });
    expect(await readdir(outside), "the folder outside the map stays empty").toEqual([]);
  });

  it.skipIf(!ffmpegInstalled)("replaces a symlink planted at the output name instead of writing through it", async () => {
    server = await createServer({ port: 0 });
    const folder = await buildRouteMap();
    const outside = await fixtures.makeTempDir("flow-map-outside-", { real: true });
    const victim = join(outside, "precious.txt");
    const untouched = Buffer.from("do not touch");
    await writeFile(victim, untouched);
    await mkdir(join(folder, "exports"));
    const finalName = join(folder, "exports", "route-a-to-b.mp4");
    await symlink(victim, finalName);
    await openMap(folder);

    const reply = await exportRoute({ from: "a", to: "b" });

    expect(reply.status, reply.body).toBe(200);
    expect((await readFile(victim)).equals(untouched), "the file the link pointed at keeps its bytes").toBe(true);
    expect((await lstat(finalName)).isFile(), "the output name is now a regular file, not the link").toBe(true);
    expect((await readFile(finalName)).subarray(4, 8).toString("latin1")).toBe("ftyp");
    expect(await exported(folder), "no temporary file is left").toEqual(["route-a-to-b.mp4"]);
  }, 60_000);

  it("refuses a route of more than 30 screens before running ffmpeg, and accepts one of exactly 30", async () => {
    server = await createServer({ port: 0, ffmpegBin: MISSING_FFMPEG });
    const ids = Array.from({ length: 31 }, (_, index) => `s${index}`);
    const folder = await fixtures.buildMapFolder(
      checkoutMap({
        entry: "s0",
        screens: ids.map((id) => screenOf(id)),
        edges: ids.slice(1).map((to, index) => ({ from: ids[index]!, to, action: "tap «Next»" })),
      }),
    );
    await openMap(folder);

    const cases = [
      { name: "31 screens", to: "s30", status: 400, error: /30/ },
      { name: "30 screens (past the cap, ffmpeg is then missing)", to: "s29", status: 409, error: /ffmpeg/ },
    ];
    for (const { name, to, status, error } of cases) {
      const reply = await exportRoute({ to });
      expect(reply.status, `${name}: ${reply.body}`).toBe(status);
      expect(json(reply).error, name).toMatch(error);
    }
  });

  it.skipIf(!ffmpegInstalled)("falls back to the default video size when a screen's width is not a finite number", async () => {
    server = await createServer({ port: 0 });
    const folder = await buildRouteMap();
    const mapText = await readFile(join(folder, "map.json"), "utf8");
    expect(mapText).toContain('"width":320'); // screen a, the first of the route
    await writeFile(join(folder, "map.json"), mapText.replace('"width":320', '"width":1e999'));
    await openMap(folder);

    const reply = await exportRoute({ from: "a", to: "b" });

    expect(reply.status, reply.body).toBe(200);
    expect((await readFile(json(reply).path)).subarray(4, 8).toString("latin1")).toBe("ftyp");
  }, 60_000);
});
