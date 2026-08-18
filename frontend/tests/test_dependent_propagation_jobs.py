from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException, status


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = FRONTEND_ROOT.parent
DATA_ENGINE_SRC = REPOSITORY_ROOT / "data-engine" / "src"
PYTHON_API_SRC = REPOSITORY_ROOT / "python-api" / "src"
for path in (FRONTEND_ROOT, DATA_ENGINE_SRC, PYTHON_API_SRC):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from arcrho_dependent_propagation_contract import (
    DEPENDENT_PROPAGATION_CONTRACT_VERSION,
    DEPENDENT_PROPAGATION_FUNCTION,
    ENGINE_UNAVAILABLE_MESSAGE,
    acquire_reserving_class_lease,
    dependent_propagation_request_path,
    dependent_propagation_status_path,
    release_reserving_class_lease,
    write_dependent_propagation_status,
)
from app_server.api.dependent_propagation_router import router
from app_server.schemas.dependent_propagation import (
    DependentPropagationJobStatusResponse,
    RefreshDependentsJobResponse,
    ReservingClassBusyResponse,
)
from app_server.services import dependent_propagation_service
from arcrho_engine import dependent_propagation as engine_propagation


class DependentPropagationJobTests(unittest.TestCase):
    REQUEST_ID = "abcdef0123456789abcdef0123456789"

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT))
        self.root = Path(self.temp_dir.name)
        (self.root / "projects").mkdir()
        self.instances_dir = self.root / "runtime" / "instances" / "arcrho_engine"
        self.path_patch = patch.object(
            dependent_propagation_service.config,
            "load_workspace_paths",
            return_value={
                "workspace_root": str(self.root),
                "paths": {"projects_dir": "projects", "requests_dir": "requests"},
            },
        )
        self.path_patch.start()

    def tearDown(self) -> None:
        self.path_patch.stop()
        self.temp_dir.cleanup()

    def _write_heartbeat(self, name: str = "engine.json") -> Path:
        self.instances_dir.mkdir(parents=True, exist_ok=True)
        heartbeat = self.instances_dir / name
        heartbeat.write_text(
            json.dumps({"Server": name, "Last seen": "2026-08-06 12:00:00"}),
            encoding="utf-8",
        )
        return heartbeat

    def _submit(self, **overrides):
        payload = {
            "project_name": "Demo Project",
            "reserving_class": "HPPREF\\HO+DF\\NJ",
            "changed_roots": [
                {"dataset_name": "Paid Output", "dataset_type": "Selected Ultimate"}
            ],
            "request_id": self.REQUEST_ID,
        }
        payload.update(overrides)
        # The Engine acts as this login while it walks, so the request must
        # carry the person who saved rather than the publishing process.
        with patch.object(
            dependent_propagation_service.user_identity_service,
            "get_windows_login_name",
            return_value="Test User",
        ):
            return dependent_propagation_service.submit_dependent_propagation_job(
                payload["project_name"],
                payload["reserving_class"],
                payload["changed_roots"],
                request_id=payload["request_id"],
            )

    def test_submit_refuses_before_writing_anything_without_live_engine(self) -> None:
        with self.assertRaises(HTTPException) as raised:
            self._submit()
        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(str(raised.exception.detail), ENGINE_UNAVAILABLE_MESSAGE)
        self.assertFalse((self.root / "requests").exists())

        with self.assertRaises(HTTPException) as raised:
            dependent_propagation_service.require_engine_available()
        self.assertEqual(raised.exception.status_code, 503)

    def test_stale_heartbeat_does_not_count_as_a_live_engine(self) -> None:
        heartbeat = self._write_heartbeat()
        stale_moment = time.time() - 120
        os.utime(heartbeat, (stale_moment, stale_moment))
        with self.assertRaises(HTTPException) as raised:
            self._submit()
        self.assertEqual(raised.exception.status_code, 503)

    def test_submit_publishes_queued_status_before_path_free_request(self) -> None:
        self._write_heartbeat()
        canonical_writer = dependent_propagation_service.write_json_atomic

        def observe_request_write(path, payload):
            if Path(path) == dependent_propagation_request_path(self.root, self.REQUEST_ID):
                self.assertTrue(
                    dependent_propagation_status_path(self.root, self.REQUEST_ID).is_file()
                )
            return canonical_writer(path, payload)

        with patch.object(
            dependent_propagation_service,
            "write_json_atomic",
            side_effect=observe_request_write,
        ):
            result = self._submit()

        self.assertEqual(
            result, {"ok": True, "job_id": self.REQUEST_ID, "status": "queued"}
        )
        request_path = dependent_propagation_request_path(self.root, self.REQUEST_ID)
        request = json.loads(request_path.read_text(encoding="utf-8"))
        self.assertEqual(
            request,
            {
                "Function": DEPENDENT_PROPAGATION_FUNCTION,
                "ContractVersion": DEPENDENT_PROPAGATION_CONTRACT_VERSION,
                "RequestId": self.REQUEST_ID,
                "ProjectName": "Demo Project",
                "Path": "HPPREF\\HO+DF\\NJ",
                "ChangedRoots": [
                    {"dataset_name": "Paid Output", "dataset_type": "Selected Ultimate"}
                ],
                "UserName": "Test User",
            },
        )
        escaped_root = str(self.root).replace("\\", "\\\\")
        self.assertNotIn(escaped_root, json.dumps(request))
        queued = json.loads(
            dependent_propagation_status_path(self.root, self.REQUEST_ID).read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(queued["status"], "queued")
        self.assertNotIn(escaped_root, json.dumps(queued))

    def test_status_read_maps_missing_invalid_and_mismatched_statuses(self) -> None:
        with self.assertRaises(HTTPException) as raised:
            dependent_propagation_service.get_dependent_propagation_status("bad id!")
        self.assertEqual(raised.exception.status_code, 400)

        with self.assertRaises(HTTPException) as raised:
            dependent_propagation_service.get_dependent_propagation_status(
                self.REQUEST_ID
            )
        self.assertEqual(raised.exception.status_code, 404)

        status_path = dependent_propagation_status_path(self.root, self.REQUEST_ID)
        status_path.parent.mkdir(parents=True)
        status_path.write_text("{", encoding="utf-8")
        with self.assertRaises(HTTPException) as raised:
            dependent_propagation_service.get_dependent_propagation_status(
                self.REQUEST_ID
            )
        self.assertEqual(raised.exception.status_code, 502)

    def test_engine_processes_submission_to_terminal_success(self) -> None:
        self._write_heartbeat()
        submitted = self._submit()
        request_path = dependent_propagation_request_path(self.root, self.REQUEST_ID)
        request = json.loads(request_path.read_text(encoding="utf-8"))

        with patch.object(
            engine_propagation,
            "execute_dependent_propagation",
            return_value={"ok": True, "steps": []},
        ) as walk:
            completed = engine_propagation.process_durable_dependent_propagation_request(
                self.root, request_path, request
            )

        self.assertEqual(submitted["status"], "queued")
        self.assertTrue(completed)
        walk.assert_called_once()
        self.assertFalse(request_path.exists())
        result = dependent_propagation_service.get_dependent_propagation_status(
            self.REQUEST_ID
        )
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["job_id"], self.REQUEST_ID)
        self.assertEqual(
            set(result),
            {
                "ok",
                "job_id",
                "contract_version",
                "status",
                "updated_at",
                "request_id",
                "progress",
            },
        )

    def test_failed_walk_publishes_error_and_is_not_auto_retried(self) -> None:
        self._write_heartbeat()
        self._submit()
        request_path = dependent_propagation_request_path(self.root, self.REQUEST_ID)
        request = json.loads(request_path.read_text(encoding="utf-8"))

        with patch.object(
            engine_propagation,
            "execute_dependent_propagation",
            return_value={
                "ok": False,
                "steps": [],
                "skipped": [{"dataset_type_name": "Broken Calc"}],
                "index_error": "",
            },
        ):
            completed = engine_propagation.process_durable_dependent_propagation_request(
                self.root, request_path, request
            )

        self.assertFalse(completed)
        # A failed job is terminal: the queue file is consumed so the rescan
        # cycle cannot auto-retry it; the next save or refresh re-enqueues.
        self.assertFalse(request_path.exists())
        result = dependent_propagation_service.get_dependent_propagation_status(
            self.REQUEST_ID
        )
        self.assertEqual(result["status"], "error")
        self.assertIn("Broken Calc", result["message"])
        self.assertNotIn(str(self.root), result["message"])

    def test_reserving_class_lease_serializes_engine_instances(self) -> None:
        self._write_heartbeat()
        self._submit()
        request_path = dependent_propagation_request_path(self.root, self.REQUEST_ID)
        request = json.loads(request_path.read_text(encoding="utf-8"))

        holder = acquire_reserving_class_lease(
            self.root, request["ProjectName"], request["Path"]
        )
        self.assertIsNotNone(holder)
        try:
            with patch.object(
                engine_propagation, "execute_dependent_propagation"
            ) as walk:
                completed = (
                    engine_propagation.process_durable_dependent_propagation_request(
                        self.root, request_path, request
                    )
                )
        finally:
            release_reserving_class_lease(holder)

        self.assertFalse(completed)
        walk.assert_not_called()
        self.assertTrue(request_path.exists())
        result = dependent_propagation_service.get_dependent_propagation_status(
            self.REQUEST_ID
        )
        self.assertEqual(result["status"], "queued")

    def test_claim_time_coalescing_merges_queued_requests_for_one_class(self) -> None:
        self._write_heartbeat()
        self._submit()
        second_id = "babe0123456789abcdef0123456789ab"
        third_id = "cafe0123456789abcdef0123456789ab"
        self._submit(
            request_id=second_id,
            changed_roots=[{"dataset_name": "Incurred Output", "dataset_type": ""}],
        )
        self._submit(
            request_id=third_id,
            reserving_class="Other\\Class",
            changed_roots=[{"dataset_name": "Elsewhere", "dataset_type": ""}],
        )
        request_path = dependent_propagation_request_path(self.root, self.REQUEST_ID)
        request = json.loads(request_path.read_text(encoding="utf-8"))

        with patch.object(
            engine_propagation,
            "execute_dependent_propagation",
            return_value={"ok": True, "steps": []},
        ) as walk:
            completed = engine_propagation.process_durable_dependent_propagation_request(
                self.root, request_path, request
            )

        self.assertTrue(completed)
        walk.assert_called_once()
        _args, kwargs = walk.call_args
        self.assertEqual(
            kwargs["additional_roots"],
            [{"dataset_name": "Incurred Output", "dataset_type": ""}],
        )
        self.assertFalse(request_path.exists())
        self.assertFalse(
            dependent_propagation_request_path(self.root, second_id).exists()
        )
        merged = dependent_propagation_service.get_dependent_propagation_status(second_id)
        self.assertEqual(merged["status"], "success")
        self.assertEqual(merged["merged_into"], self.REQUEST_ID)
        untouched = dependent_propagation_service.get_dependent_propagation_status(third_id)
        self.assertEqual(untouched["status"], "queued")
        self.assertTrue(
            dependent_propagation_request_path(self.root, third_id).exists()
        )

    def test_progress_updates_publish_processing_statuses_per_tier(self) -> None:
        self._write_heartbeat()
        self._submit()
        request_path = dependent_propagation_request_path(self.root, self.REQUEST_ID)
        request = json.loads(request_path.read_text(encoding="utf-8"))
        observed_stages = []

        def walk(_root, _request, *, additional_roots, progress_callback):
            progress_callback(
                {"stage": "dfm", "completed": 0, "total": 0, "label": "Refreshing DFM methods"}
            )
            persisted = json.loads(
                dependent_propagation_status_path(self.root, self.REQUEST_ID).read_text(
                    encoding="utf-8"
                )
            )
            observed_stages.append((persisted["status"], persisted["progress"]["stage"]))
            return {"ok": True, "steps": []}

        with patch.object(
            engine_propagation, "execute_dependent_propagation", side_effect=walk
        ):
            self.assertTrue(
                engine_propagation.process_durable_dependent_propagation_request(
                    self.root, request_path, request
                )
            )

        self.assertEqual(observed_stages, [("processing", "dfm")])
        terminal = dependent_propagation_service.get_dependent_propagation_status(
            self.REQUEST_ID
        )
        self.assertEqual(terminal["progress"]["stage"], "complete")

    def test_enqueue_save_propagation_never_raises_after_a_committed_save(self) -> None:
        payload = dependent_propagation_service.enqueue_save_propagation(
            "Demo Project",
            "HPPREF\\HO+DF\\NJ",
            [{"dataset_name": "Paid Output", "dataset_type": ""}],
        )
        self.assertEqual(payload["ok"], False)
        self.assertEqual(payload["status"], "error")
        self.assertEqual(payload["message"], ENGINE_UNAVAILABLE_MESSAGE)

    def test_marked_save_propagation_marks_only_the_first_method_tier(self) -> None:
        # The save-side marking must stay cheap on a Client PC: the deep
        # closure is the Engine job's first claimed step, on local disk.
        with (
            patch(
                "app_server.services.dataset_sidecar_status_service."
                "refresh_method_statuses_for_dependents",
                return_value=[],
            ) as marker,
            patch.object(
                dependent_propagation_service,
                "enqueue_save_propagation",
                return_value={"ok": True, "job_id": self.REQUEST_ID, "status": "queued"},
            ),
        ):
            payload = dependent_propagation_service.enqueue_marked_save_propagation(
                "Demo Project",
                "HPPREF\\HO+DF\\NJ",
                "Paid Output",
                "Selected Ultimate",
            )
        self.assertEqual(payload["status"], "queued")
        marker.assert_called_once_with(
            "Demo Project",
            "HPPREF\\HO+DF\\NJ",
            ["Paid Output", "Selected Ultimate"],
            direct_only=True,
        )

    def test_no_op_save_payload_shape(self) -> None:
        self.assertEqual(
            dependent_propagation_service.unchanged_propagation(),
            {"ok": True, "status": "unchanged"},
        )

    def test_deferred_save_propagation_collects_nested_roots_into_one_walk(self) -> None:
        # An operation saving several objects in one class (the Excel workbook
        # retarget) collects their roots and walks once; a save for another
        # class inside the same operation is not intercepted.
        with patch.object(
            dependent_propagation_service,
            "submit_dependent_propagation_job",
            return_value={"ok": True, "job_id": self.REQUEST_ID, "status": "queued"},
        ) as submit:
            with dependent_propagation_service.deferred_save_propagation(
                "Demo Project", "HPPREF\\HO+DF\\NJ"
            ) as propagation:
                first = dependent_propagation_service.enqueue_save_propagation(
                    "Demo Project", "HPPREF\\HO+DF\\NJ",
                    [{"dataset_name": "Paid", "dataset_type": "Paid"}],
                )
                second = dependent_propagation_service.enqueue_save_propagation(
                    "demo project", "hppref\\ho+df\\nj",
                    [{"dataset_name": "paid", "dataset_type": ""}, {"dataset_name": "Incurred", "dataset_type": ""}],
                )
                other = dependent_propagation_service.enqueue_save_propagation(
                    "Demo Project", "HPPREF\\HO+DF\\NY",
                    [{"dataset_name": "Elsewhere", "dataset_type": ""}],
                )
                propagation.add_roots([{"dataset_name": "DFM Output", "dataset_type": "Selected Ultimate"}])
                self.assertEqual(submit.call_count, 1, "only the other class was submitted")
            self.assertEqual(first, {"ok": True, "status": "deferred"})
            self.assertEqual(second, {"ok": True, "status": "deferred"})
            self.assertEqual(other["status"], "queued")
            self.assertEqual(
                [root["dataset_name"] for root in propagation.roots],
                ["Paid", "Incurred", "DFM Output"],
            )
            flushed = propagation.flush()
        self.assertEqual(flushed["status"], "queued")
        self.assertEqual(submit.call_count, 2)
        self.assertEqual(
            submit.call_args.args,
            (
                "Demo Project",
                "HPPREF\\HO+DF\\NJ",
                [
                    {"dataset_name": "Paid", "dataset_type": "Paid"},
                    {"dataset_name": "Incurred", "dataset_type": ""},
                    {"dataset_name": "DFM Output", "dataset_type": "Selected Ultimate"},
                ],
            ),
        )
        # Nothing collected: the flush is the canonical no-op payload.
        with dependent_propagation_service.deferred_save_propagation("Demo Project", "X") as empty:
            pass
        self.assertEqual(empty.flush(), {"ok": True, "status": "unchanged"})

    def test_a_fresh_walk_lease_holds_the_class_against_new_writes(self) -> None:
        self._write_heartbeat()
        project, reserving = "Demo Project", "HPPREF\\HO+DF\\NJ"
        # An idle class is writable and reports not busy.
        dependent_propagation_service.require_reserving_class_writable(
            project, reserving
        )
        self.assertEqual(
            dependent_propagation_service.get_reserving_class_busy(project, reserving),
            {"ok": True, "busy": False, "reason": None},
        )

        lease = acquire_reserving_class_lease(self.root, project, reserving)
        self.assertIsNotNone(lease)
        try:
            with self.assertRaises(HTTPException) as raised:
                dependent_propagation_service.require_reserving_class_writable(
                    project, reserving
                )
            self.assertEqual(raised.exception.status_code, 423)
            self.assertEqual(
                str(raised.exception.detail),
                dependent_propagation_service.RESERVING_CLASS_BUSY_MESSAGE,
            )
            self.assertEqual(
                dependent_propagation_service.get_reserving_class_busy(
                    project, reserving
                ),
                {"ok": True, "busy": True, "reason": "processing"},
            )
            # A different class stays writable while this one is held.
            dependent_propagation_service.require_reserving_class_writable(
                project, "Other\\Class"
            )
            # An orchestrated multi-save operation that preflighted the hold
            # once suspends the refusal for its nested saves.
            with dependent_propagation_service.suspended_reserving_class_hold_check():
                dependent_propagation_service.require_reserving_class_writable(
                    project, reserving
                )
        finally:
            release_reserving_class_lease(lease)
        dependent_propagation_service.require_reserving_class_writable(
            project, reserving
        )

    def test_a_queued_job_holds_the_class_until_its_terminal_status(self) -> None:
        self._write_heartbeat()
        project, reserving = "Demo Project", "HPPREF\\HO+DF\\NJ"
        self._submit()
        with self.assertRaises(HTTPException) as raised:
            dependent_propagation_service.require_reserving_class_writable(
                project, reserving
            )
        self.assertEqual(raised.exception.status_code, 423)
        self.assertEqual(
            dependent_propagation_service.get_reserving_class_busy(project, reserving),
            {"ok": True, "busy": True, "reason": "queued"},
        )

        write_dependent_propagation_status(
            self.root,
            self.REQUEST_ID,
            "success",
            progress={
                "stage": "complete",
                "completed": 1,
                "total": 1,
                "label": "Dependent updates complete",
            },
        )
        dependent_propagation_service.require_reserving_class_writable(
            project, reserving
        )

    def test_router_declares_async_and_typed_job_contracts(self) -> None:
        submit_route = next(
            route
            for route in router.routes
            if route.path == "/dependent_propagation/refresh_dependents"
            and "POST" in route.methods
        )
        status_route = next(
            route
            for route in router.routes
            if route.path
            == "/dependent_propagation/refresh_dependents/status/{request_id}"
        )
        busy_route = next(
            route
            for route in router.routes
            if route.path == "/dependent_propagation/reserving_class_busy"
        )
        self.assertEqual(submit_route.status_code, status.HTTP_202_ACCEPTED)
        self.assertIs(submit_route.response_model, RefreshDependentsJobResponse)
        self.assertIs(
            status_route.response_model, DependentPropagationJobStatusResponse
        )
        self.assertIs(busy_route.response_model, ReservingClassBusyResponse)


