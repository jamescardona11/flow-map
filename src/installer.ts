import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { cp, mkdir, readFile, readlink, rename, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isMissing, lstatOrUndefined, writeFileAtomic } from "./fs-util.ts";
import { installApp as installAppBundle } from "./install-app.ts";
import { type Prompt, terminalPrompt } from "./prompt.ts";
import { shellQuote } from "./skill-command.ts";

const USAGE =
  "Usage: install [--yes] [--skill-dir <dir>]... [--bin-dir <dir>] [--symlink] [--app [--app-dir <dir>]] [--tools] [--uninstall]\n       install   (no options, in a terminal: asks what to install)\n";
const COMMAND_NAME = "flow-map";
/** The second line of the command script: how an uninstall or a reinstall knows the file is ours. */
const MARKER = "# installed by flow-map";

export type InstallerDeps = {
  /** Where `skill/` and `src/cli.ts` live. */
  repoDir?: string;
  nodePath?: string;
  pathEnv?: string;
  out?: (text: string) => void;
  err?: (text: string) => void;
  /** Asks the questions when no install flag is given; without it, the terminal when stdin is one. */
  prompt?: Prompt;
  homeDir?: string;
  platform?: string;
  /** Writes Flow Map.app into the folder and answers the bundle path. */
  installApp?: (dir: string) => Promise<string>;
  /** Copies the skill folder into `destination`, which does not exist yet. */
  copyTree?: (source: string, destination: string) => Promise<void>;
  /** Whether a command is on PATH. */
  hasCommand?: (name: string) => boolean;
  /** Runs a command to its end; rejects when it fails. `--tools` installs with it. */
  runCommand?: (command: string[]) => Promise<void>;
};

type Context = {
  repoDir: string;
  nodePath: string;
  pathEnv: string;
  out: (text: string) => void;
  copyTree: (source: string, destination: string) => Promise<void>;
};

type Options = { skillDirs: string[]; binDir: string | undefined; symlink: boolean; uninstall: boolean; appDir: string | undefined; tools: boolean };

/** What the skill and the app run but this installer does not ship. `npm` is the package `--tools` installs; the others only get a hint. */
const TOOLS: { command: string; purpose: string; npm?: string; hint?: string }[] = [
  { command: "python3", purpose: "required: the skill's command runs on it", hint: "install Python 3" },
  { command: "playwright-cli", purpose: "to capture web apps", npm: "@playwright/cli@latest" },
  { command: "agent-device", purpose: "to capture iOS and Android apps", npm: "agent-device" },
  { command: "ffmpeg", purpose: "optional: export a route as video", hint: "brew install ffmpeg" },
  { command: "claude", purpose: "optional: Run with a new Claude from the app", hint: "install Claude Code" },
];

/** A leading `~` or `~/` in an answer typed at a prompt means the home folder; the shell is not there to expand it. */
const expandHome = (path: string, homeDir: string) => (path === "~" ? homeDir : path.startsWith("~/") ? join(homeDir, path.slice(2)) : path);

const claudeSkillsDir = (homeDir: string) => join(homeDir, ".claude", "skills");

/** No flag says what to install: the questions are asked, and the app question installs into `appDir`. */
type Ask = { ask: { appDir: string } };

/** What the arguments ask for: what to install by flags or by `--yes`, the questions when no flag says what, undefined when the arguments are wrong. */
function parseRequest(argv: string[], homeDir: string): Options | Ask | undefined {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        "skill-dir": { type: "string", multiple: true },
        "bin-dir": { type: "string" },
        symlink: { type: "boolean" },
        uninstall: { type: "boolean" },
        app: { type: "boolean" },
        "app-dir": { type: "string" },
        yes: { type: "boolean" },
        tools: { type: "boolean" },
      },
    });
    const skillDirs = values["skill-dir"] ?? [];
    const binDir = values["bin-dir"];
    const appDir = values["app-dir"] ?? join(homeDir, "Applications");
    const tools = values.tools === true;
    if (tools && values.uninstall) return undefined;
    if (skillDirs.length === 0 && binDir === undefined && !values.app && !values.symlink && !values.uninstall) {
      if (values.yes) return { ...defaultOptions(homeDir), tools };
      return tools ? { ...defaultOptions(homeDir), skillDirs: [], binDir: undefined, tools } : { ask: { appDir } };
    }
    if (skillDirs.length === 0 && binDir === undefined && !values.app) return undefined;
    return {
      skillDirs,
      binDir,
      symlink: values.symlink === true,
      uninstall: values.uninstall === true,
      appDir: values.app ? appDir : undefined,
      tools,
    };
  } catch {
    return undefined;
  }
}

function defaultOptions(homeDir: string): Options & { binDir: string } {
  return {
    skillDirs: [claudeSkillsDir(homeDir)],
    binDir: join(homeDir, ".local", "bin"),
    symlink: false,
    uninstall: false,
    appDir: undefined,
    tools: false,
  };
}

