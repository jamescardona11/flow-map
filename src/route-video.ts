import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

/** How long each screen is held, the fade into the next one, and the last part of the hold in which the tapped zone is boxed. */
const STILL_SECONDS = 2;
const FADE_SECONDS = 0.5;
const BOX_SECONDS = 1;
const FPS = 30;
/** The longest route (in screens) that is exported. */
export const MAX_ROUTE_SCREENS = 30;
const FFMPEG_TIMEOUT_MS = 120_000;
/** How long ffmpeg has to exit after SIGTERM before it is killed. */
const STOP_GRACE_MS = 2000;
/** What an ffmpeg that was stopped by a signal is reported as. */
const stoppedBy = (signal: string) => `ffmpeg failed: was stopped (${signal})`;
const FALLBACK_SIZE = { width: 1280, height: 720 };
const MAX_SIDE = 1920;
const PADDING_COLOUR = "0x1e1e1e";
const BOX_COLOUR = "0xff3b30";

export type Zone = { x: number; y: number; w: number; h: number };
/** One screen of the route: its capture (an absolute path) and the zone tapped to leave it, when the edge says where. */
export type RouteStep = { capture: string; zone?: Zone };

/** ffmpeg could not be started because the command does not exist. */
export class FfmpegMissingError extends Error {}

/** The tapped zone an edge records in `at`, or undefined when it is missing or does not stay inside the screen. */
export function zoneOf(at: unknown): Zone | undefined {
  const { x, y, w, h } = (at ?? {}) as Record<string, unknown>;
  if (![x, y, w, h].every((value) => typeof value === "number" && Number.isFinite(value))) return undefined;
  const zone = { x, y, w, h } as Zone;
  const inside = zone.x >= 0 && zone.y >= 0 && zone.w > 0 && zone.h > 0 && zone.x + zone.w <= 1 + 1e-6 && zone.y + zone.h <= 1 + 1e-6;
  return inside ? zone : undefined;
}

/** The size of the video: the first screen's, with even sides (h264 needs them) and neither above 1920; 1280x720 when the map does not say. */
export function videoSize(screen: { width?: unknown; height?: unknown }): { width: number; height: number } {
  const { width, height } = screen;
  if (typeof width !== "number" || typeof height !== "number" || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return FALLBACK_SIZE;
  const shrink = Math.min(1, MAX_SIDE / Math.max(width, height));
  const even = (side: number) => Math.max(2, 2 * Math.round((side * shrink) / 2));
  return { width: even(width), height: even(height) };
}

const seconds = (value: number) => value.toFixed(3);
/** Every screen but the last also lasts through the fade into the next one. */
const holdSeconds = (index: number, count: number) => (index === count - 1 ? STILL_SECONDS : STILL_SECONDS + FADE_SECONDS);
const fraction = (value: number) => value.toFixed(6);

/** The filter graph: one chain per screen (fit to the video size, box the tapped zone) joined by cross-fades. Only numbers are written into it. */
function filterGraph(steps: RouteStep[], { width, height }: { width: number; height: number }): string {
  const chains = steps.map(({ zone }, index) => {
    // The box is placed on the capture as it comes (iw, ih), before it is scaled to the video, so it needs no knowledge of the image size.
    const box = zone
      ? `,drawbox=x=iw*${fraction(zone.x)}:y=ih*${fraction(zone.y)}:w=iw*${fraction(zone.w)}:h=ih*${fraction(zone.h)}:color=${BOX_COLOUR}:t=ih/90:enable=gte(t\\,${seconds(STILL_SECONDS - BOX_SECONDS)})`
      : "";
    return `[${index}:v]format=rgb24${box},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${PADDING_COLOUR},setsar=1,fps=${FPS},format=yuv420p[v${index}]`;
  });
  const fades = steps.slice(1).map((_, index) => {
    const joined = index === 0 ? "[v0]" : `[x${index}]`;
    const offset = (index + 1) * STILL_SECONDS;
    return `${joined}[v${index + 1}]xfade=transition=fade:duration=${seconds(FADE_SECONDS)}:offset=${seconds(offset)}[x${index + 1}]`;
  });
  return [...chains, ...fades].join(";");
}

/** The ffmpeg arguments (the command is run without a shell: each one is one argv entry). `output` must not exist: ffmpeg is told not to overwrite. */
export function ffmpegArguments(steps: RouteStep[], size: { width: number; height: number }, output: string): string[] {
  const inputs = steps.flatMap(({ capture }, index) => {
    // image2 with no pattern: the capture path is one file, never a glob or a sequence pattern
    return ["-loop", "1", "-framerate", String(FPS), "-t", seconds(holdSeconds(index, steps.length)), "-f", "image2", "-pattern_type", "none", "-i", capture];
  });
  const last = steps.length - 1;
  return [
    "-n", "-hide_banner", "-loglevel", "error",
    ...inputs,
    "-filter_complex", filterGraph(steps, size),
    "-map", last === 0 ? "[v0]" : `[x${last}]`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", String(FPS),
    "-movflags", "+faststart",
    "-f", "mp4", // the output name ends in .part, so ffmpeg cannot guess the format
    output,
  ];
}

/**
 * Renders the steps as an MP4 at `output` (an absolute path) and answers its length in seconds. ffmpeg writes a new file with an
 * unpredictable name beside `output`, which is then renamed over it: a link planted at `output` is replaced, never written through.
 * ffmpeg runs without a shell and is stopped after two minutes, or when `signal` aborts (the promise then rejects once the child is gone).
 * Throws FfmpegMissingError when the command does not exist; on any failure no partial file is left.
 */
export async function renderRouteVideo(options: {
  ffmpegBin: string;
  steps: RouteStep[];
  size: { width: number; height: number };
  output: string;
  signal?: AbortSignal;
}): Promise<number> {
  const { ffmpegBin, steps, size, output, signal } = options;
  const partial = join(dirname(output), `.route-${randomBytes(12).toString("hex")}.mp4.part`);
  try {
    await runFfmpeg(ffmpegBin, ffmpegArguments(steps, size, partial), signal);
    await rename(partial, output);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  return steps.length * STILL_SECONDS;
}

function runFfmpeg(command: string, args: string[], signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error(stoppedBy("SIGTERM")));
  return new Promise((done, fail) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], timeout: FFMPEG_TIMEOUT_MS });
    let stderr = "";
    let killTimer: NodeJS.Timeout | undefined;
    const stop = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS);
    };
    signal?.addEventListener("abort", stop, { once: true });
    child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2000)));
    child.on("error", (error: NodeJS.ErrnoException) => {
      fail(error.code === "ENOENT" ? new FfmpegMissingError(`${command} was not found`) : error);
    });
    child.on("close", (code, killedBy) => {
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", stop);
      if (code === 0) return done();
      if (killedBy) return fail(new Error(stoppedBy(killedBy)));
      fail(new Error(`ffmpeg failed: ${stderr.trim().split("\n").pop() ?? `exited with ${code}`}`));
    });
  });
}
