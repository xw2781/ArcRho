from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

FRONTEND_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = FRONTEND_ROOT.parent
for _path in (FRONTEND_ROOT, REPOSITORY_ROOT / "python-api" / "src"):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from fastapi.encoders import jsonable_encoder  # noqa: E402

from arcrho_api import config as api_config  # noqa: E402
from app_server import config  # noqa: E402
from app_server.services import macro_library_service, workspace_read_client  # noqa: E402
from app_server.services.scripting_macro_service import _parse_macro_metadata  # noqa: E402

TEST_TEMP_ROOT = REPOSITORY_ROOT / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
GATEWAY = {"enabled": True, "url": "http://server:28767", "user": "alice", "secret": "x"}


def _macro_source(version: str, note: str = "Initial release.", body: str = "print('hi')") -> str:
    return (
        "# <arcrho-macro>\n"
        "# Title: Sample Macro\n"
        f"# Version: {version}\n"
        f"# Release Note: {note}\n"
        "# Description: A sample macro.\n"
        "# Scope: DFM\n"
        "# </arcrho-macro>\n"
        f"{body}\n"
    )


class MacroLibraryServiceTests(unittest.TestCase):
    """The library logic, run as a server process runs it: the reads are local disk."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        root = Path(self._tmp.name)
        self.library_dir = root / "library"
        self.macro_dir = root / "macros"
        self.library_dir.mkdir()
        self.macro_dir.mkdir()
        self._old_macro_dir = config.MACRO_DIR
        self._old_library_dir = config.MACRO_LIBRARY_DIR
        config.MACRO_DIR = str(self.macro_dir)
        config.MACRO_LIBRARY_DIR = str(self.library_dir)
        for patcher in (
            patch.dict(os.environ, {api_config.RUNTIME_SERVER_ROOT_ENV: str(root)}),
            patch.object(workspace_read_client, "_log"),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def tearDown(self) -> None:
        config.MACRO_DIR = self._old_macro_dir
        config.MACRO_LIBRARY_DIR = self._old_library_dir
        self._tmp.cleanup()

    def test_parse_macro_metadata_reads_version_and_release_note(self) -> None:
        meta = _parse_macro_metadata(_macro_source("1.2.5", "Fixed a bug."), "sample.py")
        self.assertEqual(meta["version"], "1.2.5")
        self.assertEqual(meta["release_note"], "Fixed a bug.")

    def test_parse_macro_metadata_reads_the_declared_flight_deck_icon(self) -> None:
        source = _macro_source("1.0.0").replace("# Scope: DFM\n", "# Scope: DFM\n# Icon: Calculator\n")
        self.assertEqual(_parse_macro_metadata(source, "sample.py")["icon"], "calculator")
        # A macro naming nothing, or something that is not a short name, leaves the choice
        # to the Flight Deck rather than reaching it as a glyph name it cannot use.
        self.assertEqual(_parse_macro_metadata(_macro_source("1.0.0"), "sample.py")["icon"], "")
        odd = _macro_source("1.0.0").replace("# Scope: DFM\n", "# Scope: DFM\n# Icon: <svg onload=x>\n")
        self.assertEqual(_parse_macro_metadata(odd, "sample.py")["icon"], "")

    def test_list_reports_unreachable_library(self) -> None:
        config.MACRO_LIBRARY_DIR = str(self.library_dir / "missing")
        result = macro_library_service.list_library_macros()
        self.assertFalse(result["available"])
        self.assertEqual(result["macros"], [])
        self.assertIn("not reachable", result["message"])

    def test_list_statuses_cover_install_states(self) -> None:
        (self.library_dir / "not_installed.py").write_text(_macro_source("1.0.0"), encoding="utf-8")
        (self.library_dir / "up_to_date.py").write_text(_macro_source("1.0.0"), encoding="utf-8")
        (self.macro_dir / "up_to_date.py").write_text(_macro_source("1.0.0"), encoding="utf-8")
        (self.library_dir / "update_available.py").write_text(_macro_source("1.1.0"), encoding="utf-8")
        (self.macro_dir / "update_available.py").write_text(_macro_source("1.0.9"), encoding="utf-8")
        (self.library_dir / "local_differs.py").write_text(_macro_source("1.0.0"), encoding="utf-8")
        (self.macro_dir / "local_differs.py").write_text(
            _macro_source("1.0.0", body="print('edited locally')"), encoding="utf-8"
        )
        # Non-macro entries at the top level and archived versions are ignored.
        (self.library_dir / "notes.txt").write_text("ignore me", encoding="utf-8")
        archive = self.library_dir / "archive" / "old" / "0.9.0"
        archive.mkdir(parents=True)
        (archive / "old.py").write_text(_macro_source("0.9.0"), encoding="utf-8")

        result = macro_library_service.list_library_macros()
        self.assertTrue(result["available"])
        statuses = {item["id"]: item["status"] for item in result["macros"]}
        self.assertEqual(statuses, {
            "not_installed.py": "not_installed",
            "up_to_date.py": "up_to_date",
            "update_available.py": "update_available",
            "local_differs.py": "local_differs",
        })
        by_id = {item["id"]: item for item in result["macros"]}
        self.assertEqual(by_id["update_available.py"]["version"], "1.1.0")
        self.assertEqual(by_id["update_available.py"]["local_version"], "1.0.9")
        self.assertEqual(by_id["not_installed.py"]["local_version"], "")

    def test_up_to_date_ignores_line_ending_differences(self) -> None:
        source = _macro_source("1.0.0")
        (self.library_dir / "sample.py").write_bytes(source.replace("\n", "\r\n").encode("utf-8"))
        (self.macro_dir / "sample.py").write_text(source, encoding="utf-8")
        result = macro_library_service.list_library_macros()
        self.assertEqual(result["macros"][0]["status"], "up_to_date")

    def test_install_copies_library_macro_byte_for_byte(self) -> None:
        payload = _macro_source("1.2.0").encode("utf-8")
        (self.library_dir / "sample.py").write_bytes(payload)
        result = macro_library_service.install_library_macro("sample.py")
        self.assertTrue(result["success"], result)
        self.assertTrue(result["installed"])
        self.assertEqual(result["version"], "1.2.0")
        self.assertEqual((self.macro_dir / "sample.py").read_bytes(), payload)

    def test_install_identical_copy_reports_up_to_date(self) -> None:
        source = _macro_source("1.0.0")
        (self.library_dir / "sample.py").write_text(source, encoding="utf-8")
        (self.macro_dir / "sample.py").write_text(source, encoding="utf-8")
        result = macro_library_service.install_library_macro("sample.py")
        self.assertTrue(result["success"])
        self.assertFalse(result["installed"])
        self.assertIn("already up to date", result["message"])

    def test_install_conflict_requires_confirmation_then_overwrites(self) -> None:
        (self.library_dir / "sample.py").write_text(_macro_source("2.0.0"), encoding="utf-8")
        (self.macro_dir / "sample.py").write_text(
            _macro_source("1.0.0", body="print('local edit')"), encoding="utf-8"
        )
        blocked = macro_library_service.install_library_macro("sample.py")
        self.assertFalse(blocked["success"])
        self.assertTrue(blocked["needs_confirmation"])
        self.assertEqual(blocked["local_version"], "1.0.0")
        self.assertEqual(blocked["version"], "2.0.0")

        replaced = macro_library_service.install_library_macro("sample.py", overwrite=True)
        self.assertTrue(replaced["success"], replaced)
        self.assertEqual(
            (self.macro_dir / "sample.py").read_text(encoding="utf-8"),
            _macro_source("2.0.0"),
        )

    def test_install_missing_library_macro_fails(self) -> None:
        result = macro_library_service.install_library_macro("missing.py")
        self.assertFalse(result["success"])
        self.assertIn("not found in library", result["message"])

    def test_install_rejects_path_traversal_ids(self) -> None:
        (self.library_dir / "sample.py").write_text(_macro_source("1.0.0"), encoding="utf-8")
        result = macro_library_service.install_library_macro("..\\..\\sample.py")
        # Traversal segments are stripped to the basename, so this resolves
        # inside the library and never escapes either folder.
        self.assertTrue(result["success"], result)
        self.assertTrue((self.macro_dir / "sample.py").is_file())
        self.assertFalse((self.macro_dir.parent / "sample.py").exists())

    def test_sync_replaces_only_a_local_copy_the_library_outversions(self) -> None:
        (self.library_dir / "newer.py").write_text(_macro_source("1.1.0"), encoding="utf-8")
        (self.macro_dir / "newer.py").write_text(
            _macro_source("1.0.0", body="print('edited locally')"), encoding="utf-8"
        )
        (self.library_dir / "current.py").write_text(_macro_source("1.0.0"), encoding="utf-8")
        (self.macro_dir / "current.py").write_text(_macro_source("1.0.0"), encoding="utf-8")
        (self.library_dir / "edited.py").write_text(_macro_source("1.0.0"), encoding="utf-8")
        (self.macro_dir / "edited.py").write_text(
            _macro_source("1.0.0", body="print('edited locally')"), encoding="utf-8"
        )
        (self.library_dir / "not_loaded.py").write_text(_macro_source("1.0.0"), encoding="utf-8")
        (self.macro_dir / "mine.py").write_text(_macro_source("1.0.0"), encoding="utf-8")

        result = macro_library_service.sync_library_updates()

        self.assertTrue(result["available"])
        self.assertEqual([entry["macro_id"] for entry in result["updated"]], ["newer.py"])
        self.assertEqual(result["updated"][0]["version"], "1.1.0")
        self.assertEqual(result["updated"][0]["local_version"], "1.0.0")
        self.assertEqual(result["updated"][0]["name"], "Sample Macro")
        # A local edit at the same version is not a library update, and a
        # library macro that was never loaded is not loaded by a sync.
        self.assertEqual((self.macro_dir / "newer.py").read_text(encoding="utf-8"), _macro_source("1.1.0"))
        self.assertIn("edited locally", (self.macro_dir / "edited.py").read_text(encoding="utf-8"))
        self.assertFalse((self.macro_dir / "not_loaded.py").exists())
        self.assertEqual(macro_library_service.sync_library_updates()["updated"], [])

    def test_sync_one_macro_reads_only_that_library_file(self) -> None:
        (self.library_dir / "sample.py").write_text(_macro_source("2.0.0"), encoding="utf-8")
        (self.macro_dir / "sample.py").write_text(_macro_source("1.0.0"), encoding="utf-8")
        (self.library_dir / "other.py").write_text(_macro_source("2.0.0"), encoding="utf-8")
        (self.macro_dir / "other.py").write_text(_macro_source("1.0.0"), encoding="utf-8")

        result = macro_library_service.sync_library_macro("sample.py")

        self.assertEqual(result["version"], "2.0.0")
        self.assertEqual(result["local_version"], "1.0.0")
        self.assertEqual((self.macro_dir / "sample.py").read_text(encoding="utf-8"), _macro_source("2.0.0"))
        self.assertEqual((self.macro_dir / "other.py").read_text(encoding="utf-8"), _macro_source("1.0.0"))
        self.assertIsNone(macro_library_service.sync_library_macro("sample.py"))
        self.assertIsNone(macro_library_service.sync_library_macro("mine.py"))

    def test_sync_one_macro_leaves_a_copy_alone_when_the_library_is_unreachable(self) -> None:
        (self.macro_dir / "sample.py").write_text(_macro_source("1.0.0"), encoding="utf-8")
        config.MACRO_LIBRARY_DIR = str(self.library_dir / "missing")
        self.assertIsNone(macro_library_service.sync_library_macro("sample.py"))
        config.MACRO_LIBRARY_DIR = ""
        self.assertIsNone(macro_library_service.sync_library_macro("sample.py"))
        self.assertEqual((self.macro_dir / "sample.py").read_text(encoding="utf-8"), _macro_source("1.0.0"))


class MacroLibraryTransportTests(unittest.TestCase):
    """A Client PC reads the library through the Gateway and writes only its own macros folder."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        self.addCleanup(self._tmp.cleanup)
        root = Path(self._tmp.name)
        self.library_dir = root / "server" / "shared" / "macros"
        self.macro_dir = root / "client" / "macros"
        self.library_dir.mkdir(parents=True)
        self.macro_dir.mkdir(parents=True)
        (self.library_dir / "sample.py").write_bytes(_macro_source("2.0.0").replace("\n", "\r\n").encode("utf-8"))
        self.requests: list[dict] = []
        env = {key: value for key, value in os.environ.items() if key != api_config.RUNTIME_SERVER_ROOT_ENV}
        for patcher in (
            patch.dict(os.environ, env, clear=True),
            patch.object(config, "MACRO_DIR", str(self.macro_dir)),
            # The client's own view of the library is a folder that does not
            # exist: any read of it over the share would find nothing.
            patch.object(config, "MACRO_LIBRARY_DIR", str(root / "client" / "no-share")),
            patch.object(config, "load_gateway_config", return_value=dict(GATEWAY)),
            patch.object(
                workspace_read_client,
                "cached_gateway_capabilities",
                return_value={"workspace_read_kinds": ["macro_library_listing", "macro_library_file"]},
            ),
            patch.object(workspace_read_client, "post_signed_json", side_effect=self._gateway),
            patch.object(workspace_read_client, "_log"),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        workspace_read_client.reset_capability_cache()
        self.addCleanup(workspace_read_client.reset_capability_cache)

    def _gateway(self, gateway_config, path, request_payload, *, timeout):
        """Run the read as the Gateway does, against the server's library folder."""

        request = json.loads(json.dumps(request_payload))
        self.requests.append(request)
        function = getattr(macro_library_service, {
            "macro_library_listing": "read_library_files",
            "macro_library_file": "read_library_file",
        }[request["ReadKind"]])
        with patch.object(config, "MACRO_LIBRARY_DIR", str(self.library_dir)):
            answer = jsonable_encoder(function(**request["Kwargs"]))
        return answer, str(self.library_dir.parent.parent), 0

    def test_listing_load_and_run_check_read_through_the_gateway(self) -> None:
        listing = macro_library_service.list_library_macros()
        self.assertTrue(listing["available"])
        self.assertEqual([(item["id"], item["status"]) for item in listing["macros"]], [("sample.py", "not_installed")])

        loaded = macro_library_service.install_library_macro("sample.py")
        self.assertTrue(loaded["installed"], loaded)
        # The copy keeps the published line endings, as a byte copy did.
        self.assertEqual(
            (self.macro_dir / "sample.py").read_bytes(),
            (self.library_dir / "sample.py").read_bytes(),
        )
        (self.library_dir / "sample.py").write_text(_macro_source("2.1.0"), encoding="utf-8")
        self.assertEqual(macro_library_service.sync_library_macro("sample.py")["version"], "2.1.0")
        self.assertEqual(
            [(request["ReadKind"], request["Kwargs"]) for request in self.requests],
            [
                ("macro_library_listing", {}),
                ("macro_library_file", {"macro_id": "sample.py"}),
                ("macro_library_file", {"macro_id": "sample.py"}),
            ],
        )
        self.assertEqual({request["UserName"] for request in self.requests}, {"alice"})

    def test_a_client_without_the_gateway_reports_the_library_unavailable(self) -> None:
        (self.macro_dir / "sample.py").write_text(_macro_source("1.0.0"), encoding="utf-8")
        with patch.object(workspace_read_client, "cached_gateway_capabilities", return_value=None):
            listing = macro_library_service.list_library_macros()
            self.assertFalse(listing["available"])
            self.assertEqual(listing["macros"], [])
            self.assertFalse(macro_library_service.install_library_macro("sample.py")["success"])
            self.assertIsNone(macro_library_service.sync_library_macro("sample.py"))
        self.assertEqual(self.requests, [])
        self.assertEqual((self.macro_dir / "sample.py").read_text(encoding="utf-8"), _macro_source("1.0.0"))


if __name__ == "__main__":
    unittest.main()
