import { realpath } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.ts";
import type { FakeClaudeInvocation } from "./fake-claude.ts";
import { createFixtures, pause, textClient, waitFor } from "./support.ts";

const MESSAGING_VARIABLES = ["CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_MESSAGING_SOCKET"];
const SESSION_ID = "sess-7f3a9c21";

type Reply = { status: number; body: string };
type Server = Awaited<ReturnType<typeof createServer>>;
type RunAnswer = { state: string; events?: unknown[]; denials?: unknown[]; result?: string; error?: string };

let server: Server | undefined;
let savedEnv: Record<string, string | undefined> = {};
const fixtures = createFixtures();
const { send } = textClient(() => server!.port);

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

function pageHeaders(): Record<string, string> {
  return { "X-Flowmap": "1", Origin: `http://127.0.0.1:${server!.port}`, "Content-Type": "application/json" };
}

/** A worker request the way the viewer page sends it. */
function askWorker(body: Record<string, unknown>): Promise<Reply> {
  return send("POST", "/__flowmap-app/request", { headers: pageHeaders(), body: JSON.stringify({ via: "worker", ...body }) });
}

/** A decision the way the viewer page sends it; `headers` replaces the page headers to test the guard. */
function decide(runId: string, body: unknown, headers: Record<string, string> = pageHeaders()): Promise<Reply> {
  return send("POST", `/__flowmap-app/runs/${runId}/decision`, { headers, body: JSON.stringify(body) });
}

/** A cancel the way the viewer page sends it; `headers` replaces the page headers to test the guard. */
function cancel(runId: string, headers: Record<string, string> = pageHeaders()): Promise<Reply> {
  return send("POST", `/__flowmap-app/runs/${runId}/cancel`, { headers });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function getRun(runId: string): Promise<RunAnswer> {
  return JSON.parse((await send("GET", `/__flowmap-app/runs/${runId}`)).body) as RunAnswer;
}

/** Polls the run until it is no longer running and returns its last answer. */
async function settledRun(runId: string): Promise<RunAnswer> {
  let last!: RunAnswer;
  await waitFor(async () => {
    last = await getRun(runId);
    return last.state !== "running";
  }, "the run to stop running");
  return last;
}

function runIdOf(reply: Reply): string {
  expect(reply.status).toBe(202);
  return (JSON.parse(reply.body) as { runId: string }).runId;
}

async function openFolder(folder: string) {
  const opened = await send("POST", "/__flowmap-app/open", { headers: { "X-Flowmap": "1", "Content-Type": "application/json" }, body: JSON.stringify({ path: folder }) });
  expect(opened.status).toBe(200);
}

/** An app with a map open and a fake `claude` that plays the given invocations, one per call. */
async function openMapWithScript(invocations: FakeClaudeInvocation[], serverOptions: { requestWindowMs?: number; workerTimeoutMs?: number } = {}) {
  const fake = await fixtures.startFakeClaude({ mode: "stream", invocations });
  server = await createServer({ port: 0, claudeBin: fake.bin, ...serverOptions });
  const folder = await fixtures.buildMapFolder();
  await openFolder(folder);
  const baseRules = [`Read(/${folder}/**)`, `Edit(/${folder}/**)`, "Bash(python3 ~/.claude/skills/flow-map/scripts/flowmap.py *)"];
  return { fake, folder, baseRules };
}

// stream-json lines as the real CLI prints them
const assistant = (...content: object[]) => ({ type: "assistant", message: { content } });
const text = (value: string) => ({ type: "text", text: value });
const tool = (name: string, input: object) => ({ type: "tool_use", name, input });
const denial = (toolName: string, input: object) => ({ tool_name: toolName, tool_use_id: `toolu_${toolName}`, tool_input: input });
const result = (value: string, denials: object[] = []) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: value,
  session_id: SESSION_ID,
  permission_denials: denials,
});
const init = { type: "system", subtype: "init", session_id: SESSION_ID };

