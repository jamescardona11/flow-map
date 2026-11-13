import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { MapData, MapScreen } from "./map-check.ts";
import { FLOW_MAP_COMMAND, mapText, ONE_COMMAND_AT_A_TIME_RULE, shellQuote, viewportOf } from "./skill-command.ts";

const MAX_NEIGHBOURS = 2;
const EXTRA_STATES = ["empty", "loading", "error"] as const;
const STATES = ["normal", ...EXTRA_STATES];

/** Lowercase letters, digits and dashes: accents lose their mark, apostrophes vanish, any other run of characters becomes one dash. */
export function slugOf(title: string): string {
  const slug = title
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "screen" : slug;
}

/** The first of slug, slug-2, slug-3... such that neither it nor the ids of its `states` (slug-empty...) are taken. */
export function uniqueId(slug: string, taken: Set<string>, states: readonly string[] = EXTRA_STATES): string {
  const isFree = (id: string) => ![id, ...states.map((state) => `${id}-${state}`)].some((candidate) => taken.has(candidate));
  if (isFree(slug)) return slug;
  let n = 2;
  while (!isFree(`${slug}-${n}`)) n += 1;
  return `${slug}-${n}`;
}

export function singleLine(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/** The flow of the screen it is reached from; without one, the flow of the entry screen, else the first screen's, else the first flow. */
export function flowOf(map: MapData, from: MapScreen | undefined): string {
  const candidates = [from, map.screens.find((screen) => screen.id === map.entry), map.screens[0]];
  for (const screen of candidates) if (typeof screen?.flow === "string") return screen.flow;
  const firstFlow = Array.isArray(map.flows) ? (map.flows[0] as { id?: unknown } | undefined) : undefined;
  return typeof firstFlow?.id === "string" ? firstFlow.id : "main";
}

/**
 * The prompt that asks Claude for a new screen: everything it needs (id, paths, viewport, the exact skill command) is decided here,
 * so nothing is left for the app to guess later. `folder` is the map folder's real path.
 */
export function buildNewScreenPrompt(input: {
  folder: string;
  map: MapData;
  /** The real path of each screen's capture that exists inside the map folder, by screen id: a neighbour without one is left out. */
  captures: Map<string, string>;
  title: string;
  description: string | undefined;
  from: string | undefined;
  action: string | undefined;
  /** The text of the map's DESIGN.md, or null when it has none. */
  design: string | null;
}): { id: string; prompt: string } {
  const { folder, map } = input;
  const title = singleLine(input.title);
  const description = input.description?.trim() ?? "";
  const action = singleLine(input.action ?? "");
  const fromScreen = map.screens.find((screen) => screen.id === input.from);
  const flow = flowOf(map, fromScreen);
  const id = uniqueId(slugOf(title), new Set(map.screens.map((screen) => screen.id)));
  const { width, height } = viewportOf(map.platform, fromScreen);

  const sourceDir = join(folder, "screens-src");
  const html = join(sourceDir, `${id}.html`);
  const pngOf = (state: string) => join(sourceDir, state === "normal" ? `${id}.png` : `${id}.${state}.png`);
  const neighbours = map.screens
    .filter((screen) => screen.flow === flow && screen.id !== fromScreen?.id && input.captures.has(screen.id))
    .slice(0, MAX_NEIGHBOURS);

  const normalAdd = [
    `--id ${shellQuote(id)}`,
    `--title ${shellQuote(title)}`,
    `--flow ${shellQuote(flow)}`,
    `--image ${shellQuote(`screens-src/${id}.png`)}`,
    ...(fromScreen ? [`--from ${shellQuote(fromScreen.id)}`, ...(action ? [`--action ${shellQuote(action)}`] : [])] : []),
    ...(description ? [`--description ${shellQuote(description)}`] : []),
  ];
  const extraAdd = (state: string) => [
    `--id ${shellQuote(`${id}-${state}`)}`,
    `--title ${shellQuote(`${title} (${state})`)}`,
    `--flow ${shellQuote(flow)}`,
    `--image ${shellQuote(`screens-src/${id}.${state}.png`)}`,
    `--from ${shellQuote(id)}`,
    `--action ${shellQuote(`state: ${state}`)}`,
    `--description ${shellQuote(`${state} state of ${title}`)}`,
  ];
  const addLine = (flags: string[]) => `${FLOW_MAP_COMMAND} add ${[shellQuote(folder), ...flags].join(" ")}`;

  const contract = input.design !== null && input.design.trim() !== "" ? input.design : null;
  const lines = [
    `New screen request from the Flow Map app for the map "${mapText(map.title)}".`,
    "",
    "Create a new screen in this map.",
    `- New screen id: ${id}`,
    `- Title: ${title}`,
    `- Description: ${description || "(none given)"}`,
    `- Flow: ${mapText(flow)}`,
    fromScreen
      ? `- Reached from: ${mapText(fromScreen.id)} (flow ${mapText(flow)}), whose capture is \`${input.captures.get(fromScreen.id)}\``
      : "- Reached from: no screen. It has no incoming transition: leave out --from and --action on the first add command (the other three still use --from).",
    ...(fromScreen ? [`- Transition from ${mapText(fromScreen.id)}: ${action || "(none given)"}`] : []),
    `- Viewport: ${width}x${height}`,
    "",
    ...(contract !== null
      ? [
          "## Design contract of this map",
          "The designer wrote this contract for the whole map. Follow it: it takes precedence over copying the neighbouring screens.",
          "",
          contract,
          "",
        ]
      : ["This map has no design contract: infer the look from the neighbouring captures.", ""]),
    ...(neighbours.length > 0
      ? [
          contract !== null
            ? "The neighbouring screens of this flow show the layout in use. Open their captures with Read:"
            : "Match the look of the neighbouring screens of this flow. Open their captures with Read:",
          ...neighbours.map((screen) => `- ${mapText(screen.id)}: \`${input.captures.get(screen.id)}\``),
          "",
        ]
      : []),
    ONE_COMMAND_AT_A_TIME_RULE,
    `1. Write ONE self-contained HTML mock (inline CSS and script, no external files) at \`${html}\`. The state it shows is chosen by \`#state=<name>\` in the URL (default normal):`,
    "- normal: the screen with its content.",
    "- empty: the screen with no data yet, with an empty message and what to do next.",
    "- loading: the screen while its content loads (skeletons or a spinner).",
    "- error: the screen when loading failed, with a message and a way to retry.",
    "2. Render each state to its own PNG at the viewport size:",
    ...STATES.map(
      (state) =>
        `npx playwright screenshot --viewport-size=${width},${height} ${shellQuote(`${pathToFileURL(html).href}#state=${state}`)} ${shellQuote(pngOf(state))}`,
    ),
    "3. Register the four states in the map with the flow-map skill, running these four commands in this order (the first one creates the screen the others link from):",
    addLine(normalAdd),
    ...EXTRA_STATES.map((state) => addLine(extraAdd(state))),
    "4. Register the HTML mock of the new screen with the skill's html command (it copies the file into screens-src and sets the screen's html key; the three state screens get none):",
    `${FLOW_MAP_COMMAND} html ${[shellQuote(folder), "--id", shellQuote(id), "--file", shellQuote(html)].join(" ")}`,
    "5. Verify the result before you answer: run the skill check command and open each rendered PNG with Read to check that it is not blank or clipped, and that the states look like the same screen.",
    `${FLOW_MAP_COMMAND} check ${shellQuote(folder)}`,
    contract !== null
      ? "Compare the normal state with the neighbouring captures and check it against the design contract."
      : "Compare the normal state with the neighbouring captures.",
    "Fix what is wrong and render again. End your final answer with a short verification report: the result of check, then one line per state (normal, empty, loading, error), saying what you checked.",
  ];
  return { id, prompt: lines.join("\n") };
}
