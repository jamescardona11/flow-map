"""Tests del CLI flowmap: esquema del JSON, recaptura con detección de cambios."""
import json
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))

import flowmap  # noqa: E402


def make_png(path, width=40, height=80, shade=0):
    raw = b"".join(b"\x00" + bytes([shade]) * width for _ in range(height))

    def chunk(kind, body):
        crc = zlib.crc32(kind + body) & 0xFFFFFFFF
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", crc)

    header = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
    )
    return path


class FlowMapTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "map"
        self.inputs = Path(self.tmp.name) / "in"
        self.inputs.mkdir()
        flowmap.init(self.root, title="Feature X", platform="ios")

    def png(self, name="a.png", **kwargs):
        return make_png(self.inputs / name, **kwargs)

    def tree(self, text, name="t.txt"):
        path = self.inputs / name
        path.write_text(text)
        return path

    def add(self, screen_id, **kwargs):
        defaults = dict(title=screen_id.upper(), flow="Entrar", image=self.png(f"{screen_id}.png"))
        defaults.update(kwargs)
        return flowmap.add(self.root, screen_id, **defaults)

    def data(self):
        return json.loads((self.root / "map.json").read_text())

    # --- init / add -------------------------------------------------------

    def test_init_refuses_to_overwrite_existing_map(self):
        with self.assertRaises(flowmap.FlowMapError):
            flowmap.init(self.root, title="otra", platform="web")

    def test_add_first_screen_becomes_entry_and_creates_flow(self):
        self.add("login", title="Login", flow="Entrar")
        data = self.data()
        self.assertEqual(data["entry"], "login")
        self.assertEqual([f["title"] for f in data["flows"]], ["Entrar"])
        screen = data["screens"][0]
        self.assertEqual((screen["width"], screen["height"]), (40, 80))
        self.assertTrue((self.root / screen["image"]).exists())

    def test_add_with_from_creates_edge_and_reuses_flow(self):
        self.add("a")
        self.add("b", from_id="a", action="tap Continuar")
        data = self.data()
        self.assertEqual(len(data["flows"]), 1)
        self.assertEqual(data["edges"], [{"from": "a", "to": "b", "action": "tap Continuar"}])

    def test_add_rejects_duplicate_id_unknown_parent_and_missing_action(self):
        self.add("a")
        with self.assertRaises(flowmap.FlowMapError):
            self.add("a")
        with self.assertRaises(flowmap.FlowMapError):
            self.add("b", from_id="zzz", action="tap")
        with self.assertRaises(flowmap.FlowMapError):
            self.add("b", from_id="a")

    def test_add_rejects_invalid_id(self):
        with self.assertRaises(flowmap.FlowMapError):
            self.add("Con Espacios")

    def test_add_reads_jpeg_dimensions_even_with_a_png_extension(self):
        def segment(marker, body):
            return b"\xff" + bytes([marker]) + struct.pack(">H", len(body) + 2) + body

        sof = struct.pack(">BHHB", 8, 800, 1024, 1) + b"\x01\x11\x00"
        jpeg = b"\xff\xd8" + segment(0xE1, b"Exif\x00\x00" + b"x" * 40) + segment(0xC0, sof) + b"\xff\xd9"
        image = self.inputs / "mac.png"
        image.write_bytes(jpeg)
        self.add("a", image=image)
        screen = self.data()["screens"][0]
        self.assertEqual((screen["width"], screen["height"]), (1024, 800))

    def test_add_keeps_a_given_capture_date_and_screen_meta(self):
        self.add("a", captured_at="2026-10-29T12:23:17+00:00", meta={"sha256": "abc", "controller": "agent-device"})
        screen = self.data()["screens"][0]
        self.assertEqual(screen["capturedAt"], "2026-10-29T12:23:17+00:00")
        self.assertEqual(screen["meta"], {"sha256": "abc", "controller": "agent-device"})

    def test_screens_without_meta_do_not_get_the_key(self):
        self.add("a")
        self.assertNotIn("meta", self.data()["screens"][0])

    def test_init_stores_map_meta(self):
        root = Path(self.tmp.name) / "withmeta"
        flowmap.init(root, title="X", platform="ios", meta={"version": "1.2", "blocks": ["Pro"]})
        self.assertEqual(json.loads((root / "map.json").read_text())["meta"], {"version": "1.2", "blocks": ["Pro"]})

    def test_update_keeps_screen_meta(self):
        self.add("a", meta={"note": "x"}, tree=self.tree("Button A\n"))
        flowmap.update(self.root, "a", self.png("a2.png"), tree=self.tree("Button B\n"))
        self.assertEqual(self.data()["screens"][0]["meta"], {"note": "x"})

    # --- link / frontier --------------------------------------------------

    def test_link_adds_edge_between_existing_screens_and_is_idempotent(self):
        self.add("a")
        self.add("b", from_id="a", action="ir")
        flowmap.link(self.root, "b", "a", "volver")
        flowmap.link(self.root, "b", "a", "volver")
        self.assertEqual(len(self.data()["edges"]), 2)

    def test_frontier_is_resolved_when_the_branch_gets_explored(self):
        self.add("a")
        flowmap.frontier(self.root, "a", "tap Ajustes")
        self.assertEqual(self.data()["frontier"], [{"from": "a", "action": "tap Ajustes"}])
        self.add("b", from_id="a", action="tap Ajustes")
        self.assertEqual(self.data()["frontier"], [])

    def test_frontier_is_resolved_by_link(self):
        self.add("a")
        self.add("b")
        flowmap.frontier(self.root, "a", "tap B")
        flowmap.link(self.root, "a", "b", "tap B")
        self.assertEqual(self.data()["frontier"], [])

    # --- update -----------------------------------------------------------

    def test_update_with_digits_only_change_is_not_a_change(self):
        self.add("a", tree=self.tree("Button Continue\nText 12 items\n"))
        result = flowmap.update(self.root, "a", self.png("a2.png", shade=9), tree=self.tree("Button Continue\nText 47 items\n"))
        self.assertFalse(result["changed"])
        self.assertEqual(self.data()["screens"][0]["status"], "ok")

    def test_update_with_text_change_marks_changed_and_records_diff(self):
        self.add("a", tree=self.tree("Button Continue\nText Welcome\n"))
        result = flowmap.update(self.root, "a", self.png("a2.png"), tree=self.tree("Button Next\nText Welcome\n"))
        self.assertTrue(result["changed"])
        screen = self.data()["screens"][0]
        self.assertEqual(screen["status"], "changed")
        self.assertEqual(screen["lastChange"]["added"], ["button next"])
        self.assertEqual(screen["lastChange"]["removed"], ["button continue"])
        self.assertLess(screen["lastChange"]["similarity"], 1)

    def test_diff_collapses_coordinate_noise(self):
        self.add("a", tree=self.tree('Button "Go" (0.1, 0.2, 0.3, 0.4)\n'))
        flowmap.update(self.root, "a", self.png("a2.png"), tree=self.tree('Button "Stop" (0.1, 0.2, 0.3, 0.4)\n'))
        change = self.data()["screens"][0]["lastChange"]
        self.assertEqual(change["added"], ['button "stop" (#)'])
        self.assertEqual(change["removed"], ['button "go" (#)'])

    def test_update_without_tree_drops_the_stale_stored_tree(self):
        self.add("a", tree=self.tree("Button A\n"))
        flowmap.update(self.root, "a", self.png("a2.png", shade=5))
        self.assertFalse((self.root / "trees" / "a.txt").exists())
        self.assertEqual(self.data()["screens"][0]["fingerprintKind"], "image")

    def test_update_without_trees_falls_back_to_image_hash(self):
        self.add("a", image=self.png("a1.png", shade=1))
        same = flowmap.update(self.root, "a", self.png("same.png", shade=1))
        self.assertFalse(same["changed"])
        different = flowmap.update(self.root, "a", self.png("diff.png", shade=200))
        self.assertTrue(different["changed"])

    def test_update_replaces_the_stored_image(self):
        self.add("a", image=self.png("a1.png", width=40, height=80))
        flowmap.update(self.root, "a", self.png("a2.png", width=60, height=90))
        screen = self.data()["screens"][0]
        self.assertEqual((screen["width"], screen["height"]), (60, 90))

    def test_update_accepts_the_image_already_stored_in_the_map(self):
        self.add("a")
        stored = self.root / self.data()["screens"][0]["image"]
        result = flowmap.update(self.root, "a", stored)
        self.assertFalse(result["changed"])
        self.assertTrue(stored.exists())

    def test_update_unknown_screen_fails(self):
        with self.assertRaises(flowmap.FlowMapError):
            flowmap.update(self.root, "zzz", self.png())

    def test_ack_clears_changed_status(self):
        self.add("a", tree=self.tree("Button A\n"))
        flowmap.update(self.root, "a", self.png("a2.png"), tree=self.tree("Button B\n"))
        flowmap.ack(self.root, "a")
        screen = self.data()["screens"][0]
        self.assertEqual(screen["status"], "ok")
        self.assertNotIn("lastChange", screen)

    # --- check / build ----------------------------------------------------

    def test_check_reports_dangling_edges_and_missing_images(self):
        self.add("a")
        data = self.data()
        data["edges"].append({"from": "a", "to": "ghost", "action": "x"})
        (self.root / data["screens"][0]["image"]).unlink()
        flowmap._save(self.root, data)
        problems = flowmap.check(self.root)
        self.assertTrue(any("ghost" in p for p in problems))
        self.assertTrue(any("imagen" in p for p in problems))

    def test_check_passes_on_a_healthy_map(self):
        self.add("a")
        self.add("b", from_id="a", action="ir")
        self.assertEqual(flowmap.check(self.root), [])

    def test_cli_roundtrip(self):
        cli = [sys.executable, str(SCRIPTS / "flowmap.py")]
        root = Path(self.tmp.name) / "cli"
        image = self.png("cli.png")
        run = lambda *args: subprocess.run([*cli, *args], capture_output=True, text=True)
        self.assertEqual(run("init", str(root), "--title", "CLI", "--platform", "web").returncode, 0)
        self.assertEqual(run("add", str(root), "--id", "home", "--title", "Home", "--flow", "Main", "--image", str(image)).returncode, 0)
        bad = run("add", str(root), "--id", "home", "--title", "x", "--flow", "Main", "--image", str(image))
        self.assertEqual(bad.returncode, 1)
        self.assertIn("home", bad.stderr)


if __name__ == "__main__":
    unittest.main()
