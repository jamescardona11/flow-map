"""HTML de una pantalla: la maqueta opcional (`screens[].html`) que la app Flow Map muestra en un iframe aislado."""
import json
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))

import flowmap  # noqa: E402
from test_flowmap import make_png  # noqa: E402

CLI = [sys.executable, str(SCRIPTS / "flowmap.py")]
PAGE = "<!doctype html><html><body>{}</body></html>"


class HtmlTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.root = self.base / "map"
        flowmap.init(self.root, title="Mock", platform="ios")
        self.image = make_png(self.base / "home.png")

    def run_cli(self, *args):
        return subprocess.run([*CLI, *args], capture_output=True, text=True)

    def write(self, name, content):
        path = self.base / name
        path.write_text(content)
        return path

    def add(self, screen_id="home", *extra):
        return self.run_cli("add", str(self.root), "--id", screen_id, "--title", screen_id, "--flow", "Main", "--image", str(self.image), *extra)

    def set_html(self, file, screen_id="home"):
        return self.run_cli("html", str(self.root), "--id", screen_id, "--file", str(file))

    def screens(self):
        return {s["id"]: s for s in json.loads((self.root / "map.json").read_text())["screens"]}

    def test_a_screen_can_register_its_html_and_replace_it_and_keeps_it_through_update_and_ack(self):
        first = self.write("first.html", PAGE.format("first"))
        self.assertEqual(self.add("home", "--html", str(first)).returncode, 0)
        self.assertEqual(self.add("plain").returncode, 0)
        screens = self.screens()
        self.assertEqual(screens["home"]["html"], "screens-src/home.html")
        self.assertEqual((self.root / "screens-src" / "home.html").read_bytes(), first.read_bytes())
        self.assertNotIn("html", screens["plain"])

        second = self.write("second.html", PAGE.format("second"))
        done = self.set_html(second)
        self.assertEqual((done.returncode, done.stdout, done.stderr), (0, "", ""))
        self.assertEqual(self.screens()["home"]["html"], "screens-src/home.html")
        self.assertEqual((self.root / "screens-src" / "home.html").read_bytes(), second.read_bytes())
        self.assertEqual(self.set_html(second, "plain").returncode, 0)
        self.assertEqual(self.screens()["plain"]["html"], "screens-src/plain.html")

        unknown = self.set_html(second, "ghost")
        self.assertEqual(unknown.returncode, 1)
        self.assertTrue(unknown.stderr.startswith("error:"))
        self.assertIn("ghost", unknown.stderr)

        recapture = make_png(self.base / "v2.png", shade=9)
        self.assertEqual(self.run_cli("update", str(self.root), "--id", "home", "--image", str(recapture)).returncode, 0)
        self.assertEqual(self.run_cli("ack", str(self.root), "--id", "home").returncode, 0)
        self.assertEqual(self.screens()["home"]["html"], "screens-src/home.html")
        self.assertEqual((self.root / "screens-src" / "home.html").read_bytes(), second.read_bytes())

    def test_refuses_html_that_loads_anything_external_or_is_not_an_html_file_and_writes_nothing(self):
        refused = [
            ("script src", "<script src='https://cdn.example.com/app.js'></script>", "https://cdn.example.com/app.js"),
            ("stylesheet link", "<link rel='stylesheet' href='style.css'>", "style.css"),
            ("icon link", "<link rel='icon' href='favicon.ico'>", "favicon.ico"),
            ("preload link", "<link rel='preload' href='font.woff2' as='font'>", "font.woff2"),
            ("@import string", "<style>@import 'theme.css';</style>", "theme.css"),
            ("@import url", "<style>@import url(https://fonts.example.com/x.css);</style>", "https://fonts.example.com/x.css"),
            ("css url", "<style>body{background:url(bg.png)}</style>", "bg.png"),
            ("css url quoted", "<style>body{background:url('https://img.example.com/y.png')}</style>", "https://img.example.com/y.png"),
            ("img src", "<img src='photo.png'>", "photo.png"),
            ("img srcset", "<img srcset='a.png 1x, b.png 2x'>", "a.png"),
            ("video poster", "<video poster='poster.jpg'></video>", "poster.jpg"),
            ("source src", "<video><source src='clip.mp4'></video>", "clip.mp4"),
            ("iframe", "<iframe srcdoc='x'></iframe>", "iframe"),
            ("object", "<object data='x.swf'></object>", "object"),
            ("embed", "<embed type='text/plain'>", "embed"),
        ]
        self.assertEqual(self.add("home").returncode, 0)
        original = self.write("original.html", PAGE.format("original"))
        self.assertEqual(self.set_html(original).returncode, 0)

        for name, markup, offending in refused:
            with self.subTest(name):
                file = self.write("bad.html", PAGE.format(markup))
                added = self.add("fresh", "--html", str(file))
                self.assertEqual(added.returncode, 1)
                self.assertTrue(added.stderr.startswith("error:"), added.stderr)
                self.assertIn(offending, added.stderr)
                self.assertNotIn("fresh", self.screens())
                self.assertFalse((self.root / "screens-src" / "fresh.html").exists())

                replaced = self.set_html(file)
                self.assertEqual(replaced.returncode, 1)
                self.assertIn(offending, replaced.stderr)
                self.assertEqual((self.root / "screens-src" / "home.html").read_bytes(), original.read_bytes())

        not_files = [
            ("missing file", self.base / "ghost.html"),
            ("wrong extension", self.write("page.txt", PAGE.format("x"))),
            ("over 5 MB", self.write("big.html", PAGE.format("a" * (5 * 1024 * 1024 + 1)))),
        ]
        for name, file in not_files:
            with self.subTest(name):
                added = self.add("fresh", "--html", str(file))
                self.assertEqual(added.returncode, 1)
                self.assertTrue(added.stderr.startswith("error:"), added.stderr)
                self.assertNotIn("fresh", self.screens())
                self.assertFalse((self.root / "screens-src" / "fresh.html").exists())
                self.assertEqual(self.set_html(file).returncode, 1)
                self.assertEqual((self.root / "screens-src" / "home.html").read_bytes(), original.read_bytes())

        allowed = [
            ("fragment link", "<a href='#x'>x</a>"),
            ("external link", "<a href='https://example.com/docs'>docs</a>"),
            ("data link", "<a href='data:text/plain,hi'>hi</a>"),
            ("data image", "<img src='data:image/png;base64,AAAA'>"),
            ("data font and fragment url", "<style>@font-face{font-family:f;src:url(data:font/woff2;base64,AAAA)}.a{fill:url(#grad)}</style>"),
            ("empty src", "<img src=''>"),
            ("inline script and handler", "<button onclick='go()'>go</button><script>function go(){document.title='x'}</script>"),
        ]
        for name, markup in allowed:
            with self.subTest(name):
                file = self.write("ok.html", PAGE.format(markup))
                self.assertEqual(self.set_html(file).returncode, 0)
        htm = self.write("legacy.htm", PAGE.format("legacy"))
        self.assertEqual(self.add("other", "--html", str(htm)).returncode, 0)
        self.assertEqual(self.screens()["other"]["html"], "screens-src/other.html")

    def test_refuses_quickly_a_style_with_unterminated_url_calls_and_writes_nothing(self):
        malformed = self.write("unterminated.html", PAGE.format("<style>" + "a{b:url(x" * 20000 + "</style>"))
        self.assertEqual(self.add("home").returncode, 0)
        original = self.write("original.html", PAGE.format("original"))
        self.assertEqual(self.set_html(original).returncode, 0)

        def run_bounded(*args):
            started = time.monotonic()
            try:
                done = subprocess.run([*CLI, *args], capture_output=True, text=True, timeout=10)
            except subprocess.TimeoutExpired:
                self.fail("the guard did not finish within 10 s on 20,000 unterminated url( calls")
            self.assertLess(time.monotonic() - started, 3)
            return done

        for name, args in [
            ("add --html", ("add", str(self.root), "--id", "fresh", "--title", "fresh", "--flow", "Main", "--image", str(self.image), "--html", str(malformed))),
            ("html", ("html", str(self.root), "--id", "home", "--file", str(malformed))),
        ]:
            with self.subTest(name):
                done = run_bounded(*args)
                self.assertEqual(done.returncode, 1)
                self.assertTrue(done.stderr.startswith("error:"), done.stderr)
                self.assertEqual(len(done.stderr.strip().splitlines()), 1, done.stderr)
                self.assertIn("url(", done.stderr)
        self.assertNotIn("fresh", self.screens())
        self.assertFalse((self.root / "screens-src" / "fresh.html").exists())
        self.assertEqual((self.root / "screens-src" / "home.html").read_bytes(), original.read_bytes())

    def test_check_reports_an_html_that_is_missing_or_not_a_relative_html_path_inside_the_folder(self):
        self.assertEqual(self.add("home").returncode, 0)
        (self.root / "screens-src").mkdir()
        (self.root / "screens-src" / "home.html").write_text(PAGE.format("ok"))

        outside = self.write("outside.html", PAGE.format("outside"))
        (self.root / "screens-src" / "notes.txt").write_text("x")
        bad = {
            "gone": "screens-src/gone.html",
            "up": "../outside.html",
            "abs": str(outside),
            "txt": "screens-src/notes.txt",
            "num": 42,
        }
        for screen_id in bad:
            self.assertEqual(self.add(screen_id).returncode, 0)
        data = json.loads((self.root / "map.json").read_text())
        for screen in data["screens"]:
            screen["html"] = bad.get(screen["id"], "screens-src/home.html")
        (self.root / "map.json").write_text(json.dumps(data))

        problems = flowmap.check(self.root)
        self.assertIn("falta el HTML de 'gone': screens-src/gone.html", problems)
        for screen_id in bad:
            with self.subTest(screen_id):
                self.assertEqual(len([p for p in problems if f"'{screen_id}'" in p and "HTML" in p]), 1, problems)
        self.assertFalse([p for p in problems if "'home'" in p], problems)


if __name__ == "__main__":
    unittest.main()
