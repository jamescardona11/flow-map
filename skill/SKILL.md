---
name: flow-map
description: Creates and maintains the folder of a screen-flow map (map.json, screenshots, edges between screens, history) for a feature or a whole web or mobile app, from real captures taken with Playwright, agent-device or argent. The map is viewed, arranged and annotated in the Flow Map app, not in this skill: the skill writes the folder and the app opens it. Use it whenever the user asks for a "feature map", "flow map", "screen map", "user flow with screenshots", "see all the screens", "navigate the app visually", to document a flow with visual evidence, to "update the map" after a screen changed or to find out which screens changed, to compare today's app with a redesign, or to read the annotations the user left on a map; also if they want to walk through an app with Playwright, agent-device or argent to get it mapped. Not for reproducible e2e tests, exploratory QA that reports bugs, or app videos.
---

# flow-map

A map = a folder with `map.json` (screens, edges, unexplored branches), `screens/*.png` and supporting files. **This skill only creates and maintains that folder.** Viewing it, arranging it, commenting on it and asking Claude for changes is done by the **Flow Map** app (the `flow-map` command): the skill and the app share only the map folder, nothing else. You capture with the browser or device tool that fits; the `scripts/flowmap.py` CLI registers, updates and validates, so the map is never edited by hand. In the examples, `flowmap.py` is `python3 ~/.claude/skills/flow-map/scripts/flowmap.py`.

Full schema and every command: `references/schema.md`. How to capture with each tool: `references/capture-backends.md`.

## Before touching the app

1. **Pick a tool** by platform: web → Playwright; mobile → agent-device first, argent as a fallback. Details in `references/capture-backends.md`.
2. **Define the folder**: `flow-map/<feature>/` at the project root (or the one the user asks for). `flowmap.py init <folder> --title "..." --platform web|ios|android`.
3. **Agree on the scope** with the user: which flows, with which account/data, and what is off limits. Exploring without this is what breaks real data.
4. **Actions forbidden by default**: deleting, paying, subscribing, sending messages or emails, signing out, resetting data. They are done only if the user authorizes them in this session. A paywall or a system permission is recorded as the limit of the flow; it does not prove the protected feature works.
5. **Use test accounts and data.** The map stores full screenshots and the full accessibility tree, with all the visible text. If the app shows real people's data (in health, patients), do not capture it or share the folder without reviewing it.

## What counts as a screen

A screen is a stable state the user tells apart from another: a different title, a different set of actions or a different result. A modal or dialog over a screen is a screen of its own (with an "open" edge from it and another one back). The same screen with other data, another row of a list or another scroll position is not duplicated: on web, capture the full page (`--full-page`) and use `link`. This rule is what keeps the map readable and stable across recaptures.

## Capture (loop)

For each stable screen: capture image + accessibility tree, and register it.

```
flowmap.py add <folder> --id <screenId> --title "..." --flow "<Flow>" --image <png> --tree <tree.txt> \
  --from <parentScreenId> --action 'tap «Continue»'
```

- **Semantic, stable `--id`** (`a1-choose-institution`, not `001`): it is the screen's identity forever; recapturing uses the same id. Without it there is no way to know what changed.
- **`--flow`** groups screens into rows of the map; one flow per user goal ("Sign in", "Add leader", "Errors").
- **`--action`** says what was done on the parent screen: `tap «Continue»`, `type an invalid email`, `submit`. It is the arrow's label in the app, so it must read on its own.
- **Always pass `--tree`** if the tool offers it. Without a tree, change detection falls back to comparing pixels and any dynamic data triggers it.
- **Wait for the screen to settle** before capturing (loaders, animations); otherwise you end up with transition captures.

### Branches and returns

