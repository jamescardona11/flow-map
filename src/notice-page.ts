import { escapeHtml } from "./choose-page.ts";

/**
 * What the open map's address shows while its folder is not a usable map.
 * It listens for the same `changed` event as the viewer, so the map comes back by itself once the file is fixed.
 */
export function buildNoticePage(problem: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Flow Map</title>
<link rel="icon" type="image/png" href="/favicon.png">
<style>
  body { font: 16px system-ui, sans-serif; display: grid; place-items: center; height: 100vh; margin: 0; background: #14161a; color: #e8eaed; }
  main { width: min(32rem, 90vw); }
  h1 { font-size: 1.4rem; }
  #problem { color: #ff8a80; overflow-wrap: anywhere; }
  a { color: #8ab4f8; }
</style>
</head>
<body>
<main>
  <h1>This map cannot be shown</h1>
  <p id="problem">${escapeHtml(problem)}</p>
  <p>It will appear here by itself once the file is fixed, or <a href="/choose">choose another map</a>.</p>
</main>
<script>
new EventSource('/__flowmap-app/events').addEventListener('changed', () => location.reload());
</script>
</body>
</html>
`;
}
