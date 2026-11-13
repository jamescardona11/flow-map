import { chmod, lstat, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.ts";
import { homeOnlyMap } from "./map-fixtures.ts";
import { createFixtures, exists, linkFilePath } from "./support.ts";

type Server = Awaited<ReturnType<typeof createServer>>;

const fixtures = createFixtures();
const { makeTempDir, buildMapFolder } = fixtures;
let servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close().catch(() => undefined)));
  await fixtures.removeTempDirs();
  servers = [];
});

async function startServer(dataDir: string): Promise<Server> {
  const server = await createServer({ port: 0, dataDir });
  servers.push(server);
  return server;
}

async function pageOf(server: Server): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${server.port}/`);
  return response.text();
}

describe("opening a map from the terminal", () => {
  it("writes app.json with its port and pid when it starts with a data directory, and removes it when it closes", async () => {
    const dataDir = await makeTempDir();
    const server = await startServer(dataDir);

    const announced = JSON.parse(await readFile(join(dataDir, "app.json"), "utf8"));
    expect(announced).toEqual({ port: server.port, pid: process.pid });

    await server.close();

    await expect(readFile(join(dataDir, "app.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("`open <folder>` opens that folder in the running app found through app.json, and asks the browser to show the app URL", async () => {
    const { runCli } = await import("../src/cli.ts");
    const dataDir = await makeTempDir();
    const running = await startServer(dataDir);
    const mapFolder = await buildMapFolder(homeOnlyMap("Checkout flow"));
    const opened: string[] = [];

    const exitCode = await runCli(["open", basename(mapFolder)], {
      dataDir,
      cwd: dirname(mapFolder),
      openBrowser: async (url) => void opened.push(url),
      startApp: async () => {
        throw new Error("the app is already running, it must not be started");
      },
      out: () => {},
      err: () => {},
    });

    expect(exitCode).toBe(0);
    expect(await pageOf(running)).toContain("Checkout flow");
    expect(opened).toEqual([`http://127.0.0.1:${running.port}/`]);
  });

  it.each([
    { case: "there is no app.json", leaveStaleFile: false },
    { case: "app.json points at an app that is gone", leaveStaleFile: true },
  ])("when no app answers ($case), `open <folder>` starts the app, waits for it, then opens the map in it", async ({ leaveStaleFile }) => {
    const { runCli } = await import("../src/cli.ts");
    const dataDir = await makeTempDir();
    const mapFolder = await buildMapFolder(homeOnlyMap("Onboarding flow"));
    if (leaveStaleFile) {
      const gone = await createServer({ port: 0 });
      const deadPort = gone.port;
      await gone.close();
      await writeFile(join(dataDir, "app.json"), JSON.stringify({ port: deadPort, pid: 2 ** 22 }));
    }
    const started: Server[] = [];
    const opened: string[] = [];

    const exitCode = await runCli(["open", mapFolder], {
      dataDir,
      cwd: tmpdir(),
      openBrowser: async (url) => void opened.push(url),
      startApp: async () => {
        started.push(await startServer(dataDir));
      },
      out: () => {},
      err: () => {},
    });

    expect(exitCode).toBe(0);
    expect(started).toHaveLength(1);
    expect(await pageOf(started[0]!)).toContain("Onboarding flow");
    expect(opened).toEqual([`http://127.0.0.1:${started[0]!.port}/`]);
  });
});

