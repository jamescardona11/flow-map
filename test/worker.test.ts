import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.ts";
import type { FakeClaudeBehavior } from "./fake-claude.ts";
import { createFixtures, textClient, waitFor } from "./support.ts";

const MESSAGING_VARIABLES = ["CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_MESSAGING_SOCKET"];

type Reply = { status: number; body: string };
type Server = Awaited<ReturnType<typeof createServer>>;

let server: Server | undefined;
let savedEnv: Record<string, string | undefined> = {};
const fixtures = createFixtures();
const { send, fromPage } = textClient(() => server!.port);

afterEach(async () => {
  await fixtures.closeFakes(); // releases held runs and kills leftovers before the server closes
  await server?.close();
  server = undefined;
  await fixtures.removeTempDirs();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv = {};
});

function setEnv(name: string, value: string) {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name];
  process.env[name] = value;
}

/** A worker request the way the viewer page sends it. */
function askWorker(body: Record<string, unknown>): Promise<Reply> {
  return fromPage("POST", "/__flowmap-app/request", { via: "worker", ...body });
}

function getRun(runId: string, headers: Record<string, string> = {}): Promise<Reply> {
  return send("GET", `/__flowmap-app/runs/${runId}`, { headers });
}

/** Polls the run until it is no longer running and returns its last answer. */
async function finishedRun(runId: string): Promise<unknown> {
  let last: unknown;
  await waitFor(async () => {
    last = JSON.parse((await getRun(runId)).body);
    return (last as { state: string }).state !== "running";
  }, "the run to end");
  return last;
}

function runIdOf(reply: Reply): string {
  expect(reply.status).toBe(202);
  return (JSON.parse(reply.body) as { runId: string }).runId;
}

async function openMap(folder: string) {
  const opened = await send("POST", "/__flowmap-app/open", {
    headers: { "X-Flowmap": "1", "Content-Type": "application/json" },
    body: JSON.stringify({ path: folder }),
  });
  expect(opened.status).toBe(200);
}

/** An app with a map open and a fake `claude`. The map is not linked to any session: the worker must not need one. */
async function openMapWithFakeClaude(behavior: FakeClaudeBehavior = { mode: "success" }) {
  const fake = await fixtures.startFakeClaude(behavior);
  server = await createServer({ port: 0, claudeBin: fake.bin });
  const folder = await fixtures.buildMapFolder();
  await openMap(folder);
  return { fake, folder };
}

