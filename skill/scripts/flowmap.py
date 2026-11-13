#!/usr/bin/env python3
"""Mapa de flujos de una app: crea y mantiene la carpeta del mapa (map.json + capturas).

El agente captura (screenshot + árbol de accesibilidad) con la herramienta que
corresponda y usa este CLI solo para registrar y actualizar el mapa. El visor
vive en la app Flow Map (comando `flow-map`), que abre esta carpeta.
Una pantalla puede llevar además una maqueta HTML autocontenida (`add --html`, `html`):
la app la muestra en un iframe aislado junto a la captura.
Esquema y comandos: references/schema.md
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
THUMB_PX = 560  # alto de las miniaturas: el doble de lo que el mapa dibuja, para pantallas de alta densidad
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
    """Las referencias `url(...)` de un CSS, en una sola pasada; un `url(` sin cerrar es un error, no se ignora."""
    urls, pos = [], 0
    while opened := CSS_URL_OPEN.search(text, pos):
        start = opened.end()
        quote = text[start:start + 1] if text[start:start + 1] in ("'", '"') else ""
        end = text.find(quote, start + 1) if quote else start
        close = text.find(")", end) if end != -1 else -1
        if close == -1:
            raise FlowMapError("el CSS está mal formado: hay un url( sin cerrar")
        urls.append(text[start + len(quote):end].strip() if quote else text[start:close].strip())
        pos = close + 1
    return urls


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _load(root):
    path = Path(root) / "map.json"
    if not path.exists():
        raise FlowMapError(f"No existe {path}; corre `init` primero")
    return json.loads(path.read_text())


def _save(root, data):
    (Path(root) / "map.json").write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def _tree_path(root, screen_id):
    return Path(root) / "trees" / f"{screen_id}.txt"


def _screen(data, screen_id):
    for screen in data["screens"]:
        if screen["id"] == screen_id:
            return screen
    raise FlowMapError(f"No existe la pantalla '{screen_id}'")


def _slug(text):
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", ascii_text.lower()).strip("-") or "flujo"


JPEG_SOF = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}


def _image_size(image):
    """(ancho, alto) de un PNG o JPEG según su contenido, no su extensión; (None, None) si es otro formato."""
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
    # Los dígitos cambian con datos dinámicos (horas, contadores, frames) y no cuentan como cambio de pantalla.
    # Las series de números (coordenadas, frames) se colapsan en un solo '#' para que el diff sea legible.
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
    """JPEG de THUMB_PX de alto para el mapa. None si la imagen ya es pequeña o no hay `sips` (macOS)."""
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
    """Genera las miniaturas que falten; devuelve cuántas creó."""
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
    """Copia la imagen de «antes» a baselines/ y devuelve sus campos (`baseline`, y `baselineThumb` si es alta).

    Es la app de hoy frente a un rediseño, no una recaptura aceptada."""
    root, image = Path(root), Path(image)
    if not image.exists():
        raise FlowMapError(f"No existe la imagen {image}")
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
    """True si la referencia carga algo que no va dentro del archivo (no es `data:`, ni vacía, ni un fragmento)."""
    url = (url or "").strip()
    return not (url == "" or url.startswith("#") or url.lower().startswith("data:"))


class _ExternalRefs(HTMLParser):
    """Recoge lo que una maqueta HTML cargaría de fuera: la app la sirve sin red ni archivos vecinos."""

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
    """Valida la maqueta antes de copiar nada; lanza FlowMapError si no es un .html autocontenido."""
    file = Path(file)
    if not file.exists():
        raise FlowMapError(f"No existe el HTML {file}")
    if file.suffix.lower() not in HTML_EXTENSIONS:
        raise FlowMapError(f"{file} no es un archivo .html")
    if file.stat().st_size > MAX_HTML_BYTES:
        raise FlowMapError(f"{file} pesa más de {MAX_HTML_BYTES // 1024 // 1024} MB")
    parser = _ExternalRefs()
    parser.feed(file.read_text(errors="replace"))
    parser.close()
    if parser.found:
        raise FlowMapError(f"el HTML no es autocontenido: carga {parser.found[0]!r} (usa CSS/JS en línea e imágenes y fuentes data:)")


def _store_html(root, screen_id, file):
    """Copia la maqueta (ya validada con `_check_html`) a screens-src/ y devuelve su ruta relativa (el campo `html` de la pantalla)."""
    root, file = Path(root), Path(file)
    target = root / "screens-src" / f"{screen_id}.html"
    target.parent.mkdir(exist_ok=True)
    if file.resolve() != target.resolve():
        shutil.copy2(file, target)
    return str(target.relative_to(root))


def _store_capture(root, screen_id, image, tree, captured_at=None):
    """Copia imagen y árbol al mapa; devuelve los campos de la pantalla y los tokens del árbol nuevo."""
    root = Path(root)
    image = Path(image)
    if not image.exists():
        raise FlowMapError(f"No existe la imagen {image}")
    target = root / "screens" / f"{screen_id}{image.suffix.lower()}"
    if image.resolve() != target.resolve():
        shutil.copy2(image, target)
    tree_path = _tree_path(root, screen_id)
    if tree:
        tree_text = Path(tree).read_text()
        tree_path.write_text(tree_text)
    else:
        tree_path.unlink(missing_ok=True)  # el árbol anterior ya no describe esta captura
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
    """Rectángulo normalizado {x, y, w, h} dentro de la pantalla; lo reutilizan las aristas y las anotaciones."""
    try:
        x, y, w, h = (float(rect[k]) for k in ("x", "y", "w", "h"))
    except (KeyError, TypeError, ValueError):
        raise FlowMapError("rect needs numeric x, y, w, h") from None
    if min(x, y) < 0 or min(w, h) <= 0 or x + w > 1 + 1e-6 or y + h > 1 + 1e-6:
        raise FlowMapError("rect must stay inside the screen (values between 0 and 1, width and height > 0)")
    return {k: round(v, 4) for k, v in zip("xywh", (x, y, w, h))}


def _add_edge(data, from_id, to_id, action, at=None):
    """Registra la arista (sin duplicarla; un `at` nuevo reemplaza al anterior) y cierra la rama pendiente."""
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
        raise FlowMapError(f"{root / 'map.json'} ya existe")
    (root / "screens").mkdir(parents=True, exist_ok=True)
    (root / "trees").mkdir(exist_ok=True)
    data = dict(version=1, title=title, platform=platform, entry=None, flows=[], screens=[], edges=[], frontier=[])
    if meta:
        data["meta"] = meta
    _save(root, data)


def add(root, screen_id, title, flow, image, tree=None, description="", from_id=None, action=None, captured_at=None, meta=None, at=None, before=None, html=None):
    if not ID_PATTERN.match(screen_id):
        raise FlowMapError(f"Id inválido '{screen_id}': usa minúsculas, dígitos y guiones")
    data = _load(root)
    if any(s["id"] == screen_id for s in data["screens"]):
        raise FlowMapError(f"La pantalla '{screen_id}' ya existe; usa `update` para recapturarla")
    if from_id:
        _screen(data, from_id)
        if not action:
            raise FlowMapError("--action es obligatorio junto a --from")

    flow_id = _slug(flow)
    if not any(f["id"] == flow_id for f in data["flows"]):
        data["flows"].append(dict(id=flow_id, title=flow, color=PALETTE[len(data["flows"]) % len(PALETTE)]))

    screen = dict(id=screen_id, title=title, flow=flow_id, description=description, status="ok")
    if before and not Path(before).exists():  # antes de copiar nada: un fallo no deja una pantalla a medias
        raise FlowMapError(f"No existe la imagen {before}")
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
    """Añade o reemplaza el «antes» de una pantalla. `update` y `ack` no lo tocan."""
    data = _load(root)
    screen = _screen(data, screen_id)
    screen.pop("baselineThumb", None)  # una miniatura vieja no describe el «antes» nuevo
    screen.update(_store_baseline(root, screen_id, image))
    _save(root, data)


def set_html(root, screen_id, file):
    """Añade o reemplaza la maqueta HTML de una pantalla. `update` y `ack` no la tocan."""
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
        raise FlowMapError(f"No existe el flujo '{flow_id}'")
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
    """Ruta libre en history/<id>/ para la captura que se va a reemplazar: <YYYYMMDDTHHMMSSZ>[-N].<ext>.

    La hora es la de esa captura en UTC (una fecha sin zona cuenta como UTC); si `capturedAt` falta o no se
    entiende, la fecha de modificación del archivo."""
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
    """Recaptura una pantalla; marca `changed` si su huella cambió y guarda qué cambió."""
    root = Path(root)
    data = _load(root)
    screen = _screen(data, screen_id)
    old_tree_path = _tree_path(root, screen_id)
    old_tree_text = old_tree_path.read_text() if old_tree_path.exists() else None  # antes de que _store_capture lo reemplace
    old_image = screen["image"]
    old_bytes = (root / old_image).read_bytes()  # el mapa puede sobrescribir este archivo al guardar la captura nueva
    history_file = _history_name(root, screen_id, old_image, screen.get("capturedAt"))  # la fecha del archivo también se pierde al reemplazarlo

    fields, new_tokens = _store_capture(root, screen_id, image, tree)
    if fields["image"] != old_image:
        (root / old_image).unlink(missing_ok=True)
    changed = (fields["fingerprintKind"], fields["fingerprint"]) != (screen["fingerprintKind"], screen["fingerprint"])
    screen.pop("thumb", None)
    screen.update(fields)

    result = dict(id=screen_id, changed=changed)
    if changed:
        history_file.parent.mkdir(parents=True, exist_ok=True)
        history_file.write_bytes(old_bytes)  # una por captura reemplazada; el CLI nunca las borra
        if "previous" not in screen:  # el «antes» es lo último aceptado: no se pisa hasta hacer `ack`
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
    problems = [f"id duplicado '{i}'" for i, n in sorted(Counter(ids).items()) if n > 1]
    for s in data["screens"]:
        if s["flow"] not in flows:
            problems.append(f"la pantalla '{s['id']}' usa el flujo inexistente '{s['flow']}'")
        if not (root / s["image"]).exists():
            problems.append(f"falta la imagen de '{s['id']}': {s['image']}")
        if s.get("thumb") and not (root / s["thumb"]).exists():
            problems.append(f"falta la miniatura de '{s['id']}': {s['thumb']}")
        for field in ("previous", "baseline", "baselineThumb"):
            if s.get(field) and not (root / s[field]).exists():
                problems.append(f"falta el «antes» de '{s['id']}': {s[field]}")
        if "html" in s:
            html = s["html"]
            parts = html.split("/") if isinstance(html, str) else []
            if not (parts and parts[0] == "screens-src" and html.endswith(".html") and ".." not in parts):
                problems.append(f"el HTML de '{s['id']}' no es una ruta dentro de screens-src/ que termine en .html: {html!r}")
            elif not (root / html).exists():
                problems.append(f"falta el HTML de '{s['id']}': {html}")
    for e in data["edges"]:
        for end in ("from", "to"):
            if e[end] not in ids:
                problems.append(f"arista '{e['action']}' apunta a '{e[end]}', que no existe")
    for f in data["frontier"]:
        if f["from"] not in ids:
            problems.append(f"rama sin explorar '{f['action']}' sale de '{f['from']}', que no existe")
    if data["entry"] not in ids and ids:
        problems.append(f"entry '{data['entry']}' no existe")
    return problems


def status(root):
    data = _load(root)
    lines = []
    for s in data["screens"]:
        if s["status"] == "changed":
            sim = s["lastChange"]["similarity"]
            lines.append(f"CAMBIÓ  {s['id']}  {s['title']}  (similitud {sim if sim is not None else 'n/d'})")
    for f in data["frontier"]:
        lines.append(f"SIN EXPLORAR  {f['from']} → {f['action']}")
    return lines


RETIRED_COMMANDS = ("build", "serve", "portal", "bundle")


def _parse_at(text):
    try:
        x, y, w, h = (float(part) for part in text.split(","))
    except ValueError:
        raise argparse.ArgumentTypeError("usa cuatro números separados por comas: x,y,w,h") from None
    return dict(x=x, y=y, w=w, h=h)


def _parser():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    def command(name, *args):
        p = sub.add_parser(name)
        p.add_argument("root", help="carpeta del mapa (contiene map.json)")
        for flags, kwargs in args:
            p.add_argument(*flags, **kwargs)
        return p

    required = dict(required=True)
    at = (["--at"], dict(type=_parse_at, help="zona tocada en la pantalla de origen, normalizada: x,y,w,h"))
    command("init", (["--title"], required), (["--platform"], dict(default="web", choices=["web", "ios", "android"])))
    command(
        "add",
        (["--id"], required), (["--title"], required), (["--flow"], required), (["--image"], required),
        (["--tree"], {}), (["--description"], dict(default="")), (["--from"], dict(dest="from_id")), (["--action"], {}),
        (["--captured-at"], {}), (["--before"], dict(help="imagen de «antes» (la app de hoy) para comparar con --image")), at,
        (["--html"], dict(help="maqueta HTML autocontenida de la pantalla (CSS/JS en línea, imágenes data:)")),
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
    for retired in RETIRED_COMMANDS:  # siguen registrados para explicar adónde se fue el visor, no para ejecutarse
        retired_parser = command(retired)
        if retired == "bundle":  # las opciones de antes se aceptan para que el aviso salga igual
            retired_parser.add_argument("--out")
            retired_parser.add_argument("--thumbs-only", action="store_true")
        if retired == "serve":
            retired_parser.add_argument("--port", type=int)
    return parser


def main(argv=None):
    args = _parser().parse_args(argv)
    import annotations, hotspots  # importan flowmap: se cargan aquí y no arriba para evitar el ciclo

    if args.command in RETIRED_COMMANDS:
        print(f"error: el visor ahora vive en la app Flow Map; abre {args.root} con: flow-map open {args.root}", file=sys.stderr)
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
            print("\n".join(status(args.root)) or "sin cambios ni ramas pendientes")
        elif args.command == "thumbs":
            print(f"{thumbs(args.root)} miniaturas creadas")
        elif args.command == "flow":
            if args.hide == args.show:
                raise FlowMapError("usa --hide o --show")
            set_flow_hidden(args.root, args.id, args.hide)
        elif args.command == "hotspots":
            result = hotspots.autodetect(args.root, args.overwrite)
            print(f"{result['applied']} zonas asignadas; omitidas: {json.dumps(result['skipped'], ensure_ascii=False)}")
        elif args.command == "annotations":
            print(annotations.export(args.root), end="")
    except FlowMapError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    import flowmap  # una sola instancia del módulo: los demás lanzan el FlowMapError de `flowmap`, no el de `__main__`

    sys.exit(flowmap.main())
