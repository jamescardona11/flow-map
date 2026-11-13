#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultDataDir } from "./data-dir.ts";
import { RequestError } from "./errors.ts";
import { installApp } from "./install-app.ts";
import { readMap } from "./map-check.ts";
import { removeLegacyLink, writeSession } from "./session-link.ts";

const START_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 50;
const ANSWER_TIMEOUT_MS = 1000;
const USAGE =
  "Usage: flow-map open <folder> [--no-browser]\n       flow-map app [<folder>]\n       flow-map [open] [--no-browser]  (no folder: the app in your default browser)\n       flow-map install-app [--dir <folder>]\n       flow-map link <folder>\n";
/** Chromium-based browsers that can show a page as an application window, in order of preference. */
const WINDOW_BROWSERS = [
  "/Applications/Google Chrome.app",
  "/Applications/Chromium.app",
  "/Applications/Microsoft Edge.app",
  "/Applications/Brave Browser.app",
  "/Applications/Vivaldi.app",
];

export type CliDeps = {
  dataDir: string;
  cwd: string;
  /** The environment of the Claude Code session `link` runs in; only `link` reads it. */
  env?: Record<string, string | undefined>;
  openBrowser: (url: string) => Promise<void>;
  /** Whether an application bundle exists; `app` looks for a browser with it. Without it, no browser counts as installed. */
  appInstalled?: (path: string) => boolean;
  /** Runs `open` with these arguments (the first is `open` itself); `app` uses it to show the window. */
  openWindow?: (args: string[]) => Promise<void>;
  startApp: () => Promise<void>;
  out: (text: string) => void;
  err: (text: string) => void;
};

/** The port the running app announced in `app.json`, or null when there is no file or nothing answers at it. */
async function findRunningApp(dataDir: string): Promise<number | null> {
  let port: unknown;
  try {
    port = (JSON.parse(await readFile(join(dataDir, "app.json"), "utf8")) as { port?: unknown }).port;
  } catch {
    return null;
  }
  if (typeof port !== "number") return null;
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS) });
    return port;
  } catch {
    return null;
  }
}

async function waitForApp(dataDir: string): Promise<number | null> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const port = await findRunningApp(dataDir);
    if (port !== null) return port;
    await new Promise((done) => setTimeout(done, POLL_INTERVAL_MS));
  }
  return null;
}

async function openMapInApp(port: number, folder: string): Promise<string | null> {
  const response = await fetch(`http://127.0.0.1:${port}/__flowmap-app/open`, {
    method: "POST",
    headers: { "X-Flowmap": "1", "Content-Type": "application/json" },
    body: JSON.stringify({ path: folder }),
  });
  if (response.ok) return null;
  try {
    return ((await response.json()) as { error: string }).error;
  } catch {
    return `The app refused the folder (HTTP ${response.status}).`;
  }
}

/** Links a map folder to the Claude Code session this command runs in. Returns the exit code. */
async function linkMapToSession(folderArg: string, deps: CliDeps): Promise<number> {
  const socket = deps.env?.CLAUDE_CODE_MESSAGING_SOCKET;
  const token = deps.env?.CLAUDE_CODE_MESSAGING_TOKEN;
  if (!socket || !token) {
    deps.err("Run `flow-map link` from inside a Claude Code session: CLAUDE_CODE_MESSAGING_SOCKET and CLAUDE_CODE_MESSAGING_TOKEN must be set.\n");
    return 1;
  }
  const folder = resolve(deps.cwd, folderArg);
  const checked = await readMap(folder);
  if ("problem" in checked) {
    deps.err(`${checked.problem}\n`);
    return 1;
  }
  try {
    await removeLegacyLink(folder);
  } catch (error) {
    if (!(error instanceof RequestError)) throw error;
    deps.err(`${error.message}\n`);
    return 1;
  }
  await writeSession(deps.dataDir, folder, { socket, token });
  deps.out(`Linked ${folder} to the Claude Code session at ${socket}\n`);
  return 0;
}

/** The port of the running app, starting the app first when nothing answers. Null (after telling why) if it did not start. */
async function runningAppPort(deps: CliDeps): Promise<number | null> {
  let port = await findRunningApp(deps.dataDir);
  if (port === null) {
    await deps.startApp();
    port = await waitForApp(deps.dataDir);
    if (port === null) deps.err("The app did not start within 5 seconds. Run `npm start` to see why.\n");
  }
  return port;
}

