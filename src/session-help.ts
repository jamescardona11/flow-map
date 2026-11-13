import { FLOW_MAP_COMMAND } from "./skill-command.ts";

/** A path with the characters gitignore patterns treat as special escaped, so a Read/Edit rule matches exactly that path. */
export function escapePathPattern(path: string): string {
  return path.replace(/[\\*?[\]]/g, "\\$&");
}

/** A folder path as a Read/Edit rule pattern: absolute (`//`) and escaped. */
function folderPattern(folder: string): string {
  return `/${escapePathPattern(folder)}/**`;
}

/** The permission rules the designer grants: read and edit under the map folder, and the flow-map skill command. */
export function buildAllowRules(folder: string): string[] {
  const pattern = folderPattern(folder);
  return [`Read(${pattern})`, `Edit(${pattern})`, `Bash(${FLOW_MAP_COMMAND} *)`];
}

/** The rules of a worker run that creates a new screen: the folder rules plus rendering its HTML mock to a PNG. */
export function buildNewScreenAllowRules(folder: string): string[] {
  return [...buildAllowRules(folder), "Bash(npx playwright screenshot *)"];
}

/**
 * What the designer must set up so the linked session serves the app's requests without terminal prompts.
 * It never contains the session's token or socket path, and the app never applies it: the person does.
 */
export function buildSessionHelp(folder: string): { settings: string; steps: string[] } {
  const settings = JSON.stringify(
    {
      crossSessionInbound: "accept",
      permissions: {
        allow: buildAllowRules(folder),
      },
    },
    null,
    2,
  );
  const steps = [
    "Open your Claude Code settings file (settings.json, in the .claude folder of your home folder for all your projects, or in the project's .claude folder for just one).",
    'Add "crossSessionInbound": "accept" so messages sent from this app are delivered to the session instead of being held or refused.',
    `Add permission allow rules so the session can read and edit files under this map folder (${folder}) and run the flow-map skill commands without asking you in the terminal.`,
    "The settings below show both changes together. Merge them into your existing file; do not replace what is already there.",
    'Optional: New screen and Re-capture render and capture screens with Playwright, so you can also allow "Bash(npx playwright screenshot *)" in the same allow list. Without it, that command asks you in the terminal. The agent-device commands that iOS and Android re-captures use will also ask in the terminal unless you allow them.',
    "A message from the app can never approve permissions or change settings by itself, and the app never changes your settings for you. You apply these changes yourself.",
  ];
  return { settings, steps };
}
