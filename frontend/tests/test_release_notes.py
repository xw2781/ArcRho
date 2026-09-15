from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


RELEASE_DIR = Path(__file__).resolve().parents[1] / "build" / "release"
if str(RELEASE_DIR) not in sys.path:
    sys.path.insert(0, str(RELEASE_DIR))

import release_notes

TEST_TEMP_ROOT = Path(__file__).resolve().parents[2] / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)


class ReleaseNotesStagingTests(unittest.TestCase):
    """The build writes a version's notes before packaging, then archives its fragments.

    The Release History window reads only the notes bundled inside the installer, so
    notes written after packaging would never reach the build that shipped them.
    """

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        self.root = Path(self.temp_dir.name)
        self.addCleanup(self.temp_dir.cleanup)

        self.original = {
            name: getattr(release_notes, name)
            for name in (
                "REPO_ROOT",
                "CHANGES_ROOT",
                "UNRELEASED_DIR",
                "ARCHIVE_DIR",
                "RELEASES_DIR",
                "RELEASE_INDEX_PATH",
            )
        }
        self.addCleanup(self._restore_paths)

        release_notes.REPO_ROOT = self.root
        release_notes.CHANGES_ROOT = self.root / "changes"
        release_notes.UNRELEASED_DIR = release_notes.CHANGES_ROOT / "unreleased"
        release_notes.ARCHIVE_DIR = release_notes.CHANGES_ROOT / "archive"
        release_notes.RELEASES_DIR = self.root / "docs" / "releases"
        release_notes.RELEASE_INDEX_PATH = release_notes.RELEASES_DIR / "INDEX.md"
        release_notes.ensure_dirs()

        (release_notes.UNRELEASED_DIR / "about-release-history.json").write_text(
            json.dumps(
                {
                    "type": "fix",
                    "scope": "about",
                    "audience": "user",
                    "summary": "Release History lists the installed version.",
                }
            ),
            encoding="utf-8",
        )

    def _restore_paths(self) -> None:
        for name, value in self.original.items():
            setattr(release_notes, name, value)

    def test_staging_writes_the_notes_and_leaves_the_fragments_unreleased(self) -> None:
        path = release_notes.write_release_notes("1.6.2", release_notes.load_unreleased_fragments())

        self.assertTrue(path.is_file())
        self.assertIn("Release History lists the installed version.", path.read_text(encoding="utf-8"))
        # The pending release record and the publish step both read the fragments again.
        self.assertEqual(len(release_notes.load_unreleased_fragments()), 1)
        self.assertFalse((release_notes.ARCHIVE_DIR / "1.6.2").exists())

    def test_release_keeps_the_notes_the_build_packaged(self) -> None:
        path = release_notes.write_release_notes("1.6.2", release_notes.load_unreleased_fragments())
        packaged = path.read_text(encoding="utf-8") + "\nPackaged copy.\n"
        path.write_text(packaged, encoding="utf-8")

        release_notes.release_fragments("1.6.2", release_notes.load_unreleased_fragments())

        self.assertEqual(path.read_text(encoding="utf-8"), packaged)
        self.assertEqual(len(list((release_notes.ARCHIVE_DIR / "1.6.2").glob("*.json"))), 1)
        self.assertIn("1.6.2", release_notes.RELEASE_INDEX_PATH.read_text(encoding="utf-8"))

    def test_release_writes_the_notes_when_nothing_staged_them(self) -> None:
        path = release_notes.release_fragments("1.6.2", release_notes.load_unreleased_fragments())

        self.assertTrue(path.is_file())
        self.assertIn("Release History lists the installed version.", path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
