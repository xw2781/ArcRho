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
SERVER_COMPONENTS_SRC = REPO_ROOT / "server-components" / "src"
for path in (FRONTEND_ROOT, PYTHON_API_SRC, SERVER_COMPONENTS_SRC):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from arcrho_bridge import resq_client
from app_server.schemas.dfm_rpc_bridge import (
    DfmRpcBridgeApplyRequest,
    DfmRpcBridgeUpdateRemoteRequest,
)
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
            "payload_format": dfm_rpc_bridge_service.DFM_OWNED_PATCH_FORMAT,
            "ratios_tab": {"ratio_triangle": {"excluded": [[1]]}},
            "method_metadata": {"method_notes": "Remote ResQ note"},
        }
        local = {"json_format": "arcrho-dfm-v4"}
        preview = {"json_format": "arcrho-dfm-v4", "preview": True}
        saved_method = {"json_format": "arcrho-dfm-v4", "saved": True}
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
        self.assertEqual(save.call_args.kwargs["notes"], "Remote ResQ note")
        self.assertTrue(result["sync_report"]["method_notes_applied"])

    def test_apply_method_notes_absent_keeps_and_present_empty_clears(self) -> None:
        for metadata, expected_notes in (
            ({}, None),
            ({"method_notes": ""}, ""),
            ({"method_notes": "   "}, ""),
        ):
            patch = {
                "payload_format": dfm_rpc_bridge_service.DFM_OWNED_PATCH_FORMAT,
                "ratios_tab": {"ratio_triangle": {"excluded": [[1]]}},
                "method_metadata": metadata,
            }
            local = {"json_format": "arcrho-dfm-v4"}
            with (
                mock.patch.object(dfm_rpc_bridge_service, "build_paths", return_value=self.paths()),
                mock.patch.object(dfm_rpc_bridge_service.os.path, "exists", return_value=True),
                mock.patch.object(dfm_rpc_bridge_service, "_read_json", return_value=patch),
                mock.patch.object(dfm_rpc_bridge_service, "apply_owned_patch", return_value=local),
                mock.patch(
                    "app_server.services.dfm_service.load_dfm_method",
                    return_value={"method": local, "owned_revision": "r1", "derived_revision": "r1"},
                ),
                mock.patch(
                    "app_server.services.dfm_service.save_dfm_method",
                    return_value={
                        "method": local,
                        "owned_revision": "r2",
                        "derived_revision": "r2",
                        "publication_revision": "p2",
                    },
                ) as save,
                mock.patch.object(dfm_rpc_bridge_service, "_try_remove", return_value=True),
                mock.patch.object(dfm_rpc_bridge_service, "_file_meta", return_value={"exists": True}),
            ):
                result = dfm_rpc_bridge_service.apply_remote_to_local(self.request())
            self.assertEqual(save.call_args.kwargs["notes"], expected_notes, msg=f"metadata={metadata!r}")
            self.assertEqual(
                result["sync_report"]["method_notes_applied"],
                expected_notes is not None,
                msg=f"metadata={metadata!r}",
            )

    def test_snapshot_reports_remote_method_notes_and_local_sidecar_notes(self) -> None:
        remote_payload = {
            "payload_format": dfm_rpc_bridge_service.DFM_OWNED_PATCH_FORMAT,
            "method_metadata": {"last_modified": "2026-01-01T00:00:00Z", "method_notes": "ResQ note"},
        }
        self.assertEqual(
            dfm_rpc_bridge_service._extract_method_notes_snapshot(remote_payload),
            {"exists": True, "text": "ResQ note"},
        )
        self.assertEqual(
            dfm_rpc_bridge_service._extract_method_notes_snapshot({"method_metadata": {}}),
            {"exists": False, "text": ""},
        )

        local_payload = {"details_tab": {"name": "Development", "output_dataset": "Development Output"}}
        with (
            mock.patch(
                "app_server.services.dataset_sidecar_status_service.sidecar_path",
                return_value="sidecar.json",
            ) as sidecar_path,
            mock.patch.object(dfm_rpc_bridge_service.os.path, "exists", return_value=True),
            mock.patch.object(dfm_rpc_bridge_service, "_read_json", return_value={"notes": "Local sidecar note"}),
        ):
            snapshot = dfm_rpc_bridge_service._sidecar_method_notes_snapshot(self.request(), local_payload)
        self.assertEqual(snapshot, {"exists": True, "text": "Local sidecar note"})
        self.assertEqual(sidecar_path.call_args.args[2], "Development Output")

    def test_bridge_sync_writes_method_notes_with_crlf_normalization(self) -> None:
        client = resq_client.ResQClient()

        dfm = SimpleNamespace(Notes="Old note")
        changed = client._sync_method_notes(dfm, {"MethodNotes": "Line one\nLine two\r\nLine three"})
        self.assertEqual(changed, 1)
        self.assertEqual(dfm.Notes, "Line one\r\nLine two\r\nLine three")

        unchanged = client._sync_method_notes(dfm, {"MethodNotes": "Line one\nLine two\nLine three"})
        self.assertEqual(unchanged, 0)
        self.assertEqual(dfm.Notes, "Line one\r\nLine two\r\nLine three")

        absent = client._sync_method_notes(dfm, {})
        self.assertEqual(absent, 0)
        self.assertEqual(dfm.Notes, "Line one\r\nLine two\r\nLine three")

        for empty in ({"MethodNotes": ""}, {"MethodNotes": "   "}):
            dfm.Notes = "Line one\r\nLine two\r\nLine three"
            cleared = client._sync_method_notes(dfm, empty)
            self.assertEqual(cleared, 1, msg=f"request={empty!r}")
            self.assertEqual(dfm.Notes, "", msg=f"request={empty!r}")

        already_empty = client._sync_method_notes(dfm, {"MethodNotes": ""})
        self.assertEqual(already_empty, 0)
        self.assertEqual(dfm.Notes, "")

    def test_update_remote_ships_sidecar_method_notes_in_request(self) -> None:
        request = DfmRpcBridgeUpdateRemoteRequest(
            project_name="Project",
            reserving_class="Class",
            method_name="Development",
            output_vector="Selected Ultimate",
            input_triangle="Paid",
            origin_length=12,
            development_length=12,
            decimal_places=4,
            rpc_server_write_confirmed=True,
        )
        for local_notes, expected_field in (
            ({"exists": True, "text": "Sidecar note"}, "Sidecar note"),
            ({"exists": True, "text": ""}, ""),
            ({"exists": False, "text": ""}, None),
        ):
            with (
                mock.patch.object(dfm_rpc_bridge_service, "build_paths", return_value=self.paths()),
                mock.patch.object(dfm_rpc_bridge_service.os, "makedirs"),
                mock.patch.object(dfm_rpc_bridge_service, "_try_remove", return_value=False),
                mock.patch.object(dfm_rpc_bridge_service, "_local_method_notes", return_value=local_notes),
                mock.patch.object(dfm_rpc_bridge_service, "_write_request_file", return_value="request.json") as write,
                mock.patch.object(dfm_rpc_bridge_service, "wait_for_file", return_value=True),
                mock.patch.object(dfm_rpc_bridge_service, "_read_json", return_value={"ok": True, "status": "passed"}),
            ):
                result = dfm_rpc_bridge_service.update_remote(request)
            self.assertTrue(result["ok"], msg=f"local_notes={local_notes!r}")
            extra_fields = write.call_args.args[4]
            if expected_field is None:
                self.assertNotIn("MethodNotes", extra_fields, msg=f"local_notes={local_notes!r}")
            else:
                self.assertEqual(extra_fields["MethodNotes"], expected_field, msg=f"local_notes={local_notes!r}")

    def test_apply_rejects_non_patch_payload(self) -> None:
        with (
            mock.patch.object(dfm_rpc_bridge_service, "build_paths", return_value=self.paths()),
            mock.patch.object(dfm_rpc_bridge_service.os.path, "exists", return_value=True),
            mock.patch.object(dfm_rpc_bridge_service, "_read_json", return_value={"json_format": "v1"}),
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
            Notes="Excluded 2020 LDFs.\r\nSelected low LDF.",
        )
        client = resq_client.ResQClient()
        client._connect = lambda: None
        client._disconnect = lambda: None
        client._dfm_method = lambda _request: method
        client._average_data = lambda _method: {
            "label": ["Simple - all"],
            "custom_average_formula_settings": {"average_type": ["custom"]},
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

        self.assertEqual(payload["payload_format"], resq_client.DFM_OWNED_PATCH_FORMAT)
        self.assertNotIn("json_format", payload)
        self.assertNotIn("data_tab", payload)
        self.assertNotIn("ratio_values", payload["ratios_tab"]["ratio_triangle"])
        self.assertNotIn("ultimate_vector", payload["results_tab"])
        self.assertEqual(
            payload["method_metadata"]["method_notes"],
            "Excluded 2020 LDFs.\r\nSelected low LDF.",
        )
        write.assert_called_once()


if __name__ == "__main__":
    unittest.main()
