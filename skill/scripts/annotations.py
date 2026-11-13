"""Annotations on the screens of a map: box + comment.

The Flow Map app writes them to <map>/temp/annotations.json (with the crop in temp/<id>.png); `export` reads them and
produces the text handed to Claude, with absolute paths of the crop and of the full screen.
"""
import json
from collections import deque
from pathlib import Path

import flowmap


def map_folders(folder):
    found = sorted(p.parent for p in folder.rglob("map.json") if p.parent != folder)
    return [p for p in found if not {"temp", "history"} & set(p.relative_to(folder).parts) and len(p.relative_to(folder).parts) <= 3]


def _file(root):
    return Path(root) / "temp" / "annotations.json"


def _read(root):
    path = _file(root)
    return json.loads(path.read_text()) if path.exists() else {"version": 1, "seq": {}, "annotations": []}


def listing(root):
    return _read(root)["annotations"]


def _has(root, ids):
    return any(ids is None or a["id"] in ids for a in listing(root))


def _route(data, screen_id):
    """Shortest path from the entry: 'A → [action] → B'. None if no path is recorded."""
    titles = {s["id"]: s["title"] for s in data["screens"]}
    previous = {data["entry"]: None}
    queue = deque([data["entry"]])
    while queue:
        current = queue.popleft()
        for edge in data["edges"]:
            if edge["from"] == current and edge["to"] not in previous:
                previous[edge["to"]] = (current, edge["action"])
                queue.append(edge["to"])
    if screen_id not in previous:
        return None
    steps, node = [], screen_id
    while previous[node]:
        parent, action = previous[node]
        steps.append(f"[{action}] → {titles[node]}")
        node = parent
    return " → ".join([titles[node], *reversed(steps)])


PREAMBLE = (
    "The user marked areas on screenshots of a flow map and left a comment on each one: treat each comment as the request. "
    "Open the crop with Read; the full screenshot and the route are context, so work on the marked area, not the whole screen. "
    "If the screenshots are of another app (a competitor or a reference), they are references, not code to edit."
)


def export(root, ids=None, preamble=True):
    """Markdown to paste into Claude: which screen, how to reach it, where the crop is and what was asked.

    If `root` is a folder of maps instead of one map, it gathers those that have annotations under a single instruction.
    """
    root = Path(root).resolve()
    if not (root / "map.json").exists():
        if not root.is_dir():
            raise flowmap.FlowMapError(f"Folder {root} does not exist")
        sections = [export(m, ids, preamble=False) for m in map_folders(root) if _has(m, ids)]
        return "\n".join([PREAMBLE + "\n", *sections]) if sections else "No annotations.\n"
    data = flowmap._load(root)
    screens = {s["id"]: s for s in data["screens"]}
    flows = {f["id"]: f["title"] for f in data["flows"]}
    chosen = [a for a in listing(root) if ids is None or a["id"] in ids]
    if not chosen:
        return "No annotations.\n"
    parts = [
        *([PREAMBLE, ""] if preamble else []),
        f"# Annotations: {data['title']}",
        f"Map: `{root}`",
        *([f"App: {data['meta']['subtitle']}"] if data.get("meta", {}).get("subtitle") else []),
        "",
    ]
    for n, ann in enumerate(chosen, 1):
        screen = screens.get(ann["screen"])
        if not screen:
            parts += [f"## {n}. {ann['screen']} (this screen no longer exists in the map)", f"Comment: {ann['comment']}", ""]
            continue
        rect = ann["rect"]
        route = _route(data, screen["id"])
        parts += [
            f"## {n}. {screen['title']} ({screen['id']}) · flow {flows[screen['flow']]}",
            f"Route: {route or 'no route recorded from the entry'}",
            f"Full screen: `{root / screen['image']}`",
            f"Crop: `{root / ann['crop']}` (area x {round(rect['x'] * 100)}%, y {round(rect['y'] * 100)}%, "
            f"width {round(rect['w'] * 100)}%, height {round(rect['h'] * 100)}%)",
            f"Comment: {ann['comment']}",
        ]
        if screen["fingerprint"] != ann["fingerprint"]:
            parts.append("Warning: the screen was recaptured after this annotation; the area may have moved.")
        parts.append("")
    return "\n".join(parts)
