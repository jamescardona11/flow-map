import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { parseStreamLine, type Denial, type ResultEvent, type RunEvent } from "./stream-events.ts";

export type RunStatus = {
  state: "running" | "needs-approval" | "done" | "failed";
  result?: string;
  error?: string;
  /** The last progress events of the run, oldest first. */
  events: RunEvent[];
  /** What the CLI denied; only while the state is `needs-approval`. */
  denials?: Denial[];
};

export type DecisionOutcome = "ok" | "unknown-run" | "not-waiting" | "bad-rules";
export type CancelOutcome = "ok" | "unknown-run" | "finished";

export const DEFAULT_WORKER_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_EVENTS = 50;
const DENIED_RESULT = "Denied by the designer.";
const CANCELLED_ERROR = "Cancelled by the designer.";
// The child is a new Claude Code run: it must not inherit the linked session's credentials.
const SESSION_VARIABLES = ["CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_MESSAGING_SOCKET"];

type RunEnd = { state: "done"; result: string } | { state: "failed"; error: string };

/** A run: what the page may see (`status`) and what only the app keeps. */
type Run = { id: string; status: RunStatus; folder: string; allowedTools: string[]; sessionId?: string; approvalTimer?: NodeJS.Timeout };

/**
 * Runs headless `claude -p` processes with the user's own Claude Code login, one run at a time.
 * A run that Claude could not finish for lack of permission waits in `needs-approval` and keeps its slot until the designer decides
 * or the worker timeout passes, which fails the run: approving resumes the same conversation with more allowed rules, for that run only.
 * Runs live in memory only. The prompt and the environment are never logged.
 */
