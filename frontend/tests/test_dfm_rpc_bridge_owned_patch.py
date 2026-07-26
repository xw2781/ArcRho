from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from fastapi import HTTPException


REPO_ROOT = Path(__file__).resolve().parents[2]
FRONTEND_ROOT = REPO_ROOT / "frontend"
PYTHON_API_SRC = REPO_ROOT / "python-api" / "src"
DATA_ENGINE_SRC = REPO_ROOT / "data-engine" / "src"
for path in (FRONTEND_ROOT, PYTHON_API_SRC, DATA_ENGINE_SRC):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from arcrho_bridge import resq_client
from app_server.schemas.dfm_rpc_bridge import DfmRpcBridgeApplyRequest
from app_server.services import dfm_rpc_bridge_service


class DfmRpcOwnedPatchTests(unittest.TestCase):
    @staticmethod
    def request() -> DfmRpcBridgeApplyRequest:
        return DfmRpcBridgeApplyRequest(
            project_name="Project",
            reserving_class="Class",
            method_name="Development",
            output_vector="Selected Ultimate",
            input_triangle="Paid",
            origin_length=12,
            development_length=12,
            decimal_places=4,
        )

    @staticmethod
    def paths() -> dict[str, str]:
        return {
            "remote_path": "remote.json",
            "local_path": "local.json",
            "method_dir": "methods",
            "rpc_methods_dir": "rpc",
            "sync_status_path": "status.json",
            "request_dir": "requests",
            "project_dir": "project",
            "data_dir": "data",
        }

    def test_apply_validates_owned_patch_and_uses_aggregate_save(self) -> None:
        patch = {
            "payload format": dfm_rpc_bridge_service.DFM_OWNED_PATCH_FORMAT,
            "ratios tab": {"ratio triangle": {"excluded": [[1]]}},
        }
        local = {"json format": "arcrho-dfm-method-by-tab-v2"}
        preview = {"json format": "arcrho-dfm-method-by-tab-v2", "preview": True}
        saved_method = {"json format": "arcrho-dfm-method-by-tab-v2", "saved": True}
        with (
            mock.patch.object(dfm_rpc_bridge_service, "build_paths", return_value=self.paths()),
            mock.patch.object(dfm_rpc_bridge_service.os.path, "exists", return_value=True),
            mock.patch.object(dfm_rpc_bridge_service, "_read_json", return_value=patch),
            mock.patch.object(dfm_rpc_bridge_service, "apply_owned_patch", return_value=preview) as merge,
            mock.patch(
                "app_server.services.dfm_service.load_dfm_method",
                return_value={
                    "method": local,
                    "owned_revision": "owned-r1",
                    "derived_revision": "derived-r1",
                },
            ),
            mock.patch(
                "app_server.services.dfm_service.save_dfm_method",
                return_value={
                    "method": saved_method,
                    "owned_revision": "owned-r2",
                    "derived_revision": "derived-r2",
                    "publication_revision": "publication-r2",
                },
            ) as save,
            mock.patch.object(dfm_rpc_bridge_service, "_try_remove", return_value=True),
            mock.patch.object(dfm_rpc_bridge_service, "_file_meta", return_value={"exists": True}),
        ):
            result = dfm_rpc_bridge_service.apply_remote_to_local(self.request())

        self.assertTrue(result["ok"])
        self.assertEqual(result["payload"], saved_method)
        merge.assert_called_once_with(local, patch)
        save.assert_called_once()
        self.assertEqual(save.call_args.kwargs["expected_owned_revision"], "owned-r1")

    def test_apply_rejects_non_patch_payload(self) -> None:
        with (
            mock.patch.object(dfm_rpc_bridge_service, "build_paths", return_value=self.paths()),
            mock.patch.object(dfm_rpc_bridge_service.os.path, "exists", return_value=True),
            mock.patch.object(dfm_rpc_bridge_service, "_read_json", return_value={"json format": "v1"}),
        ):
            with self.assertRaises(HTTPException) as raised:
                dfm_rpc_bridge_service.apply_remote_to_local(self.request())
        self.assertEqual(raised.exception.status_code, 422)

    def test_resq_bridge_emits_owned_patch_without_derived_v2_placeholders(self) -> None:
        dataset_type = SimpleNamespace(Name="Selected Ultimate", Category=SimpleNamespace(Name="Loss"))
        method = SimpleNamespace(
            Name="Development",
            OutputVector=SimpleNamespace(Name="Development Output", DatasetType=dataset_type),
            InputTriangle=SimpleNamespace(Name="Paid"),
            SummaryRatioBasis=SimpleNamespace(Name="Premium"),
            OriginLength=12,
            DevelopmentLength=12,
            RatioDecimalPlaces=4,
            SummaryRatioDecimalPlaces=2,
        )
        client = resq_client.ResQClient()
        client._connect = lambda: None
        client._disconnect = lambda: None
        client._dfm_method = lambda _request: method
        client._average_data = lambda _method: {
            "label": ["Simple - all"],
            "custom average formula settings": {"averageType": ["custom"]},
            "selected": [[1]],
            "values": [[1.5]],
            "inputs": [[""]],
        }
        client._labels = lambda _method: (["2024"], ["12", "24"])
        client._ratio_development_labels = lambda _labels: ["12-24"]
        client._cell_notes_data = lambda *_args: {}
        client._excluded_ratio_pattern = lambda _method: [[1]]
        client._dfm_last_modified = lambda _method: "2026-01-01T00:00:00Z"

        with mock.patch.object(resq_client, "write_json_with_compact_rows") as write:
            payload = client.write_dfm_payload({
                "MethodName": "Development",
                "OutputVector": "Development Output",
                "DataPath": "unused.json",
            })

        self.assertEqual(payload["payload format"], resq_client.DFM_OWNED_PATCH_FORMAT)
        self.assertNotIn("json format", payload)
        self.assertNotIn("data tab", payload)
        self.assertNotIn("ratio values", payload["ratios tab"]["ratio triangle"])
        self.assertNotIn("ultimate vector", payload["results tab"])
        write.assert_called_once()


if __name__ == "__main__":
    unittest.main()
