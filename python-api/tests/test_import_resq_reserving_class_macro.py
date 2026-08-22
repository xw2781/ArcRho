from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch


_MACRO_PATH = (
    Path(__file__).resolve().parents[1]
    / "macros"
    / "import_resq_reserving_class.py"
)
_CONTRACT_PATH = (
    Path(__file__).resolve().parents[2]
    / "data-engine"
    / "src"
    / "arcrho_bridge"
    / "resq_reserving_class_import_contract.json"
)
_REQUEST_ID = "a1b2c3d4e5f6478899aabbccddeeff00"


def load_macro_module():
    spec = importlib.util.spec_from_file_location(
        "import_resq_reserving_class_macro_under_test",
        _MACRO_PATH,
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load the ResQ reserving-class import macro.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _Progress:
    def __init__(self):
        self.total = 0
        self.completed = 0
        self.updates = []
        self.closed = False

    def update(self, **kwargs):
        self.updates.append(kwargs)
        self.total = int(kwargs.get("total", self.total) or 0)
        self.completed = int(kwargs.get("completed", self.completed) or 0)

    def close(self, **_kwargs):
        self.closed = True


class _UI:
    def __init__(self, button_script=None):
        self.messages = []
        self.progress_calls = []
        self.reload_calls = []
        # Buttons returned by successive message boxes; empty answers mean the
        # non-destructive merge default, which keeps the older tests unchanged.
        self.button_script = list(button_script or [])
        self.project_instance = types.SimpleNamespace(
            context=lambda **_kwargs: {
                "projectName": "Demo",
                "selectedPath": r"Auto\PP",
            },
            reload_dataset_table=self._reload_dataset_table,
        )

    def _reload_dataset_table(self, **kwargs):
        self.reload_calls.append(kwargs)
        return {"refreshed": True}

    def message_box(self, message, **kwargs):
        self.messages.append((message, kwargs))
        if kwargs.get("buttons") and self.button_script:
            return {"ok": True, "button": self.button_script.pop(0)}
        return {"ok": True}

    def progress_bar(self, **kwargs):
        self.progress_calls.append(kwargs)
        return _Progress()


class ImportResqReservingClassMacroTests(unittest.TestCase):
    def setUp(self):
        self.module = load_macro_module()
        self.tempdir = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[2])
        self.addCleanup(self.tempdir.cleanup)
        self.server_root = Path(self.tempdir.name)
        self.ui = _UI()
        self.api_module = types.ModuleType("arcrho_api")
        self.api_module.ArcRhoUI = lambda: self.ui
        self.api_module.get_server_root = lambda **_kwargs: self.server_root

    def _write_worker(
        self,
        *,
        name: str = "worker.json",
        role: str = "bridge_worker",
        gui_running: bool = True,
        age_sec: float = 0.0,
    ) -> Path:
        path = self.server_root / self.module.BRIDGE_WORKER_DIR / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps({"Role": role, "ResQGuiRunning": gui_running}),
            encoding="utf-8",
        )
        if age_sec:
            timestamp = time.time() - age_sec
            os.utime(path, (timestamp, timestamp))
        return path

    def _macro_modules(self):
        return patch.dict(sys.modules, {"arcrho_api": self.api_module})

    def _contract(self) -> dict:
        with _CONTRACT_PATH.open(encoding="utf-8") as stream:
            return json.load(stream)

    def _publish_status(self, status: dict):
        original_publish = self.module.publish_import_request

        def publish_and_respond(**kwargs):
            request_path = original_publish(**kwargs)
            _, status_path = self.module._request_paths(
                kwargs["server_root"],
                kwargs["request_id"],
            )
            status_path.parent.mkdir(parents=True, exist_ok=True)
            status_path.write_text(json.dumps(status), encoding="utf-8")
            return request_path

        return publish_and_respond

    def test_embedded_adapter_matches_canonical_bridge_contract(self):
        contract = self._contract()

        self.assertEqual(self.module.REQUEST_FUNCTION, contract["function"])
        self.assertEqual(self.module.CONTRACT_VERSION, contract["contract_version"])
        self.assertEqual(
            tuple(self.module.REQUEST_RELATIVE_DIR.parts),
            tuple(contract["request_relative_dir"]),
        )
        self.assertEqual(
            tuple(self.module.STATUS_RELATIVE_DIR.parts),
            tuple(contract["status_relative_dir"]),
        )
        self.assertEqual(
            tuple(self.module.BRIDGE_WORKER_DIR.parts),
            tuple(contract["worker_heartbeat_relative_dir"]),
        )
        self.assertEqual(self.module.BRIDGE_WORKER_ROLE, contract["worker_role"])
        self.assertEqual(
            self.module.BRIDGE_WORKER_MAX_AGE_SEC,
            contract["worker_heartbeat_max_age_seconds"],
        )
        self.assertEqual(
            self.module.REQUIRED_REQUEST_FIELDS,
            tuple(contract["required_request_fields"]),
        )
        self.assertEqual(
            self.module.FORBIDDEN_PATH_FIELDS,
            tuple(contract["forbidden_path_fields"]),
        )
        self.assertEqual(
            self.module.ALLOWED_EXPORT_MODES,
            frozenset(contract["allowed_export_modes"]),
        )
        self.assertEqual(
            self.module.ALLOWED_IMPORT_POLICIES,
            frozenset(contract["allowed_import_policies"]),
        )
        self.assertEqual(
            self.module.STATUS_VALUES,
            frozenset(contract["status_values"]),
        )

    def test_logical_identifiers_match_bridge_request_validation(self):
        self.assertEqual(self.module._logical_project_name("Demo"), "Demo")
        self.assertEqual(self.module._logical_rc_path("Auto/PP"), r"Auto\PP")

        for project_name in ("Demo:Archive", "Demo/Archive", r"Demo\Archive", ".", ".."):
            with self.subTest(project_name=project_name):
                with self.assertRaises(ValueError):
                    self.module._logical_project_name(project_name)

        invalid_paths = (
            "",
            r"\Auto\PP",
            r"Auto\\PP",
            r"Auto\.\PP",
            r"Auto\..\PP",
            "Auto:PP",
            "Auto\x00PP",
            "Auto\\PP\\",
        )
        for rc_path in invalid_paths:
            with self.subTest(rc_path=rc_path):
                with self.assertRaises(ValueError):
                    self.module._logical_rc_path(rc_path)

    def test_unavailable_bridge_stops_before_progress_or_request_publication(self):
        with self._macro_modules():
            result = self.module.run_macro()

        self.assertFalse(result["success"])
        self.assertEqual(result["reason"], "bridge_unavailable")
        self.assertEqual(self.ui.progress_calls, [])
        self.assertFalse((self.server_root / self.module.REQUEST_ROOT).exists())
        message, options = self.ui.messages[-1]
        self.assertIn("import was not started", message)
        self.assertEqual(options["title"], "ArcRho Bridge Unavailable")
        self.assertEqual(options["kind"], "error")

    def test_progress_status_exposes_indeterminate_and_determinate_phase_labels(self):
        progress = _Progress()

        self.module._update_progress_from_status(
            progress,
            {
                "status": "processing",
                "progress": {
                    "event": "inventory",
                    "message": "Scanning ResQ triangles: 17 found",
                },
            },
        )
        self.assertEqual(progress.total, 0)
        self.assertEqual(progress.completed, 0)
        self.assertEqual(progress.updates[-1]["label"], "Scanning ResQ triangles: 17 found")
        self.assertEqual(progress.updates[-1]["detail"], "Scanning ResQ triangles: 17 found")

        self.module._update_progress_from_status(
            progress,
            {
                "status": "processing",
                "progress": {
                    "event": "engine_wait",
                    "message": "Waiting for ArcRho Engine result 3 of 8: Paid Loss",
                    "completed": 41,
                    "total": 130,
                },
            },
        )
        self.assertEqual(progress.total, 130)
        self.assertEqual(progress.completed, 41)
        self.assertEqual(
            progress.updates[-1]["label"],
            "Waiting for ArcRho Engine result 3 of 8: Paid Loss",
        )

    def test_non_dfm_macro_context_falls_back_to_project_instance_context(self):
        self._write_worker()
        status = {
            "contract_version": 1,
            "status": "success",
            "updated_at": "2026-07-26T10:00:00",
            "request_id": _REQUEST_ID,
            "result": {"datasets_imported": 1, "errors": 0},
        }
        request_uuid = types.SimpleNamespace(hex=_REQUEST_ID)
        non_dfm_context = {
            "available": False,
            "pageType": "project_instance",
            "error": "Open or activate a DFM tab/window before running a macro.",
        }

        with (
            self._macro_modules(),
            patch.object(self.module.uuid, "uuid4", return_value=request_uuid),
            patch.object(self.module, "publish_import_request", side_effect=self._publish_status(status)),
        ):
            result = self.module.run_macro(active_context=non_dfm_context)

        self.assertTrue(result["success"])
        request_path, _ = self.module._request_paths(self.server_root, _REQUEST_ID)
        payload = json.loads(request_path.read_text(encoding="utf-8"))
        self.assertEqual(payload["ProjectName"], "Demo")
        self.assertEqual(payload["Path"], r"Auto\PP")

    def test_stale_or_non_resq_worker_does_not_pass_hard_preflight(self):
        self._write_worker(age_sec=self.module.BRIDGE_WORKER_MAX_AGE_SEC + 1)
        self._write_worker(name="not-resq.json", gui_running=False)

        with self._macro_modules():
            result = self.module.run_macro()

        self.assertFalse(result["success"])
        self.assertEqual(result["reason"], "bridge_unavailable")
        self.assertFalse((self.server_root / self.module.REQUEST_ROOT).exists())

    def test_unclaimed_request_fails_promptly_with_a_bridge_restart_message(self):
        self._write_worker()

        with self.assertRaisesRegex(self.module.BridgeRequestError, "did not claim request"):
            self.module.wait_for_import_result(
                server_root=self.server_root,
                request_id=_REQUEST_ID,
                timeout_sec=1,
                poll_interval_sec=0.01,
                claim_timeout_sec=0.01,
            )

    def test_publishes_location_independent_request_and_waits_for_success_status(self):
        self._write_worker()
        status = {
            "contract_version": 1,
            "status": "success",
            "updated_at": "2026-07-26T10:00:00",
            "request_id": _REQUEST_ID,
            "result": {"datasets_imported": 2, "methods_imported": 1, "errors": 0},
        }
        request_uuid = types.SimpleNamespace(hex=_REQUEST_ID)
        publish_and_respond = self._publish_status(status)

        with (
            self._macro_modules(),
            patch.object(self.module.uuid, "uuid4", return_value=request_uuid),
            patch.object(self.module, "publish_import_request", side_effect=publish_and_respond),
        ):
            result = self.module.run_macro()

        self.assertTrue(result["success"])
        self.assertEqual(result["request_id"], _REQUEST_ID)
        self.assertEqual(len(self.ui.reload_calls), 1)
        request_path, status_path = self.module._request_paths(self.server_root, _REQUEST_ID)
        self.assertTrue(request_path.is_file())
        self.assertTrue(status_path.is_file())
        payload = json.loads(request_path.read_text(encoding="utf-8"))
        self.assertEqual(
            set(payload),
            {
                "Function",
                "ContractVersion",
                "RequestId",
                "ProjectName",
                "Path",
                "UserName",
                "ExportMode",
            },
        )
        self.assertEqual(payload["Function"], "ImportResQReservingClass")
        self.assertEqual(payload["ContractVersion"], 1)
        self.assertEqual(payload["RequestId"], _REQUEST_ID)
        self.assertEqual(payload["ProjectName"], "Demo")
        self.assertEqual(payload["Path"], r"Auto\PP")
        self.assertTrue(payload["UserName"])
        self.assertEqual(payload["ExportMode"], "configured")
        self.assertNotIn("StatusPath", payload)
        self.assertNotIn(str(self.server_root), json.dumps(payload))
        self.assertFalse(request_path.with_name(f".{_REQUEST_ID}.tmp").exists())
        self.assertIn("Datasets imported: 2", result["message"])
        self.assertIn("Methods imported: 1", result["message"])

    def test_confirmed_overwrite_travels_in_the_request_payload(self):
        self._write_worker()
        self.ui = _UI(button_script=["Overwrite", "Overwrite"])
        status = {
            "contract_version": 1,
            "status": "success",
            "updated_at": "2026-07-26T10:00:00",
            "request_id": _REQUEST_ID,
            "result": {"datasets_imported": 1, "errors": 0},
        }
        request_uuid = types.SimpleNamespace(hex=_REQUEST_ID)

        with (
            self._macro_modules(),
            patch.object(self.module.uuid, "uuid4", return_value=request_uuid),
            patch.object(self.module, "publish_import_request", side_effect=self._publish_status(status)),
        ):
            result = self.module.run_macro()

        self.assertTrue(result["success"])
        request_path, _ = self.module._request_paths(self.server_root, _REQUEST_ID)
        payload = json.loads(request_path.read_text(encoding="utf-8"))
        self.assertEqual(payload["ImportPolicy"], "overwrite")
        # The choice ran as two prompts: policy pick, then explicit confirm.
        prompts = [kwargs for _msg, kwargs in self.ui.messages if kwargs.get("buttons")]
        self.assertEqual(len(prompts), 2)
        self.assertEqual(prompts[0]["buttons"], ["Merge", "Overwrite", "Cancel"])
        self.assertEqual(prompts[1]["buttons"], ["Overwrite", "Cancel"])
        self.assertEqual(prompts[1]["kind"], "warning")

    def test_a_declined_overwrite_confirmation_publishes_nothing(self):
        self._write_worker()
        self.ui = _UI(button_script=["Overwrite", "Cancel"])

        with self._macro_modules():
            result = self.module.run_macro()

        self.assertFalse(result["success"])
        self.assertEqual(result["reason"], "cancelled")
        self.assertFalse((self.server_root / self.module.REQUEST_ROOT / "requests").exists())

    def test_a_merge_answer_keeps_the_payload_free_of_the_policy_field(self):
        self._write_worker()
        self.ui = _UI(button_script=["Merge"])
        status = {
            "contract_version": 1,
            "status": "success",
            "updated_at": "2026-07-26T10:00:00",
            "request_id": _REQUEST_ID,
            "result": {"datasets_imported": 1, "errors": 0},
        }
        request_uuid = types.SimpleNamespace(hex=_REQUEST_ID)

        with (
            self._macro_modules(),
            patch.object(self.module.uuid, "uuid4", return_value=request_uuid),
            patch.object(self.module, "publish_import_request", side_effect=self._publish_status(status)),
        ):
            result = self.module.run_macro()

        self.assertTrue(result["success"])
        request_path, _ = self.module._request_paths(self.server_root, _REQUEST_ID)
        payload = json.loads(request_path.read_text(encoding="utf-8"))
        self.assertNotIn("ImportPolicy", payload)

    def test_a_success_status_with_skipped_items_lists_them_by_name(self):
        self._write_worker()
        self.ui = _UI(button_script=["Merge"])
        status = {
            "contract_version": 1,
            "status": "success",
            "updated_at": "2026-08-21T10:00:00",
            "request_id": _REQUEST_ID,
            "result": {
                "datasets_imported": 4,
                "errors": 1,
                "error_details": [{
                    "kind": "vector",
                    "name": "G 41 - BF Paid",
                    "message": (
                        "The Perc Developed input does not name a ResQ dataset; "
                        "its selection is blank or broken."
                    ),
                }],
            },
        }
        request_uuid = types.SimpleNamespace(hex=_REQUEST_ID)

        with (
            self._macro_modules(),
            patch.object(self.module.uuid, "uuid4", return_value=request_uuid),
            patch.object(self.module, "publish_import_request", side_effect=self._publish_status(status)),
        ):
            result = self.module.run_macro()

        # The class committed with one item skipped; the completion box names
        # the skipped item and stays on screen as a warning.
        self.assertEqual(len(self.ui.reload_calls), 1)
        message, options = self.ui.messages[-1]
        self.assertIn("Import from ResQ completed.", message)
        self.assertIn("Skipped (could not be exported from ResQ", message)
        self.assertIn("vector G 41 - BF Paid: The Perc Developed input", message)
        self.assertEqual(options["kind"], "warning")
        self.assertIsNone(options.get("auto_close_ms"))

    def test_bridge_error_status_is_reported_without_reloading_dataset_table(self):
        self._write_worker()
        status = {
            "contract_version": 1,
            "status": "error",
            "updated_at": "2026-07-26T10:00:00",
            "request_id": _REQUEST_ID,
            "message": "ResQ import failed safely.",
            "result": {
                "errors": 1,
                "error_details": [{
                    "kind": "dfm",
                    "name": "Broken DFM",
                    "message": "Missing input triangle.",
                }],
            },
        }
        request_uuid = types.SimpleNamespace(hex=_REQUEST_ID)

        with (
            self._macro_modules(),
            patch.object(self.module.uuid, "uuid4", return_value=request_uuid),
            patch.object(self.module, "publish_import_request", side_effect=self._publish_status(status)),
        ):
            result = self.module.run_macro()

        self.assertFalse(result["success"])
        self.assertEqual(result["request_id"], _REQUEST_ID)
        self.assertEqual(self.ui.reload_calls, [])
        message, options = self.ui.messages[-1]
        self.assertIn("ResQ import failed safely.", message)
        self.assertIn("dfm Broken DFM: Missing input triangle.", message)
        self.assertEqual(options["kind"], "error")

    def test_incompatible_status_contract_is_not_accepted_as_success(self):
        self._write_worker()
        status = {
            "contract_version": 2,
            "status": "success",
            "updated_at": "2026-07-26T10:00:00",
            "request_id": _REQUEST_ID,
        }
        request_uuid = types.SimpleNamespace(hex=_REQUEST_ID)

        with (
            self._macro_modules(),
            patch.object(self.module.uuid, "uuid4", return_value=request_uuid),
            patch.object(self.module, "publish_import_request", side_effect=self._publish_status(status)),
        ):
            result = self.module.run_macro()

        self.assertFalse(result["success"])
        self.assertEqual(self.ui.reload_calls, [])
        self.assertIn("unsupported status contract version", result["message"])


if __name__ == "__main__":
    unittest.main()
