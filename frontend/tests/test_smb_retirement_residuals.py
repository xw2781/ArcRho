"""Residual client paths fail closed and leave filesystem access on the server."""

import importlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
for source in (ROOT / "frontend", ROOT / "python-api" / "src"):
    sys.path.insert(0, str(source))
TEST_ROOT = ROOT / "test"
TEST_ROOT.mkdir(exist_ok=True)

from fastapi import HTTPException
from arcrho_api import config as api_config
from arcrho_api.dfm_contract import normalize_dfm_method
from app_server import config
from app_server.services import (
    dataset_service, macro_dfm_service, project_json_service,
    resq_class_inventory_service, resq_import_queue_service, scripting_macro_service,
)


class ResidualTransportTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(dir=TEST_ROOT)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.data = self.root / "projects" / "Demo" / "data"
        self.data.mkdir(parents=True)

    def test_restarted_gateway_reads_a_client_handle_from_its_own_root(self):
        csv = self.data / "COL" / "datasets" / "Paid.csv"
        csv.parent.mkdir(parents=True)
        csv.write_text("1,2\n3,4\n", encoding="utf-8")
        relative = str(csv.relative_to(self.root))
        with (
            patch.dict(config.DATASETS, {}, clear=True),
            patch.dict(config.DATASET_ROLLUPS, {}, clear=True),
            patch.object(config, "get_root_path", return_value=str(self.root)),
            patch.object(config, "get_project_data_dir", return_value=str(self.data)),
            patch.object(dataset_service, "_resolve_origin_labels", return_value=["2024", "2025"]),
        ):
            result = dataset_service.get_dataset("lost-handle", "Demo", 12, relative)
        self.assertEqual(result["id"], "lost-handle")
        self.assertEqual(result["values"], [[1, 2], [3, 4]])

    def test_grid_path_cannot_escape_the_named_project(self):
        with (
            patch.object(config, "get_root_path", return_value=str(self.root)),
            patch.object(config, "get_project_data_dir", return_value=str(self.data)),
        ):
            for path in ("../private.csv", "projects/Other/data/Paid.csv", "config/private.json"):
                with self.subTest(path=path), self.assertRaises(HTTPException) as caught:
                    dataset_service.get_dataset("id", "Demo", 12, path)
                self.assertEqual(caught.exception.status_code, 400)

    def test_client_describes_handle_without_touching_the_csv(self):
        with (
            patch.dict(config.DATASETS, {"id": str(self.data / "Paid.csv")}, clear=True),
            patch.object(config, "get_root_path", return_value=str(self.root)),
            patch("os.stat", side_effect=AssertionError("Client stat")),
        ):
            arguments = dataset_service.dataset_grid_read_arguments("id", "Demo", 12)
        self.assertEqual(arguments["dataset_path"], str(Path("projects/Demo/data/Paid.csv")))

    def test_project_json_is_raw_and_confined_to_the_selected_folder(self):
        folder = self.data / "COL" / "sidecars"
        folder.mkdir(parents=True)
        payload = {"dataset_name": "Paid", "notes": "Original"}
        (folder / "Paid.json").write_text(json.dumps(payload), encoding="utf-8")
        with patch.object(config, "get_project_dataset_sidecar_dir", return_value=str(folder)):
            result = project_json_service.read_project_json("Demo", "COL", "sidecars", "Paid.json")
            self.assertEqual(result["data"], payload)
            for filename in ("../Paid.json", "Paid.csv", str(folder / "Paid.json")):
                with self.subTest(filename=filename), self.assertRaises(HTTPException):
                    project_json_service.read_project_json("Demo", "COL", "sidecars", filename)

    def test_json_route_does_not_read_locally_on_gateway_failure(self):
        router = importlib.import_module("app_server.api.dataset_router")
        with (
            patch.object(router.workspace_read_client, "run_workspace_read", side_effect=HTTPException(503, "Offline")),
            patch.object(project_json_service, "read_project_json") as local,
            self.assertRaises(HTTPException),
        ):
            router.get_project_json("Demo", "COL", "sidecars", "Paid.json")
        local.assert_not_called()

    def test_profile_can_record_an_unmounted_folder(self):
        with patch.object(api_config, "validate_server_root", side_effect=AssertionError("Share validation")):
            saved = api_config.upsert_server_profile(
                name="Unavailable share", root=r"Q:\unmounted", gateway_url="http://server:28767",
                path=self.root / "workspace_paths.json",
            )
        self.assertEqual(saved["profiles"][-1]["root"], r"Q:\unmounted")

    def test_review_request_is_published_once_on_server_with_signed_identity(self):
        from arcrho_api.bridge_liveness import QUEUE_STATUS_DIRS
        from app_server.services.user_identity_service import acting_identity

        request = dict(Function="ReviewResQReservingClass", ContractVersion=1,
                       RequestId="review-test", ProjectName="Demo", Path="COL", UserName="forged")
        with patch.object(config, "get_root_path", return_value=str(self.root)), acting_identity("alice", "Alice"):
            first = resq_import_queue_service.publish_resq_review_request("Demo", "COL", "review-test", request)
            again = resq_import_queue_service.publish_resq_review_request("Demo", "COL", "review-test", request)
        path = self.root / QUEUE_STATUS_DIRS["sync"].with_name("requests") / "review-test.json"
        self.assertEqual(json.loads(path.read_text())["UserName"], "alice")
        self.assertFalse(first["resumed"])
        self.assertTrue(again["resumed"])

    def test_inventory_preserves_unindexed_classes_and_counts(self):
        indexed = self.data / "Auto_%5C_NJ"
        indexed.mkdir()
        (indexed / "index.json").write_text(json.dumps({"reserving_class": "Auto\\NJ", "files": [{}, {}]}))
        (self.data / "Auto_%5C_PA").mkdir()
        with patch.object(config, "get_project_data_dir", return_value=str(self.data)):
            self.assertEqual(resq_class_inventory_service.existing_class_counts("Demo"),
                             {"auto\\nj": 2, "auto\\pa": None})

    def test_macro_build_and_save_never_open_the_method_path(self):
        payload = normalize_dfm_method({"details_tab": {"name": "Development"}}, require_complete=False)
        context = {"activeJson": payload, "fields": {"project": "Demo", "reservingClass": "COL", "methodName": "Development"},
                   "methodPath": r"Q:\unmounted\Development.json"}
        with (
            patch("arcrho_api.ArcRhoClient", side_effect=AssertionError("Share client")),
            patch.object(scripting_macro_service, "_ensure_arcrho_api_import_path"),
            patch.object(Path, "open", side_effect=AssertionError("Client file read")),
            patch.object(Path, "stat", side_effect=AssertionError("Client stat")),
        ):
            dfm = scripting_macro_service._build_active_dfm(context)
            with patch.object(macro_dfm_service.engine_hosted_save_service, "run_hosted_save", return_value={"method": payload}) as save:
                dfm.save()
            self.assertEqual(save.call_args.args, ("dfm_method", "Demo", "COL"))
            with patch.object(macro_dfm_service.engine_hosted_save_service, "run_hosted_save", side_effect=HTTPException(503, "Offline")):
                with self.assertRaises(HTTPException):
                    dfm.save()


if __name__ == "__main__":
    unittest.main()