/** Opens `folderArg` in the app; false (after telling why) if the app refused it. */
async function openFolderInApp(port: number, folderArg: string, deps: CliDeps): Promise<boolean> {
  const refusal = await openMapInApp(port, resolve(deps.cwd, folderArg));
  if (refusal !== null) deps.err(`${refusal}\n`);
  return refusal === null;
}

/** Shows the app in its own window with the first installed Chromium browser, or in the default browser when there is none. */
async function showAppWindow(url: string, deps: CliDeps): Promise<void> {
  const browser = deps.appInstalled ? WINDOW_BROWSERS.find(deps.appInstalled) : undefined;
  if (!browser || !deps.openWindow) {
    deps.err("No Chromium-based browser found (Chrome, Chromium, Edge, Brave, Vivaldi): opening the app in the default browser.\n");
    await deps.openBrowser(url);
    return;
  }
  await deps.openWindow(["open", "-n", "-a", browser, "--args", `--app=${url}`, `--user-data-dir=${join(deps.dataDir, "window-profile")}`]);
}

const appUrl = (port: number) => `http://127.0.0.1:${port}/`;

/** `flow-map app [<folder>]`: the app in its own window. Returns the exit code. */
async function openAppWindow(folderArg: string | undefined, deps: CliDeps): Promise<number> {
  const port = await runningAppPort(deps);
  if (port === null) return 1;
  if (folderArg !== undefined && !(await openFolderInApp(port, folderArg, deps))) return 1;
  const url = appUrl(port);
  await showAppWindow(url, deps);
  deps.out(`Opened the app at ${url}\n`);
  return 0;
}

/** `flow-map` and `flow-map open` with no folder: the app in the default browser. Returns the exit code. */
async function openAppInBrowser(showBrowser: boolean, deps: CliDeps): Promise<number> {
  const port = await runningAppPort(deps);
  if (port === null) return 1;
  const url = appUrl(port);
  if (showBrowser) await deps.openBrowser(url);
  deps.out(`Opened the app at ${url}\n`);
  return 0;
}

/** `flow-map install-app [--dir <folder>]`: writes the macOS app bundle. Returns the exit code. */
async function installAppBundle(dirArg: string | undefined, deps: CliDeps): Promise<number> {
  try {
    const bundle = await installApp(resolve(deps.cwd, dirArg ?? join(homedir(), "Applications")), deps.env?.FLOW_MAP_HOME);
    deps.out(`Installed ${bundle}\n`);
    return 0;
  } catch (error) {
    deps.err(`${(error as Error).message}\n`);
    return 1;
  }
}

/** Opens a map folder in the running app, starting the app first when nothing answers. Returns the exit code. */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [command, folderArg, ...flags] = argv;
  if (command === "link" && folderArg && flags.length === 0) return linkMapToSession(folderArg, deps);
  const isBareOpen = command === "open" && flags.length === 0 && (folderArg === undefined || folderArg === "--no-browser");
  if (argv.length === 0 || isBareOpen) return openAppInBrowser(folderArg !== "--no-browser", deps);
  if (command === "app" && argv.length <= 2 && !folderArg?.startsWith("-")) return openAppWindow(folderArg, deps);
  if (command === "install-app" && (argv.length === 1 || (folderArg === "--dir" && flags.length === 1))) {
    return installAppBundle(flags[0], deps);
  }
  if (command !== "open" || !folderArg || flags.some((flag) => flag !== "--no-browser")) {
    deps.err(USAGE);
    return 1;
  }

  const port = await runningAppPort(deps);
  if (port === null) return 1;
  if (!(await openFolderInApp(port, folderArg, deps))) return 1;

  const url = appUrl(port);
  if (!flags.includes("--no-browser")) await deps.openBrowser(url);
  deps.out(`Opened ${resolve(deps.cwd, folderArg)} at ${url}\n`);
  return 0;
}

function detach(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  spawn(command, args, { detached: true, stdio: "ignore", env }).unref();
  return Promise.resolve();
}

function isRunDirectly(): boolean {
  return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isRunDirectly()) {
  const dataDir = defaultDataDir();
  process.exitCode = await runCli(process.argv.slice(2), {
    dataDir,
    cwd: process.cwd(),
    env: process.env,
    openBrowser: (url) => detach("open", [url], process.env),
    appInstalled: existsSync,
    openWindow: ([, ...args]) => detach("/usr/bin/open", args, process.env),
    startApp: () =>
      detach(process.execPath, [fileURLToPath(new URL("./main.ts", import.meta.url))], {
        ...process.env,
        FLOW_MAP_HOME: dataDir,
      }),
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
  });
}