class EngineWalkParityTests(unittest.TestCase):
    """The Engine-run walk must write the exact bytes a direct walk writes."""

    PROJECT = "Demo Parity"
    RESERVING_CLASS = "HOL"
    REQUEST_ID = "feed0123456789abcdef0123456789ab"

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT))
        self.base = Path(self.temp_dir.name)
        self._previous_env = os.environ.get("ARCRHO_RUNTIME_SERVER_ROOT")

    def tearDown(self) -> None:
        if self._previous_env is None:
            os.environ.pop("ARCRHO_RUNTIME_SERVER_ROOT", None)
        else:
            os.environ["ARCRHO_RUNTIME_SERVER_ROOT"] = self._previous_env
        from app_server import config

        config.refresh_runtime_paths()
        config.clear_runtime_path_caches()
        self.temp_dir.cleanup()

    def _build_fixture(self, name: str) -> Path:
        root = self.base / name
        project_dir = root / "projects" / self.PROJECT
        rc_dir = project_dir / "data" / self.RESERVING_CLASS
        datasets = rc_dir / "datasets"
        sidecars = rc_dir / "sidecars"
        datasets.mkdir(parents=True)
        sidecars.mkdir(parents=True)
        (project_dir / "dataset_types.json").write_text(
            json.dumps(
                {
                    "columns": [
                        "Name",
                        "Data Format",
                        "Category",
                        "Calculated",
                        "Formula",
                        "Source",
                        "Generated",
                    ],
                    "rows": [
                        ["Source", "Vector", "", False, "", "", False],
                        ["Calc", "Vector", "", True, '"Source" * 2', "", False],
                    ],
                    "updated_at": "2026-08-06T00:00:00Z",
                }
            ),
            encoding="utf-8",
        )
        (datasets / "Source@12.csv").write_text("100.0\n200.0\n", encoding="utf-8")
        (sidecars / "Source.json").write_text(
            json.dumps(
                {
                    "dataset_name": "Source",
                    "dataset_type": "Source",
                    "project_name": self.PROJECT,
                    "reserving_class": self.RESERVING_CLASS,
                    "source_kind": "input",
                    "data_format": "Vector",
                    "period_length": 12,
                    "csv_file": "Source@12.csv",
                    "status": 0,
                }
            ),
            encoding="utf-8",
        )
        (datasets / "Calc@12.csv").write_text("1.0\n1.0\n", encoding="utf-8")
        (sidecars / "Calc.json").write_text(
            json.dumps(
                {
                    "dataset_name": "Calc",
                    "dataset_type": "Calc",
                    "project_name": self.PROJECT,
                    "reserving_class": self.RESERVING_CLASS,
                    "source_kind": "calculated",
                    "data_format": "Vector",
                    "period_length": 12,
                    "csv_file": "Calc@12.csv",
                    "status": 0,
                }
            ),
            encoding="utf-8",
        )
        # Recalculated sidecars fingerprint their source files by size and
        # mtime, so both fixture roots must present identical observations.
        fixed_moment = 1_754_000_000
        for folder in (datasets, sidecars):
            for item in folder.iterdir():
                os.utime(item, (fixed_moment, fixed_moment))
        return root

    def _frozen_clocks(self):
        from app_server.services import calculated_dataset_service

        return (
            patch.object(
                calculated_dataset_service,
                "_now_utc_iso",
                return_value="2026-08-06T00:00:00+00:00",
            ),
            patch.object(
                calculated_dataset_service,
                "_current_user_name",
                return_value="parity-user",
            ),
        )

    def _run_direct_walk(self, root: Path) -> None:
        from app_server import config
        from app_server.services import calculated_dataset_service

        os.environ["ARCRHO_RUNTIME_SERVER_ROOT"] = str(root)
        config.refresh_runtime_paths()
        config.clear_runtime_path_caches()
        clock_patch, user_patch = self._frozen_clocks()
        with clock_patch, user_patch:
            result = calculated_dataset_service.recalculate_dependents(
                self.PROJECT,
                self.RESERVING_CLASS,
                "Source",
                "Source",
            )
        self.assertTrue(result["ok"], result)

    def _run_engine_walk(self, root: Path) -> None:
        request = {
            "Function": DEPENDENT_PROPAGATION_FUNCTION,
            "ContractVersion": DEPENDENT_PROPAGATION_CONTRACT_VERSION,
            "RequestId": self.REQUEST_ID,
            "ProjectName": self.PROJECT,
            "Path": self.RESERVING_CLASS,
            "ChangedRoots": [{"dataset_name": "Source", "dataset_type": "Source"}],
            "UserName": "parity-user",
        }
        request_path = dependent_propagation_request_path(root, self.REQUEST_ID)
        request_path.parent.mkdir(parents=True)
        request_path.write_text(json.dumps(request), encoding="utf-8")
        clock_patch, user_patch = self._frozen_clocks()
        with clock_patch, user_patch:
            completed = engine_propagation.process_durable_dependent_propagation_request(
                root, request_path, request
            )
        self.assertTrue(completed)

    @staticmethod
    def _index_payload_without_observation_fields(path: Path) -> dict:
        payload = json.loads(path.read_text(encoding="utf-8"))
        payload.pop("folder_signature", None)
        payload.pop("generated_at", None)
        payload.pop("updated_at", None)
        for item in payload.get("files", []) or []:
            if isinstance(item, dict):
                for volatile in ("mtime", "mtime_ns", "size", "file_mtime"):
                    item.pop(volatile, None)
        return payload

    def test_engine_walk_writes_byte_identical_dependent_payloads(self) -> None:
        direct_root = self._build_fixture("direct")
        engine_root = self._build_fixture("engine")

        self._run_direct_walk(direct_root)
        self._run_engine_walk(engine_root)

        relative_targets = (
            Path("projects")
            / self.PROJECT
            / "data"
            / self.RESERVING_CLASS
        )
        def normalized_bytes(root: Path, relative: Path) -> bytes:
            text = (root / relative).read_text(encoding="utf-8")
            # The two runs use different fixture roots by construction; the
            # comparison must be alias-independent, exactly like the
            # cross-producer index parity tests.
            for alias in (
                json.dumps(str(root))[1:-1],
                str(root),
                str(root).replace("\\", "/"),
            ):
                text = text.replace(alias, "<server-root>")
            return text.encode("utf-8")

        for relative in (
            relative_targets / "datasets" / "Calc@12.csv",
            relative_targets / "sidecars" / "Calc.json",
        ):
            direct_bytes = normalized_bytes(direct_root, relative)
            engine_bytes = normalized_bytes(engine_root, relative)
            self.assertEqual(direct_bytes, engine_bytes, f"payload drift: {relative}")

        direct_index = self._index_payload_without_observation_fields(
            direct_root / relative_targets / "index.json"
        )
        engine_index = self._index_payload_without_observation_fields(
            engine_root / relative_targets / "index.json"
        )
        self.assertEqual(direct_index, engine_index)


if __name__ == "__main__":
    unittest.main()
