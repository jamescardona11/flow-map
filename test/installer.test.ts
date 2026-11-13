import { lstat, mkdir, readdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Prompt } from "../src/prompt.ts";
import { createFixtures, exists } from "./support.ts";

const fixtures = createFixtures();
const { makeTempDir } = fixtures;

afterEach(() => fixtures.removeTempDirs());

const SKILL_MD = "---\nname: flow-map\ndescription: test skill\n---\n\n# flow-map\n";
const FOREIGN_SKILL_MD = "---\nname: other-skill\ndescription: not ours\n---\n";
const MARKER = "# installed by flow-map";

/** A stand-in for the repo: `skill/` with a SKILL.md, scripts (one cache folder inside), references and tests. */
async function makeRepo(): Promise<string> {
  const repoDir = await makeTempDir("flow-map-repo-");
  const skill = join(repoDir, "skill");
  await mkdir(join(skill, "scripts", "__pycache__"), { recursive: true });
  await mkdir(join(skill, "references"), { recursive: true });
  await mkdir(join(skill, "tests"), { recursive: true });
  await writeFile(join(skill, "SKILL.md"), SKILL_MD);
  await writeFile(join(skill, "scripts", "flowmap.py"), "print('flowmap')\n");
  await writeFile(join(skill, "scripts", "__pycache__", "flowmap.cpython-314.pyc"), "bytecode");
  await writeFile(join(skill, "references", "schema.md"), "# schema\n");
  await writeFile(join(skill, "tests", "test_flowmap.py"), "def test(): pass\n");
  return repoDir;
}

/** Every file under `dir`, as paths relative to it. */
async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
    .sort();
}

type Asked = { kind: "confirm" | "input"; question: string; default: boolean | string };

/** A prompt that answers from `answers` in order (undefined takes the default) and records what it was asked. */
function scriptedPrompt(answers: (boolean | string | undefined)[]) {
  const asked: Asked[] = [];
  const next = (kind: Asked["kind"], question: string, fallback: boolean | string) => {
    asked.push({ kind, question, default: fallback });
    return answers[asked.length - 1] ?? fallback;
  };
  const prompt: Prompt = {
    confirm: async (question, defaultYes) => next("confirm", question, defaultYes) as boolean,
    input: async (question, defaultValue) => next("input", question, defaultValue) as string,
  };
  return { prompt, asked };
}

const noPrompt: Prompt = {
  confirm: async () => {
    throw new Error("must not prompt");
  },
  input: async () => {
    throw new Error("must not prompt");
  },
};

async function setup() {
  const { runInstaller } = await import("../src/installer.ts");
  const repoDir = await makeRepo();
  const home = await makeTempDir("flow-map-home-");
  const output: string[] = [];
  const errors: string[] = [];
  const run = (
    args: string[],
    overrides: {
      nodePath?: string;
      pathEnv?: string;
      prompt?: Prompt;
      homeDir?: string;
      platform?: string;
      installApp?: (dir: string) => Promise<string>;
      copyTree?: (source: string, destination: string) => Promise<void>;
    } = {},
  ) => {
    output.length = 0;
    errors.length = 0;
    return runInstaller(args, {
      repoDir,
      nodePath: "/usr/local/bin/node",
      pathEnv: "/usr/bin:/bin",
      ...overrides,
      out: (text: string) => void output.push(text),
      err: (text: string) => void errors.push(text),
    });
  };
  return { run, repoDir, home, out: () => output.join(""), err: () => errors.join("") };
}