- If you leave a screen through several actions, repeat `add --from` (one per branch). The app shows one button per branch.
- If an action leads to a screen that already exists (back, cancel, cycles): `flowmap.py link <folder> --from A --to B --action "..."`. Do not duplicate the screen.
- If you know where the tap happened, add `--at x,y,w,h` (0-1 over the source screen) to `add`/`link`: the app draws a clickable area and the screen can be walked like a prototype. If the trees carry frames (`Button "Skip" (x, y, w, h)`), `flowmap.py hotspots <folder>` derives them on its own, when the action names the element and the match is unique.
- When the tree shows something tappable that you will not explore now: `flowmap.py frontier <folder> --from A --action "tap «Filter»"`. It shows up in the map as a dotted "unexplored" branch and disappears on its own once you register it later with `add`/`link` using the same action. This way the map honestly says what is missing to cover the app.
- `flowmap.py flow <folder> --id F --hide` leaves a flow hidden when the map opens, useful for historical material.

### Guided exploration

Do not blindly crawl the whole app. Walk one flow at a time, with an agreed step budget, and record the rest as `frontier`. Deduplicate before adding: if the screen already exists with other data (another row of a list), it is the same screen, use `link`.

### Example

```
flowmap.py init flow-map/login --title "Login" --platform web
flowmap.py add flow-map/login --id a1-login --title "Login" --flow "Sign in" --image /tmp/a1.png --tree /tmp/a1.txt
flowmap.py add flow-map/login --id a2-error --title "Invalid credentials" --flow "Sign in" --image /tmp/a2.png --tree /tmp/a2.txt \
  --from a1-login --action 'submit a wrong password'
flowmap.py link flow-map/login --from a2-error --to a1-login --action 'tap «Retry»'
flowmap.py frontier flow-map/login --from a1-login --action 'tap «Forgot my password»'
flowmap.py check flow-map/login
```

## Validate and open in the app

```
flowmap.py check <folder>    # broken edges, missing images (exit code 1 if there are problems)
flowmap.py thumbs <folder>   # missing thumbnails (add and update already create them; uses sips, macOS)
```

This skill no longer generates any HTML or serves the map: `build`, `serve`, `portal` and `bundle` were retired and answer with a notice pointing to the app. When done, **tell the user to open the folder in the Flow Map app**:

```
flow-map open <folder>   # opens the map in the default browser (starts the app if it is not running)
flow-map                 # just opens the app, with the recent maps
```