describe("linking a map to a Claude Code session from the terminal", () => {
  const SOCKET_VAR = "CLAUDE_CODE_MESSAGING_SOCKET";
  const TOKEN_VAR = "CLAUDE_CODE_MESSAGING_TOKEN";

  async function runLink(folder: string, env: Record<string, string | undefined>, dataDir?: string) {
    const { runCli } = await import("../src/cli.ts");
    const linkDataDir = dataDir ?? (await makeTempDir());
    const output: string[] = [];
    const exitCode = await runCli(["link", folder], {
      dataDir: linkDataDir,
      cwd: tmpdir(),
      env,
      openBrowser: async () => {},
      startApp: async () => {
        throw new Error("linking must not start the app");
      },
      out: (text) => void output.push(text),
      err: (text) => void output.push(text),
    });
    return { exitCode, output: output.join(""), dataDir: linkDataDir };
  }

  it("`link <folder>` writes the link file (mode 600) from the session variables, and linking again replaces the previous link", async () => {
    const folder = await buildMapFolder(homeOnlyMap("Linked map"));

    const first = await runLink(folder, { [SOCKET_VAR]: "/tmp/claude/first.sock", [TOKEN_VAR]: "TOKEN-FIRST" });

    expect(first.exitCode).toBe(0);
    expect(first.output).not.toContain("TOKEN-FIRST");
    const linkFile = await linkFilePath(first.dataDir, folder);
    expect(JSON.parse(await readFile(linkFile, "utf8"))).toEqual({
      version: 1,
      socket: "/tmp/claude/first.sock",
      token: "TOKEN-FIRST",
      linkedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/),
    });
    expect((await stat(linkFile)).mode & 0o777).toBe(0o600);

    const second = await runLink(folder, { [SOCKET_VAR]: "/tmp/claude/second.sock", [TOKEN_VAR]: "TOKEN-SECOND" }, first.dataDir);

    expect(second.exitCode).toBe(0);
    expect(JSON.parse(await readFile(linkFile, "utf8"))).toMatchObject({
      socket: "/tmp/claude/second.sock",
      token: "TOKEN-SECOND",
    });
    expect((await stat(linkFile)).mode & 0o777).toBe(0o600);
  });

  it("`link <folder>` keeps the link in the app's data dir, one private file named by 32 hex characters per folder, and writes nothing in the map folder", async () => {
    const folder = await buildMapFolder(homeOnlyMap("Linked map"), { real: true });
    await writeFile(join(folder, ".gitignore"), "node_modules\n");
    const before = (await readdir(folder)).sort();
    const sessionsDir = (dataDir: string) => join(dataDir, "sessions");

    const first = await runLink(folder, { [SOCKET_VAR]: "/tmp/claude/first.sock", [TOKEN_VAR]: "TOKEN-FIRST" });
    const [file, ...others] = await readdir(sessionsDir(first.dataDir));

    expect(others, "one file for the folder").toEqual([]);
    expect(file).toMatch(/^[0-9a-f]{32}\.json$/);
    expect((await stat(join(sessionsDir(first.dataDir), file!))).mode & 0o777).toBe(0o600);
    expect((await stat(sessionsDir(first.dataDir))).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(join(sessionsDir(first.dataDir), file!), "utf8"))).toMatchObject({
      socket: "/tmp/claude/first.sock",
      token: "TOKEN-FIRST",
    });
    expect((await readdir(folder)).sort(), "the map folder gets no session.json").toEqual(before);
    expect(await readFile(join(folder, ".gitignore"), "utf8"), "and its .gitignore is left alone").toBe("node_modules\n");

    await runLink(folder, { [SOCKET_VAR]: "/tmp/claude/second.sock", [TOKEN_VAR]: "TOKEN-SECOND" }, first.dataDir);
    const viaSymlink = join(await makeTempDir(), "shortcut");
    await symlink(folder, viaSymlink);
    await runLink(viaSymlink, { [SOCKET_VAR]: "/tmp/claude/third.sock", [TOKEN_VAR]: "TOKEN-THIRD" }, first.dataDir);

    expect(await readdir(sessionsDir(first.dataDir)), "linking again, even through a symlink, replaces the same file").toEqual([file]);
    expect(JSON.parse(await readFile(join(sessionsDir(first.dataDir), file!), "utf8"))).toMatchObject({
      socket: "/tmp/claude/third.sock",
      token: "TOKEN-THIRD",
    });
  });

  const legacyLink = JSON.stringify({ version: 1, socket: "/tmp/claude/old.sock", token: "OLD-TOKEN", linkedAt: "2026-11-05T10:00:00.000Z" });

  it.each([
    { case: "a link an earlier version left", content: legacyLink, deleted: true },
    { case: "JSON that is not a link", content: '{"hello":1}', deleted: false },
    { case: "a link without its token", content: JSON.stringify({ version: 1, socket: "/tmp/claude/old.sock" }), deleted: false },
    { case: "text that is not JSON", content: "{ not json", deleted: false },
  ])("deletes the session.json in a map folder when the app opens it and when `link` runs for it only if it is $case: it is a live token the worker could read", async ({ content, deleted }) => {
    const dataDir = await makeTempDir();
    const server = await startServer(dataDir);
    const openedFolder = await buildMapFolder(homeOnlyMap("Opened map"));
    const linkedFolder = await buildMapFolder(homeOnlyMap("Linked map"));
    for (const folder of [openedFolder, linkedFolder]) await writeFile(join(folder, "session.json"), content);

    const opened = await fetch(`http://127.0.0.1:${server.port}/__flowmap-app/open`, {
      method: "POST",
      headers: { "X-Flowmap": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ path: openedFolder }),
    });
    const linked = await runLink(linkedFolder, { [SOCKET_VAR]: "/tmp/claude/new.sock", [TOKEN_VAR]: "NEW-TOKEN" }, dataDir);

    expect(opened.status).toBe(200);
    expect(linked.exitCode).toBe(0);
    for (const folder of [openedFolder, linkedFolder]) {
      if (deleted) expect(await exists(join(folder, "session.json"))).toBe(false);
      else expect(await readFile(join(folder, "session.json"), "utf8")).toBe(content);
    }
  });

  async function openOnServer(server: Server, folder: string) {
    return fetch(`http://127.0.0.1:${server.port}/__flowmap-app/open`, {
      method: "POST",
      headers: { "X-Flowmap": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ path: folder }),
    });
  }

  it("leaves a session.json that is a symlink or bigger than 4 KB untouched when the app opens the map and when `link` runs, even if it holds a valid link", async () => {
    const dataDir = await makeTempDir();
    const server = await startServer(dataDir);
    const outside = join(await makeTempDir(), "elsewhere.json");
    await writeFile(outside, legacyLink);
    const oversized = `${legacyLink}${" ".repeat(64 * 1024)}`;
    const planted = { symlink: async (file: string) => symlink(outside, file), oversized: async (file: string) => writeFile(file, oversized) };
    const folders: { kind: keyof typeof planted; opened: string; linked: string }[] = [];
    for (const kind of Object.keys(planted) as (keyof typeof planted)[]) {
      const opened = await buildMapFolder(homeOnlyMap("Opened map"));
      const linked = await buildMapFolder(homeOnlyMap("Linked map"));
      for (const folder of [opened, linked]) await planted[kind](join(folder, "session.json"));
      folders.push({ kind, opened, linked });
    }

    for (const { kind, opened, linked } of folders) {
      expect((await openOnServer(server, opened)).status, kind).toBe(200);
      expect((await runLink(linked, { [SOCKET_VAR]: "/tmp/claude/new.sock", [TOKEN_VAR]: "NEW-TOKEN" }, dataDir)).exitCode, kind).toBe(0);
      for (const folder of [opened, linked]) {
        const left = await lstat(join(folder, "session.json")).catch(() => null);
        expect(left, `${kind}: session.json stays`).not.toBeNull();
        expect(left!.isSymbolicLink(), `${kind}: and is still what it was`).toBe(kind === "symlink");
      }
    }
  });

  it.skipIf(process.getuid?.() === 0)("answers a JSON error naming session.json when the app cannot delete a legacy link, and `link` exits 1 with the same advice", async () => {
    const dataDir = await makeTempDir();
    const server = await startServer(dataDir);
    const openedFolder = await buildMapFolder(homeOnlyMap("Opened map"));
    const linkedFolder = await buildMapFolder(homeOnlyMap("Linked map"));
    for (const folder of [openedFolder, linkedFolder]) {
      await writeFile(join(folder, "session.json"), legacyLink);
      await chmod(folder, 0o555);
    }

    try {
      const opened = await openOnServer(server, openedFolder);
      const linked = await runLink(linkedFolder, { [SOCKET_VAR]: "/tmp/claude/new.sock", [TOKEN_VAR]: "NEW-TOKEN" }, dataDir);

      expect(opened.status, "a refusal, not a bare 500").toBeGreaterThanOrEqual(400);
      expect(opened.status).toBeLessThan(500);
      expect(((await opened.json()) as { error: string }).error).toContain("session.json");
      expect(linked.exitCode).toBe(1);
      expect(linked.output).toContain("session.json");
      expect(linked.output).not.toContain("NEW-TOKEN");
    } finally {
      for (const folder of [openedFolder, linkedFolder]) await chmod(folder, 0o755);
    }
  });

  it.each([
    { case: "the socket variable is missing", env: { [TOKEN_VAR]: "TOKEN-X" }, folder: "map", message: SOCKET_VAR },
    { case: "the token variable is missing", env: { [SOCKET_VAR]: "/tmp/claude/x.sock" }, folder: "map", message: TOKEN_VAR },
    {
      case: "the folder has no map.json",
      env: { [SOCKET_VAR]: "/tmp/claude/x.sock", [TOKEN_VAR]: "TOKEN-X" },
      folder: "empty",
      message: "no map.json",
    },
    {
      case: "the map.json is broken",
      env: { [SOCKET_VAR]: "/tmp/claude/x.sock", [TOKEN_VAR]: "TOKEN-X" },
      folder: "broken",
      message: "not valid JSON",
    },
  ])("`link <folder>` exits 1 and writes nothing when $case, without printing the token", async ({ env, folder: kind, message }) => {
    const folder = kind === "map" ? await buildMapFolder(homeOnlyMap("Map")) : await makeTempDir();
    if (kind === "broken") await writeFile(join(folder, "map.json"), "{ not json");

    const { exitCode, output, dataDir } = await runLink(folder, env);

    expect(exitCode).toBe(1);
    expect(output).toContain(message);
    expect(output).not.toContain("TOKEN-X");
    expect(await readdir(dataDir), "nothing in the data dir either").toEqual([]);
    expect(await exists(join(folder, "session.json"))).toBe(false);
    expect(await exists(join(folder, ".gitignore"))).toBe(false);
  });
});
