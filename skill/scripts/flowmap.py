#!/usr/bin/env python3
"""Flow map of an app: creates and maintains the map folder (map.json + captures).

The agent captures (screenshot + accessibility tree) with whichever tool fits and
uses this CLI only to register and update the map. The viewer lives in the Flow Map
app (the `flow-map` command), which opens this folder.
A screen can also carry a self-contained HTML mock (`add --html`, `html`):
the app shows it in an isolated iframe next to the capture.
Schema and commands: references/schema.md
"""
import argparse
import hashlib
import json
import re
import shutil
import struct
import subprocess
import sys
import unicodedata
from collections import Counter
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path

PALETTE = ["#5aa9e6", "#3aa58b", "#e0a63a", "#b583e6", "#e5736a", "#79bdb3"]
ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]*$")
MAX_DIFF_LINES = 12
THUMB_PX = 560  # thumbnail height: twice what the map draws, for high-density screens
QUOTED = re.compile(r'"((?:[^"\\]|\\.)*)"')
MAX_HTML_BYTES = 5 * 1024 * 1024
HTML_EXTENSIONS = (".html", ".htm")
EMBEDDING_TAGS = ("iframe", "object", "embed")
CSS_URL_OPEN = re.compile(r"url\(\s*", re.IGNORECASE)
CSS_IMPORT = re.compile(r"@import\s+(?:url\(\s*)?['\"]?([^'\")\s;]+)", re.IGNORECASE)
SRCSET_DESCRIPTOR = re.compile(r"^\d+(\.\d+)?[xw]$")


class FlowMapError(Exception):
    pass


def _css_urls(text):
    """The `url(...)` references of a CSS text, in a single pass; an unclosed `url(` is an error, not ignored."""
    urls, pos = [], 0
    while opened := CSS_URL_OPEN.search(text, pos):
        start = opened.end()
        quote = text[start:start + 1] if text[start:start + 1] in ("'", '"') else ""
        end = text.find(quote, start + 1) if quote else start
        close = text.find(")", end) if end != -1 else -1
        if close == -1:
            raise FlowMapError("the CSS is malformed: there is an unclosed url(")
        urls.append(text[start + len(quote):end].strip() if quote else text[start:close].strip())
        pos = close + 1
    return urls


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _load(root):
    path = Path(root) / "map.json"
    if not path.exists():
        raise FlowMapError(f"{path} does not exist; run `init` first")
    return json.loads(path.read_text())


def _save(root, data):
    (Path(root) / "map.json").write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def _tree_path(root, screen_id):
    return Path(root) / "trees" / f"{screen_id}.txt"


def _screen(data, screen_id):
    for screen in data["screens"]:
        if screen["id"] == screen_id:
            return screen
    raise FlowMapError(f"There is no screen '{screen_id}'")


def _slug(text):
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", ascii_text.lower()).strip("-") or "flow"


JPEG_SOF = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}


def _image_size(image):
    """(width, height) of a PNG or JPEG by its content, not its extension; (None, None) for any other format."""
    with open(image, "rb") as f:
        header = f.read(24)
        if header[:8] == b"\x89PNG\r\n\x1a\n":
            return struct.unpack(">II", header[16:24])
        if header[:2] != b"\xff\xd8":
            return None, None
        f.seek(2)
        while True:
            marker = f.read(4)
            if len(marker) < 4 or marker[0] != 0xFF:
                return None, None
            if marker[1] in JPEG_SOF:
                height, width = struct.unpack(">HH", f.read(5)[1:5])
                return width, height
            f.seek(struct.unpack(">H", marker[2:4])[0] - 2, 1)


def _tree_tokens(text):
    # Digits change with dynamic data (times, counters, frames) and do not count as a screen change.
    # Runs of numbers (coordinates, frames) collapse into a single '#' so the diff stays readable.
    def normalize(line):
        line = re.sub(r"\d+(?:\.\d+)?", "#", line)
        return re.sub(r"\s+", " ", re.sub(r"#(?:[ ,]*#)+", "#", line)).strip().lower()

    lines = (normalize(line) for line in text.splitlines())
    return sorted({line for line in lines if line})


