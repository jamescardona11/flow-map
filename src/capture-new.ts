import { join } from "node:path";
import type { MapData, MapScreen } from "./map-check.ts";
import { flowOf, singleLine, slugOf, uniqueId } from "./new-screen.ts";
import { FLOW_MAP_COMMAND, mapText, ONE_COMMAND_AT_A_TIME_RULE, shellQuote, viewportOf } from "./skill-command.ts";

/** What to do to capture what the app shows now, by the map's platform. Web needs the page's address, which the app does not know. */
function captureSteps(platform: unknown, viewport: { width: number; height: number }, png: string): string[] {
  if (platform === "ios" || platform === "android") {
    return [
      `1. With the agent-device CLI, open the app on the ${platform === "ios" ? "iOS simulator" : "Android emulator"} and navigate to the screen the designer describes (it may already be showing).`,
      `2. Take a screenshot of that screen and save it as \`${png}\`.`,
    ];
  }
  return [
    "1. Find the page the designer describes. If the page's address is not in the designer's note, ask the designer for the app's dev URL.",
    `2. Capture that page and save it as \`${png}\`: \`npx playwright screenshot --viewport-size=${viewport.width},${viewport.height} <url> ${shellQuote(png)}\``,
  ];
}

/**
 * The prompt that asks Claude to capture what the app shows now and add it to the map as a new screen: the app captures nothing itself.
 * The id, the capture path and the exact skill command are decided here. `folder` is the map folder's real path.
 */
export function buildCapturePrompt(input: {
  folder: string;
  map: MapData;
  title: string;
  /** The screen the new one is reached from, when the designer gave one. */
  from: MapScreen | undefined;
  action: string | undefined;
  note: string | undefined;
}): string {
  const { folder, map, from } = input;
  const title = singleLine(input.title);
  const action = singleLine(input.action ?? "");
  const note = input.note?.trim() ?? "";
  const flow = flowOf(map, from);
  const id = uniqueId(slugOf(title), new Set(map.screens.map((screen) => screen.id)), []);
  const png = join(folder, "screens-src", `${id}.capture.png`);
  const addFlags = [
    `--id ${shellQuote(id)}`,
    `--title ${shellQuote(title)}`,
    `--flow ${shellQuote(flow)}`,
    `--image ${shellQuote(png)}`,
    ...(from ? [`--from ${shellQuote(from.id)}`, ...(action ? [`--action ${shellQuote(action)}`] : [])] : []),
  ];
  const lines = [
    `Capture request from the Flow Map app for the map "${mapText(map.title)}".`,
    "",
    "Capture what the app shows right now and add it to the map as a new screen.",
    `- New screen id: ${id}`,
    `- Title: ${title}`,
    `- Platform: ${typeof map.platform === "string" ? mapText(map.platform) : "unknown"}`,
    `- Flow: ${mapText(flow)}`,
    ...(from ? [`- Reached from: ${mapText(from.id)}${action ? ` (${action})` : ""}`] : []),
    ...(note !== "" ? ["", "Designer's note:", note] : []),
    "",
    ONE_COMMAND_AT_A_TIME_RULE,
    ...captureSteps(map.platform, viewportOf(map.platform, from), png),
    `3. Open the capture with Read. Do not register it if it is blank or clipped, or shows an error or a loading state, or is identical to a screen the map already has: say so in your answer instead. If it is a screen the map already has, reached from another screen by a new action, add only the transition with the skill's \`link\` command (\`${FLOW_MAP_COMMAND} link <folder> --from <screen> --to <screen> --action <action>\`).`,
    "4. Otherwise register it in the map:",
    `${FLOW_MAP_COMMAND} add ${[shellQuote(folder), ...addFlags].join(" ")}`,
    "5. End your final answer with one line that reports the JSON the command printed.",
  ];
  return lines.join("\n");
}
