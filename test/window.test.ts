import { readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.ts";
import { homeOnlyMap } from "./map-fixtures.ts";
import { createFixtures } from "./support.ts";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CLI_PATH = join(import.meta.dirname, "..", "src", "cli.ts");

type Server = Awaited<ReturnType<typeof createServer>>;

const fixtures = createFixtures();
const { makeTempDir, buildMapFolder } = fixtures;
let servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close().catch(() => undefined)));
  await fixtures.removeTempDirs();
  servers = [];
});

async function startServer(dataDir?: string): Promise<Server> {
  const server = await createServer({ port: 0, dataDir });
  servers.push(server);
  return server;
}

function plistValue(plist: string, key: string, valueTag: string): boolean {
  return new RegExp(`<key>${key}</key>\\s*${valueTag}`).test(plist);
}

function plistString(plist: string, key: string, value: string): boolean {
  return plistValue(plist, key, `<string>${value}</string>`);
}

function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

describe("launching Flow Map as an application", () => {
  it.skipIf(process.platform !== "darwin")(
    "`install-app --dir <folder>` writes Flow Map.app with its plist, an executable launcher and an icns icon, replaces an older bundle without stale files, and fails clearly when the folder cannot be created",
    async () => {
      const { runCli } = await import("../src/cli.ts");
      const parent = await makeTempDir();
      const folder = join(parent, "Designer's apps");
      const bundle = join(folder, "Flow Map.app");
      const output: string[] = [];
      const errors: string[] = [];
      const install = (target: string) =>
        runCli(["install-app", "--dir", target], {
          dataDir: parent,
          cwd: parent,
          openBrowser: async () => {
            throw new Error("installing must not open a browser");
          },
          startApp: async () => {
            throw new Error("installing must not start the app");
          },
          out: (text) => void output.push(text),
          err: (text) => void errors.push(text),
        });

      expect(await install(folder)).toBe(0);

      expect(output.join("")).toContain(bundle);
      const plist = await readFile(join(bundle, "Contents", "Info.plist"), "utf8");
      for (const [key, value] of [
        ["CFBundleName", "Flow Map"],
        ["CFBundleDisplayName", "Flow Map"],
        ["CFBundleIdentifier", "app.flowmap.desktop"],
        ["CFBundleExecutable", "flow-map"],
        ["CFBundleIconFile", "AppIcon"],
        ["CFBundlePackageType", "APPL"],
        ["CFBundleVersion", "1"],
        ["LSMinimumSystemVersion", "12.0"],
      ] as const) {
        expect(plistString(plist, key, value), key).toBe(true);
      }
      expect(plistValue(plist, "NSHighResolutionCapable", "<true\\s*/>")).toBe(true);

      const launcher = join(bundle, "Contents", "MacOS", "flow-map");
      const script = await readFile(launcher, "utf8");
      expect((await stat(launcher)).mode & 0o111).not.toBe(0);
      expect(script.startsWith("#!")).toBe(true);
      expect(script).toContain(shellQuote(process.execPath));
      expect(script).toContain(shellQuote(CLI_PATH));
      expect(script).toMatch(/\bapp\b/);

      const icon = await readFile(join(bundle, "Contents", "Resources", "AppIcon.icns"));
      expect(icon.subarray(0, 4).toString("latin1")).toBe("icns");

      const stale = join(bundle, "Contents", "stale.txt");
      await writeFile(stale, "left by an older install");
      expect(await install(folder)).toBe(0);
      await expect(stat(stale)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(launcher)).resolves.toBeDefined();

      const aFile = join(parent, "not-a-folder");
      await writeFile(aFile, "");
      errors.length = 0;
      expect(await install(join(aFile, "inside"))).toBe(1);
      expect(errors.join("").trim()).not.toBe("");
    },
    30_000,
  );

  it.each([
    {
      case: "Chrome and Brave are installed, with a folder to open first",
      installed: ["/Applications/Google Chrome.app", "/Applications/Brave Browser.app"],
      withFolder: true,
      window: "/Applications/Google Chrome.app",
    },
    {
      case: "only Vivaldi is installed",
      installed: ["/Applications/Vivaldi.app"],
      withFolder: false,
      window: "/Applications/Vivaldi.app",
    },
    { case: "no Chromium browser is installed", installed: [] as string[], withFolder: false, window: null },
  ])(
    "`app` finds the running app and opens its window in app mode with its own profile when $case, or falls back to the default browser with a one-line notice",
    async ({ installed, withFolder, window }) => {
      const { runCli } = await import("../src/cli.ts");
      const dataDir = await makeTempDir();
      const running = await startServer(dataDir);
      const mapFolder = await buildMapFolder(homeOnlyMap("Window flow"));
      const url = `http://127.0.0.1:${running.port}/`;
      const windows: string[][] = [];
      const browsers: string[] = [];
      const errors: string[] = [];

      const exitCode = await runCli(withFolder ? ["app", mapFolder] : ["app"], {
        dataDir,
        cwd: tmpdir(),
        appInstalled: (path: string) => installed.includes(path),
        openWindow: async (args: string[]) => void windows.push(args),
        openBrowser: async (target) => void browsers.push(target),
        startApp: async () => {
          throw new Error("the app is already running, it must not be started");
        },
        out: () => {},
        err: (text) => void errors.push(text),
      });

      expect(exitCode).toBe(0);
      if (window === null) {
        expect(windows).toEqual([]);
        expect(browsers).toEqual([url]);
        expect(errors.join("")).toMatch(/^[^\n]+\n$/);
      } else {
        expect(windows).toEqual([
          ["open", "-n", "-a", window, "--args", `--app=${url}`, `--user-data-dir=${join(dataDir, "window-profile")}`],
        ]);
        expect(browsers).toEqual([]);
        expect(errors).toEqual([]);
      }
      if (withFolder) expect(await (await fetch(url)).text()).toContain("Window flow");
    },
  );

  it("`flow-map` and `flow-map open` with no folder open the app in the default browser, never in an app window, `--no-browser` only prints the URL, and any other unknown argument prints a usage that lists the no-argument form and exits 1", async () => {
    const { runCli } = await import("../src/cli.ts");
    const dataDir = await makeTempDir();
    const running = await startServer(dataDir);
    const url = `http://127.0.0.1:${running.port}/`;
    const windows: string[][] = [];
    const browsers: string[] = [];
    const output: string[] = [];
    const errors: string[] = [];
    const run = (argv: string[]) => {
      windows.length = 0;
      browsers.length = 0;
      output.length = 0;
      return runCli(argv, {
        dataDir,
        cwd: tmpdir(),
        appInstalled: (path: string) => path === "/Applications/Vivaldi.app",
        openWindow: async (args: string[]) => void windows.push(args),
        openBrowser: async (target) => void browsers.push(target),
        startApp: async () => {
          throw new Error("the app is already running, it must not be started");
        },
        out: (text) => void output.push(text),
        err: (text) => void errors.push(text),
      });
    };

    for (const argv of [[], ["open"]]) {
      expect(await run(argv), argv.join(" ")).toBe(0);
      expect(windows).toEqual([]);
      expect(browsers).toEqual([url]);
      expect(output.join("")).toContain(`Opened the app at ${url}`);
      expect(errors).toEqual([]);
    }

    expect(await run(["open", "--no-browser"])).toBe(0);
    expect(browsers).toEqual([]);
    expect(windows).toEqual([]);
    expect(output.join("")).toContain(`Opened the app at ${url}`);

    expect(await run(["--frobnicate"])).toBe(1);
    expect(windows).toEqual([]);
    expect(browsers).toEqual([]);
    const usage = errors.join("");
    expect(usage).toContain("Usage");
    const noArgumentLine = usage.split("\n").find((line) => /^(Usage:)?\s*flow-map(?!\s+(open|app|install-app|link)\b)/.test(line));
    expect(noArgumentLine).toMatch(/browser/i);
  });

  it("serves /favicon.png as a 512x512 PNG and links it from the chooser, the notice page and the viewer", async () => {
    const server = await startServer();
    const base = `http://127.0.0.1:${server.port}`;
    const pageAt = async () => (await fetch(`${base}/`)).text();

    const favicon = await fetch(`${base}/favicon.png`);
    expect(favicon.status).toBe(200);
    expect(favicon.headers.get("content-type")).toBe("image/png");
    const png = Buffer.from(await favicon.arrayBuffer());
    expect(png.length).toBeGreaterThan(1024);
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(png.readUInt32BE(16)).toBe(512);
    expect(png.readUInt32BE(20)).toBe(512);
    expect(png[24]).toBe(8);
    const channels = { 2: 3, 6: 4 }[png[25]!];
    expect(channels).toBeDefined();
    const idat: Buffer[] = [];
    for (let offset = 8; offset < png.length; ) {
      const length = png.readUInt32BE(offset);
      if (png.toString("latin1", offset + 4, offset + 8) === "IDAT") idat.push(png.subarray(offset + 8, offset + 8 + length));
      offset += 12 + length;
    }
    expect(inflateSync(Buffer.concat(idat)).length).toBe(512 * (512 * channels! + 1));

    const iconLink = /<link[^>]*rel="icon"[^>]*href="\/favicon\.png"|<link[^>]*href="\/favicon\.png"[^>]*rel="icon"/;
    const chooser = await pageAt();
    expect(chooser).toContain('id="choose-folder"');
    expect(chooser).toMatch(iconLink);

    const mapFolder = await buildMapFolder(homeOnlyMap("Icon flow"));
    const opened = await fetch(`${base}/__flowmap-app/open`, {
      method: "POST",
      headers: { "X-Flowmap": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ path: mapFolder }),
    });
    expect(opened.status).toBe(200);
    const viewer = await pageAt();
    expect(viewer).toContain("const DATA");
    expect(viewer).toMatch(iconLink);

    await writeFile(join(mapFolder, "map.json"), "{ not json");
    const notice = await pageAt();
    expect(notice).toContain('id="problem"');
    expect(notice).toMatch(iconLink);
  });
});