def _diff(old_tokens, new_tokens):
    old, new = set(old_tokens), set(new_tokens)
    union = old | new
    return dict(
        similarity=round(len(old & new) / len(union), 2) if union else 1.0,
        added=sorted(new - old)[:MAX_DIFF_LINES],
        removed=sorted(old - new)[:MAX_DIFF_LINES],
    )


def _fingerprint(tokens, image):
    if tokens:
        return "tree", hashlib.sha1("\n".join(tokens).encode()).hexdigest()
    return "image", hashlib.sha256(image.read_bytes()).hexdigest()


def _make_thumb(root, name, source):
    """JPEG THUMB_PX tall for the map. None if the image is already small or `sips` (macOS) is missing."""
    thumb = root / "thumbs" / f"{name}.jpg"
    thumb.unlink(missing_ok=True)
    height = _image_size(source)[1]
    if not height or height <= THUMB_PX or not shutil.which("sips"):
        return None
    thumb.parent.mkdir(exist_ok=True)
    cmd = ["sips", "-s", "format", "jpeg", "-s", "formatOptions", "80", "--resampleHeight", str(THUMB_PX), str(source), "--out", str(thumb)]
    done = subprocess.run(cmd, capture_output=True)
    return str(thumb.relative_to(root)) if done.returncode == 0 and thumb.exists() else None


def thumbs(root):
    """Creates the missing thumbnails; returns how many it made."""
    root = Path(root)
    data = _load(root)
    made = 0
    for screen in data["screens"]:
        for field, source, name in (("thumb", "image", screen["id"]), ("baselineThumb", "baseline", f"{screen['id']}-before")):
            if not screen.get(source) or (screen.get(field) and (root / screen[field]).exists()):
                continue
            thumb = _make_thumb(root, name, root / screen[source])
            if thumb:
                screen[field] = thumb
                made += 1
    _save(root, data)
    return made


def _store_baseline(root, screen_id, image):
    """Copies the «before» image to baselines/ and returns its fields (`baseline`, and `baselineThumb` if it is tall).

    It is today's app against a redesign, not an accepted recapture."""
    root, image = Path(root), Path(image)
    if not image.exists():
        raise FlowMapError(f"Image {image} does not exist")
    target = root / "baselines" / f"{screen_id}{image.suffix.lower()}"
    target.parent.mkdir(exist_ok=True)
    if image.resolve() != target.resolve():
        shutil.copy2(image, target)
    fields = {"baseline": str(target.relative_to(root))}
    thumb = _make_thumb(root, f"{screen_id}-before", target)
    if thumb:
        fields["baselineThumb"] = thumb
    return fields


def _external(url):
    """True if the reference loads something that is not inside the file (not `data:`, not empty, not a fragment)."""
    url = (url or "").strip()
    return not (url == "" or url.startswith("#") or url.lower().startswith("data:"))


class _ExternalRefs(HTMLParser):
    """Collects what an HTML mock would load from outside: the app serves it with no network and no neighbouring files."""

    def __init__(self):
        super().__init__()
        self.found = []
        self._in_style = False

    def _css(self, text):
        self.found += [url for url in _css_urls(text) if _external(url)]
        self.found += [target for target in CSS_IMPORT.findall(text) if _external(target)]

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        self._in_style = tag == "style"
        if tag in EMBEDDING_TAGS:
            self.found.append(f"<{tag}>")
        if tag == "link" and _external(attrs.get("href")):
            self.found.append(attrs["href"])
        for name in ("src", "poster"):
            if _external(attrs.get(name)):
                self.found.append(attrs[name])
        for token in (attrs.get("srcset") or "").split():
            token = token.rstrip(",")
            if not SRCSET_DESCRIPTOR.match(token) and _external(token):
                self.found.append(token)
        self._css(attrs.get("style") or "")

    def handle_endtag(self, tag):
        self._in_style = False

    def handle_data(self, data):
        if self._in_style:
            self._css(data)


