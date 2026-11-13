import { describe, expect, it } from "vitest";
import { ffmpegArguments, videoSize, zoneOf } from "../src/route-video.ts";

describe("zoneOf", () => {
  it("keeps a zone inside the screen and gives none for a missing, non-numeric or out-of-range one", () => {
    expect(zoneOf({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 })).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
    expect(zoneOf(undefined), "no zone").toBeUndefined();
    expect(zoneOf("0.1,0.2"), "not an object").toBeUndefined();
    expect(zoneOf({ x: "0.1", y: 0.2, w: 0.3, h: 0.4 }), "a number written as text").toBeUndefined();
    expect(zoneOf({ x: Infinity, y: 0, w: 0.3, h: 0.4 }), "not finite").toBeUndefined();
    expect(zoneOf({ x: -0.1, y: 0, w: 0.3, h: 0.4 }), "starts before the screen").toBeUndefined();
    expect(zoneOf({ x: 0.8, y: 0, w: 0.3, h: 0.4 }), "runs past the right edge").toBeUndefined();
    expect(zoneOf({ x: 0, y: 0, w: 0, h: 0.4 }), "empty").toBeUndefined();
  });
});

describe("ffmpegArguments", () => {
  it("draws one box per zone, fades between consecutive screens, reads one input per screen and carries no user text", () => {
    const steps = [
      { capture: "/maps/m/screens/a.png", zone: { x: 0.1, y: 0.2, w: 0.3, h: 0.2 } },
      { capture: "/maps/m/screens/b.png", zone: { x: 0.5, y: 0.6, w: 0.4, h: 0.1 } },
      { capture: "/maps/m/screens/c.png" },
    ];

    const args = ffmpegArguments(steps, videoSize({ width: 320, height: 200 }), "/maps/m/exports/out.mp4");

    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph.match(/drawbox=/g)).toHaveLength(2);
    expect(graph.match(/xfade=/g)).toHaveLength(2);
    expect(args.filter((arg) => arg === "-i")).toHaveLength(3);
    expect(args.filter((arg, index) => args[index - 1] === "-i")).toEqual(steps.map(({ capture }) => capture));
    expect(graph, "the filter graph has no path and no text of the map").not.toMatch(/maps|\.png|tap|«/);
    expect(args.filter((arg) => arg.includes("/maps/m/")), "only the inputs and the output are paths").toHaveLength(4);
  });
});