describe("serving a request with the app's own worker", () => {
  it("starts a headless claude run for a worker request: spawns the configured CLI in the map folder with -p, the header and text as prompt, stream-json and the folder-scoped allow rules, and answers 202 {runId, via}", async () => {
    const { fake, folder } = await openMapWithFakeClaude();

    const reply = await askWorker({ text: "Make the header blue", screen: "a2-detail" });

    expect(reply.status).toBe(202);
    expect(JSON.parse(reply.body)).toEqual({ runId: expect.stringMatching(/^[0-9a-f]+$/), via: "worker" });
    await waitFor(async () => (await fake.calls()).length === 1, "the fake claude to start");
    const [call] = await fake.calls();
    const { argv } = call!;
    expect(argv[0]).toBe("-p");
    for (const part of ["Make the header blue", "Checkout flow", "a2-detail"]) expect(argv[1]).toContain(part);
    expect(argv[argv.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(argv).toContain("--verbose");
    expect(argv.slice(argv.indexOf("--allowedTools") + 1)).toEqual([
      `Read(/${folder}/**)`,
      `Edit(/${folder}/**)`,
      "Bash(python3 ~/.claude/skills/flow-map/scripts/flowmap.py *)",
    ]);
    expect(await realpath(call!.cwd)).toBe(await realpath(folder));
  });

  it("reports a run as running, then done with the result of the last stream-json result event, or failed with a clear message when the CLI reports is_error, exits non-zero, finishes without a result or cannot be started, and 404 for an unknown run id", async () => {
    const { fake, folder } = await openMapWithFakeClaude();

    // held: running until released, then done with the LAST result event (earlier ones and non-JSON lines are ignored)
    await fake.configure({ mode: "success", hold: true });
    const heldRun = runIdOf(await askWorker({ text: "Hold on" }));
    await waitFor(async () => (await fake.calls()).length === 1, "the fake claude to start");
    expect(JSON.parse((await getRun(heldRun)).body)).toEqual({ state: "running", events: [] });
    expect((await getRun(heldRun, { Host: "evil.example" })).status).toBe(403);
    await fake.release();
    expect(await finishedRun(heldRun)).toEqual({ state: "done", result: "All done", events: [] });

    const failures: { name: string; mode: "is_error" | "exit1" | "no_result"; message?: string }[] = [
      { name: "the CLI reports is_error", mode: "is_error" },
      { name: "the CLI exits non-zero", mode: "exit1" },
      { name: "the CLI exits 0 without a result event", mode: "no_result", message: "Claude finished without a result" },
    ];
    for (const { name, mode, message } of failures) {
      await fake.configure({ mode });
      const run = await finishedRun(runIdOf(await askWorker({ text: "Do it" })));
      expect(run, name).toEqual({ state: "failed", error: expect.any(String), events: [] });
      const { error } = run as { error: string };
      expect(error.length, name).toBeGreaterThan(0);
      if (message) expect(error, name).toContain(message);
    }

    // a command that does not exist
    await server!.close();
    server = await createServer({ port: 0, claudeBin: join(fake.dir, "no-such-claude") });
    await openMap(folder);
    const missing = await finishedRun(runIdOf(await askWorker({ text: "Do it" })));
    expect(missing).toEqual({ state: "failed", error: expect.stringContaining("Claude Code CLI not found"), events: [] });

    const unknown = await getRun("0123456789abcdef");
    expect(unknown.status).toBe(404);
    expect(JSON.parse(unknown.body)).toEqual({ error: expect.any(String) });
  }, 20_000);

  it("answers 409 and starts nothing when a worker run is already running, and accepts a new one once the run has ended", async () => {
    const { fake } = await openMapWithFakeClaude({ mode: "success", hold: true });
    const firstRun = runIdOf(await askWorker({ text: "First" }));
    await waitFor(async () => (await fake.calls()).length === 1, "the fake claude to start");

    const busy = await askWorker({ text: "Second" });

    expect(busy.status).toBe(409);
    expect(JSON.parse(busy.body)).toEqual({ error: expect.any(String) });
    await new Promise((done) => setTimeout(done, 200));
    expect(await fake.calls(), "the refused request started nothing").toHaveLength(1);

    await fake.configure({ mode: "success" });
    await fake.release();
    expect(await finishedRun(firstRun)).toMatchObject({ state: "done" });
    const later = runIdOf(await askWorker({ text: "Third" }));
    expect(await finishedRun(later)).toMatchObject({ state: "done" });
    expect(await fake.calls()).toHaveLength(2);
  }, 20_000);

  it("never gives the worker more power than the designer's rules: no --dangerously-skip-permissions, bypassPermissions or --bare in its arguments, and the session messaging token and socket stripped from its environment", async () => {
    setEnv("CLAUDE_CODE_MESSAGING_TOKEN", "SECRET-TOKEN-123");
    setEnv("CLAUDE_CODE_MESSAGING_SOCKET", "/tmp/fm-secret/s.sock");
    setEnv("FLOWMAP_TEST_MARKER", "still-here");
    const { fake } = await openMapWithFakeClaude();

    runIdOf(await askWorker({ text: "Do it" }));

    await waitFor(async () => (await fake.calls()).length === 1, "the fake claude to start");
    const { argv, env } = (await fake.calls())[0]!;
    for (const forbidden of ["--dangerously-skip-permissions", "bypassPermissions", "--bare"]) {
      expect(argv.join("\n"), forbidden).not.toContain(forbidden);
    }
    for (const name of MESSAGING_VARIABLES) expect(env, name).not.toHaveProperty(name);
    expect(JSON.stringify({ argv, env })).not.toContain("SECRET-TOKEN-123");
    expect(env.FLOWMAP_TEST_MARKER, "other variables are inherited").toBe("still-here");
  });
});