async function askOptions(prompt: Prompt, homeDir: string, platform: string, appDir: string): Promise<Options> {
  const defaults = defaultOptions(homeDir);
  const claudeDir = claudeSkillsDir(homeDir);
  const codexDir = join(homeDir, ".codex", "skills");
  const skillDirs: string[] = [];
  if (await prompt.confirm(`Claude Code skills folder (${claudeDir})?`, true)) skillDirs.push(claudeDir);
  if (await prompt.confirm(`Codex skills folder (${codexDir})?`, false)) skillDirs.push(codexDir);
  const another = await prompt.input("Another skills folder (empty for none)", "");
  if (another !== "") skillDirs.push(expandHome(another, homeDir));
  const symlink = await prompt.confirm("Link the skill instead of copying it?", false);
  const binDir = expandHome(await prompt.input("Folder for the flow-map command", defaults.binDir), homeDir);
  const wantsApp = platform === "darwin" && (await prompt.confirm("Install Flow Map.app?", false));
  return { ...defaults, skillDirs, symlink, binDir, appDir: wantsApp ? appDir : undefined };
}

async function readOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error) || (error as NodeJS.ErrnoException).code === "EISDIR") return undefined;
    throw error;
  }
}

/** A folder is the flow-map skill when the front matter of its SKILL.md says `name: flow-map`. */
async function isSkillFolder(folder: string): Promise<boolean> {
  const text = await readOrUndefined(join(folder, "SKILL.md"));
  const frontMatter = text?.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  return frontMatter !== undefined && /^name:\s*flow-map\s*$/m.test(frontMatter);
}

async function isOurScript(path: string): Promise<boolean> {
  return (await readOrUndefined(path))?.split("\n")[1] === MARKER;
}

async function isLinkToSkill(path: string, ctx: Context): Promise<boolean> {
  return resolve(dirname(path), await readlink(path)) === join(ctx.repoDir, "skill");
}

/** The skill without Python caches and its own tests. */
const copySkill = (source: string, destination: string) =>
  cp(source, destination, {
    recursive: true,
    filter: (path) => basename(path) !== "__pycache__" && relative(source, path) !== "tests",
  });

/**
 * Installs the skill at `<skillDir>/flow-map`; false when what is there is not ours and was left alone, or the copy failed.
 * A link replaces only a link to this repo's skill or to some other flow-map skill folder (the owner's old skills repo).
 * A copy goes into a temporary sibling first, so a failing copy leaves the previous skill in place.
 */
async function installSkill(skillDir: string, options: Options, ctx: Context, err: (text: string) => void): Promise<boolean> {
  const target = join(skillDir, COMMAND_NAME);
  const existing = await lstatOrUndefined(target);
  let replacedLink: string | undefined;
  if (existing?.isSymbolicLink()) {
    replacedLink = resolve(skillDir, await readlink(target));
    if (!(await isLinkToSkill(target, ctx)) && !(await isSkillFolder(target))) {
      err(`${target} is a link to ${replacedLink}, which is not the flow-map skill: left as it is\n`);
      return false;
    }
  } else if (existing && (!existing.isDirectory() || !(await isSkillFolder(target)))) {
    err(`${target} exists and is not the flow-map skill: left as it is\n`);
    return false;
  }

  const source = join(ctx.repoDir, "skill");
  await mkdir(skillDir, { recursive: true });
  if (options.symlink) {
    if (existing) await rm(target, { recursive: true });
    await symlink(source, target);
  } else {
    const temp = join(skillDir, `.${COMMAND_NAME}.${randomUUID()}.tmp`);
    try {
      await ctx.copyTree(source, temp);
    } catch (error) {
      await rm(temp, { recursive: true, force: true });
      err(`Could not copy the skill into ${skillDir}: ${(error as Error).message}\n`);
      return false;
    }
    if (existing) await rm(target, { recursive: true });
    await rename(temp, target);
  }
  ctx.out(`Installed skill: ${target}\n`);
  if (replacedLink) ctx.out(`Replaced the link to ${replacedLink}\n`);
  return true;
}

async function installCommand(binDir: string, ctx: Context, err: (text: string) => void): Promise<boolean> {
  const target = join(binDir, COMMAND_NAME);
  if ((await lstatOrUndefined(target)) && !(await isOurScript(target))) {
    err(`${target} exists and was not installed by flow-map: left as it is\n`);
    return false;
  }

  const script = `#!/bin/sh\n${MARKER}\nexec ${shellQuote(ctx.nodePath)} ${shellQuote(join(ctx.repoDir, "src", "cli.ts"))} "$@"\n`;
  await mkdir(binDir, { recursive: true });
  await writeFileAtomic(target, script, { mode: 0o755 });
  ctx.out(`Installed command: ${target}\n`);

  const onPath = ctx.pathEnv.split(":").some((entry) => entry !== "" && resolve(entry) === resolve(binDir));
  if (!onPath) ctx.out(`${binDir} is not on your PATH. Add this line to your shell profile:\nexport PATH="${binDir}:$PATH"\n`);
  return true;
}

async function uninstallSkill(skillDir: string, ctx: Context) {
  const target = join(skillDir, COMMAND_NAME);
  const existing = await lstatOrUndefined(target);
  if (!existing) return;
  const ours = existing.isSymbolicLink() ? await isLinkToSkill(target, ctx) : existing.isDirectory() && (await isSkillFolder(target));
  if (!ours) return ctx.out(`Left ${target}: it is not the flow-map skill\n`);
  await rm(target, { recursive: true });
  ctx.out(`Removed ${target}\n`);
}

