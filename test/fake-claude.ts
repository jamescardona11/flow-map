import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** One scripted invocation: prints `before`, waits for `release()` when `hold`, then prints `after`. A string is printed as it is (not JSON). */
export type FakeClaudeInvocation = { before?: (object | string)[]; after?: (object | string)[]; hold?: boolean };

/**
 * What the fake CLI does when it is started. `hold` keeps it running until `release()`.
 * `stream` plays one scripted invocation per call (the Nth call plays entry N, extra calls repeat the last entry).
 */
export type FakeClaudeBehavior =
  | { mode: "success" | "is_error" | "exit1" | "no_result"; hold?: boolean }
  | { mode: "stream"; invocations: FakeClaudeInvocation[] };

export type FakeClaudeCall = { pid: number; argv: string[]; cwd: string; env: Record<string, string> };

// Runs as the `claude` command: records how it was started, then prints stream-json lines the way `claude -p` does.
const SCRIPT = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = __dirname;
const control = JSON.parse(fs.readFileSync(path.join(dir, "control.json"), "utf8"));
const callsFile = path.join(dir, "calls.jsonl");
const index = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8").split("\\n").length - 1 : 0;
fs.appendFileSync(
  callsFile,
  JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd(), env: process.env }) + "\\n",
);
const out = (event) => process.stdout.write((typeof event === "string" ? event : JSON.stringify(event)) + "\\n");
function finish() {
  if (control.mode === "success") {
    process.stdout.write("this line is not JSON\\n");
    out({ type: "system", subtype: "init" });
    out({ type: "result", subtype: "success", result: "A first result", is_error: false });
    out({ type: "assistant", message: { role: "assistant", content: "working" } });
    out({ type: "result", subtype: "success", result: "All done", is_error: false });
  } else if (control.mode === "is_error") {
    out({ type: "result", subtype: "error_during_execution", result: "Something broke", is_error: true });
  } else if (control.mode === "exit1") {
    process.stderr.write("crash\\n");
    process.exitCode = 1;
  } else {
    out({ type: "system", subtype: "init" });
  }
}
function whenReleased(hold, then) {
  if (!hold) return then();
  const started = Date.now();
  const timer = setInterval(() => {
    if (fs.existsSync(path.join(dir, "release"))) {
      clearInterval(timer);
      fs.rmSync(path.join(dir, "release"), { force: true }); // one release lets one held call go
      then();
    } else if (Date.now() - started > 20000) {
      process.exit(2);
    }
  }, 20);
}
if (control.mode === "stream") {
  const invocation = control.invocations[Math.min(index, control.invocations.length - 1)];
  (invocation.before || []).forEach(out);
  whenReleased(invocation.hold, () => (invocation.after || []).forEach(out));
} else {
  whenReleased(control.hold, finish);
}
`;

/** A stand-in for the `claude` command in a temp dir. Always call `cleanup()`: it releases a held run and kills what is left. */
export async function createFakeClaude(behavior: FakeClaudeBehavior = { mode: "success" }) {
  const dir = await mkdtemp(join(tmpdir(), "fake-claude-"));
  const bin = join(dir, "claude");
  await writeFile(bin, SCRIPT);
  await chmod(bin, 0o755);

  const configure = (next: FakeClaudeBehavior) => writeFile(join(dir, "control.json"), JSON.stringify(next));
  await configure(behavior);

  const calls = async (): Promise<FakeClaudeCall[]> => {
    const text = await readFile(join(dir, "calls.jsonl"), "utf8").catch(() => "");
    return text
      .split("\n")
      .slice(0, -1) // the text after the last newline is a line still being written
      .map((line) => JSON.parse(line) as FakeClaudeCall);
  };

  return {
    bin,
    dir,
    configure,
    calls,
    release: () => writeFile(join(dir, "release"), ""),
    async cleanup() {
      await writeFile(join(dir, "release"), "");
      for (const { pid } of await calls()) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export type FakeClaude = Awaited<ReturnType<typeof createFakeClaude>>;