describe("installing the flow-map skill and command", () => {
  it("installs the skill at <skill-dir>/flow-map without caches or tests, replaces an older copy or a link without touching its target, refuses a folder that is not ours, and links with --symlink", async () => {
    const { run, repoDir, home, out, err } = await setup();
    const first = join(home, "claude", "skills");
    const second = join(home, "codex", "skills");

    expect(await run(["--skill-dir", first, "--skill-dir", second])).toBe(0);
    for (const skillsDir of [first, second]) {
      const installed = join(skillsDir, "flow-map");
      expect(await listFiles(installed)).toEqual(["SKILL.md", "references/schema.md", "scripts/flowmap.py"]);
      expect(out()).toContain(installed);
    }

    const installed = join(first, "flow-map");
    await writeFile(join(installed, "stale.txt"), "left by an older install");
    expect(await run(["--skill-dir", first])).toBe(0);
    expect(await exists(join(installed, "stale.txt"))).toBe(false);
    expect(await readFile(join(installed, "SKILL.md"), "utf8")).toBe(SKILL_MD);

    expect(await readdir(first), "a reinstall leaves no temporary sibling next to the skill").toEqual(["flow-map"]);

    const unrelated = await makeTempDir("flow-map-link-target-");
    await writeFile(join(unrelated, "keep.txt"), "the owner's own skill");
    const unrelatedLinks = join(home, "unrelated-link", "skills");
    await mkdir(unrelatedLinks, { recursive: true });
    await symlink(unrelated, join(unrelatedLinks, "flow-map"));
    expect(await run(["--skill-dir", unrelatedLinks])).toBe(1);
    expect(err()).toContain("left as it is");
    expect(await readlink(join(unrelatedLinks, "flow-map"))).toBe(unrelated);

    const oldSkill = await makeTempDir("flow-map-old-skill-");
    await writeFile(join(oldSkill, "SKILL.md"), SKILL_MD);
    await writeFile(join(oldSkill, "keep.txt"), "the old skills repo");
    const linked = join(home, "linked", "skills");
    await mkdir(linked, { recursive: true });
    await symlink(oldSkill, join(linked, "flow-map"));
    expect(await run(["--skill-dir", linked])).toBe(0);
    expect(out(), "the old target is named").toContain(oldSkill);
    expect((await lstat(join(linked, "flow-map"))).isSymbolicLink()).toBe(false);
    expect(await listFiles(join(linked, "flow-map"))).toEqual(["SKILL.md", "references/schema.md", "scripts/flowmap.py"]);
    expect(await listFiles(oldSkill)).toEqual(["SKILL.md", "keep.txt"]);

    const foreign = join(home, "foreign", "skills");
    await mkdir(join(foreign, "flow-map"), { recursive: true });
    await writeFile(join(foreign, "flow-map", "SKILL.md"), FOREIGN_SKILL_MD);
    expect(await run(["--skill-dir", foreign])).toBe(1);
    expect(err().trim()).not.toBe("");
    expect(await listFiles(join(foreign, "flow-map"))).toEqual(["SKILL.md"]);
    expect(await readFile(join(foreign, "flow-map", "SKILL.md"), "utf8")).toBe(FOREIGN_SKILL_MD);

    const linkedSkills = join(home, "symlinked", "skills");
    expect(await run(["--skill-dir", linkedSkills, "--symlink"])).toBe(0);
    expect(await readlink(join(linkedSkills, "flow-map"))).toBe(join(repoDir, "skill"));
    expect(out()).toContain(join(linkedSkills, "flow-map"));
    expect(await run(["--skill-dir", linkedSkills, "--symlink"]), "a link to this repo's skill is replaced").toBe(0);
  });

  it("keeps the previous skill and leaves no temporary sibling when copying the new one fails", async () => {
    const { run, home, err } = await setup();
    const skills = join(home, "skills");
    expect(await run(["--skill-dir", skills])).toBe(0);
    await writeFile(join(skills, "flow-map", "stale.txt"), "the previous install");
    const failingCopy = async (_source: string, destination: string) => {
      await mkdir(destination);
      await writeFile(join(destination, "half.txt"), "partial");
      throw new Error("disk full");
    };

    expect(await run(["--skill-dir", skills], { copyTree: failingCopy })).toBe(1);

    expect(err()).toContain("disk full");
    expect(await readdir(skills)).toEqual(["flow-map"]);
    expect(await listFiles(join(skills, "flow-map"))).toEqual(["SKILL.md", "references/schema.md", "scripts/flowmap.py", "stale.txt"]);
  });

  it("installs the flow-map command as an executable script of ours, replaces it, refuses any other file, and prints the PATH line only when the folder is not on PATH", async () => {
    const { run, repoDir, home, out, err } = await setup();
    const binDir = join(home, "bin");
    await mkdir(binDir);
    const command = join(binDir, "flow-map");
    const nodePath = "/opt/o'brien/bin/node";

    expect(await run(["--bin-dir", binDir], { nodePath, pathEnv: "/usr/bin:/bin" })).toBe(0);
    expect(out()).toContain(command);
    expect(out()).toContain(`export PATH="${binDir}:$PATH"`);
    const lines = (await readFile(command, "utf8")).trimEnd().split("\n");
    expect(lines[0]).toBe("#!/bin/sh");
    expect(lines[1]).toBe(MARKER);
    expect(lines.at(-1)).toBe(`exec '/opt/o'\\''brien/bin/node' '${repoDir}/src/cli.ts' "$@"`);
    expect((await stat(command)).mode & 0o111).not.toBe(0);

    expect(await run(["--bin-dir", binDir], { nodePath: "/usr/local/bin/node", pathEnv: `/usr/bin:${binDir}` })).toBe(0);
    expect(out()).not.toContain("export PATH");
    expect((await readFile(command, "utf8")).trimEnd().split("\n").at(-1)).toBe(`exec '/usr/local/bin/node' '${repoDir}/src/cli.ts' "$@"`);

    const mine = "#!/bin/sh\necho my own flow-map\n";
    await writeFile(command, mine);
    expect(await run(["--bin-dir", binDir])).toBe(1);
    expect(err().trim()).not.toBe("");
    expect(await readFile(command, "utf8")).toBe(mine);

    await rm(command);
    await mkdir(join(command, "inside"), { recursive: true });
    expect(await run(["--bin-dir", binDir])).toBe(1);
    expect(err()).toContain("left as it is");
    expect((await lstat(command)).isDirectory()).toBe(true);
    expect(await readdir(command)).toEqual(["inside"]);
  });

  it("--uninstall removes only the skill folder or link and the command script that are ours, names what it leaves, and is fine to run twice", async () => {
    const { run, repoDir, home, out, err } = await setup();
    const skillsDir = join(home, "skills");
    const binDir = join(home, "bin");
    await mkdir(binDir);
    const ours = ["--skill-dir", skillsDir, "--bin-dir", binDir];

    expect(await run(ours)).toBe(0);
    expect(await run([...ours, "--uninstall"])).toBe(0);
    expect(await exists(join(skillsDir, "flow-map"))).toBe(false);
    expect(await exists(join(binDir, "flow-map"))).toBe(false);
    expect(await run([...ours, "--uninstall"])).toBe(0);

    expect(await run([...ours, "--symlink"])).toBe(0);
    expect(await run([...ours, "--uninstall"])).toBe(0);
    expect(await exists(join(skillsDir, "flow-map"))).toBe(false);
    expect(await exists(join(binDir, "flow-map"))).toBe(false);
    expect(await readFile(join(repoDir, "skill", "SKILL.md"), "utf8")).toBe(SKILL_MD);

    expect(await run(ours)).toBe(0);
    expect(await run([...ours, "--uninstall", "--app"])).toBe(1);
    expect(err().trim().split("\n"), "one line says --uninstall does not remove the app").toHaveLength(1);
    expect(await exists(join(skillsDir, "flow-map"))).toBe(true);
    expect(await exists(join(binDir, "flow-map"))).toBe(true);
    expect(await run([...ours, "--uninstall"])).toBe(0);

    const foreignSkills = join(home, "foreign-skills");
    await mkdir(join(foreignSkills, "flow-map"), { recursive: true });
    await writeFile(join(foreignSkills, "flow-map", "SKILL.md"), FOREIGN_SKILL_MD);
    const elsewhere = await makeTempDir("flow-map-elsewhere-");
    const linkedSkills = join(home, "linked-skills");
    await mkdir(linkedSkills);
    await symlink(elsewhere, join(linkedSkills, "flow-map"));
    const foreignBin = join(home, "foreign-bin");
    await mkdir(foreignBin);
    await writeFile(join(foreignBin, "flow-map"), "#!/bin/sh\necho my own flow-map\n");

    await run(["--skill-dir", foreignSkills, "--skill-dir", linkedSkills, "--bin-dir", foreignBin, "--uninstall"]);
    expect(await readFile(join(foreignSkills, "flow-map", "SKILL.md"), "utf8")).toBe(FOREIGN_SKILL_MD);
    expect(await readlink(join(linkedSkills, "flow-map"))).toBe(elsewhere);
    expect(await readFile(join(foreignBin, "flow-map"), "utf8")).toBe("#!/bin/sh\necho my own flow-map\n");
    for (const left of [join(foreignSkills, "flow-map"), join(linkedSkills, "flow-map"), join(foreignBin, "flow-map")]) {
      expect(out()).toContain(left);
    }
  });
});

