import { describe, expect, it } from "vitest";
import { findRoute } from "../src/route.ts";

const edge = (from: string, to: string) => ({ from, to });

describe("findRoute", () => {
  it("answers the shortest route, ends on cycles, and answers null when there is none", () => {
    const edges = [edge("a", "b"), edge("b", "c"), edge("c", "a"), edge("a", "d"), edge("d", "c"), edge("c", "e"), edge("x", "y")];

    const screensOf = (route: ReturnType<typeof findRoute>) => route!.map(({ to }) => to);

    expect(screensOf(findRoute(edges, "a", "e")), "a>b>c>e and a>d>c>e are both three edges").toHaveLength(3);
    expect(screensOf(findRoute(edges, "a", "d")), "the direct edge, not the way round through the cycle").toEqual(["d"]);
    expect(findRoute(edges, "a", "y"), "a screen no edge leads to").toBeNull();
    expect(findRoute([edge("a", "b"), edge("b", "a")], "a", "z"), "a cycle with no way out ends").toBeNull();
  });
});