def _check_html(file):
    """Validates the mock before copying anything; raises FlowMapError if it is not a self-contained .html."""
    file = Path(file)
    if not file.exists():
        raise FlowMapError(f"HTML {file} does not exist")
    if file.suffix.lower() not in HTML_EXTENSIONS:
        raise FlowMapError(f"{file} is not an .html file")
    if file.stat().st_size > MAX_HTML_BYTES:
        raise FlowMapError(f"{file} is larger than {MAX_HTML_BYTES // 1024 // 1024} MB")
    parser = _ExternalRefs()
    parser.feed(file.read_text(errors="replace"))
    parser.close()
    if parser.found:
        raise FlowMapError(f"the HTML is not self-contained: it loads {parser.found[0]!r} (use inline CSS/JS and data: images and fonts)")


def _store_html(root, screen_id, file):
    """Copies the mock (already validated with `_check_html`) to screens-src/ and returns its relative path (the screen's `html` field)."""
    root, file = Path(root), Path(file)
    target = root / "screens-src" / f"{screen_id}.html"
    target.parent.mkdir(exist_ok=True)
    if file.resolve() != target.resolve():
        shutil.copy2(file, target)
    return str(target.relative_to(root))


def _store_capture(root, screen_id, image, tree, captured_at=None):
    """Copies image and tree into the map; returns the screen fields and the new tree's tokens."""
    root = Path(root)
    image = Path(image)
    if not image.exists():
        raise FlowMapError(f"Image {image} does not exist")
    target = root / "screens" / f"{screen_id}{image.suffix.lower()}"
    if image.resolve() != target.resolve():
        shutil.copy2(image, target)
    tree_path = _tree_path(root, screen_id)
    if tree:
        tree_text = Path(tree).read_text()
        tree_path.write_text(tree_text)
    else:
        tree_path.unlink(missing_ok=True)  # the previous tree no longer describes this capture
        tree_text = ""
    tokens = _tree_tokens(tree_text)
    kind, fingerprint = _fingerprint(tokens, target)
    width, height = _image_size(target)
    fields = dict(
        image=str(target.relative_to(root)),
        width=width,
        height=height,
        fingerprintKind=kind,
        fingerprint=fingerprint,
        capturedAt=captured_at or _now(),
    )
    thumb = _make_thumb(root, screen_id, target)
    if thumb:
        fields["thumb"] = thumb
    return fields, tokens


def valid_rect(rect):
    """Normalized rectangle {x, y, w, h} inside the screen; reused by edges and annotations."""
    try:
        x, y, w, h = (float(rect[k]) for k in ("x", "y", "w", "h"))
    except (KeyError, TypeError, ValueError):
        raise FlowMapError("rect needs numeric x, y, w, h") from None
    if min(x, y) < 0 or min(w, h) <= 0 or x + w > 1 + 1e-6 or y + h > 1 + 1e-6:
        raise FlowMapError("rect must stay inside the screen (values between 0 and 1, width and height > 0)")
    return {k: round(v, 4) for k, v in zip("xywh", (x, y, w, h))}


def _add_edge(data, from_id, to_id, action, at=None):
    """Registers the edge (without duplicating it; a new `at` replaces the old one) and closes the pending branch."""
    at = valid_rect(at) if at else None
    edge = next((e for e in data["edges"] if (e["from"], e["to"], e["action"]) == (from_id, to_id, action)), None)
    if edge is None:
        edge = {"from": from_id, "to": to_id, "action": action}
        data["edges"].append(edge)
    if at:
        edge["at"] = at
    data["frontier"] = [f for f in data["frontier"] if not (f["from"] == from_id and f["action"] == action)]


def init(root, title, platform, meta=None):
    root = Path(root)
    if (root / "map.json").exists():
        raise FlowMapError(f"{root / 'map.json'} already exists")
    (root / "screens").mkdir(parents=True, exist_ok=True)
    (root / "trees").mkdir(exist_ok=True)
    data = dict(version=1, title=title, platform=platform, entry=None, flows=[], screens=[], edges=[], frontier=[])
    if meta:
        data["meta"] = meta
    _save(root, data)


