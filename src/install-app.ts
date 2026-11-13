import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { iconPng } from "./icon.ts";
import { shellQuote } from "./skill-command.ts";

const SIPS = "/usr/bin/sips";
const BUNDLE_NAME = "Flow Map.app";
const CLI_PATH = join(import.meta.dirname, "cli.ts");

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Flow Map</string>
  <key>CFBundleDisplayName</key>
  <string>Flow Map</string>
  <key>CFBundleIdentifier</key>
  <string>app.flowmap.desktop</string>
  <key>CFBundleExecutable</key>
  <string>flow-map</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;

/** Finder starts the bundle with an almost empty environment, so the script names node and the CLI by absolute path. */
function launcherScript(flowMapHome: string | undefined): string {
  const lines = ["#!/bin/sh"];
  if (flowMapHome) lines.push(`export FLOW_MAP_HOME=${shellQuote(flowMapHome)}`);
  lines.push(`exec ${shellQuote(process.execPath)} ${shellQuote(CLI_PATH)} app`);
  return `${lines.join("\n")}\n`;
}

async function writeIcns(destination: string): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), "flow-map-icon-"));
  try {
    const png = join(scratch, "AppIcon.png");
    await writeFile(png, iconPng());
    await promisify(execFile)(SIPS, ["-s", "format", "icns", png, "--out", destination]);
  } catch (error) {
    throw new Error(`Could not convert the icon with ${SIPS}: ${(error as Error).message}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Creates `Flow Map.app` in `dir`, replacing a previous one, and returns its path. Throws an Error with a readable message. */
export async function installApp(dir: string, flowMapHome: string | undefined): Promise<string> {
  const bundle = join(dir, BUNDLE_NAME);
  const macOsDir = join(bundle, "Contents", "MacOS");
  const resourcesDir = join(bundle, "Contents", "Resources");
  try {
    await mkdir(dir, { recursive: true });
    await rm(bundle, { recursive: true, force: true });
    await mkdir(macOsDir, { recursive: true });
    await mkdir(resourcesDir, { recursive: true });
    await writeFile(join(bundle, "Contents", "Info.plist"), PLIST);
    await writeFile(join(macOsDir, "flow-map"), launcherScript(flowMapHome));
    await chmod(join(macOsDir, "flow-map"), 0o755);
  } catch (error) {
    throw new Error(`Could not create ${bundle}: ${(error as Error).message}`);
  }
  await writeIcns(join(resourcesDir, "AppIcon.icns"));
  return bundle;
}