describe("progress and approvals of a run served by the app's own Claude", () => {
  it("shows the last 50 progress events of a run while it is still running: assistant text cut to 300 characters, tool calls as name plus command or file path cut to 200, in order, and other lines ignored", async () => {
    const steps = Array.from({ length: 52 }, (_, i) => i + 1).map((n) =>
      n % 2 === 1 ? assistant(text(`step ${n}`)) : assistant(tool("Bash", { command: `echo ${n}` })),
    );
    const { fake } = await openMapWithScript([
      {
        before: [
          init,
          "this line is not JSON",
          { type: "assistant", message: { role: "assistant", content: "a message whose content is a string" } },
          ...steps,
          { type: "user", message: { content: [{ type: "tool_result", content: "ignored" }] } },
          assistant(text("x".repeat(400))),
          assistant(tool("Bash", { command: "y".repeat(300) }), tool("Read", { file_path: "/tmp/notes.md" })),
        ],
        hold: true,
        after: [result("Finished")],
      },
    ]);
    const runId = runIdOf(await askWorker({ text: "Do it" }));
    await waitFor(async () => (await fake.calls()).length === 1, "the fake claude to start");

    let run!: RunAnswer;
    await waitFor(async () => {
      run = await getRun(runId);
      return run.events?.length === 50;
    }, "50 progress events while the run is still running");

    expect(run.state).toBe("running");
    expect(run.events![0]).toEqual({ kind: "tool", name: "Bash", summary: "echo 6" }); // 55 events: the first 5 fell off
    expect(run.events!.slice(-3)).toEqual([
      { kind: "text", text: "x".repeat(300) },
      { kind: "tool", name: "Bash", summary: "y".repeat(200) },
      { kind: "tool", name: "Read", summary: "/tmp/notes.md" },
    ]);
    expect(run.events![1]).toEqual({ kind: "text", text: "step 7" });
  }, 20_000);

  it("a result with permission_denials leaves the run in needs-approval with the worker slot taken, and lists each denial with the minimal allow rule; the session id is not in the response", async () => {
    const denials = [
      { call: denial("Bash", { command: "git status && ls" }), expected: { tool: "Bash", summary: "git status && ls", rule: "Bash(git status && ls)" } },
      { call: denial("Bash", { command: "ls *.md" }), expected: { tool: "Bash", summary: "ls *.md", rule: null } }, // an exact rule would be read as a wildcard
      { call: denial("Read", { file_path: "/Users/me/map/notes.md" }), expected: { tool: "Read", summary: "/Users/me/map/notes.md", rule: "Read(//Users/me/map/notes.md)" } },
      { call: denial("Edit", { file_path: "/Users/me/map/a.html" }), expected: { tool: "Edit", summary: "/Users/me/map/a.html", rule: "Edit(//Users/me/map/a.html)" } },
      { call: denial("Write", { file_path: "/Users/me/map/new.html" }), expected: { tool: "Write", summary: "/Users/me/map/new.html", rule: "Edit(//Users/me/map/new.html)" } },
      {
        call: denial("Edit", { file_path: "/Users/me/we*ird?[1]\\x.md" }),
        expected: { tool: "Edit", summary: "/Users/me/we*ird?[1]\\x.md", rule: "Edit(//Users/me/we\\*ird\\?\\[1\\]\\\\x.md)" },
      },
      { call: denial("WebFetch", { url: "https://example.com/page", prompt: "summarise" }), expected: { tool: "WebFetch", summary: "https://example.com/page", rule: null } },
      { call: denial("ExitPlanMode", {}), expected: { tool: "ExitPlanMode", summary: "", rule: "ExitPlanMode" } },
    ];
    const { fake } = await openMapWithScript([{ before: [init, assistant(text("Trying")), result("I could not finish", denials.map((d) => d.call))] }]);

    const runId = runIdOf(await askWorker({ text: "Do it" }));

    const run = await settledRun(runId);
    expect(run.state).toBe("needs-approval");
    expect(run.denials).toEqual(denials.map((d) => d.expected));
    expect((await send("GET", `/__flowmap-app/runs/${runId}`)).body).not.toContain(SESSION_ID);
    const busy = await askWorker({ text: "Another" });
    expect(busy.status, "the slot stays taken while the run waits for the designer").toBe(409);
    await new Promise((done) => setTimeout(done, 200));
    expect(await fake.calls()).toHaveLength(1);
  }, 20_000);

  it("approving resumes the same run: claude -p --resume with the previous rules plus only the approved ones, in the same folder and without session variables; the run keeps its events, a second round of denials asks again, the approval does not outlive the run, and resuming takes no request slot", async () => {
    setEnv("CLAUDE_CODE_MESSAGING_TOKEN", "SECRET-TOKEN-123");
    setEnv("CLAUDE_CODE_MESSAGING_SOCKET", "/tmp/fm-secret/s.sock");
    const { fake, folder, baseRules } = await openMapWithScript(
      [
        { before: [init, assistant(text("Reading the map")), result("Blocked", [denial("Bash", { command: "npm test" }), denial("Read", { file_path: "/etc/hosts" })])] },
        { before: [assistant(text("Tests ran"))], hold: true, after: [result("Blocked again", [denial("Bash", { command: "npm run build" })])] },
        { before: [result("Build passed")] },
      ],
      { requestWindowMs: 60_000 },
    );
    const runId = runIdOf(await askWorker({ text: "Check the build" }));
    expect((await settledRun(runId)).state).toBe("needs-approval");

    const first = await decide(runId, { allow: true, rules: ["Bash(npm test)"] });

    expect(first.status).toBe(202);
    expect(JSON.parse(first.body)).toEqual({ runId });
    let resumed!: RunAnswer;
    await waitFor(async () => {
      resumed = await getRun(runId);
      return JSON.stringify(resumed.events ?? []).includes("Tests ran");
    }, "the resumed run to report progress");
    expect(resumed.state).toBe("running");
    expect(resumed.events).toEqual([
      { kind: "text", text: "Reading the map" },
      { kind: "text", text: "Tests ran" },
    ]);
    await fake.release();
    const second = await settledRun(runId);
    expect(second.state).toBe("needs-approval");
    expect(second.denials).toEqual([{ tool: "Bash", summary: "npm run build", rule: "Bash(npm run build)" }]);

    expect((await decide(runId, { allow: true, rules: ["Bash(npm run build)"] })).status).toBe(202);
    expect(await settledRun(runId)).toMatchObject({ state: "done", result: "Build passed" });

    const [firstCall, firstResume, secondResume] = await fake.calls();
    expect(await fake.calls()).toHaveLength(3);
    const allowedTools = (argv: string[]) => argv.slice(argv.indexOf("--allowedTools") + 1);
    expect(allowedTools(firstCall!.argv)).toEqual(baseRules);
    expect(firstResume!.argv.slice(0, 2)).toEqual(["-p", "Permission granted for: Bash(npm test). Continue where you stopped."]);
    expect(secondResume!.argv.slice(0, 2)).toEqual(["-p", "Permission granted for: Bash(npm run build). Continue where you stopped."]);
    for (const resume of [firstResume!, secondResume!]) {
      expect(resume.argv[resume.argv.indexOf("--resume") + 1]).toBe(SESSION_ID);
      expect(resume.argv[resume.argv.indexOf("--output-format") + 1]).toBe("stream-json");
      expect(resume.argv).toContain("--verbose");
      expect(await realpath(resume.cwd)).toBe(await realpath(folder));
      expect(resume.argv.join("\n")).not.toMatch(/--dangerously-skip-permissions|bypassPermissions|--bare/);
      for (const name of MESSAGING_VARIABLES) expect(resume.env, name).not.toHaveProperty(name);
      expect(JSON.stringify(resume)).not.toContain("SECRET-TOKEN-123");
    }
    expect(allowedTools(firstResume!.argv), "Read of /etc/hosts was not approved").toEqual([...baseRules, "Bash(npm test)"]);
    expect(allowedTools(secondResume!.argv)).toEqual([...baseRules, "Bash(npm test)", "Bash(npm run build)"]);

    // the approvals belong to that run: later runs start from the folder rules, and the window of 5 requests was used by 5 runs, not by the 2 resumes
    for (let n = 1; n <= 4; n++) {
      const later = runIdOf(await askWorker({ text: `Later ${n}` }));
      await settledRun(later);
    }
    const laterCalls = await fake.calls();
    expect(allowedTools(laterCalls[3]!.argv)).toEqual(baseRules);
    expect(laterCalls[3]!.argv).not.toContain("--resume");
  }, 20_000);

  it("refuses a decision that is not valid (403, 404, 409, 400) without starting anything, and a denial ends the run as done with 'Denied by the designer.' and frees the slot", async () => {
    const needsApproval = { before: [init, result("Blocked", [denial("Bash", { command: "npm test" }), denial("WebFetch", { url: "https://example.com" })])] };
    const { fake } = await openMapWithScript([needsApproval, { before: [init], hold: true, after: [result("Resumed")] }, needsApproval]);
    const runId = runIdOf(await askWorker({ text: "Do it" }));
    expect((await settledRun(runId)).state).toBe("needs-approval");
    const stillWaiting = async () => {
      expect(await fake.calls(), "the refused decision started nothing").toHaveLength(1);
      expect((await getRun(runId)).state).toBe("needs-approval");
    };

    const withoutMarker = { Origin: pageHeaders().Origin!, "Content-Type": "application/json" };
    const refusals: { name: string; status: number; reply: () => Promise<Reply> }[] = [
      { name: "no X-Flowmap header", status: 403, reply: () => decide(runId, { allow: true, rules: ["Bash(npm test)"] }, withoutMarker) },
      { name: "another origin", status: 403, reply: () => decide(runId, { allow: true, rules: ["Bash(npm test)"] }, { ...pageHeaders(), Origin: "http://evil.example" }) },
      { name: "an unknown run", status: 404, reply: () => decide("0123456789abcdef", { allow: true, rules: ["Bash(npm test)"] }) },
      { name: "a rule the app never suggested", status: 400, reply: () => decide(runId, { allow: true, rules: ["Bash(rm -rf *)"] }) },
      { name: "a wildcard version of a suggested rule", status: 400, reply: () => decide(runId, { allow: true, rules: ["Bash(npm *)"] }) },
      { name: "one good rule next to a bad one", status: 400, reply: () => decide(runId, { allow: true, rules: ["Bash(npm test)", "Bash(curl *)"] }) },
      { name: "the null rule of a denial that cannot be approved", status: 400, reply: () => decide(runId, { allow: true, rules: [null] }) },
      { name: "an empty list of rules", status: 400, reply: () => decide(runId, { allow: true, rules: [] }) },
      { name: "rules that are not a list", status: 400, reply: () => decide(runId, { allow: true, rules: "Bash(npm test)" }) },
    ];
    for (const { name, status, reply } of refusals) {
      expect((await reply()).status, name).toBe(status);
      await stillWaiting();
    }

    // a decision on a run that is not waiting: running, then done
    expect((await decide(runId, { allow: true, rules: ["Bash(npm test)"] })).status).toBe(202);
    await waitFor(async () => (await fake.calls()).length === 2, "the resume to start");
    expect((await decide(runId, { allow: true, rules: ["Bash(npm test)"] })).status, "while running").toBe(409);
    expect((await decide(runId, { allow: false })).status, "while running").toBe(409);
    expect(await fake.calls()).toHaveLength(2);
    await fake.release();
    expect(await settledRun(runId)).toMatchObject({ state: "done", result: "Resumed" });
    expect((await decide(runId, { allow: false })).status, "when done").toBe(409);

    // denying
    const secondRun = runIdOf(await askWorker({ text: "Again" }));
    expect((await settledRun(secondRun)).state).toBe("needs-approval");
    const denied = await decide(secondRun, { allow: false });
    expect(denied.status).toBeLessThan(300);
    expect(await getRun(secondRun)).toMatchObject({ state: "done", result: "Denied by the designer." });
    expect(await fake.calls(), "denying starts nothing").toHaveLength(3);
    runIdOf(await askWorker({ text: "The slot is free" }));
  }, 20_000);

  it("shows the whole Bash command of a denial next to a rule for exactly that command, and offers no rule when the command, or the path of a file tool, is over 2000 characters", async () => {
    const longCommand = `echo ${"a".repeat(295)} && rm -rf /tmp/hidden-tail`; // 300+ characters: the dangerous tail is past the old cut of 200
    const hugeCommand = `echo ${"b".repeat(2100)}`;
    const hugePath = `/Users/me/map/${"c".repeat(2100)}`;
    const fileTools = ["Read", "Edit", "Write"];
    const denials = [denial("Bash", { command: longCommand }), denial("Bash", { command: hugeCommand }), ...fileTools.map((name) => denial(name, { file_path: hugePath }))];
    await openMapWithScript([{ before: [init, result("Blocked", denials)] }]);

    const run = await settledRun(runIdOf(await askWorker({ text: "Do it" })));

    expect(run.state).toBe("needs-approval");
    expect(run.denials).toEqual([
      { tool: "Bash", summary: longCommand, rule: `Bash(${longCommand})` },
      { tool: "Bash", summary: expect.stringContaining("bbbb"), rule: null },
      ...fileTools.map((name) => ({ tool: name, summary: expect.stringContaining("cccc"), rule: null })),
    ]);
  }, 20_000);

  it("answers the run in progress, with its runId and its approval request, and 404 once it is over", async () => {
    await openMapWithScript([{ before: [init, result("Blocked", [denial("Bash", { command: "npm test" })])] }]);
    const runId = runIdOf(await askWorker({ text: "Do it" }));
    expect((await settledRun(runId)).state).toBe("needs-approval");

    const current = await send("GET", "/__flowmap-app/runs/current");

    expect(current.status).toBe(200);
    expect(JSON.parse(current.body)).toMatchObject({
      runId,
      state: "needs-approval",
      denials: [{ tool: "Bash", summary: "npm test", rule: "Bash(npm test)" }],
    });

    expect((await decide(runId, { allow: false })).status).toBeLessThan(300);

    const over = await send("GET", "/__flowmap-app/runs/current");
    expect(over.status).toBe(404);
    expect(JSON.parse(over.body)).toEqual({ error: "no run in progress" });
  }, 20_000);

  it("answers the run in progress only while the map folder it started on is open, and 404 while another map is open", async () => {
    const { folder } = await openMapWithScript([{ before: [init, result("Blocked", [denial("Bash", { command: "npm test" })])] }]);
    const runId = runIdOf(await askWorker({ text: "Do it" }));
    expect((await settledRun(runId)).state).toBe("needs-approval");
    const otherFolder = await fixtures.buildMapFolder();

    await openFolder(otherFolder);
    const whileOtherMapIsOpen = await send("GET", "/__flowmap-app/runs/current");
    await openFolder(folder);
    const backOnTheFirstMap = await send("GET", "/__flowmap-app/runs/current");

    expect(whileOtherMapIsOpen.status).toBe(404);
    expect(JSON.parse(whileOtherMapIsOpen.body)).toEqual({ error: "no run in progress" });
    expect(backOnTheFirstMap.status).toBe(200);
    expect(JSON.parse(backOnTheFirstMap.body)).toMatchObject({ runId, state: "needs-approval" });
  }, 20_000);

  it("answers a run by its id only while the map folder it started on is open, and 404 \"unknown run\" while another map is open", async () => {
    const { folder } = await openMapWithScript([{ before: [init, result("Blocked", [denial("Bash", { command: "npm test" })])] }]);
    const runId = runIdOf(await askWorker({ text: "Do it" }));
    expect((await settledRun(runId)).state).toBe("needs-approval");
    const otherFolder = await fixtures.buildMapFolder();
    const get = () => send("GET", `/__flowmap-app/runs/${runId}`);

    const whileItsMapIsOpen = await get();
    await openFolder(otherFolder);
    const whileOtherMapIsOpen = await get();
    await openFolder(folder);
    const backOnItsMap = await get();

    expect(whileItsMapIsOpen.status).toBe(200);
    expect(whileOtherMapIsOpen.status).toBe(404);
    expect(JSON.parse(whileOtherMapIsOpen.body)).toEqual({ error: "unknown run" });
    expect(backOnItsMap.status).toBe(200);
  }, 20_000);

  it("takes a decision for a run only while the map folder it started on is open: 404 \"unknown run\" and the run keeps waiting while another map is open, accepted once its map is open again", async () => {
    const { folder, fake } = await openMapWithScript([
      { before: [init, result("Blocked", [denial("Bash", { command: "npm test" })])] },
      { before: [result("Resumed")] },
    ]);
    const runId = runIdOf(await askWorker({ text: "Do it" }));
    expect((await settledRun(runId)).state).toBe("needs-approval");
    const approve = () => decide(runId, { allow: true, rules: ["Bash(npm test)"] });

    await openFolder(await fixtures.buildMapFolder());
    const fromOtherMap = await approve();
    await openFolder(folder);
    const stillWaiting = await getRun(runId);
    const fromItsMap = await approve();

    expect(fromOtherMap.status).toBe(404);
    expect(JSON.parse(fromOtherMap.body)).toEqual({ error: "unknown run" });
    expect(stillWaiting.state).toBe("needs-approval");
    expect(fromItsMap.status).toBe(202);
    expect(await settledRun(runId)).toMatchObject({ state: "done", result: "Resumed" });
    expect(await fake.calls(), "only the accepted decision resumed the run").toHaveLength(2);
  }, 20_000);

  it("a run nobody answers in needs-approval fails after the worker timeout and frees the slot for a new worker run", async () => {
    await openMapWithScript([{ before: [init, result("Blocked", [denial("Bash", { command: "npm test" })])] }], { workerTimeoutMs: 1500 });
    const runId = runIdOf(await askWorker({ text: "Do it" }));
    await waitFor(async () => (await getRun(runId)).state === "needs-approval", "the run to wait for approval");
    expect((await askWorker({ text: "Too early" })).status, "while the run waits within its timeout").toBe(409);

    await waitFor(async () => (await getRun(runId)).state === "failed", "the unanswered run to expire");

    expect((await getRun(runId)).error).toMatch(/permission/i);
    runIdOf(await askWorker({ text: "The slot is free" }));
  }, 20_000);

  it("cancels a run waiting for approval or running: refused with 403 or 404 without touching it, otherwise its process is killed, it fails with 'Cancelled by the designer.' and the slot is free for a new worker run", async () => {
    const { fake, folder } = await openMapWithScript([
      { before: [init, result("Blocked", [denial("Bash", { command: "npm test" })])] },
      { before: [init], hold: true, after: [result("Too late")] },
      { before: [init], hold: true },
    ]);
    const waiting = runIdOf(await askWorker({ text: "Do it" }));
    expect((await settledRun(waiting)).state).toBe("needs-approval");

    // refused cancels leave the run waiting
    const withoutMarker = { Origin: pageHeaders().Origin!, "Content-Type": "application/json" };
    expect((await cancel(waiting, withoutMarker)).status, "no X-Flowmap header").toBe(403);
    expect((await cancel(waiting, { ...pageHeaders(), Origin: "http://evil.example" })).status, "another origin").toBe(403);
    expect((await cancel("0123456789abcdef")).status, "an unknown run").toBe(404);
    await openFolder(await fixtures.buildMapFolder());
    expect((await cancel(waiting)).status, "while another map is open").toBe(404);
    await openFolder(folder);
    expect((await getRun(waiting)).state).toBe("needs-approval");

    // waiting for approval: no process is left, the run just ends
    const cancelledWaiting = await cancel(waiting);
    expect(cancelledWaiting.status).toBe(200);
    expect(JSON.parse(cancelledWaiting.body)).toEqual({ runId: waiting });
    expect(await getRun(waiting)).toMatchObject({ state: "failed", error: "Cancelled by the designer." });
    expect((await getRun(waiting)).denials).toBeUndefined();

    // the slot is free: a new run starts and, while it is running, its process is killed by the cancel
    const running = runIdOf(await askWorker({ text: "Again" }));
    await waitFor(async () => (await fake.calls()).length === 2, "the second run to start");
    const { pid } = (await fake.calls())[1]!;
    expect(isAlive(pid)).toBe(true);
    const cancelledRunning = await cancel(running);
    expect(cancelledRunning.status).toBe(200);
    expect(JSON.parse(cancelledRunning.body)).toEqual({ runId: running });
    await waitFor(() => !isAlive(pid), "the cancelled run's process to be killed");
    await pause(100); // the killed process must not rewrite the outcome when it closes
    expect(await getRun(running)).toMatchObject({ state: "failed", error: "Cancelled by the designer." });

    runIdOf(await askWorker({ text: "The slot is free" }));
  }, 20_000);

  it("answers 409 to a cancel of a run that is already done or failed, and changes nothing", async () => {
    await openMapWithScript([
      { before: [init, result("All good")] },
      { before: [{ type: "result", subtype: "error_during_execution", result: "Something broke", is_error: true }] },
    ]);
    const done = runIdOf(await askWorker({ text: "Works" }));
    expect(await settledRun(done)).toMatchObject({ state: "done", result: "All good" });
    const failed = runIdOf(await askWorker({ text: "Breaks" }));
    expect(await settledRun(failed)).toMatchObject({ state: "failed", error: "Something broke" });

    expect((await cancel(done)).status, "a done run").toBe(409);
    expect((await cancel(failed)).status, "a failed run").toBe(409);

    expect(await getRun(done)).toMatchObject({ state: "done", result: "All good" });
    expect(await getRun(failed)).toMatchObject({ state: "failed", error: "Something broke" });
  }, 20_000);
});