def add(root, screen_id, title, flow, image, tree=None, description="", from_id=None, action=None, captured_at=None, meta=None, at=None, before=None, html=None):
    if not ID_PATTERN.match(screen_id):
        raise FlowMapError(f"Invalid id '{screen_id}': use lowercase letters, digits and hyphens")
    data = _load(root)
    if any(s["id"] == screen_id for s in data["screens"]):
        raise FlowMapError(f"Screen '{screen_id}' already exists; use `update` to recapture it")
    if from_id:
        _screen(data, from_id)
        if not action:
            raise FlowMapError("--action is required with --from")

    flow_id = _slug(flow)
    if not any(f["id"] == flow_id for f in data["flows"]):
        data["flows"].append(dict(id=flow_id, title=flow, color=PALETTE[len(data["flows"]) % len(PALETTE)]))

    screen = dict(id=screen_id, title=title, flow=flow_id, description=description, status="ok")
    if before and not Path(before).exists():  # before copying anything: a failure must not leave a half-added screen
        raise FlowMapError(f"Image {before} does not exist")
    if html:
        _check_html(html)
    fields, _ = _store_capture(root, screen_id, image, tree, captured_at)
    screen.update(fields)
    if before:
        screen.update(_store_baseline(root, screen_id, before))
    if html:
        screen["html"] = _store_html(root, screen_id, html)
    if meta:
        screen["meta"] = meta
    data["screens"].append(screen)
    data["entry"] = data["entry"] or screen_id
    if from_id:
        _add_edge(data, from_id, screen_id, action, at)
    _save(root, data)


def set_baseline(root, screen_id, image):
    """Adds or replaces the «before» of a screen. `update` and `ack` leave it alone."""
    data = _load(root)
    screen = _screen(data, screen_id)
    screen.pop("baselineThumb", None)  # an old thumbnail does not describe the new «before»
    screen.update(_store_baseline(root, screen_id, image))
    _save(root, data)


def set_html(root, screen_id, file):
    """Adds or replaces the HTML mock of a screen. `update` and `ack` leave it alone."""
    data = _load(root)
    screen = _screen(data, screen_id)
    _check_html(file)
    screen["html"] = _store_html(root, screen_id, file)
    _save(root, data)


def link(root, from_id, to_id, action, at=None):
    data = _load(root)
    _screen(data, from_id)
    _screen(data, to_id)
    _add_edge(data, from_id, to_id, action, at)
    _save(root, data)


def set_flow_hidden(root, flow_id, hidden):
    data = _load(root)
    flow = next((f for f in data["flows"] if f["id"] == flow_id), None)
    if flow is None:
        raise FlowMapError(f"There is no flow '{flow_id}'")
    if hidden:
        flow["hidden"] = True
    else:
        flow.pop("hidden", None)
    _save(root, data)


def frontier(root, from_id, action):
    data = _load(root)
    _screen(data, from_id)
    item = {"from": from_id, "action": action}
    explored = any(e["from"] == from_id and e["action"] == action for e in data["edges"])
    if item not in data["frontier"] and not explored:
        data["frontier"].append(item)
    _save(root, data)


def _history_name(root, screen_id, old_image, captured_at):
    """Free path in history/<id>/ for the capture about to be replaced: <YYYYMMDDTHHMMSSZ>[-N].<ext>.

    The time is that capture's time in UTC (a date without a zone counts as UTC); if `capturedAt` is missing or
    unparseable, the file's modification time."""
    old_path = Path(root) / old_image
    try:
        taken = datetime.fromisoformat(captured_at)
    except (TypeError, ValueError):
        taken = datetime.fromtimestamp(old_path.stat().st_mtime, timezone.utc)
    if taken.tzinfo is None:
        taken = taken.replace(tzinfo=timezone.utc)
    stamp = taken.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    folder = Path(root) / "history" / screen_id
    target, n = folder / f"{stamp}{old_path.suffix}", 1
    while target.exists():
        n += 1
        target = folder / f"{stamp}-{n}{old_path.suffix}"
    return target


