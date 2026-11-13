"""Zonas clicables: deduce dónde se tocó en la pantalla de origen buscando en su árbol el elemento que nombra la acción.

Solo sirve con árboles que traen el marco normalizado de cada elemento (`Button "Skip" (x, y, w, h)`, el
formato del runner de XCUITest). Es una heurística: si no hay una coincidencia única, no asigna nada.
"""
import re
from pathlib import Path

import flowmap

ELEMENT = re.compile(r"^\s*\w+\s+" + flowmap.QUOTED.pattern + r"\s+\(([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\)")
MAX_AREA = 0.5  # lo que ocupa media pantalla es un contenedor, no algo que se toque
MIN_W, MIN_H = 0.08, 0.04  # objetivo táctil mínimo: una línea de texto de 13 px no se puede pulsar en el visor


def _tappable(rect):
    """Agranda alrededor de su centro lo que sea más pequeño que MIN_W × MIN_H, sin salirse de la pantalla."""
    grown = dict(rect)
    for pos, size, minimum in (("x", "w", MIN_W), ("y", "h", MIN_H)):
        grown[size] = max(rect[size], minimum)
        grown[pos] = min(max(0.0, rect[pos] + rect[size] / 2 - grown[size] / 2), 1 - grown[size])
    return grown


def _elements(tree_text):
    for line in tree_text.splitlines():
        match = ELEMENT.match(line)
        if not match:
            continue
        label = match.group(1).replace("\\n", "\n").split("\n")[0].strip().lower()
        x, y, w, h = (float(v) for v in match.groups()[1:])
        if len(label) >= 2 and w * h <= MAX_AREA:
            yield label, _tappable(dict(x=x, y=y, w=min(w, 1 - x), h=min(h, 1 - y)))


def _locate(tree_text, action):
    """(rect, None) si un único elemento nombra la acción; (None, motivo) si no hay coincidencia o es ambigua."""
    action = action.lower()
    found = [(label, rect) for label, rect in _elements(tree_text) if re.search(rf"(?<!\w){re.escape(label)}(?!\w)", action)]
    if not found:
        return None, "no match"
    longest = max(len(label) for label, _ in found)
    best = [rect for label, rect in found if len(label) == longest]
    if any(rect != best[0] for rect in best):
        return None, "ambiguous"
    return best[0], None


def autodetect(root, overwrite=False):
    root = Path(root)
    data = flowmap._load(root)
    skipped = dict.fromkeys(("ambiguous", "no match", "no tree", "already set"), 0)
    applied = 0
    for edge in data["edges"]:
        tree = flowmap._tree_path(root, edge["from"])
        if edge.get("at") and not overwrite:
            rect, reason = None, "already set"
        elif not tree.exists():
            rect, reason = None, "no tree"
        else:
            rect, reason = _locate(tree.read_text(errors="replace"), edge["action"])
        if rect:
            edge["at"] = flowmap.valid_rect(rect)
            applied += 1
        else:
            skipped[reason] += 1
    flowmap._save(root, data)
    return dict(applied=applied, skipped=skipped)