export function createWorker(options: { claudeBin: string; timeoutMs: number }) {
  const runs = new Map<string, Run>();
  let busyRun: Run | null = null;
  let stopActive: () => void = () => {};

  /** The run is over: it gives up the slot and, when `stop` is its finished child's, that child is no longer kept to be stopped. */
  function finishRun(run: Run, end: RunEnd, stop?: () => void) {
    if (busyRun === run) busyRun = null;
    if (stop && stopActive === stop) stopActive = () => {};
    Object.assign(run.status, end);
  }

  /** Starts one process of the run: its first prompt, or a resume of its conversation. The timeout counts per process. */
  function launch(run: Run, prompt: string, resumeSession?: string) {
    const { status } = run;
    const resume = resumeSession ? ["--resume", resumeSession] : [];
    const args = ["-p", prompt, ...resume, "--output-format", "stream-json", "--verbose", "--allowedTools", ...run.allowedTools];
    const env = { ...process.env };
    for (const name of SESSION_VARIABLES) delete env[name];
    const child = spawn(options.claudeBin, args, { cwd: run.folder, env, stdio: ["ignore", "pipe", "ignore"] });

    const finish = (end: RunEnd) => finishRun(run, end, stop);
    const settle = (outcome: { result: ResultEvent } | { error: string }) => {
      if (status.state !== "running") return;
      clearTimeout(timer);
      if ("error" in outcome) return finish({ state: "failed", error: outcome.error });
      const { result } = outcome;
      if (result.denials.length === 0) return finish({ state: "done", result: result.text });
      if (!run.sessionId) return finish({ state: "failed", error: "Claude asked for permissions but gave no session to continue." });
      Object.assign(status, { state: "needs-approval", denials: result.denials }); // the run keeps the slot, for as long as the timeout
      run.approvalTimer = setTimeout(() => {
        delete status.denials;
        finish({ state: "failed", error: "Nobody answered the permission request in time" });
      }, options.timeoutMs);
    };
    const timer = setTimeout(() => {
      settle({ error: "Claude took too long and was stopped" });
      child.kill("SIGKILL");
    }, options.timeoutMs);
    const stop = () => {
      clearTimeout(timer);
      clearTimeout(run.approvalTimer);
      child.kill("SIGKILL");
    };
    stopActive = stop;

    let lastResult: ResultEvent | null = null;
    let pending = "";
    const readLine = (line: string) => {
      const parsed = parseStreamLine(line);
      run.sessionId = parsed.sessionId ?? run.sessionId;
      status.events.push(...parsed.events);
      status.events.splice(0, status.events.length - MAX_EVENTS);
      lastResult = parsed.result ?? lastResult;
    };
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      const lines = (pending + chunk).split("\n");
      pending = lines.pop()!; // the text after the last newline is a line still arriving
      lines.forEach(readLine);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      // spawn reports a missing command as ENOENT; this is not a file lookup, so isMissing does not apply
      settle({ error: error.code === "ENOENT" ? "Claude Code CLI not found" : "Claude Code could not be started." });
    });
    child.on("close", (code, signal) => {
      readLine(pending);
      if (lastResult?.isError) return settle({ error: lastResult.text || "Claude reported an error." });
      if (signal) return settle({ error: `Claude was stopped by ${signal}.` });
      if (code !== 0) return settle({ error: `Claude exited with code ${code}.` });
      if (!lastResult) return settle({ error: "Claude finished without a result" });
      settle({ result: lastResult });
    });
  }

  function start(input: { folder: string; prompt: string; allowedTools: string[] }): string {
    const runId = randomBytes(8).toString("hex");
    const run: Run = { id: runId, status: { state: "running", events: [] }, folder: input.folder, allowedTools: input.allowedTools };
    runs.set(runId, run);
    busyRun = run;
    launch(run, input.prompt);
    return runId;
  }

  /** The designer's answer to a run in `needs-approval`, only while the map folder it started on is open. Only rules the run itself suggested can be approved. */
  function decide(runId: string, decision: { allow: false } | { allow: true; rules: unknown }, folder: string | null): DecisionOutcome {
    const run = runs.get(runId);
    if (!run || run.folder !== folder) return "unknown-run";
    const { status, sessionId } = run;
    if (status.state !== "needs-approval" || !sessionId) return "not-waiting";

    if (!decision.allow) {
      clearTimeout(run.approvalTimer);
      Object.assign(status, { state: "done", result: DENIED_RESULT });
      delete status.denials;
      busyRun = null;
      return "ok";
    }
    const offered = (status.denials ?? []).flatMap((denial) => (denial.rule ? [denial.rule] : []));
    const { rules } = decision;
    const isOffered = (rule: unknown): rule is string => typeof rule === "string" && offered.includes(rule);
    if (!Array.isArray(rules) || rules.length === 0 || !rules.every(isOffered)) return "bad-rules";

    clearTimeout(run.approvalTimer);
    const approved = [...new Set<string>(rules)];
    run.allowedTools = [...new Set([...run.allowedTools, ...approved])];
    status.state = "running";
    delete status.denials;
    launch(run, `Permission granted for: ${approved.join(", ")}. Continue where you stopped.`, sessionId);
    return "ok";
  }

  /** Ends a run that is running or waiting for approval, only while the map folder it started on is open: its process is killed and the slot freed. */
  function cancel(runId: string, folder: string | null): CancelOutcome {
    const run = runs.get(runId);
    if (!run || run.folder !== folder) return "unknown-run";
    const { status } = run;
    if (status.state !== "running" && status.state !== "needs-approval") return "finished";

    stopActive();
    delete status.denials;
    finishRun(run, { state: "failed", error: CANCELLED_ERROR }, stopActive);
    return "ok";
  }

  return {
    isBusy: () => busyRun !== null,
    start,
    decide,
    cancel,
    /** The run's status, only when it belongs to `folder`: a run of another map is unknown to the page that has this one open. */
    get: (runId: string, folder: string | null) => {
      const run = runs.get(runId);
      return run && run.folder === folder ? run.status : undefined;
    },
    /** The run that holds the slot (running or waiting for approval) when it belongs to `folder`, so a page that reloaded can find it again. */
    current: (folder: string | null) => (busyRun && busyRun.folder === folder ? { runId: busyRun.id, ...busyRun.status } : undefined),
    /** Stops the run in progress, if any: the app must not leave a Claude process behind when it closes. */
    close: () => stopActive(),
  };
}
