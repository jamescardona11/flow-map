"""History: `update` keeps every replaced capture in history/<id>/<YYYYMMDDTHHMMSSZ>.<ext>."""
import os
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))

import flowmap  # noqa: E402
from test_flowmap import make_png  # noqa: E402

TAKEN = "2026-10-29T12:23:17+00:00"
TAKEN_EPOCH = 1793276597  # the same instant, in seconds since 1970 UTC


class HistoryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.root = self.base / "map"
        flowmap.init(self.root, title="History", platform="ios")

    def png(self, name, shade):
        return make_png(self.base / name, shade=shade)

    def add(self, screen_id, shade, captured_at=None):
        flowmap.add(self.root, screen_id, title=screen_id, flow="Main", image=self.png(f"{screen_id}.png", shade), captured_at=captured_at)

    def set_captured_at(self, screen_id, value):
        """`update` stamps the new capture with the current time; this lets the test set the time of the «old» one."""
        data = flowmap._load(self.root)
        screen = next(s for s in data["screens"] if s["id"] == screen_id)
        if value is None:
            screen.pop("capturedAt")
        else:
            screen["capturedAt"] = value
        flowmap._save(self.root, data)

    def history(self, screen_id):
        folder = self.root / "history" / screen_id
        return sorted(p.name for p in folder.iterdir()) if folder.exists() else []

    def test_keeps_every_replaced_capture_named_by_its_own_time_and_never_deletes_them(self):
        self.add("home", shade=0, captured_at=TAKEN)
        first = (self.root / "screens" / "home.png").read_bytes()

        flowmap.update(self.root, "home", self.png("v2.png", shade=10))
        self.assertEqual(self.history("home"), ["20261029T122317Z.png"])
        self.assertEqual((self.root / "history/home/20261029T122317Z.png").read_bytes(), first)

        second = (self.root / "screens" / "home.png").read_bytes()
        flowmap.update(self.root, "home", self.png("v2-again.png", shade=10))  # same fingerprint: no change
        self.assertEqual(self.history("home"), ["20261029T122317Z.png"])

        flowmap.ack(self.root, "home")
        self.assertEqual(self.history("home"), ["20261029T122317Z.png"])

        self.set_captured_at("home", TAKEN)  # the second capture «was taken» in the same second
        flowmap.update(self.root, "home", self.png("v3.png", shade=20))
        self.assertEqual(self.history("home"), ["20261029T122317Z-2.png", "20261029T122317Z.png"])
        self.assertEqual((self.root / "history/home/20261029T122317Z-2.png").read_bytes(), second)
        self.assertEqual(flowmap.check(self.root), [])

    def test_names_the_file_in_utc_and_falls_back_to_the_old_image_mtime(self):
        cases = [
            ("offset", "2026-10-29T14:23:17+02:00", None),
            ("naive", "2026-10-29T12:23:17", None),
            ("missing", None, TAKEN_EPOCH),
            ("garbage", "not-a-date", TAKEN_EPOCH),
        ]
        for screen_id, captured_at, mtime in cases:
            with self.subTest(screen_id):
                self.add(screen_id, shade=0)
                self.set_captured_at(screen_id, captured_at)
                if mtime:
                    os.utime(self.root / "screens" / f"{screen_id}.png", (mtime, mtime))
                flowmap.update(self.root, screen_id, self.png(f"{screen_id}-v2.png", shade=10))
                self.assertEqual(self.history(screen_id), ["20261029T122317Z.png"])


if __name__ == "__main__":
    unittest.main()