def update(root, screen_id, image, tree=None):
    """Recaptures a screen; marks it `changed` if its fingerprint changed and records what changed."""
    root = Path(root)
    data = _load(root)
    screen = _screen(data, screen_id)
    old_tree_path = _tree_path(root, screen_id)
    old_tree_text = old_tree_path.read_text() if old_tree_path.exists() else None  # before _store_capture replaces it
    old_image = screen["image"]
    old_bytes = (root / old_image).read_bytes()  # the map may overwrite this file when it stores the new capture
    history_file = _history_name(root, screen_id, old_image, screen.get("capturedAt"))  # the file's date is also lost when it is replaced

    fields, new_tokens = _store_capture(root, screen_id, image, tree)
    if fields["image"] != old_image:
        (root / old_image).unlink(missing_ok=True)
    changed = (fields["fingerprintKind"], fields["fingerprint"]) != (screen["fingerprintKind"], screen["fingerprint"])
    screen.pop("thumb", None)
    screen.update(fields)

    result = dict(id=screen_id, changed=changed)
    if changed:
        history_file.parent.mkdir(parents=True, exist_ok=True)
        history_file.write_bytes(old_bytes)  # one per replaced capture; the CLI never deletes them
        if "previous" not in screen:  # the «before» is the last accepted one: it is not overwritten until `ack`
            previous = root / "history" / f"{screen_id}{Path(old_image).suffix}"
            previous.parent.mkdir(exist_ok=True)
            previous.write_bytes(old_bytes)
            screen["previous"] = str(previous.relative_to(root))
        change = dict(at=fields["capturedAt"], similarity=None, added=[], removed=[])
        if old_tree_text is not None and new_tokens:
            change.update(_diff(_tree_tokens(old_tree_text), new_tokens))
        screen["status"] = "changed"
        screen["lastChange"] = change
        result["similarity"] = change["similarity"]
    _save(root, data)
    return result


def ack(root, screen_id):
    data = _load(root)
    screen = _screen(data, screen_id)
    screen["status"] = "ok"
    screen.pop("lastChange", None)
    if screen.get("previous"):
        (Path(root) / screen.pop("previous")).unlink(missing_ok=True)
    _save(root, data)


def check(root):
    root = Path(root)
    data = _load(root)
    ids = [s["id"] for s in data["screens"]]
    flows = {f["id"] for f in data["flows"]}
    problems = [f"duplicate id '{i}'" for i, n in sorted(Counter(ids).items()) if n > 1]
    for s in data["screens"]:
        if s["flow"] not in flows:
            problems.append(f"screen '{s['id']}' uses the nonexistent flow '{s['flow']}'")
        if not (root / s["image"]).exists():
            problems.append(f"missing image of '{s['id']}': {s['image']}")
        if s.get("thumb") and not (root / s["thumb"]).exists():
            problems.append(f"missing thumbnail of '{s['id']}': {s['thumb']}")
        for field in ("previous", "baseline", "baselineThumb"):
            if s.get(field) and not (root / s[field]).exists():
                problems.append(f"missing «before» of '{s['id']}': {s[field]}")
        if "html" in s:
            html = s["html"]
            parts = html.split("/") if isinstance(html, str) else []
            if not (parts and parts[0] == "screens-src" and html.endswith(".html") and ".." not in parts):
                problems.append(f"the HTML of '{s['id']}' is not a path inside screens-src/ ending in .html: {html!r}")
            elif not (root / html).exists():
                problems.append(f"missing HTML of '{s['id']}': {html}")
    for e in data["edges"]:
        for end in ("from", "to"):
            if e[end] not in ids:
                problems.append(f"edge '{e['action']}' points to '{e[end]}', which does not exist")
    for f in data["frontier"]:
        if f["from"] not in ids:
            problems.append(f"unexplored branch '{f['action']}' leaves '{f['from']}', which does not exist")
    if data["entry"] not in ids and ids:
        problems.append(f"entry '{data['entry']}' does not exist")
    return problems


def status(root):
    data = _load(root)
    lines = []
    for s in data["screens"]:
        if s["status"] == "changed":
            sim = s["lastChange"]["similarity"]
            lines.append(f"CHANGED  {s['id']}  {s['title']}  (similarity {sim if sim is not None else 'n/a'})")
    for f in data["frontier"]:
        lines.append(f"UNEXPLORED  {f['from']} → {f['action']}")
    return lines


RETIRED_COMMANDS = ("build", "serve", "portal", "bundle")


def _parse_at(text):
    try:
        x, y, w, h = (float(part) for part in text.split(","))
    except ValueError:
        raise argparse.ArgumentTypeError("use four numbers separated by commas: x,y,w,h") from None
    return dict(x=x, y=y, w=w, h=h)


