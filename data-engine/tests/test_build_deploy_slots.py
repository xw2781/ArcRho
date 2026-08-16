"""A/B slot deployment contract shared by every frozen-component build script."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
ENGINE_SRC = REPOSITORY_ROOT / "data-engine" / "src"
TEST_TMP_ROOT = Path(__file__).resolve().parent / "logs" / "tmp"
if str(ENGINE_SRC) not in sys.path:
    sys.path.insert(0, str(ENGINE_SRC))

import build_runtime  # noqa: E402
from build_runtime import (  # noqa: E402
    DEPLOY_MANIFEST_NAME,
    align_staged_timestamps,
    deploy_manifest_path,
    deploy_slot_paths,
    stage_deploy,
    swap_deploy,
)


APP_NAME = "ArcRho Test Component"
# Roles whose build script must deploy through the canonical slot rotation
# rather than restating a copy/rename transaction of its own.
DEPLOYING_ROLES = ("engine", "bridge", "gateway", "orchestrator", "admin", "launcher")


def _write_build(root: Path, files: dict[str, str]) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    for relative, text in files.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    return root


def _tree(root: Path) -> dict[str, str]:
    """The build's own files, excluding the deploy manifest that travels with them."""

    return {
        path.relative_to(root).as_posix(): path.read_text(encoding="utf-8")
        for path in root.rglob("*")
        if path.is_file() and path.name != DEPLOY_MANIFEST_NAME
    }


class DeploySlotTests(unittest.TestCase):
    def setUp(self):
        TEST_TMP_ROOT.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=str(TEST_TMP_ROOT))
        self.base = Path(self.temp.name)
        self.apps = self.base / "apps"
        self.dist = self.base / "dist"
        self.live, self.slot, self.previous = deploy_slot_paths(self.apps, APP_NAME)
        self.addCleanup(self.temp.cleanup)

    def _deploy(self, files: dict[str, str]) -> None:
        staged = _write_build(self.dist / APP_NAME, files)
        stage_deploy(staged, self.apps, APP_NAME)
        swap_deploy(self.apps, APP_NAME)

    def _reset_dist(self) -> None:
        build_runtime.remove_tree_with_retry(self.dist / APP_NAME)

    def test_first_deploy_creates_the_live_folder(self):
        self._deploy({"app.exe": "v1", "_internal/runtime.dat": "shared"})

        self.assertEqual(
            _tree(self.live), {"app.exe": "v1", "_internal/runtime.dat": "shared"}
        )
        self.assertFalse(self.previous.exists())

    def test_swap_parks_the_previous_build_in_the_slot(self):
        self._deploy({"app.exe": "v1", "_internal/runtime.dat": "shared"})
        self._reset_dist()
        self._deploy({"app.exe": "v2", "_internal/runtime.dat": "shared"})

        # The new build is live and the one it replaced is the standby slot,
        # where it serves as both rollback copy and the next delta base.
        self.assertEqual(_tree(self.live)["app.exe"], "v2")
        self.assertEqual(_tree(self.slot)["app.exe"], "v1")
        self.assertFalse(self.previous.exists())

    def test_staging_reuses_the_slot_instead_of_deleting_it(self):
        """The delta is the whole point: the slot must never be cleared first."""

        self._deploy({"app.exe": "v1", "_internal/runtime.dat": "shared"})
        self._reset_dist()
        staged = _write_build(
            self.dist / APP_NAME, {"app.exe": "v2", "_internal/runtime.dat": "shared"}
        )

        removed: list[Path] = []
        real_remove = build_runtime.remove_tree_with_retry

        def spy(path, *args, **kwargs):
            removed.append(Path(path))
            return real_remove(path, *args, **kwargs)

        with patch.object(build_runtime, "remove_tree_with_retry", spy):
            stage_deploy(staged, self.apps, APP_NAME)

        self.assertNotIn(self.slot, removed)
        self.assertEqual(removed, [self.previous])

    def test_staging_mirrors_additions_updates_and_removals(self):
        self._deploy({"app.exe": "v1", "drop.dat": "gone", "keep.dat": "same"})
        self._reset_dist()
        staged = _write_build(
            self.dist / APP_NAME, {"app.exe": "v2", "keep.dat": "same", "add.dat": "new"}
        )

        stage_deploy(staged, self.apps, APP_NAME)

        # The slot began as the v1 build; mirroring must leave it exactly v2.
        self.assertEqual(
            _tree(self.slot), {"app.exe": "v2", "keep.dat": "same", "add.dat": "new"}
        )

    def test_failed_swap_restores_the_previous_build(self):
        self._deploy({"app.exe": "v1"})
        self._reset_dist()
        staged = _write_build(self.dist / APP_NAME, {"app.exe": "v2"})
        stage_deploy(staged, self.apps, APP_NAME)

        real_rename = build_runtime.rename_with_retry

        def fail_slot_rename(source, target, *args, **kwargs):
            if Path(source) == self.slot:
                raise PermissionError("slot rename blocked")
            return real_rename(source, target, *args, **kwargs)

        with patch.object(build_runtime, "rename_with_retry", fail_slot_rename):
            with self.assertRaises(PermissionError):
                swap_deploy(self.apps, APP_NAME)

        # Rollback must leave the previous build deployed rather than nothing.
        self.assertEqual(_tree(self.live), {"app.exe": "v1"})
        self.assertFalse(self.previous.exists())

    def test_staging_recovers_a_deploy_interrupted_between_renames(self):
        self._deploy({"app.exe": "v1"})
        # Reproduce a swap killed after parking the live folder: the last good
        # build sits in .prev and nothing is deployed.
        self.live.rename(self.previous)
        self.assertFalse(self.live.exists())

        self._reset_dist()
        staged = _write_build(self.dist / APP_NAME, {"app.exe": "v2"})
        stage_deploy(staged, self.apps, APP_NAME)

        self.assertEqual(_tree(self.live), {"app.exe": "v1"})
        self.assertEqual(_tree(self.slot), {"app.exe": "v2"})

        swap_deploy(self.apps, APP_NAME)
        self.assertEqual(_tree(self.live), {"app.exe": "v2"})
        self.assertEqual(_tree(self.slot), {"app.exe": "v1"})

    def test_missing_build_output_is_reported(self):
        with self.assertRaises(FileNotFoundError):
            stage_deploy(self.dist / "absent", self.apps, APP_NAME)

    def test_swap_without_a_staged_slot_is_reported(self):
        with self.assertRaises(FileNotFoundError):
            swap_deploy(self.apps, APP_NAME)

    def test_slot_names_never_collide_with_the_live_folder(self):
        live, slot, previous = deploy_slot_paths(self.apps, APP_NAME)
        self.assertEqual(len({live, slot, previous}), 3)
        for path in (slot, previous):
            self.assertTrue(path.name.startswith("."), path.name)


