"""Tests de miniaturas, flujos ocultos, antes/después, zonas clicables y comandos retirados."""
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))

import flowmap  # noqa: E402
import hotspots  # noqa: E402
from test_flowmap import make_png  # noqa: E402

HAS_SIPS = shutil.which("sips") is not None
CLI = [sys.executable, str(SCRIPTS / "flowmap.py")]

TREE = """ROOT  Application (0.000, 0.000, 1.000, 1.000)
  Other "Whole screen container"  (0.000, 0.000, 1.000, 0.900)
  Button "Skip"  (0.800, 0.050, 0.150, 0.040)
  Button "Search"  (0.100, 0.900, 0.200, 0.050)
  Other "Search results"  (0.100, 0.500, 0.800, 0.100)
"""


class FeatureTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.root = self.base / "map"
        flowmap.init(self.root, title="Feature X", platform="ios")

    def png(self, name="a.png", **kwargs):
        return make_png(self.base / name, **kwargs)

    def tree(self, text, name="t.txt"):
        path = self.base / name
        path.write_text(text)
        return path

    def add(self, screen_id, **kwargs):
        defaults = dict(title=screen_id.upper(), flow="Main", image=self.png(f"{screen_id}.png"))
        defaults.update(kwargs)
        return flowmap.add(self.root, screen_id, **defaults)

    def data(self):
        return json.loads((self.root / "map.json").read_text())

    # --- miniaturas -------------------------------------------------------

    @unittest.skipUnless(HAS_SIPS, "necesita sips (macOS)")
    def test_add_makes_a_small_jpeg_thumbnail_for_tall_images(self):
        self.add("a", image=self.png("big.png", width=640, height=1400))
        screen = self.data()["screens"][0]
        self.assertEqual(screen["thumb"], "thumbs/a.jpg")
        self.assertEqual(flowmap._image_size(self.root / screen["thumb"])[1], flowmap.THUMB_PX)

    @unittest.skipUnless(HAS_SIPS, "necesita sips (macOS)")
    def test_images_already_small_get_no_thumbnail(self):
        self.add("a", image=self.png("small.png", width=40, height=80))
        self.assertNotIn("thumb", self.data()["screens"][0])

    @unittest.skipUnless(HAS_SIPS, "necesita sips (macOS)")
    def test_thumbs_command_backfills_and_check_flags_a_missing_thumb(self):
        self.add("a", image=self.png("big.png", width=640, height=1400))
        data = self.data()
        data["screens"][0].pop("thumb")
        (self.root / "thumbs" / "a.jpg").unlink()
        flowmap._save(self.root, data)
        self.assertEqual(flowmap.thumbs(self.root), 1)
        self.assertTrue((self.root / "thumbs" / "a.jpg").exists())
        (self.root / "thumbs" / "a.jpg").unlink()
        self.assertTrue(any("miniatura" in p for p in flowmap.check(self.root)))

    # --- flujos ocultos ---------------------------------------------------

    def test_flows_can_be_hidden_and_shown(self):
        self.add("a")
        flowmap.set_flow_hidden(self.root, "main", True)
        self.assertTrue(self.data()["flows"][0]["hidden"])
        flowmap.set_flow_hidden(self.root, "main", False)
        self.assertNotIn("hidden", self.data()["flows"][0])
        with self.assertRaises(flowmap.FlowMapError):
            flowmap.set_flow_hidden(self.root, "ghost", True)

    # --- antes / después --------------------------------------------------

    def test_update_keeps_the_image_from_before_the_first_unacknowledged_change(self):
        original = self.png("a1.png", shade=10)
        self.add("a", image=original, tree=self.tree("Button A\n"))
        flowmap.update(self.root, "a", self.png("a2.png", shade=50), tree=self.tree("Button B\n"))
        previous = self.data()["screens"][0]["previous"]
        self.assertEqual((self.root / previous).read_bytes(), original.read_bytes())
        flowmap.update(self.root, "a", self.png("a3.png", shade=90), tree=self.tree("Button C\n"))
        self.assertEqual(self.data()["screens"][0]["previous"], previous)
        self.assertEqual((self.root / previous).read_bytes(), original.read_bytes())

    def test_unchanged_update_has_no_previous_and_ack_removes_it(self):
        self.add("a", tree=self.tree("Button A\n"))
        flowmap.update(self.root, "a", self.png("a2.png", shade=5), tree=self.tree("Button A\n"))
        self.assertNotIn("previous", self.data()["screens"][0])
        flowmap.update(self.root, "a", self.png("a3.png", shade=7), tree=self.tree("Button B\n"))
        previous = self.data()["screens"][0]["previous"]
        flowmap.ack(self.root, "a")
        self.assertNotIn("previous", self.data()["screens"][0])
        self.assertFalse((self.root / previous).exists())

    # --- zonas clicables (aristas con `at`) -------------------------------

    def test_edges_can_carry_the_tapped_area(self):
        self.add("a")
        self.add("b", from_id="a", action="tap Skip", at={"x": 0.8, "y": 0.05, "w": 0.15, "h": 0.04})
        self.assertEqual(self.data()["edges"][0]["at"], {"x": 0.8, "y": 0.05, "w": 0.15, "h": 0.04})
        flowmap.link(self.root, "a", "b", "tap Skip", at={"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2})
        edges = self.data()["edges"]
        self.assertEqual(len(edges), 1)
        self.assertEqual(edges[0]["at"]["x"], 0.1)

    def test_link_rejects_an_area_outside_the_screen(self):
        self.add("a")
        self.add("b")
        with self.assertRaises(flowmap.FlowMapError):
            flowmap.link(self.root, "a", "b", "tap", at={"x": 0.9, "y": 0, "w": 0.3, "h": 0.1})

    def test_cli_accepts_at_as_four_numbers(self):
        self.add("a")
        self.add("b")
        run = subprocess.run([*CLI, "link", str(self.root), "--from", "a", "--to", "b", "--action", "tap", "--at", "0.1,0.2,0.3,0.1"], capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(self.data()["edges"][0]["at"], {"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.1})

    def test_hotspots_finds_the_element_named_in_the_action(self):
        self.add("a", tree=self.tree(TREE))
        self.add("b", from_id="a", action="Pulsar Skip")
        result = hotspots.autodetect(self.root)
        self.assertEqual(result["applied"], 1)
        self.assertEqual(self.data()["edges"][0]["at"], {"x": 0.8, "y": 0.05, "w": 0.15, "h": 0.04})

    def test_hotspots_grows_tiny_elements_to_a_tappable_size_around_their_center(self):
        self.add("a", tree=self.tree('ROOT  Application (0, 0, 1, 1)\n  AXImage "Chikorita 046"  (0.545, 0.698, 0.212, 0.015)\n'))
        self.add("b", from_id="a", action="Abrir Chikorita 046")
        hotspots.autodetect(self.root)
        at = self.data()["edges"][0]["at"]
        self.assertGreaterEqual(at["h"], hotspots.MIN_H)
        self.assertAlmostEqual(at["y"] + at["h"] / 2, 0.698 + 0.015 / 2, places=3)
        self.assertEqual((at["x"], at["w"]), (0.545, 0.212))

    def test_hotspots_prefers_the_exact_button_over_a_longer_text(self):
        self.add("a", tree=self.tree(TREE))
        self.add("b", from_id="a", action="Buscar Search")
        hotspots.autodetect(self.root)
        self.assertEqual(self.data()["edges"][0]["at"]["y"], 0.9)

    def test_hotspots_skips_ambiguous_missing_and_existing(self):
        ambiguous = TREE + '  Button "Skip"  (0.1, 0.1, 0.1, 0.1)\n'
        self.add("a", tree=self.tree(ambiguous))
        self.add("b", from_id="a", action="Pulsar Skip")
        self.add("c")
        self.add("d", from_id="c", action="Pulsar Skip")  # c no tiene árbol
        flowmap.link(self.root, "a", "d", "Pulsar Search", at={"x": 0.5, "y": 0.5, "w": 0.1, "h": 0.1})
        result = hotspots.autodetect(self.root)
        self.assertEqual(result["applied"], 0)
        self.assertEqual(result["skipped"], {"ambiguous": 1, "no match": 0, "no tree": 1, "already set": 1})

    def test_check_flags_a_missing_before_image(self):
        self.add("a", tree=self.tree("Button A\n"))
        flowmap.update(self.root, "a", self.png("a2.png", shade=50), tree=self.tree("Button B\n"))
        (self.root / self.data()["screens"][0]["previous"]).unlink()
        self.assertTrue(any("antes" in p for p in flowmap.check(self.root)))

    def test_cli_reports_errors_from_every_command_without_a_traceback(self):
        for command in ("hotspots", "annotations", "thumbs"):
            run = subprocess.run([*CLI, command, str(self.base / "nope")], capture_output=True, text=True)
            self.assertEqual(run.returncode, 1, command)
            self.assertIn("error:", run.stderr, command)
            self.assertNotIn("Traceback", run.stderr, command)

    def test_retired_viewer_commands_point_to_the_flow_map_app_and_write_nothing(self):
        self.add("a")
        before = sorted(self.root.rglob("*"))
        for command in ("build", "serve", "portal", "bundle"):
            try:
                run = subprocess.run([*CLI, command, str(self.root)], capture_output=True, text=True, timeout=10)
            except subprocess.TimeoutExpired:
                self.fail(f"{command} started a server instead of refusing")
            self.assertNotEqual(run.returncode, 0, command)
            self.assertNotIn("Traceback", run.stderr, command)
            lines = run.stderr.strip().splitlines()
            self.assertEqual(len(lines), 1, f"{command}: {run.stderr!r}")
            self.assertIn("flow-map", lines[0], command)
            self.assertIn(str(self.root), lines[0], command)
            self.assertEqual(sorted(self.root.rglob("*")), before, command)


if __name__ == "__main__":
    unittest.main()
