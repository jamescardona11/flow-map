"""Baseline: la imagen de «antes» de una pantalla (la app de hoy frente a un rediseño), aparte de las recapturas."""
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))

import flowmap  # noqa: E402
from test_flowmap import make_png  # noqa: E402


HAS_SIPS = shutil.which("sips") is not None


class BaselineTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.root = self.base / "map"
        flowmap.init(self.root, title="Today vs redesign", platform="ios")
        self.today = make_png(self.base / "today.png", width=4, height=8)
        self.redesign = make_png(self.base / "redesign.png", width=6, height=12)

    def screen(self, screen_id="home"):
        return next(s for s in flowmap._load(self.root)["screens"] if s["id"] == screen_id)

    def add(self, screen_id="home", **kwargs):
        flowmap.add(self.root, screen_id, title=screen_id.title(), flow="Main", image=self.redesign, **kwargs)

    def test_add_with_a_baseline_stores_it_and_keeps_the_screen_unchanged(self):
        self.add(before=self.today)
        screen = self.screen()
        self.assertEqual(screen["baseline"], "baselines/home.png")
        self.assertEqual((self.root / screen["baseline"]).read_bytes(), self.today.read_bytes())
        self.assertEqual(screen["status"], "ok")
        self.assertNotIn("previous", screen)
        self.assertEqual(flowmap.status(self.root), [])

    def test_add_without_a_baseline_has_none(self):
        self.add()
        self.assertNotIn("baseline", self.screen())

    def test_add_rejects_a_missing_baseline_image_and_leaves_no_screen(self):
        with self.assertRaises(flowmap.FlowMapError):
            self.add(before=self.base / "ghost.png")
        self.assertEqual(flowmap._load(self.root)["screens"], [])

    def test_a_baseline_can_be_attached_later_and_replaced(self):
        self.add()
        flowmap.set_baseline(self.root, "home", self.today)
        self.assertEqual((self.root / self.screen()["baseline"]).read_bytes(), self.today.read_bytes())
        flowmap.set_baseline(self.root, "home", self.redesign)
        self.assertEqual((self.root / self.screen()["baseline"]).read_bytes(), self.redesign.read_bytes())

    def test_attaching_to_an_unknown_screen_fails(self):
        with self.assertRaises(flowmap.FlowMapError):
            flowmap.set_baseline(self.root, "ghost", self.today)

    def test_recapturing_and_acknowledging_never_touch_the_baseline(self):
        self.add(before=self.today)
        flowmap.update(self.root, "home", make_png(self.base / "v2.png", width=6, height=12, shade=9))
        flowmap.ack(self.root, "home")
        screen = self.screen()
        self.assertEqual(screen["baseline"], "baselines/home.png")
        self.assertTrue((self.root / screen["baseline"]).exists())

    def test_check_reports_a_baseline_file_that_went_missing(self):
        self.add(before=self.today)
        self.assertEqual(flowmap.check(self.root), [])
        (self.root / "baselines" / "home.png").unlink()
        self.assertTrue(any("home" in problem and "antes" in problem for problem in flowmap.check(self.root)))

    @unittest.skipUnless(HAS_SIPS, "necesita sips (macOS)")
    def test_a_tall_baseline_gets_its_own_small_thumbnail(self):
        tall = make_png(self.base / "tall.png", width=300, height=1200)
        self.add(before=tall)
        screen = self.screen()
        self.assertEqual(screen["baselineThumb"], "thumbs/home-before.jpg")
        self.assertEqual(flowmap._image_size(self.root / screen["baselineThumb"])[1], flowmap.THUMB_PX)
        flowmap.set_baseline(self.root, "home", self.today)  # un «antes» pequeño ya no necesita miniatura
        self.assertNotIn("baselineThumb", self.screen())
        self.assertFalse((self.root / "thumbs" / "home-before.jpg").exists())

    @unittest.skipUnless(HAS_SIPS, "necesita sips (macOS)")
    def test_thumbs_command_backfills_and_check_flags_a_missing_baseline_thumb(self):
        self.add(before=make_png(self.base / "tall.png", width=300, height=1200))
        data = flowmap._load(self.root)
        data["screens"][0].pop("baselineThumb")
        (self.root / "thumbs" / "home-before.jpg").unlink()
        flowmap._save(self.root, data)
        self.assertEqual(flowmap.thumbs(self.root), 1)
        self.assertEqual(flowmap.check(self.root), [])
        (self.root / "thumbs" / "home-before.jpg").unlink()
        self.assertTrue(any("home-before" in problem for problem in flowmap.check(self.root)))
        flowmap.thumbs(self.root)
        screen = flowmap._load(self.root)["screens"][0]
        self.assertIn("baselineThumb", screen)

    def test_cli_add_before_and_baseline_command(self):
        run = lambda *a: subprocess.run([sys.executable, str(SCRIPTS / "flowmap.py"), *a], capture_output=True, text=True)
        self.assertEqual(run("add", str(self.root), "--id", "a", "--title", "A", "--flow", "F", "--image", str(self.redesign), "--before", str(self.today)).returncode, 0)
        self.assertEqual(run("add", str(self.root), "--id", "b", "--title", "B", "--flow", "F", "--image", str(self.redesign)).returncode, 0)
        self.assertEqual(run("baseline", str(self.root), "--id", "b", "--image", str(self.today)).returncode, 0)
        self.assertIn("baseline", self.screen("a"))
        self.assertIn("baseline", self.screen("b"))
        self.assertEqual(run("baseline", str(self.root), "--id", "ghost", "--image", str(self.today)).returncode, 1)


if __name__ == "__main__":
    unittest.main()
