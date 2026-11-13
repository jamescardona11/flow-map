# `map.json` schema and commands

This folder is the contract between the skill (which writes it) and the Flow Map app (the `flow-map` command, which opens, arranges and comments on it). The skill does not generate HTML or serve the map.

```
<folder>/
├── map.json        source of truth (the CLI writes it; do not edit it by hand)
├── screens/<id>.png  (the suffix is that of the captured file: it may be .jpg)
├── thumbs/<id>.jpg 560 px tall thumbnail for the map (only if the capture is taller and `sips` is available, macOS)
├── history/<id>.png  the «before» of a changed screen, until `ack` is run
├── history/<id>/<YYYYMMDDTHHMMSSZ>.<ext>  one for each capture replaced by an `update` with a change; the name is the UTC time at which that capture was taken (if it already exists, `-2`, `-3`…); the CLI never deletes it
├── baselines/<id>.png  the «before» pinned on purpose (today's app against a redesign); `ack` does not delete it
├── trees/<id>.txt  accessibility tree as it arrived (evidence + basis of the diff)
├── evidence/<id>.txt  optional: raw output of the capture, untouched; linked through meta.evidence (only when importing)
├── layout.json     written by the app: positions the user dragged ({positions: {id: {x, y}}}); optional; the skill does not touch it
├── groups.json     written by the app: groups of screens that move together; optional; the skill does not touch it
├── DESIGN.md       written by the user from the app: design contract for new screens; optional
├── screens-src/<id>.html  self-contained HTML mock (`screens[].html`); copied by `add --html` / `html`. Also its working PNGs when Claude renders
├── exports/        written by the app: route videos
└── temp/           written by the app: annotations.json + crops <id>-NN.png (draft; delete it when done)
```

## map.json

```json
{
  "version": 1,
  "title": "Findings leaders",
  "platform": "web",                       // web | ios | android
  "meta": { "subtitle": "iPhone 16 Pro · 1.24.4", "blocks": ["Pro required"], "status": "partial" },  // optional, free-form; the app uses subtitle and blocks
  "entry": "a1-choose-institution",       // first screen added; the app opens here
  "flows":   [{ "id": "sign-in", "title": "Sign in", "color": "#5aa9e6", "hidden": true }],  // hidden: the app hides it on open
  "screens": [{
    "id": "a1-elegir-institucion",         // stable; lowercase letters, digits and hyphens
    "title": "Choose institution",
    "flow": "sign-in",
    "description": "",
    "image": "screens/a1-elegir-institucion.png",
    "thumb": "thumbs/a1-elegir-institucion.jpg",   // optional; the app uses it in the map and in the navigation cards
    "previous": "history/a1-elegir-institucion.png", // optional; exists until the change has been reviewed
    "baseline": "baselines/a1-elegir-institucion.png", // optional; fixed «before» to compare against; the app prefers it over `previous`
    "baselineThumb": "thumbs/a1-elegir-institucion-before.jpg", // optional; thumbnail of the baseline
    "width": 1440, "height": 900,          // PNG or JPEG (by content); null if it could not be read
    "fingerprintKind": "tree",             // tree | image (if there was no tree)
    "fingerprint": "…",
    "capturedAt": "2026-10-29T12:23:17+00:00",
    "status": "ok",                        // ok | changed
    "meta": { "evidence": "evidence/a1.txt" },  // optional, free-form; the app links meta.evidence as «Screen text»
    "lastChange": { "at": "…", "similarity": 0.81, "added": ["…"], "removed": ["…"] },  // only if changed
    "html": "screens-src/a1-elegir-institucion.html"  // optional: self-contained HTML mock that the app shows live; written by `add --html` / `html`
  }],
  "edges":    [{ "from": "a1-…", "to": "a2-…", "action": "tap «Continue»", "at": { "x": 0.1, "y": 0.9, "w": 0.2, "h": 0.05 } }],  // at: tapped area (0-1), optional
  "frontier": [{ "from": "a2-…", "action": "tap «Filter»" }]
}
```

- `edges` can cross flows and point backwards (cycles, "back"). The app draws the return ones dotted underneath.
- `meta` (of the map and of each screen) is only written from the Python API (`init(..., meta=)`, `add(..., meta=, captured_at=)`), meant for importing existing maps without losing their data; `update` does not touch it. `capturedAt` defaults to the capture time; `add --captured-at` or `captured_at=` sets a real date when importing.
- `at` makes the app draw a clickable area over the source capture (H key). It is written by `link/add --at x,y,w,h` or `hotspots`.
- `frontier` = actions seen and not explored. They are removed on their own when the same `(from, action)` enters as an edge.