async function uninstallCommand(binDir: string, ctx: Context) {
  const target = join(binDir, COMMAND_NAME);
  if (!(await lstatOrUndefined(target))) return;
  if (!(await isOurScript(target))) return ctx.out(`Left ${target}: it was not installed by flow-map\n`);
  await rm(target);
  ctx.out(`Removed ${target}\n`);
}

const onPath = (name: string, pathEnv: string) =>
  pathEnv.split(":").some((dir) => {
    if (dir === "") return false;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });

const runToEnd = (command: string[]) =>
  new Promise<void>((done, fail) => {
    const child = spawn(command[0]!, command.slice(1), { stdio: "inherit" });
    child.on("error", fail);
    child.on("exit", (code) => (code === 0 ? done() : fail(new Error(`${command[0]} exited with code ${code}`))));
  });

/** Names the tools that are not on PATH and how to get each; with `install`, installs the ones that come from npm first. False when an install failed. */
async function checkTools(install: boolean, deps: InstallerDeps, ctx: Context, err: (text: string) => void): Promise<boolean> {
  const hasCommand = deps.hasCommand ?? ((name: string) => onPath(name, ctx.pathEnv));
  const run = deps.runCommand ?? runToEnd;
  let installed = true;
  const missing = [];
  for (const tool of TOOLS) {
    if (hasCommand(tool.command)) continue;
    if (!install || tool.npm === undefined) {
      missing.push(tool);
      continue;
    }
    try {
      await run(["npm", "install", "-g", tool.npm]);
      ctx.out(`Installed tool: ${tool.command}\n`);
    } catch (error) {
      err(`Could not install ${tool.command}: ${(error as Error).message}\n`);
      installed = false;
    }
  }
  if (missing.length === 0) return installed;
  ctx.out("Missing tools:\n");
  for (const tool of missing) ctx.out(`  ${tool.command} (${tool.purpose}): ${tool.npm === undefined ? tool.hint : `npm install -g ${tool.npm}`}\n`);
  if (missing.some((tool) => tool.npm !== undefined)) ctx.out("Run `./install --tools` to install the ones that come from npm.\n");
  return installed;
}

/** Ctrl+C and Ctrl+D at a readline question reject with an AbortError. */
const isCancel = (error: unknown) => error instanceof Error && error.name === "AbortError";

/** Installs or removes the flow-map skill and command as the flags say. Answers the exit code. */
export async function runInstaller(argv: string[], deps: InstallerDeps = {}): Promise<number> {
  const out = deps.out ?? ((text: string) => void process.stdout.write(text));
  const err = deps.err ?? ((text: string) => void process.stderr.write(text));
  const homeDir = deps.homeDir ?? homedir();
  const platform = deps.platform ?? process.platform;
  const request = parseRequest(argv, homeDir);
  const prompt = deps.prompt ?? (process.stdin.isTTY ? terminalPrompt : undefined);
  if (!request || ("ask" in request && !prompt)) {
    err(USAGE);
    return 1;
  }
  let options: Options;
  try {
    options = "ask" in request ? await askOptions(prompt!, homeDir, platform, request.ask.appDir) : request;
  } catch (error) {
    err(isCancel(error) ? "Cancelled: nothing was installed.\n" : `${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (options.uninstall && options.appDir !== undefined) {
    err("--uninstall does not remove the app: delete Flow Map.app yourself.\n");
    return 1;
  }
  const ctx: Context = {
    repoDir: deps.repoDir ?? join(import.meta.dirname, ".."),
    nodePath: deps.nodePath ?? process.execPath,
    pathEnv: deps.pathEnv ?? process.env.PATH ?? "",
    out,
    copyTree: deps.copyTree ?? copySkill,
  };

  if (options.uninstall) {
    for (const skillDir of options.skillDirs) await uninstallSkill(skillDir, ctx);
    if (options.binDir !== undefined) await uninstallCommand(options.binDir, ctx);
    return 0;
  }

  let installed = true;
  for (const skillDir of options.skillDirs) installed = (await installSkill(skillDir, options, ctx, err)) && installed;
  if (options.skillDirs.length > 0 && !options.skillDirs.some((dir) => resolve(dir) === claudeSkillsDir(homeDir))) {
    out("The Flow Map app's prompts expect the skill at ~/.claude/skills/flow-map: install it there too, or the app will not find it.\n");
  }
  if (options.binDir !== undefined) installed = (await installCommand(options.binDir, ctx, err)) && installed;
  if (options.appDir !== undefined) {
    const install = deps.installApp ?? ((dir: string) => installAppBundle(dir, process.env.FLOW_MAP_HOME));
    try {
      out(`Installed app: ${await install(options.appDir)}\n`);
    } catch (error) {
      err(`${(error as Error).message}\n`);
      installed = false;
    }
  }
  installed = (await checkTools(options.tools, deps, ctx, err)) && installed;
  return installed ? 0 : 1;
}
