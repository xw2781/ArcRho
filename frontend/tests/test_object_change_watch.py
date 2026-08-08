"""Open-window change-watch fingerprint endpoint behavior."""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi import HTTPException


REPO_ROOT = Path(__file__).resolve().parents[2]
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
        self.temp = tempfile.TemporaryDirectory(dir=REPO_ROOT)
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