class StagedTimestampAlignmentTests(unittest.TestCase):
    """PyInstaller restamps every file, so content decides what is unchanged."""

    def setUp(self):
        TEST_TMP_ROOT.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=str(TEST_TMP_ROOT))
        self.base = Path(self.temp.name)
        self.apps = self.base / "apps"
        self.dist = self.base / "dist"
        self.live, self.slot, _ = deploy_slot_paths(self.apps, APP_NAME)
        self.manifest = deploy_manifest_path(self.slot)
        self.addCleanup(self.temp.cleanup)

    def _rebuild(self, files: dict[str, str], day: int = 1) -> Path:
        """Write a dist the way a later PyInstaller run would: all files fresh.

        Every collected file is restamped with the moment of the build, which is
        exactly what defeats a plain timestamp compare.
        """

        build_runtime.remove_tree_with_retry(self.dist / APP_NAME)
        staged = _write_build(self.dist / APP_NAME, files)
        stamp = time.time() + day * 86_400
        for path in staged.rglob("*"):
            if path.is_file():
                os.utime(path, (stamp, stamp))
        return staged

    def _deploy(self, files: dict[str, str], day: int) -> None:
        staged = self._rebuild(files, day)
        stage_deploy(staged, self.apps, APP_NAME)
        swap_deploy(self.apps, APP_NAME)

    def test_unchanged_files_are_not_resent_once_the_rotation_is_warm(self):
        shared = "_internal/runtime.dat"
        # The slot only gains a manifest-bearing predecessor on the third
        # deploy: the first leaves no slot behind, the second parks a build
        # that predates any manifest.
        self._deploy({"app.exe": "v1", shared: "same"}, day=1)
        self._deploy({"app.exe": "v2", shared: "same"}, day=2)
        carried = (self.slot / shared).stat().st_mtime

        staged = self._rebuild({"app.exe": "v3", shared: "same"}, day=3)
        rebuilt_stamp = (staged / shared).stat().st_mtime
        self.assertNotEqual(rebuilt_stamp, carried)

        stage_deploy(staged, self.apps, APP_NAME)

        # Byte-identical, so the new build's stamp was rewound to the one the
        # slot already carries and robocopy had nothing to send.
        self.assertEqual((staged / shared).stat().st_mtime, carried)
        self.assertEqual((self.slot / shared).stat().st_mtime, carried)
        self.assertEqual((self.slot / "app.exe").read_text(encoding="utf-8"), "v3")

    def test_alignment_counts_only_byte_identical_files(self):
        recorded = self._rebuild({"same.dat": "abc", "changed.dat": "abc"}, day=1)
        self.slot.mkdir(parents=True, exist_ok=True)
        build_runtime.write_deploy_manifest(recorded, self.manifest)

        # Same size, different bytes: a size-only check would wrongly skip it.
        staged = self._rebuild({"same.dat": "abc", "changed.dat": "xyz"}, day=2)
        self.assertEqual(align_staged_timestamps(staged, self.manifest), 1)

    def test_alignment_without_a_manifest_changes_nothing(self):
        staged = self._rebuild({"app.exe": "v1"})
        before = (staged / "app.exe").stat().st_mtime

        self.assertEqual(align_staged_timestamps(staged, self.manifest), 0)
        self.assertEqual((staged / "app.exe").stat().st_mtime, before)

    def test_corrupt_manifest_falls_back_to_a_full_copy(self):
        staged = self._rebuild({"app.exe": "v1"})
        self.slot.mkdir(parents=True, exist_ok=True)
        self.manifest.write_text("{not json", encoding="utf-8")

        self.assertEqual(align_staged_timestamps(staged, self.manifest), 0)
        stage_deploy(staged, self.apps, APP_NAME)
        self.assertEqual(_tree(self.slot), {"app.exe": "v1"})

    def test_manifest_travels_with_the_folder_it_describes(self):
        self._deploy({"app.exe": "v1"}, day=1)
        self._deploy({"app.exe": "v2"}, day=2)

        # After the rotation the slot holds v1, so the manifest inside it must
        # describe v1 rather than whatever was staged most recently.
        recorded = json.loads(self.manifest.read_text(encoding="utf-8"))
        self.assertEqual(sorted(recorded["files"]), ["app.exe"])
        entry = recorded["files"]["app.exe"]
        self.assertEqual(entry["size"], len("v1"))
        self.assertEqual(entry["mtime"], (self.slot / "app.exe").stat().st_mtime)
        self.assertIn("sha256", entry)

    def test_mirroring_never_purges_the_destination_manifest(self):
        self._deploy({"app.exe": "v1"}, day=1)
        self._deploy({"app.exe": "v2"}, day=2)
        self.assertTrue(self.manifest.is_file())

        staged = self._rebuild({"app.exe": "v3"}, day=3)
        stage_deploy(staged, self.apps, APP_NAME)

        # /MIR would remove a destination file the source lacks.
        self.assertTrue(self.manifest.is_file())
        self.assertNotIn(DEPLOY_MANIFEST_NAME, _tree(self.slot))


class BuildScriptDelegationTests(unittest.TestCase):
    """Every build script must deploy through the one canonical implementation."""

    def test_build_scripts_delegate_to_the_shared_slot_rotation(self):
        for role in DEPLOYING_ROLES:
            source = (ENGINE_SRC / f"arcrho_{role}" / "build_exe.py").read_text(
                encoding="utf-8"
            )
            with self.subTest(role=role):
                self.assertIn("stage_deploy", source)
                self.assertIn("swap_deploy", source)
                # A restated copy or rename transaction is drift by definition.
                self.assertNotIn("shutil.copytree", source)
                self.assertNotIn(".new", source)
                self.assertNotIn(".old", source)


if __name__ == "__main__":
    unittest.main()
