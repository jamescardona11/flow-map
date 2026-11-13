/** A map.json as the skill writes it. Only `screens[].id` is typed: the suites build the rest by hand. */
export type MapData = { screens: { id: string }[]; [key: string]: unknown };

/** One screen entry: flow "main", 1x1, status "ok", title = id. `extra` overrides any field. */
export function screenOf(id: string, extra: Record<string, unknown> = {}) {
  return { id, title: id, flow: "main", description: "", image: `screens/${id}.png`, width: 1, height: 1, status: "ok", ...extra };
}

/** The map most suites open: "Checkout flow", screens a1-home and a2-detail joined by one edge. `overrides` replace whole fields. */
export function checkoutMap(overrides: Partial<MapData> = {}): MapData {
  return {
    version: 1,
    title: "Checkout flow",
    platform: "web",
    entry: "a1-home",
    flows: [{ id: "main", title: "Main", color: "#5aa9e6" }],
    screens: [screenOf("a1-home"), screenOf("a2-detail")],
    edges: [{ from: "a1-home", to: "a2-detail", action: "tap «Open»" }],
    frontier: [],
    ...overrides,
  };
}

/** A map with the single screen a1-home and no edges. */
export function homeOnlyMap(title = "Checkout flow"): MapData {
  return checkoutMap({ title, screens: [screenOf("a1-home")], edges: [] });
}

/** Three screens in the flow "main" (a2-detail is 1280x800 on web, 390x844 on ios) and one, "new-offer", in the flow "extras". Titles are the ids unless `titles` names them. */
export function fourScreenMap(platform: "web" | "ios" = "web", titles: Record<string, string> = {}): MapData {
  const web = platform === "web";
  const size = (webWidth: number, webHeight: number) => ({ width: web ? webWidth : 390, height: web ? webHeight : 844 });
  const screen = (id: string, extra: Record<string, unknown>) => screenOf(id, { ...(titles[id] ? { title: titles[id] } : {}), ...extra });
  return {
    version: 1,
    title: "Checkout flow",
    platform,
    entry: "a1-home",
    fingerprint: "test-fingerprint",
    flows: [
      { id: "main", title: "Main", color: "#5aa9e6" },
      { id: "extras", title: "Extras", color: "#e6a95a" },
    ],
    screens: [
      screen("a1-home", size(1440, 900)),
      screen("a2-detail", size(1280, 800)),
      screen("a3-cart", size(1440, 900)),
      screen("new-offer", { flow: "extras", ...size(1440, 900) }),
    ],
    edges: [
      { from: "a1-home", to: "a2-detail", action: "tap «Open»" },
      { from: "a2-detail", to: "a3-cart", action: "tap «Add»" },
    ],
    frontier: [],
  };
}