describe("the interactive installer and the app", () => {
  it("with no install flag it asks the questions in order and installs what the answers say, `--yes` takes the same defaults without asking, and the app question exists only on macOS", async () => {
    const cases = [
      {
        case: "asks six questions in order on macOS and takes every default, which leaves the app out",
        argv: [] as string[],
        platform: "darwin",
        answers: () => [] as (boolean | string | undefined)[],
        kinds: ["confirm", "confirm", "input", "confirm", "input", "confirm"],
        skills: [".claude/skills"],
        linked: false,
        command: ".local/bin",
        apps: [] as string[],
      },
      {
        case: "skips the app question off macOS",
        argv: [] as string[],
        platform: "linux",
        answers: () => [] as (boolean | string | undefined)[],
        kinds: ["confirm", "confirm", "input", "confirm", "input"],
        skills: [".claude/skills"],
        linked: false,
        command: ".local/bin",
        apps: [] as string[],
      },
      {
        case: "installs what the answers ask for: Codex, another folder, links, another command folder, and the app",
        argv: [] as string[],
        platform: "darwin",
        answers: (home: string) => [true, true, join(home, "elsewhere"), true, join(home, "my-bin"), true],
        kinds: ["confirm", "confirm", "input", "confirm", "input", "confirm"],
        skills: [".claude/skills", ".codex/skills", "elsewhere"],
        linked: true,
        command: "my-bin",
        apps: ["Applications"],
      },
      {
        case: "--yes never asks, takes the defaults and leaves the app out on macOS",
        argv: ["--yes"],
        platform: "darwin",
        answers: () => [] as (boolean | string | undefined)[],
        kinds: [] as string[],
        skills: [".claude/skills"],
        linked: false,
        command: ".local/bin",
        apps: [] as string[],
      },
      {
        case: "--yes never asks and leaves the app out off macOS",
        argv: ["--yes"],
        platform: "linux",
        answers: () => [] as (boolean | string | undefined)[],
        kinds: [] as string[],
        skills: [".claude/skills"],
        linked: false,
        command: ".local/bin",
        apps: [] as string[],
      },
    ];
    for (const { case: name, argv, platform, answers, kinds, skills, linked, command, apps } of cases) {
      const { run, home } = await setup();
      const { prompt, asked } = scriptedPrompt(answers(home));
      const appDirs: string[] = [];
      const installApp = async (dir: string) => {
        appDirs.push(dir);
        return join(dir, "Flow Map.app");
      };

      expect(await run(argv, { prompt: argv.length === 0 ? prompt : noPrompt, homeDir: home, platform, installApp }), name).toBe(0);

      expect(
        asked.map((question) => question.kind),
        name,
      ).toEqual(kinds);
      if (argv.length === 0) {
        expect(asked.map((question) => question.default)).toEqual(
          [true, false, "", false, join(home, ".local", "bin"), false].slice(0, kinds.length),
        );
        expect(asked[0]!.question).toContain(join(home, ".claude", "skills"));
        expect(asked[1]!.question).toContain(join(home, ".codex", "skills"));
      }
      for (const folder of [".claude/skills", ".codex/skills", "elsewhere"]) {
        const installed = join(home, folder, "flow-map");
        expect(await exists(installed), folder).toBe(skills.includes(folder));
        if (skills.includes(folder)) expect((await lstat(installed)).isSymbolicLink()).toBe(linked);
      }
      expect(await exists(join(home, command, "flow-map")), name).toBe(true);
      expect(await exists(join(home, command === "my-bin" ? ".local/bin" : "my-bin", "flow-map"))).toBe(false);
      expect(appDirs, name).toEqual(apps.map((app) => join(home, app)));
    }
  });

  it("cancelling at a question (Ctrl+C or Ctrl+D) installs nothing, says so in one line and exits 1, while any other prompt failure prints its own message", async () => {
    const failures = [
      { failure: Object.assign(new Error("Aborted with Ctrl+D"), { name: "AbortError" }), printed: "Cancelled: nothing was installed." },
      { failure: new Error("boom"), printed: "boom" },
    ];
    for (const { failure, printed } of failures) {
      const { run, home, err } = await setup();
      let asked = 0;
      const prompt: Prompt = {
        confirm: async (_question, defaultYes) => {
          asked += 1;
          if (asked === 2) throw failure;
          return defaultYes;
        },
        input: async (_question, defaultValue) => defaultValue,
      };

      expect(await run([], { prompt, homeDir: home, platform: "darwin", installApp: async () => join(home, "Flow Map.app") }), printed).toBe(1);

      expect(err().trim().split("\n"), printed).toEqual([printed]);
      expect(await exists(join(home, ".claude"))).toBe(false);
      expect(await exists(join(home, ".local"))).toBe(false);
      expect(await exists(join(home, "Flow Map.app"))).toBe(false);
    }
  });

  it("expands a leading ~ in the answers for another skills folder and the command folder to the home folder, and creates nothing under the working folder", async () => {
    const { run, home } = await setup();
    const { prompt } = scriptedPrompt([false, false, "~/elsewhere", false, "~/mybin", false]);

    expect(await run([], { prompt, homeDir: home, platform: "darwin" })).toBe(0);

    expect(await exists(join(home, "elsewhere", "flow-map", "SKILL.md"))).toBe(true);
    expect(await exists(join(home, "mybin", "flow-map"))).toBe(true);
    expect(await exists(join(process.cwd(), "~"))).toBe(false);
  });

  it("warns once that the app expects the skill under ~/.claude/skills when it was installed elsewhere, installs the app with --app into --app-dir or <home>/Applications, and finishes the skill and command when the app fails", async () => {
    const { run, home, out, err } = await setup();
    const appDirs: string[] = [];
    const installApp = async (dir: string) => {
      appDirs.push(dir);
      return join(dir, "Flow Map.app");
    };
    const deps = { homeDir: home, platform: "darwin", installApp };
    const headsUp = () =>
      out()
        .split("\n")
        .filter((line) => line.includes("~/.claude/skills/flow-map"));

    expect(await run(["--skill-dir", join(home, "codex-skills")], deps)).toBe(0);
    expect(headsUp()).toHaveLength(1);
    expect(await run(["--skill-dir", join(home, ".claude", "skills"), "--skill-dir", join(home, "codex-skills")], deps)).toBe(0);
    expect(headsUp()).toHaveLength(0);
    expect(appDirs).toEqual([]);

    expect(await run(["--app"], deps)).toBe(0);
    expect(appDirs).toEqual([join(home, "Applications")]);
    expect(out()).toContain(join(home, "Applications", "Flow Map.app"));
    appDirs.length = 0;
    expect(await run(["--app", "--app-dir", join(home, "my-apps")], deps)).toBe(0);
    expect(appDirs).toEqual([join(home, "my-apps")]);
    expect(out()).toContain(join(home, "my-apps", "Flow Map.app"));

    const failing = async () => {
      throw new Error("sips is not available");
    };
    const skills = join(home, "failing-skills");
    const bin = join(home, "failing-bin");
    expect(await run(["--skill-dir", skills, "--bin-dir", bin, "--app"], { ...deps, installApp: failing })).toBe(1);
    expect(err()).toContain("sips is not available");
    expect(await exists(join(skills, "flow-map", "SKILL.md"))).toBe(true);
    expect(await exists(join(bin, "flow-map"))).toBe(true);
  });
});