def _parser():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    def command(name, *args):
        p = sub.add_parser(name)
        p.add_argument("root", help="map folder (contains map.json)")
        for flags, kwargs in args:
            p.add_argument(*flags, **kwargs)
        return p

    required = dict(required=True)
    at = (["--at"], dict(type=_parse_at, help="area tapped on the source screen, normalized: x,y,w,h"))
    command("init", (["--title"], required), (["--platform"], dict(default="web", choices=["web", "ios", "android"])))
    command(
        "add",
        (["--id"], required), (["--title"], required), (["--flow"], required), (["--image"], required),
        (["--tree"], {}), (["--description"], dict(default="")), (["--from"], dict(dest="from_id")), (["--action"], {}),
        (["--captured-at"], {}), (["--before"], dict(help="«before» image (today's app) to compare with --image")), at,
        (["--html"], dict(help="self-contained HTML mock of the screen (inline CSS/JS, data: images)")),
    )
    command("baseline", (["--id"], required), (["--image"], required))
    command("html", (["--id"], required), (["--file"], required))
    command("link", (["--from"], dict(required=True, dest="from_id")), (["--to"], required), (["--action"], required), at)
    command("frontier", (["--from"], dict(required=True, dest="from_id")), (["--action"], required))
    command("update", (["--id"], required), (["--image"], required), (["--tree"], {}))
    command("ack", (["--id"], required))
    command("check")
    command("status")
    command("thumbs")
    command("flow", (["--id"], required), (["--hide"], dict(action="store_true")), (["--show"], dict(action="store_true")))
    command("hotspots", (["--overwrite"], dict(action="store_true")))
    command("annotations")
    for retired in RETIRED_COMMANDS:  # still registered to explain where the viewer went, not to run
        retired_parser = command(retired)
        if retired == "bundle":  # the old options are accepted so the notice still prints
            retired_parser.add_argument("--out")
            retired_parser.add_argument("--thumbs-only", action="store_true")
        if retired == "serve":
            retired_parser.add_argument("--port", type=int)
    return parser


def main(argv=None):
    args = _parser().parse_args(argv)
    import annotations, hotspots  # they import flowmap: loaded here, not at the top, to avoid the cycle

    if args.command in RETIRED_COMMANDS:
        print(f"error: the viewer now lives in the Flow Map app; open {args.root} with: flow-map open {args.root}", file=sys.stderr)
        return 1
    try:
        if args.command == "init":
            init(args.root, args.title, args.platform)
        elif args.command == "add":
            add(args.root, args.id, args.title, args.flow, args.image, args.tree, args.description, args.from_id, args.action, args.captured_at, at=args.at, before=args.before, html=args.html)
        elif args.command == "link":
            link(args.root, args.from_id, args.to, args.action, args.at)
        elif args.command == "frontier":
            frontier(args.root, args.from_id, args.action)
        elif args.command == "baseline":
            set_baseline(args.root, args.id, args.image)
        elif args.command == "html":
            set_html(args.root, args.id, args.file)
        elif args.command == "update":
            print(json.dumps(update(args.root, args.id, args.image, args.tree), ensure_ascii=False))
        elif args.command == "ack":
            ack(args.root, args.id)
        elif args.command == "check":
            problems = check(args.root)
            print("\n".join(problems) or "ok")
            return 1 if problems else 0
        elif args.command == "status":
            print("\n".join(status(args.root)) or "no changes or pending branches")
        elif args.command == "thumbs":
            print(f"{thumbs(args.root)} thumbnails created")
        elif args.command == "flow":
            if args.hide == args.show:
                raise FlowMapError("use --hide or --show")
            set_flow_hidden(args.root, args.id, args.hide)
        elif args.command == "hotspots":
            result = hotspots.autodetect(args.root, args.overwrite)
            print(f"{result['applied']} hotspots assigned; skipped: {json.dumps(result['skipped'], ensure_ascii=False)}")
        elif args.command == "annotations":
            print(annotations.export(args.root), end="")
    except FlowMapError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    import flowmap  # a single module instance: the others raise `flowmap`'s FlowMapError, not `__main__`'s

    sys.exit(flowmap.main())
