"""Tests del export de anotaciones: la app Flow Map escribe <mapa>/temp/annotations.json y `annotations` lo convierte en texto para Claude."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))

import annotations  # noqa: E402
import flowmap  # noqa: E402
from test_flowmap import make_png  # noqa: E402

RECT = {"x": 0.1, "y": 0.2, "w": 0.5, "h": 0.25}


class AnnotationsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name)
        self.root = base / "map"
        flowmap.init(self.root, title="Feature X", platform="ios")
        for screen_id, parent in [("home", None), ("detail", "home"), ("edit", "detail")]:
            flowmap.add(
                self.root, screen_id, title=screen_id.title(), flow="Main", image=make_png(base / f"{screen_id}.png"),
                from_id=parent, action=f"tap {screen_id}" if parent else None,
            )
        self.crop = make_png(base / "crop.png", width=10, height=10).read_bytes()

    def add(self, screen="detail", comment="el botón se ve cortado", root=None, rect=RECT):
        """Escribe temp/annotations.json y el recorte tal como lo hace la app Flow Map."""
        root = root or self.root
        (root / "temp").mkdir(exist_ok=True)
        path = root / "temp" / "annotations.json"
        store = json.loads(path.read_text()) if path.exists() else {"version": 1, "seq": {}, "annotations": []}
        number = store["seq"].get(screen, 0) + 1
        store["seq"][screen] = number
        ann = dict(
            id=f"{screen}-{number:02d}", screen=screen, rect=rect, comment=comment, crop=f"temp/{screen}-{number:02d}.png",
            fingerprint=next(s["fingerprint"] for s in json.loads((root / "map.json").read_text())["screens"] if s["id"] == screen),
            at="2026-11-07T10:00:00+00:00",
        )
        (root / ann["crop"]).write_bytes(self.crop)
        store["annotations"].append(ann)
        path.write_text(json.dumps(store, ensure_ascii=False, indent=2) + "\n")
        return ann

    def test_export_gives_claude_everything_needed_to_find_the_spot(self):
        self.add(screen="edit", comment="falta el título")
        text = annotations.export(self.root)
        self.assertIn("falta el título", text)
        self.assertIn("Edit (edit)", text)
        self.assertIn("flow Main", text)
        self.assertIn("Home → [tap detail] → Detail → [tap edit] → Edit", text)
        self.assertIn(str((self.root / "temp" / "edit-01.png").resolve()), text)
        self.assertIn(str((self.root / "screens" / "edit.png").resolve()), text)
        self.assertIn("10%", text)  # x del recuadro

    def test_export_describes_a_whole_screen_annotation_as_the_full_area(self):
        self.add(rect={"x": 0, "y": 0, "w": 1, "h": 1})
        self.assertIn("area x 0%, y 0%, width 100%, height 100%", annotations.export(self.root))

    def test_export_can_select_ids_and_is_explicit_when_empty(self):
        self.add(comment="uno")
        second = self.add(comment="dos")
        text = annotations.export(self.root, [second["id"]])
        self.assertIn("dos", text)
        self.assertNotIn("uno", text)
        self.assertIn("No annotations", annotations.export(self.root, ["nope"]))

    def test_export_warns_when_the_screen_was_recaptured_after_annotating(self):
        self.add(screen="home")
        flowmap.update(self.root, "home", make_png(Path(self.tmp.name) / "new.png", shade=200))
        self.assertIn("recaptured", annotations.export(self.root))

    def test_export_opens_with_an_instruction_so_the_text_works_as_a_prompt(self):
        self.add(comment="mover el botón")
        text = annotations.export(self.root)
        self.assertTrue(text.startswith("The user marked areas"), text[:80])
        first = text.splitlines()[0]
        self.assertIn("Read", first)
        self.assertIn("references, not code to edit", first)  # capturas de otra app no se «aplican»

    def test_export_survives_losing_its_line_breaks(self):
        self.add(screen="edit", comment="falta el título")
        text = annotations.export(self.root)
        crop = (self.root / "temp" / "edit-01.png").resolve()
        full = (self.root / "screens" / "edit.png").resolve()
        self.assertIn(f"`{crop}`", text)
        self.assertIn(f"`{full}`", text)
        self.assertIn(f"`{self.root.resolve()}`", text)

    def test_export_names_the_app_when_the_map_has_a_subtitle(self):
        data = json.loads((self.root / "map.json").read_text())
        data["meta"] = {"subtitle": "iPhone 16 Pro · 1.24.4"}
        flowmap._save(self.root, data)
        self.add()
        self.assertIn("App: iPhone 16 Pro · 1.24.4", annotations.export(self.root))

    def make_folder_of_maps(self):
        folder = Path(self.tmp.name) / "maps"
        for name in ("alpha", "beta", "gamma"):
            root = folder / name
            flowmap.init(root, title=f"App {name}", platform="ios")
            flowmap.add(root, "home", "Home", "Main", make_png(Path(self.tmp.name) / f"{name}.png"))
        self.add("home", "nota de alpha", root=folder / "alpha")
        self.add("home", "nota de gamma", root=folder / "gamma")
        return folder

    def test_export_over_a_folder_groups_every_map_that_has_annotations(self):
        text = annotations.export(self.make_folder_of_maps())
        self.assertIn("nota de alpha", text)
        self.assertIn("nota de gamma", text)
        self.assertIn("App alpha", text)
        self.assertNotIn("App beta", text)  # sin anotaciones: no aparece
        self.assertEqual(text.count("The user marked areas"), 1)  # la instrucción va una sola vez

    def test_export_over_a_folder_without_annotations_or_a_missing_one(self):
        folder = self.make_folder_of_maps()
        self.assertIn("No annotations", annotations.export(folder, ["nope"]))
        with self.assertRaises(flowmap.FlowMapError):
            annotations.export(Path(self.tmp.name) / "ghost")

    def test_cli_annotations_prints_the_export(self):
        self.add(comment="desde el CLI")
        run = subprocess.run([sys.executable, str(SCRIPTS / "flowmap.py"), "annotations", str(self.root)], capture_output=True, text=True)
        self.assertEqual(run.returncode, 0)
        self.assertIn("desde el CLI", run.stdout)


if __name__ == "__main__":
    unittest.main()
