from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


RELEASE_DIR = Path(__file__).resolve().parents[1] / "build" / "release"
if str(RELEASE_DIR) not in sys.path:
    sys.path.insert(0, str(RELEASE_DIR))

import release_notes
import release_workflow


class ReleaseWorkflowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.work_dir = self.root / "work"
        self.installer = self.root / "ArcRho-Setup-1.2.13.exe"
        self.installer.write_bytes(b"installer payload")
        self.fragment_path = self.root / "release-manager.json"
        self.fragment_path.write_text(
            json.dumps(
                {
                    "type": "feature",
                    "scope": "build",
                    "audience": "internal",
                    "summary": "Added release-manager test coverage.",
                }
            ),
            encoding="utf-8",
        )
        self.fragment = release_notes.Fragment(
            path=self.fragment_path,
            type="feature",
            scope="build",
            audience="internal",
            summary="Added release-manager test coverage.",
            details=(),
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_capture_records_installer_and_fragment_hashes(self) -> None:
        with mock.patch.object(
            release_workflow.release_notes,
            "load_unreleased_fragments",
            return_value=[self.fragment],
        ):
            manifest_path, manifest = release_workflow.capture_built_release(
                "ArcRho",
                "1.2.13",
                self.installer,
                work_dir=self.work_dir,
            )

        self.assertTrue(manifest_path.is_file())
        self.assertEqual(manifest["status"], "built")
        self.assertEqual(manifest["installer"]["name"], self.installer.name)
        self.assertEqual(manifest["fragments"][0]["name"], self.fragment_path.name)

    def test_publish_rejects_fragment_changed_after_build(self) -> None:
        with mock.patch.object(
            release_workflow.release_notes,
            "load_unreleased_fragments",
            return_value=[self.fragment],
        ):
            _, manifest = release_workflow.capture_built_release(
                "ArcRho",
                "1.2.13",
                self.installer,
                work_dir=self.work_dir,
            )
            self.fragment_path.write_text("changed after build", encoding="utf-8")
            with self.assertRaisesRegex(
                release_workflow.ReleaseWorkflowError,
                "changed after the installer was built",
            ):
                release_workflow._manifest_fragments(manifest)

    def test_version_metadata_snapshot_restores_byte_exact_files(self) -> None:
        frontend_root = self.root / "frontend"
        original = {
            "package.json": b'{"version":"1.2.12"}\r\n',
            "package-lock.json": b'{"version":"1.2.12"}\r\n',
            "ui/index.html": b"version 1.2.12\r\n",
            "ui/splash.html": b"version 1.2.12\r\n",
        }
        for relative, content in original.items():
            path = frontend_root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        snapshot = self.root / "snapshot.json"

        with mock.patch.object(release_workflow, "FRONTEND_ROOT", frontend_root):
            release_workflow.snapshot_version_metadata(snapshot)
            for relative in original:
                (frontend_root / relative).write_bytes(b"changed")
            release_workflow.restore_version_metadata(snapshot, delete_snapshot=True)

        self.assertFalse(snapshot.exists())
        self.assertEqual(
            {relative: (frontend_root / relative).read_bytes() for relative in original},
            original,
        )

    def test_history_filters_to_the_selected_product(self) -> None:
        payload = json.dumps(
            [
                {
                    "tag_name": "ArcRho-v1.2.13",
                    "name": "ArcRho 1.2.13",
                    "published_at": "2026-08-14T12:00:00Z",
                    "html_url": "https://example.invalid/arcrho",
                },
                {
                    "tag_name": "Arcode-v1.2.13",
                    "name": "Arcode 1.2.13",
                    "published_at": "2026-08-14T12:00:00Z",
                    "html_url": "https://example.invalid/arcode",
                },
            ]
        )
        with mock.patch.object(release_workflow, "_gh_path", return_value="gh"), mock.patch.object(
            release_workflow,
            "_run_checked",
            return_value=payload,
        ):
            history = release_workflow.list_release_history("ArcRho")

        self.assertEqual([item["tag"] for item in history], ["ArcRho-v1.2.13"])

    def test_python_api_wheel_publication_writes_versioned_and_latest_files(self) -> None:
        wheel = self.root / "arcrho_api-0.1.0-py3-none-any.whl"
        wheel.write_bytes(b"wheel payload")
        package_dir = self.root / "packages"

        versioned, latest = release_workflow.publish_python_api_wheel(wheel, package_dir)

        self.assertEqual(versioned.read_bytes(), b"wheel payload")
        self.assertEqual(latest.read_bytes(), b"wheel payload")

    def test_pending_arcrho_publish_defers_wheel_and_bookkeeping_until_after_github(self) -> None:
        wheel = self.root / "arcrho_api-0.1.0-py3-none-any.whl"
        wheel.write_bytes(b"wheel payload")
        with mock.patch.object(
            release_workflow.release_notes,
            "load_unreleased_fragments",
            return_value=[self.fragment],
        ):
            _, manifest = release_workflow.capture_built_release(
                "ArcRho",
                "1.2.13",
                self.installer,
                work_dir=self.work_dir,
                python_api_wheel_path=wheel,
                python_api_package_dir=self.root / "packages",
            )
            with mock.patch.object(
                release_workflow,
                "_ensure_version_is_publishable",
            ), mock.patch.object(
                release_workflow,
                "_write_release_notes_preview",
                return_value=self.root / "release-notes.md",
            ), mock.patch.object(
                release_workflow,
                "_run_checked",
                return_value="",
            ) as run_checked, mock.patch.object(
                release_workflow,
                "publish_python_api_wheel",
            ) as publish_wheel, mock.patch.object(
                release_workflow,
                "_run_repository_bookkeeping",
            ) as bookkeeping:
                result = release_workflow.publish_pending_release(
                    "ArcRho",
                    "1.2.13",
                    work_dir=self.work_dir,
                )

        self.assertEqual(result["status"], "published")
        self.assertEqual(run_checked.call_args.args[0][0], "powershell")
        publish_wheel.assert_called_once()
        bookkeeping.assert_called_once()
        self.assertEqual(manifest["status"], "built")

    def test_revoke_uses_cleanup_tag_after_history_confirmation(self) -> None:
        commands: list[list[str]] = []
        record = {
            "product": "ArcRho",
            "version": "1.2.13",
            "tag": "ArcRho-v1.2.13",
        }
        with mock.patch.object(release_workflow, "list_release_history", return_value=[record]), mock.patch.object(
            release_workflow,
            "_gh_path",
            return_value="gh",
        ), mock.patch.object(
            release_workflow,
            "_run_checked",
            side_effect=lambda command, **_kwargs: commands.append(command) or "",
        ):
            release_workflow.revoke_remote_release("ArcRho", "1.2.13", work_dir=self.work_dir)

        self.assertEqual(len(commands), 1)
        self.assertIn("--cleanup-tag", commands[0])
        self.assertIn("--yes", commands[0])
        self.assertIn("ArcRho-v1.2.13", commands[0])


if __name__ == "__main__":
    unittest.main()
