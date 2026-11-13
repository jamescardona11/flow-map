export type RouteEdge = { from: string; to: string; at?: unknown };

/** The edges of the shortest route from `from` to `to` (breadth first, an edge goes from `edge.from` to `edge.to`), or null when there is none. */
export function findRoute<Edge extends RouteEdge>(edges: Edge[], from: string, to: string): Edge[] | null {
  const arrivedBy = new Map<string, Edge | null>([[from, null]]);
  const queue = [from];
  for (let next = 0; next < queue.length; next++) {
    const screen = queue[next]!;
    if (screen === to) break;
    for (const edge of edges) {
      if (edge.from !== screen || arrivedBy.has(edge.to)) continue;
      arrivedBy.set(edge.to, edge);
      queue.push(edge.to);
    }
  }
  if (!arrivedBy.has(to)) return null;
  const route: Edge[] = [];
  for (let edge = arrivedBy.get(to); edge; edge = arrivedBy.get(edge.from)) route.unshift(edge);
  return route;
}
