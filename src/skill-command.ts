/** The command of the flow-map skill: the prompts tell Claude to run it and the permission rules allow exactly it. */
export const FLOW_MAP_COMMAND = "python3 ~/.claude/skills/flow-map/scripts/flowmap.py";

/** One line for the prompts: only commands that match the permission rules run unprompted, so Claude must not chain, pipe or script them. */
export const ONE_COMMAND_AT_A_TIME_RULE =
  "Run each shell command on its own, exactly as written (only the placeholders filled in): no `cd`, no `&&`, `;` or `|` pipes, no inline scripts (`python -c`, `node -e`). Inspect a PNG only with Read.";

const MOBILE_VIEWPORT = { width: 390, height: 844 };
const WEB_VIEWPORT = { width: 1440, height: 900 };

export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

const MAX_MAP_TEXT_LENGTH = 200;

/** A value read from map.json, as prose in a prompt: one line (whitespace runs, newlines included, become one space) of at most 200 characters. */
export function mapText(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, MAX_MAP_TEXT_LENGTH);
}

export function positive(value: unknown): value is number {
  return typeof value === "number" && value > 0;
}

/** The size of the screen when it has one, else the default of the platform: a phone for ios and android, a desktop window otherwise. */
export function viewportOf(platform: unknown, screen: { width?: unknown; height?: unknown } | undefined): { width: number; height: number } {
  if (screen && positive(screen.width) && positive(screen.height)) return { width: screen.width, height: screen.height };
  return platform === "ios" || platform === "android" ? MOBILE_VIEWPORT : WEB_VIEWPORT;
}
