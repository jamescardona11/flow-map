import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { createFakeClaude, type FakeClaude, type FakeClaudeBehavior } from "./fake-claude.ts";
import { checkoutMap, type MapData } from "./map-fixtures.ts";

export const TOKEN = "SECRET-TOKEN-123";
/** A 1x1 PNG. */
export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);

/** True when something (a file, a folder or a link, even a dangling one) is at `path`. */
export const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

export type TextReply = { status: number; body: string; headers: http.IncomingHttpHeaders };
export type BinaryReply = { status: number; body: Buffer; headers: http.IncomingHttpHeaders; contentType: string | undefined };

type SendOptions = { headers?: Record<string, string>; body?: string };
type RawReply = { status: number; body: Buffer; headers: http.IncomingHttpHeaders };

function makeClient<Reply>(getPort: () => number, toReply: (raw: RawReply) => Reply) {
  // node:http instead of fetch: fetch normalises `..` segments and cannot set the Host or Origin headers
  function send(method: string, path: string, options: SendOptions = {}): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const request = http.request({ host: "127.0.0.1", port: getPort(), method, path, headers: options.headers }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve(toReply({ status: response.statusCode ?? 0, body: Buffer.concat(chunks), headers: response.headers })));
      });
      request.on("error", reject);
      request.end(options.body);
    });
  }

  /** A request the way the viewer page sends it: with the X-Flowmap header and its own origin. `headers` adds to or replaces those. */
  function fromPage(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
    return send(method, path, {
      headers: { "X-Flowmap": "1", Origin: `http://127.0.0.1:${getPort()}`, "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  return { send, fromPage };
}

/** HTTP calls to the app on `getPort()`, answered with the body as text. */
export const textClient = (getPort: () => number) =>
  makeClient<TextReply>(getPort, ({ status, body, headers }) => ({ status, body: body.toString(), headers }));

/** HTTP calls to the app on `getPort()`, answered with the body as bytes. */
export const binaryClient = (getPort: () => number) =>
  makeClient<BinaryReply>(getPort, ({ status, body, headers }) => ({ status, body, headers, contentType: headers["content-type"] }));

/** Polls until `condition` holds, for about 6 s, then fails the test naming what it was waiting for. */
export async function waitFor(condition: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 300; i++) {
    if (await condition()) return;
    await new Promise((done) => setTimeout(done, 20));
  }
  expect.fail(`timed out waiting for ${what}`);
}

export const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Polls for up to `timeoutMs` and answers whether `condition` held: for "does not happen" checks, where `waitFor` would fail instead. */
export async function until(condition: () => boolean, timeoutMs = 2000): Promise<boolean> {
  for (let waited = 0; waited < timeoutMs; waited += 10) {
    if (condition()) return true;
    await pause(10);
  }
  return condition();
}

/**
 * Where the app keeps the link of a map folder: `<dataDir>/sessions/<key>.json`, the key being the first 32 hex
 * characters of the sha256 of the folder's real path (macOS temp dirs are symlinks, so the path is resolved first).
 */
export async function linkFilePath(dataDir: string, folder: string): Promise<string> {
  const key = createHash("sha256")
    .update(await realpath(folder))
    .digest("hex")
    .slice(0, 32);
  return join(dataDir, "sessions", `${key}.json`);
}

/** Writes `content` as is where the app looks for the link of `folder`: for the broken and incomplete links. */
export async function writeLinkFile(dataDir: string, folder: string, content: string) {
  await mkdir(join(dataDir, "sessions"), { recursive: true, mode: 0o700 });
  await writeFile(await linkFilePath(dataDir, folder), content, { mode: 0o600 });
}

/** Writes the session link `flow-map link <folder>` leaves in the app's data dir. */
export function linkTo(dataDir: string, folder: string, socket: string) {
  return writeLinkFile(dataDir, folder, JSON.stringify({ version: 1, socket, token: TOKEN, linkedAt: "2026-11-05T10:00:00.000Z" }));
}

/** Removes the link of `folder`, as if it had never been linked. */
export async function unlink(dataDir: string, folder: string) {
  await rm(await linkFilePath(dataDir, folder));
}

export type FakeSession = { socket: string; dir: string; messages: string[]; connections: () => number };

/**
 * The temp dirs and fake servers one suite creates. Each suite makes its own and cleans it up in its own `afterEach`,
 * in the order its server needs: `closeFakes()` first or last, and `removeTempDirs()` at the end.
 */
export function createFixtures() {
  let tempDirs: string[] = [];
  let closers: (() => Promise<void>)[] = [];

  /** Registers a directory the suite made itself, so `removeTempDirs()` deletes it. */
  function track(dir: string): string {
    tempDirs.push(dir);
    return dir;
  }

  /** A new temp dir. `real` resolves symlinks (macOS temp dirs are symlinks, and some checks compare real paths). */
  async function makeTempDir(prefix = "flow-map-test-", { real = false } = {}): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    return track(real ? await realpath(dir) : dir);
  }

  /** A Claude Code session stand-in: a Unix socket (short path, macOS limits them to ~104 bytes) that keeps what it is sent. */
  async function startFakeSession(): Promise<FakeSession> {
    const dir = track(await mkdtemp(join("/tmp", "fm-")));
    const socket = join(dir, "s.sock");
    const messages: string[] = [];
    const open = new Set<net.Socket>();
    let connections = 0;
    const listener = net.createServer((connection) => {
      connections += 1;
      open.add(connection);
      let received = "";
      connection.setEncoding("utf8");
      connection.on("data", (chunk: string) => (received += chunk));
      connection.on("close", () => {
        open.delete(connection);
        messages.push(received);
      });
    });
    await new Promise<void>((done) => listener.listen(socket, done));
    closers.push(
      () =>
        new Promise<void>((done) => {
          open.forEach((connection) => connection.destroy());
          listener.close(() => done());
        }),
    );
    return { socket, dir, messages, connections: () => connections };
  }

  async function startFakeClaude(behavior: FakeClaudeBehavior = { mode: "success" }): Promise<FakeClaude> {
    const fake = await createFakeClaude(behavior);
    closers.push(fake.cleanup);
    return fake;
  }

  /**
   * Writes `map` as map.json in a new temp dir, plus a `screens/<id>.png` (`png`, 1x1 by default) for each of its screens.
   * With `png: false` the folder has no screens/ at all.
   */
  async function buildMapFolder(map: MapData = checkoutMap(), { png = PNG, real = false }: { png?: Buffer | false; real?: boolean } = {}): Promise<string> {
    const folder = await makeTempDir("flow-map-test-", { real });
    if (png) {
      await mkdir(join(folder, "screens"));
      for (const { id } of map.screens) await writeFile(join(folder, "screens", `${id}.png`), png);
    }
    await writeFile(join(folder, "map.json"), JSON.stringify(map));
    return folder;
  }

  /** Releases held fake CLIs and kills what is left, and closes the fake sessions. */
  async function closeFakes() {
    await Promise.all(closers.map((close) => close()));
    closers = [];
  }

  async function removeTempDirs() {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs = [];
  }

  return { track, makeTempDir, startFakeSession, startFakeClaude, buildMapFolder, closeFakes, removeTempDirs };
}
