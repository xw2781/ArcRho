"""Open-window change-watch fingerprint endpoint behavior."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Dict
from unittest import mock

from fastapi import HTTPException


REPO_ROOT = Path(__file__).resolve().parents[2]
# Every test temp directory lives under one gitignored folder at the
# repository root, so a suite that dies before teardown cannot scatter
# tmp folders beside the code.
TEST_TEMP_ROOT = REPO_ROOT / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
FRONTEND_ROOT = REPO_ROOT / "frontend"
PYTHON_API_SRC = REPO_ROOT / "python-api" / "src"
for path in (FRONTEND_ROOT, PYTHON_API_SRC):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from app_server.services import (
    dataset_sidecar_status_service,
    object_change_watch_service,
)


class ObjectChangeWatchServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        root = Path(self.temp.name)
        self.methods = root / "methods"
        self.sidecars = root / "sidecars"
        for folder in (self.methods, self.sidecars):
            folder.mkdir()
        self.patchers = [
            mock.patch.object(
                dataset_sidecar_status_service,
                "sidecar_path",
                side_effect=lambda _p, _r, name: str(self.sidecars / f"{name}.json"),
            ),
            mock.patch.object(
                dataset_sidecar_status_service.config,
                "get_project_method_data_dir",
                return_value=str(self.methods),
            ),
        ]
        for patcher in self.patchers:
            patcher.start()

    def tearDown(self) -> None:
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.temp.cleanup()

    def _fingerprint(self, **overrides):
        request = {
            "project_name": "Example Project",
            "reserving_class": "Example RC",
            "kind": "dataset",
            "name": "Paid Loss",
        }
        request.update(overrides)
        return object_change_watch_service.object_change_fingerprint(
            request["project_name"],
            request["reserving_class"],
            request["kind"],
            request["name"],
            method_type=request.get("method_type", ""),
            output_dataset=request.get("output_dataset", ""),
        )

    def test_dataset_fingerprint_is_stat_only_and_moves_on_rewrite(self) -> None:
        sidecar = self.sidecars / "Paid Loss.json"
        sidecar.write_text("{}", encoding="utf-8")
        first = self._fingerprint()
        self.assertTrue(first["ok"])
        self.assertEqual(len(first["files"]), 1)
        self.assertEqual(first["files"][0]["role"], "sidecar")
        self.assertTrue(first["files"][0]["exists"])

        unchanged = self._fingerprint()
        self.assertEqual(first["token"], unchanged["token"])

        sidecar.write_text('{"status": 2}', encoding="utf-8")
        moved = self._fingerprint()
        self.assertNotEqual(first["token"], moved["token"])

    def test_missing_files_report_exists_false_with_stable_token(self) -> None:
        first = self._fingerprint()
        self.assertFalse(first["files"][0]["exists"])
        self.assertIsNone(first["files"][0]["size"])
        self.assertEqual(first["token"], self._fingerprint()["token"])

    def test_method_fingerprint_covers_method_json_and_output_sidecar(self) -> None:
        (self.methods / "DFM@Development.json").write_text("{}", encoding="utf-8")
        (self.sidecars / "Development Output.json").write_text("{}", encoding="utf-8")
        result = self._fingerprint(
            kind="method",
            name="Development",
            method_type="dfm",
            output_dataset="Development Output",
        )
        roles = [item["role"] for item in result["files"]]
        self.assertEqual(roles, ["method", "sidecar"])
        self.assertTrue(all(item["exists"] for item in result["files"]))

        (self.methods / "DFM@Development.json").write_text(
            '{"changed": true}', encoding="utf-8"
        )
        self.assertNotEqual(
            result["token"],
            self._fingerprint(
                kind="method",
                name="Development",
                method_type="dfm",
                output_dataset="Development Output",
            )["token"],
        )

    def test_unknown_method_type_is_a_client_error(self) -> None:
        with self.assertRaises(HTTPException) as raised:
            self._fingerprint(kind="method", name="Development", method_type="mystery")
        self.assertEqual(raised.exception.status_code, 400)

    def test_unknown_kind_is_a_client_error(self) -> None:
        with self.assertRaises(HTTPException) as raised:
            self._fingerprint(kind="triangle")
        self.assertEqual(raised.exception.status_code, 400)

    def test_missing_identity_is_a_client_error(self) -> None:
        with self.assertRaises(HTTPException) as raised:
            self._fingerprint(name="  ")
        self.assertEqual(raised.exception.status_code, 400)

    def _attribution(self, **overrides):
        request = {
            "project_name": "Example Project",
            "reserving_class": "Example RC",
            "kind": "dataset",
            "name": "Paid Loss",
        }
        request.update(overrides)
        return object_change_watch_service.object_change_attribution(
            request["project_name"],
            request["reserving_class"],
            request["kind"],
            request["name"],
            method_type=request.get("method_type", ""),
            output_dataset=request.get("output_dataset", ""),
        )["attribution"]

    def _write_sidecar(self, name: str, payload: Dict[str, Any]) -> None:
        (self.sidecars / f"{name}.json").write_text(json.dumps(payload), encoding="utf-8")

    def test_attribution_names_the_person_who_saved_the_dataset(self) -> None:
        self._write_sidecar("Paid Loss", {
            "updated_at": "2026-08-20T14:20:00Z",
            "modified_by": "Dana Reid",
            "audit_log": [
                {"event_date": "2026-08-19T09:00:00Z", "action": "Insert", "user": "Dana Reid"},
                {"event_date": "2026-08-20T14:24:11Z", "action": "Update", "user": "Sam Okafor"},
            ],
        })
        attribution = self._attribution()
        self.assertEqual(attribution["user"], "Sam Okafor")
        self.assertEqual(attribution["action"], "Update")
        self.assertEqual(attribution["at"], "2026-08-20T14:24:11Z")
        self.assertFalse(attribution["automatic"])
        self.assertEqual(attribution["subject"], "dataset")

    def test_attribution_marks_an_automatic_refresh_and_the_account_it_ran_as(self) -> None:
        self._write_sidecar("Development Output", {
            "updated_at": "2026-08-20T14:24:11Z",
            "modified_by": "Dana Reid",
            "audit_log": [
                {"event_date": "2026-08-20T14:24:11Z", "action": "Auto Refresh", "user": "Dana Reid"},
            ],
        })
        (self.methods / "DFM@Development.json").write_text("{}", encoding="utf-8")
        attribution = self._attribution(
            kind="method",
            name="Development",
            method_type="dfm",
            output_dataset="Development Output",
        )
        self.assertEqual(attribution["action"], "Auto Refresh")
        self.assertTrue(attribution["automatic"])
        self.assertEqual(attribution["user"], "Dana Reid")
        self.assertEqual(attribution["subject"], "method")

    def test_attribution_falls_back_to_the_method_stamp_then_to_nothing(self) -> None:
        (self.methods / "DFM@Development.json").write_text(
            json.dumps({"method_metadata": {"last_modified": "2026-08-20T14:24:11Z"}}),
            encoding="utf-8",
        )
        attribution = self._attribution(
            kind="method", name="Development", method_type="dfm",
        )
        self.assertEqual(attribution["at"], "2026-08-20T14:24:11Z")
        self.assertEqual(attribution["user"], "")

        missing = self._attribution(name="Nothing Here")
        self.assertEqual(missing["user"], "")
        self.assertEqual(missing["action"], "")
        self.assertEqual(missing["at"], "")

    def test_attribution_survives_an_unreadable_payload(self) -> None:
        (self.sidecars / "Paid Loss.json").write_text("{not json", encoding="utf-8")
        attribution = self._attribution()
        self.assertEqual(attribution["user"], "")
        self.assertFalse(attribution["automatic"])

    def test_attribution_rejects_an_unknown_kind(self) -> None:
        with self.assertRaises(HTTPException) as raised:
            self._attribution(kind="triangle")
        self.assertEqual(raised.exception.status_code, 400)

    def test_canonical_method_json_paths_cover_every_method_type(self) -> None:
        expected = {
            "dfm": "DFM@M.json",
            "result_selection": "RS@M.json",
            "bornhuetter_ferguson": "BF@M.json",
            "cape_cod": "CC@M.json",
            "bootstrap": "BST@M.json",
            "berquist_sherman_sr": "BSSR@M.json",
            "berquist_sherman_cra": "BSCRA@M.json",
        }
        for method_type, filename in expected.items():
            path = dataset_sidecar_status_service.method_json_path(
                "Example Project", "Example RC", method_type, "M"
            )
            self.assertEqual(Path(path).name, filename, method_type)


if __name__ == "__main__":
    unittest.main()