(`flow-map` is installed by the app's `./install`; if it is not on the PATH, it is `node <app repo>/src/cli.ts open|app <folder>`). In the app the user pans and zooms the canvas, sees the detail of each screen with its exits and entries, arranges and groups screens, compares before/after, sees the history and comments; the app reloads on its own when this skill changes `map.json`. Do not open windows or browsers yourself: give them the command.

What the app writes into the folder and this skill neither touches nor deletes: `layout.json` (positions), `groups.json` (groups), `DESIGN.md` (design contract for new screens), `temp/` (comments and crops), `exports/` (route videos). The skill preserves the `map.json` keys it does not know.

## Read the user's annotations

The user comments on screens (or areas) in the app; the comments are kept in `<map>/temp/annotations.json` with a PNG crop of each one. To read them:

```
flowmap.py annotations <folder>   # the text for Claude; over a folder of maps it gathers those that have annotations
```

The text opens with the instruction to treat each comment as the request (and not to edit code if the screenshots are of another app) and brings the screen, its flow, the route from the entry, the absolute paths of the crop and of the full screenshot, and the comment; if the screen was recaptured after being annotated, it says so. When the user hands you annotations: open each crop with Read, locate the screen in `map.json` by its id and work on that area, not on the whole screenshot. `temp/` is a draft: delete it when done.

## Update after a change

1. Recapture only the affected screens. The map does not store which code file originates each screen, so deciding which ones they are (from a diff, for example) is your judgment: use the titles and flows in `map.json`, and when in doubt recapture the whole flow.
2. `flowmap.py update <folder> --id <screenId> --image <png> --tree <tree.txt>`. It answers `changed` and similarity; the JSON stores which tree lines were added/removed in `lastChange`. If it changed, it also stores the replaced capture in `history/<id>/<YYYYMMDDTHHMMSSZ>.<ext>` (UTC time at which that capture was taken): one for each recapture with a change, to see how the screen evolved; the app reads that folder.
3. `flowmap.py status <folder>` lists the changed screens and the pending branches.
4. Review with the user (in the app, the comparison shows before and after side by side) and confirm with `flowmap.py ack <folder> --id <screenId>`, which deletes the «before» (`history/<id>.<ext>`) but never `history/<id>/`.

If a screen changed so much that its edges no longer hold, recapture the neighbouring ones too: the CLI only detects changes of the recaptured screen, not of the routes leading to it.

## Compare the current app with a redesign

1. For each screen: `add ... --image <redesign> --before <today's app>`; for a screen already added, `flowmap.py baseline <folder> --id <id> --image <today's app>`. The «before» is kept in `baselines/` and the screen stays `ok`, with no «changed» marks. The app draws both side by side in the map («Before | After» button) and in the detail.
2. Edges come from the design's real navigation (what links to what), they are not invented. Screens without a capture of today's app have no «before»: count them when delivering, they are what is left to capture.
3. Tell the user to open the folder in the app to annotate, per screen, what they keep and what they want to re-evaluate, and then read their comments with `flowmap.py annotations`.

## HTML screens (mocks)

For a design (a screen that does not exist yet in the app, or a board), Claude writes the HTML and the skill registers it in the structure:

```
flowmap.py add <folder> --id ... --image <png> --html <mock.html>     # when adding the screen
flowmap.py html <folder> --id <id> --file <mock.html>                  # to a screen that already exists (replaces the previous one)
```

The skill copies the file to `screens-src/<id>.html` and sets `"html"` on the screen. The app shows it live in the detail («Capture | HTML» button), next to the PNG capture, which remains the map's image (a Playwright render of the HTML). The HTML must be **self-contained**: inline CSS and JS, images and fonts as `data:`, no `<script src>`, `<link href>`, `@import`, `<iframe>` or network resources; the app serves it in a `sandbox` with no network and the skill rejects (exit code 1, writing nothing) anything that loads something external, is not `.html` or exceeds 5 MB. `check` warns if the file is missing or the path is not relative and inside the folder.

## Link this session to the app (ask you for changes from the map)

If the user wants to ask Claude for things from the app (the dock's box, «New screen», «Re-capture»), the app can send those messages to **this** session instead of launching a separate Claude. It can only be linked from inside the session, because the socket and the token are in its variables (`CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN`), which your Bash tool sees.

1. **Ask before linking.** Linking lets the app inject messages into this session: do not do it on your own even if you just created the map. Ask once ("Shall I link this map to this session so you can ask me for changes from the app?") and wait for the yes.
2. With the yes, run it with the **absolute** path of the folder: `flow-map link <folder>` (or `node <app repo>/src/cli.ts link <folder>` if `flow-map` is not on the PATH). It writes the link into the app's data directory (permissions 600), never inside the map. If it answers that the variables are missing, this session does not support cross-session messages: say so and suggest the sessionless route (in the app, «Run with a new Claude»).
3. The session will only handle the messages without asking permission in the terminal if the user has `"crossSessionInbound": "accept"` in their settings and `allow` rules to read and edit that folder and run the skill's commands. **Do not edit their settings yourself**: show them the block (with the map's path) and let them merge it, or copy it from the «?» button in the app's dock:

```json
{
  "crossSessionInbound": "accept",
  "permissions": { "allow": [
    "Read(//<folder>/**)",
    "Edit(//<folder>/**)",
    "Bash(python3 ~/.claude/skills/flow-map/scripts/flowmap.py *)",
    "Bash(npx playwright screenshot *)"
  ] }
}
```

4. Tell them that in the dock the chip changes to «Session linked» (it updates in about 10 s) and that the app's requests arrive here as messages; when you receive them, run the skill as usual (`add`, `update`, `html`, `check`) and answer with what changed. A new link replaces the previous one for that map.

## What this skill does not do

- It does not show or serve the map: that is the Flow Map app.
- It does not decide for you which actions are safe: that is step 4 of "Before touching the app".
- It does not guarantee full coverage of an app: whatever is unexplored is left as `frontier` or simply absent. Say so when delivering.
