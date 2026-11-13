import { join } from "node:path";
import type { MapScreen } from "./map-check.ts";
import { FLOW_MAP_COMMAND, mapText, ONE_COMMAND_AT_A_TIME_RULE, shellQuote, viewportOf } from "./skill-command.ts";

/** What to do to capture the same screen again, by the map's platform. Web needs the page's address, which the app does not know. */
function captureSteps(platform: unknown, screen: MapScreen, png: string): string[] {
  if (platform === "ios" || platform === "android") {
    return [
      `1. With the agent-device CLI, open the app on the ${platform === "ios" ? "iOS simulator" : "Android emulator"} and navigate until it shows the same screen as the current capture (open the current capture with Read to compare).`,
      `2. Take a screenshot of that screen and save it as \`${png}\`. If you can, also save its accessibility tree (\`agent-device snapshot\`) as text and pass that file with \`--tree <file>\` at the end of the command in step 4: it makes the change detection more exact. It is optional.`,
    ];
  }
  const { width, height } = viewportOf(platform, screen);
  return [
    "1. Open the current capture with Read to see which page and state it shows. If the page's address is not in the designer's note, ask the designer for the app's dev URL.",
    `2. Capture that page at the same size as the current capture (${width}x${height}) and save it as \`${png}\`: \`npx playwright screenshot --viewport-size=${width},${height} <url> ${shellQuote(png)}\``,
  ];
}

/**
 * The prompt that asks Claude to capture one screen again and register the result: the app captures nothing itself.
 * `folder` is the map folder's real path.
 */
export function buildRecapturePrompt(input: {
  folder: string;
  map: { title: string; platform?: unknown };
  screen: MapScreen;
  /** The real path of the screen's current capture. */
  capture: string;
  note: string | undefined;
}): string {
  const { folder, map, screen, capture } = input;
  const png = join(folder, "screens-src", `${screen.id}.recapture.png`);
  const note = input.note?.trim() ?? "";
  const updateLine = `${FLOW_MAP_COMMAND} update ${shellQuote(folder)} --id ${shellQuote(screen.id)} --image ${shellQuote(png)}`;
  const lines = [
    `Recapture request from the Flow Map app for the map "${mapText(map.title)}".`,
    "",
    "Capture one screen of the app again and update the map with it.",
    `- Screen id: ${mapText(screen.id)}`,
    `- Title: ${mapText(typeof screen.title === "string" ? screen.title : screen.id)}`,
    `- Platform: ${typeof map.platform === "string" ? mapText(map.platform) : "unknown"}`,
    `- Current capture: \`${capture}\``,
    ...(note !== "" ? ["", "Designer's note:", note] : []),
    "",
    ONE_COMMAND_AT_A_TIME_RULE,
    ...captureSteps(map.platform, screen, png),
    "3. Open the old capture and the new one with Read and check that the new one shows the same screen, is not blank or clipped, and is not an error or a loading state.",
    "4. Register it in the map (the previous capture is kept so Before | After works):",
    updateLine,
    "5. End your final answer with one line that reports the JSON the command printed: whether the screen changed and its similarity.",
  ];
  return lines.join("\n");
}
