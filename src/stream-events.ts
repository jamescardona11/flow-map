import { escapePathPattern } from "./session-help.ts";

export type RunEvent = { kind: "text"; text: string } | { kind: "tool"; name: string; summary: string };
/** A tool call the CLI denied. `rule` is the allow rule that would permit exactly that call, or null when the app cannot offer one. */
export type Denial = { tool: string; summary: string; rule: string | null };
export type ResultEvent = { text: string; isError: boolean; denials: Denial[] };
export type StreamLine = { events: RunEvent[]; sessionId?: string; result?: ResultEvent };

const MAX_RESULT_LENGTH = 20_000;
const MAX_TEXT_LENGTH = 300;
const MAX_SUMMARY_LENGTH = 200;
const MAX_DENIAL_SUMMARY_LENGTH = 2000; // a denial's summary is what the designer approves: it must show the whole command
const FILE_TOOLS = ["Read", "Edit", "Write"];

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

/** What a tool call acts on: its command or file path, else its first text input. */
function summarize(input: Json, maxLength = MAX_SUMMARY_LENGTH): string {
  const { command, file_path: filePath } = input;
  const chosen =
    typeof command === "string" ? command : typeof filePath === "string" ? filePath : Object.values(input).find((value) => typeof value === "string");
  return typeof chosen === "string" ? chosen.slice(0, maxLength) : "";
}

/** The minimal allow rule for one denied call: the exact command (unless it has a `*`) or path, the bare tool name when it has no input, else none. */
function allowRuleFor(tool: string, input: Json): string | null {
  const { command, file_path: filePath } = input;
  if (tool === "Bash" && typeof command === "string") {
    if (command.length > MAX_DENIAL_SUMMARY_LENGTH) return null; // the designer could not see all of it
    return command.includes("*") ? null : `Bash(${command})`; // the CLI reads `*` in a rule as a wildcard: the rule would allow more than this call
  }
  if (FILE_TOOLS.includes(tool) && typeof filePath === "string" && filePath.startsWith("/")) {
    if (filePath.length > MAX_DENIAL_SUMMARY_LENGTH) return null; // the designer could not see all of it
    return `${tool === "Read" ? "Read" : "Edit"}(/${escapePathPattern(filePath)})`;
  }
  return Object.keys(input).length === 0 ? tool : null;
}

function parseDenials(value: unknown): Denial[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): Denial[] => {
    const denial = asObject(entry);
    if (!denial || typeof denial.tool_name !== "string") return [];
    const input = asObject(denial.tool_input) ?? {};
    return [{ tool: denial.tool_name, summary: summarize(input, MAX_DENIAL_SUMMARY_LENGTH), rule: allowRuleFor(denial.tool_name, input) }];
  });
}

function parseAssistantEvents(message: unknown): RunEvent[] {
  const content = asObject(message)?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((entry): RunEvent[] => {
    const block = asObject(entry);
    if (block?.type === "text" && typeof block.text === "string") return [{ kind: "text", text: block.text.slice(0, MAX_TEXT_LENGTH) }];
    if (block?.type === "tool_use" && typeof block.name === "string") {
      return [{ kind: "tool", name: block.name, summary: summarize(asObject(block.input) ?? {}) }];
    }
    return [];
  });
}

/** What one stream-json line says: progress events, the session id and the final result. Anything that is not such a line says nothing. */
export function parseStreamLine(line: string): StreamLine {
  let event: Json | null;
  try {
    event = asObject(JSON.parse(line));
  } catch {
    return { events: [] };
  }
  if (!event) return { events: [] };
  const sessionId = typeof event.session_id === "string" ? event.session_id : undefined;
  if (event.type === "assistant") return { events: parseAssistantEvents(event.message), sessionId };
  if (event.type === "result") {
    const text = typeof event.result === "string" ? event.result.slice(0, MAX_RESULT_LENGTH) : "";
    return { events: [], sessionId, result: { text, isError: event.is_error === true, denials: parseDenials(event.permission_denials) } };
  }
  return { events: [], sessionId };
}
