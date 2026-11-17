"""Synthetic ZIPs only; no game code or map data in test fixtures."""
import importlib.util
import stat
import tempfile
import unittest
import zipfile
from pathlib import Path

PATH = Path(__file__).resolve().parents[1] / "scripts" / "audit_html5_zip.py"
SPEC = importlib.util.spec_from_file_location("audit_html5_zip", PATH)
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)


def build_zip(path, entries=None):
    if entries is None:
        entries = {
            f"html5-online/games/{v}-fixture/js/game.js":
            (b"(o = new h.Game(m)),\r\nprohibitJump togglePause MechManager\r\n"
             if v == 1 else b"synthetic-game-fixture")
            for v in range(1, 7)
        }
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as stream:
        for name, data in entries.items():
            stream.writestr(name, data)
    return path


class ArchiveTests(unittest.TestCase):
    def test_detect_six_versions_and_preserve_input(self):
        with tempfile.TemporaryDirectory() as root:
            p = build_zip(Path(root) / "original-only-in-test.zip")
            before = p.read_bytes()
            result = audit.inspect(p)
            self.assertEqual(result["status"], "inspected")
            self.assertEqual(sorted(result["games"]), list("123456"))
            self.assertEqual(result["games"]["1"]["crlfCount"], 2)
            self.assertEqual(result["games"]["1"]["anchorCounts"]["(o = new h.Game(m)),"], 1)
            self.assertEqual(result["archive"]["sha256"], audit.file_sha256(p))
            self.assertEqual(p.read_bytes(), before)
            self.assertFalse(result["gameplayVerified"])
            self.assertFalse(result["netplayVerified"])

    def test_partial_archive_is_never_a_playable_claim(self):
        with tempfile.TemporaryDirectory() as root:
            p = build_zip(Path(root) / "one.zip", {"games/1-fixture/js/game.js": b"synthetic"})
            result = audit.inspect(p)
            self.assertEqual(result["status"], "partial")
            self.assertEqual(result["missingScriptVersions"], list("23456"))
            self.assertFalse(result["games"]["1"]["identicalToResearchCandidate"])
            self.assertFalse(result["netplayVerified"])

    def test_reject_unsafe_paths_and_case_duplicates(self):
        with tempfile.TemporaryDirectory() as root:
            for idx, bad in enumerate(["../bad", "/absolute", "C:/root", "a\\b", "a//b", "a/./b"]):
                p = build_zip(Path(root) / f"unsafe-{idx}.zip", {bad: b"synthetic"})
                with self.subTest(bad=bad), self.assertRaises(audit.UnsafeArchive):
                    audit.inspect(p)
            p = Path(root) / "cases.zip"
            with zipfile.ZipFile(p, "w") as stream:
                stream.writestr("one/FILE", b"x")
                stream.writestr("ONE/file", b"y")
            with self.assertRaises(audit.UnsafeArchive):
                audit.inspect(p)

    def test_reject_symbolic_link(self):
        with tempfile.TemporaryDirectory() as root:
            p = Path(root) / "link.zip"
            item = zipfile.ZipInfo("link")
            item.create_system = 3
            item.external_attr = (stat.S_IFLNK | 0o777) << 16
            with zipfile.ZipFile(p, "w") as archive:
                archive.writestr(item, "destination")
            with self.assertRaises(audit.UnsafeArchive):
                audit.inspect(p)

    def test_reject_invalid_script_encoding_and_excessive_data(self):
        with tempfile.TemporaryDirectory() as root:
            p = build_zip(Path(root) / "bad-utf8.zip", {"games/1-s/js/game.js": b"\xff"})
            with self.assertRaises(audit.UnsafeArchive):
                audit.inspect(p)
            old = audit.MAX_TOTAL_BYTES
            try:
                audit.MAX_TOTAL_BYTES = 2
                p = build_zip(Path(root) / "quota.zip", {"a": b"123"})
                with self.assertRaises(audit.UnsafeArchive):
                    audit.inspect(p)
            finally:
                audit.MAX_TOTAL_BYTES = old


if __name__ == "__main__":
    unittest.main()
