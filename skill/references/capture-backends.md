# Capturing screen + tree by tool

`flowmap.py add/update` needs two files per screen: a PNG and, ideally, the accessibility tree as text. Any tool works as long as it delivers both as local files. Order of preference: **Playwright** (web) → **agent-device** (mobile) → **argent** (fallback).

Verified against the tools' CLI/schemas on 2026-10-29; anything marked "untested" was not run end to end, so check on the first capture that the file exists and is not empty.

## Web: Playwright (`playwright-cli`)

```
playwright-cli goto <url-http>                       # file: is blocked; serve the site over http
playwright-cli resize 1440 900                       # fixes the viewport: same dimensions in every capture
playwright-cli screenshot --filename=<dir>/a1.png    # --full-page if the screen scrolls
playwright-cli snapshot --filename=<dir>/a1.txt      # accessibility tree (refs included)
playwright-cli click <ref>                           # refs come from the snapshot
```

Refs (`e12`) change between snapshots; `flowmap`'s normalizer treats them as numbers and they do not count as a change. If there is a session/login, do it before the first capture and do not register it as a screen unless the login is part of the flow.

## Mobile: agent-device (MCP)

- `screenshot` with `path: <dir>/a1.png` saves the PNG. It accepts `platform: "web"`, so it also covers web if Playwright is not available.
- `snapshot` returns the tree as text in the response and has no output parameter: save that text yourself to `<dir>/a1.txt` (Write). Use `interactiveOnly: true` for exploration, but for the map use the full tree: it is the basis of the diff.
- To move around use `press`/`click`/`fill`/`back` with `settle: true` (the response already waits for the UI to settle).
- If the tree comes back empty or with an AX-unavailable warning, capture anyway and register the screen without `--tree`; change detection will be by pixels (untested with a real app in this version of the skill).

## Mobile: argent (fallback)

- `screenshot` downscales to 0.25 by default: pass `scale: 1.0` or the map's captures will come out blurry. With `includeImageInContext: false` the file is still written; read its path in the result (untested where it lands on each platform) and pass it to `--image`.
- `describe` returns the accessibility tree as text; save it to a `.txt` and pass it to `--tree`.
- The interaction tools return the screen after the action, useful for deciding the next `--action`.
- Physical phone: the capture only covers the app registered with `launch-app`; system screens (permissions) are not included.

## File names

Keep the raw captures in a temporary folder and let `flowmap.py` copy them to `screens/<id>.png`. Do not point `--image` at `screens/` except to re-register the same image with another tree (it works, it does not copy).