## Fingerprint and change detection

The fingerprint comes from the accessibility tree: each line is normalized (lowercase; numbers and runs of numbers, such as coordinates, become `#`) and the sorted set is hashed. That is why a counter or a time does not count as a change, but a new text or button does. `similarity` is the Jaccard index between the old and the new set of lines (1 = identical). Without a tree, the PNG's hash is compared, which is triggered by any dynamic data.

Known limitation: dynamic data that is text (names, written dates) does mark `changed`. Look at `lastChange` before treating the change as real.

## Commands (`scripts/flowmap.py`)

| Command | What it does |
|---|---|
| `init <dir> --title T [--platform web\|ios\|android]` | creates the folder and an empty `map.json` |
| `add <dir> --id --title --flow --image [--tree] [--description] [--from --action [--at x,y,w,h]] [--captured-at ISO] [--before IMG]` | adds a screen (and an edge if `--from` is given); creates the flow if it is new |
| `link <dir> --from --to --action [--at x,y,w,h]` | edge between existing screens; idempotent (a new `--at` replaces the previous one) |
| `frontier <dir> --from --action` | branch seen but not explored |
| `update <dir> --id --image [--tree]` | recapture; prints `{"id", "changed", "similarity"}` (`similarity` only if it changed); if it changed, stores the «before» in `history/<id>.<ext>` and the replaced capture in `history/<id>/<YYYYMMDDTHHMMSSZ>.<ext>` (the time comes from the previous `capturedAt`, in UTC; without it, from the file's date; the Flow Map app reads this folder and shows the history) |
| `baseline <dir> --id --image` | pins (or replaces) the «before» of an existing screen without marking it `changed`; `add --before` does the same when adding |
| `ack <dir> --id` | marks a change as reviewed and deletes its «before» (`history/<id>.<ext>`); does not touch `history/<id>/` |
| `status <dir>` | changed screens and pending branches |
| `check <dir>` | validates; exits with code 1 if there are problems |
| `thumbs <dir>` | creates the missing thumbnails (`add` and `update` already create them) |
| `flow <dir> --id F --hide\|--show` | hides or shows a flow when the map opens in the app |
| `hotspots <dir> [--overwrite]` | derives `at` for each edge by finding, in the source tree, the element the action names; only with trees that carry `Role "label" (x, y, w, h)` frames and if the match is unique; grows tiny elements to a minimum tappable size |
| `add ... --html FILE` / `html <dir> --id --file FILE` | copies a self-contained HTML mock to `screens-src/<id>.html` and sets `screens[].html`; rejects (exit code 1, writing nothing) anything that loads external resources (`<script src>`, `<link href>`, `@import`, non-`data:` `url()`/`src`, `iframe/object/embed`), anything that is not `.html`/`.htm` or exceeds 5 MB; `update` and `ack` do not touch it |
| `annotations <dir>` | the annotations text (`temp/annotations.json`, written by the app) to hand to Claude; over a folder of maps it gathers those that have annotations |
| `build`, `serve`, `portal`, `bundle` | **retired**: they print a notice (the viewer lives in the Flow Map app: `flow-map open <dir>`), exit with code 1 and write nothing |

Errors: message on stderr and exit code 1.

Open a map: `flow-map open <dir>` (or `flow-map app <dir>` for a window of its own); the command is installed by the app's `./install`. The skill never runs it on its own.

## Tests

`python3 -m unittest discover -s tests` from the skill folder.

## Annotations (`temp/annotations.json`)

```json
{ "version": 1, "seq": { "s003": 1 },
  "annotations": [{ "id": "s003-01", "screen": "s003", "rect": { "x": 0.12, "y": 0.15, "w": 0.71, "h": 0.18 },
                    "comment": "…", "crop": "temp/s003-01.png", "fingerprint": "…", "at": "2026-10-29T21:00:00+00:00" }] }
```

`rect` is normalized (0-1) over the capture. `seq` prevents reusing the number of a deleted annotation. `fingerprint` is the screen's at the time of annotating: if it changes, `annotations` warns that it was recaptured. **Annotations, `layout.json` and `groups.json` are written only by the app** (`/__flowmap/annotations`, `/__flowmap/layout`, `/__flowmap/groups`, only from its own page); the skill only reads `temp/annotations.json` to export it.
