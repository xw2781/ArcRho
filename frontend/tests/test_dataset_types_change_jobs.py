"""Dataset-type changes: what is written directly, and what becomes a job."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from importlib import import_module
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = FRONTEND_ROOT.parent
DATA_ENGINE_SRC = REPOSITORY_ROOT / "data-engine" / "src"
PYTHON_API_SRC = REPOSITORY_ROOT / "python-api" / "src"
for path in (FRONTEND_ROOT, DATA_ENGINE_SRC, PYTHON_API_SRC):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from arcrho_dataset_types_change_contract import (
    DATASET_TYPES_CHANGE_CONTRACT_VERSION,
    DATASET_TYPES_CHANGE_FUNCTION,
    DatasetTypesChangeContractError,
    build_dataset_types_change_request,
    build_dataset_types_change_status,
    dataset_types_change_request_path,
    dataset_types_change_status_path,
    find_queued_dataset_types_change,
    validate_dataset_types_change_request,
    validate_dataset_types_change_status,
)
from arcrho_dependent_propagation_contract import (
    ENGINE_UNAVAILABLE_MESSAGE,
    acquire_project_scope_lease,
    acquire_reserving_class_lease,
    find_any_reserving_class_propagation_hold,
    find_project_scope_propagation_hold,
    find_reserving_class_propagation_hold,
    release_project_scope_lease,
    release_reserving_class_lease,
)
# ``app_server.api`` re-exports the APIRouter object under the module's own
# name, so the module has to be imported explicitly to reach its handlers.
dataset_types_router = import_module("app_server.api.dataset_types_router")
from app_server.schemas.dataset_types import DatasetTypesSaveRequest
from app_server.services import (
    calculated_dataset_service,
    dataset_types_change_service,
    dataset_types_service,
    dependent_propagation_service,
    source_refresh_service,
)


PROJECT = "Demo Project"
CLASS_A = "HPPREF\\HO+DF\\NJ"
CLASS_B = "PRNJ - PA\\PA\\All States"


class DatasetTypesChangeContractTests(unittest.TestCase):
    REQUEST_ID = "abcdef0123456789abcdef0123456789"

    def _request(self, **overrides):
        payload = {
            "request_id": self.REQUEST_ID,
            "project_name": PROJECT,
            "rows": [
                ["Paid", "Triangle", "A Loss", False, ""],
                ["Paid Ultimate", "Vector", "A Loss", True, '"Paid" * 2'],
            ],
            "changed_types": ["Paid Ultimate"],
            "user_name": "Test User",
        }
        payload.update(overrides)
        return build_dataset_types_change_request(**payload)

    def test_request_round_trips_and_rejects_filesystem_fields(self) -> None:
        request = self._request()
        self.assertEqual(request["Function"], DATASET_TYPES_CHANGE_FUNCTION)
        self.assertEqual(
            request["ContractVersion"], DATASET_TYPES_CHANGE_CONTRACT_VERSION
        )
        self.assertEqual(validate_dataset_types_change_request(request), request)

        with self.assertRaises(DatasetTypesChangeContractError):
            validate_dataset_types_change_request(
                {**request, "TablePath": "E:\\ArcRho Server\\x.json"}
            )

    def test_rows_must_keep_the_transport_shape(self) -> None:
        for bad_rows in (
            [["Paid", "Triangle", "A Loss", "no", ""]],  # flag is not a boolean
            [["Paid", "Triangle", "A Loss", False]],  # short row
            [["Paid", "Triangle", "A Loss", False, "", "extra"]],  # long row
            [{"Name": "Paid"}],  # object instead of a row
            [["Paid", 3, "A Loss", False, ""]],  # non-string cell
        ):
            with self.assertRaises(DatasetTypesChangeContractError):
                self._request(rows=bad_rows)

    def test_changed_types_are_ordered_and_deduplicated(self) -> None:
        request = self._request(changed_types=["Paid", "paid", " Paid ", "Incurred"])
        self.assertEqual(request["ChangedTypes"], ["Paid", "Incurred"])

    def test_status_round_trips(self) -> None:
        status = build_dataset_types_change_status(
            self.REQUEST_ID,
            "success",
            progress={
                "stage": "complete",
                "completed": 2,
                "total": 2,
                "label": "Dataset type change complete",
            },
            result={
                "rows_written": 2,
                "types_changed": 1,
                "datasets_total": 12,
                "datasets_updated": 7,
                "classes_total": 2,
                "classes_walked": 2,
                "datasets_recalculated": 3,
                "failures": [],
            },
        )
        self.assertEqual(
            validate_dataset_types_change_status(
                status, expected_request_id=self.REQUEST_ID
            ),
            status,
        )
        with self.assertRaises(DatasetTypesChangeContractError):
            validate_dataset_types_change_status(
                status, expected_request_id="0" * 32
            )


class ProjectScopeLeaseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT))
        self.root = Path(self.temp_dir.name)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_project_lease_holds_every_class_of_that_project_only(self) -> None:
        lease = acquire_project_scope_lease(self.root, PROJECT)
        self.assertIsNotNone(lease)
        try:
            self.assertEqual(
                find_project_scope_propagation_hold(self.root, PROJECT),
                {"reason": "project"},
            )
            for reserving_class in (CLASS_A, CLASS_B):
                self.assertEqual(
                    find_reserving_class_propagation_hold(
                        self.root, PROJECT, reserving_class
                    ),
                    {"reason": "project"},
                )
            self.assertIsNone(
                find_reserving_class_propagation_hold(
                    self.root, "Other Project", CLASS_A
                )
            )
            # A whole-project hold is not one class being walked; the
            # dataset-type preflight must not mistake its own lease for one.
            self.assertIsNone(
                find_any_reserving_class_propagation_hold(self.root, PROJECT)
            )
            self.assertIsNone(acquire_project_scope_lease(self.root, PROJECT))
        finally:
            release_project_scope_lease(lease)
        self.assertIsNone(find_project_scope_propagation_hold(self.root, PROJECT))

    def test_any_class_probe_names_the_class_still_being_walked(self) -> None:
        lease = acquire_reserving_class_lease(self.root, PROJECT, CLASS_A)
        self.assertIsNotNone(lease)
        try:
            self.assertEqual(
                find_any_reserving_class_propagation_hold(self.root, PROJECT),
                {"reason": "processing", "reserving_class": CLASS_A},
            )
            self.assertIsNone(
                find_any_reserving_class_propagation_hold(self.root, "Other Project")
            )
            # Only that class is held; the rest of the project stays writable.
            self.assertIsNone(
                find_reserving_class_propagation_hold(self.root, PROJECT, CLASS_B)
            )
        finally:
            release_reserving_class_lease(lease)
        self.assertIsNone(find_any_reserving_class_propagation_hold(self.root, PROJECT))


class DatasetTypesChangeJobTests(unittest.TestCase):
    REQUEST_ID = "abcdef0123456789abcdef0123456789"

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT))
        self.root = Path(self.temp_dir.name)
        self.project_dir = self.root / "projects" / PROJECT
        self.project_dir.mkdir(parents=True)
        self.instances_dir = self.root / "runtime" / "instances" / "arcrho_engine"
        self.workspace = {
            "workspace_root": str(self.root),
            "paths": {"projects_dir": "projects", "requests_dir": "requests"},
        }
        # Every service reaches the same ``app_server.config`` module, so each
        # attribute is patched exactly once: patching one twice would leak the
        # first mock past the stop, into whatever test runs next.
        self.patches = [
            patch.object(
                dependent_propagation_service.config,
                "load_workspace_paths",
                return_value=self.workspace,
            ),
            patch.object(
                dataset_types_service.config,
                "get_dataset_types_path",
                side_effect=lambda name: str(self.project_dir / "dataset_types.json"),
            ),
            # Source and Generated come from the project's field mapping, which
            # this test has no need to build; the change decision is what is
            # under test.
            patch.object(
                dataset_types_service, "_load_dataset_source_map", return_value={}
            ),
            patch.object(
                dataset_types_service, "_load_field_mapping_field_names", return_value=[]
            ),
            patch.object(
                dataset_types_change_service.user_identity_service,
                "get_windows_login_name",
                return_value="Test User",
            ),
        ]
        for item in self.patches:
            item.start()
        self.addCleanup(self._stop_patches)
        self.addCleanup(self.temp_dir.cleanup)

    def _stop_patches(self) -> None:
        for item in reversed(self.patches):
            item.stop()

    def _write_heartbeat(self) -> Path:
        self.instances_dir.mkdir(parents=True, exist_ok=True)
        heartbeat = self.instances_dir / "engine.json"
        heartbeat.write_text(
            json.dumps({"Server": "engine", "Last seen": "2026-08-20 12:00:00"}),
            encoding="utf-8",
        )
        return heartbeat

    def _seed_table(self, rows) -> None:
        dataset_types_service.apply_dataset_types_rows(PROJECT, rows)

    def _save(self, rows, request_id: str = ""):
        return dataset_types_router.save_dataset_types(
            DatasetTypesSaveRequest(
                project_name=PROJECT,
                columns=["Name", "Data Format", "Category", "Calculated", "Formula"],
                rows=rows,
                request_id=request_id or self.REQUEST_ID,
            )
        )

    # -- what counts as a project-wide change ----------------------------

    def test_category_only_edit_is_written_directly(self) -> None:
        self._seed_table([["Paid", "Triangle", "A Loss", False, ""]])
        with patch.object(
            dataset_types_change_service, "submit_dataset_types_change_job"
        ) as submit:
            response = self._save([["Paid", "Triangle", "B Renamed", False, ""]])
        submit.assert_not_called()
        self.assertEqual(response["applied"], "direct")
        self.assertEqual(response["count"], 1)
        saved = json.loads(
            (self.project_dir / "dataset_types.json").read_text(encoding="utf-8")
        )
        self.assertEqual(saved["rows"][0][2], "B Renamed")

    def test_adding_an_ordinary_type_is_written_directly(self) -> None:
        # The most common edit this grid sees. A brand-new type has no
        # instances and no formula names it, so nothing derived from the table
        # moves and the user must not wait for a project-wide rebuild.
        self._seed_table([["Paid", "Triangle", "A Loss", False, ""]])
        self._write_heartbeat()
        with patch.object(
            dataset_types_change_service, "submit_dataset_types_change_job"
        ) as submit:
            response = self._save(
                [
                    ["Paid", "Triangle", "A Loss", False, ""],
                    ["Growth Adjustment - Paid", "Vector", "B Exposure", False, ""],
                ]
            )
        submit.assert_not_called()
        self.assertEqual(response["applied"], "direct")
        saved = json.loads(
            (self.project_dir / "dataset_types.json").read_text(encoding="utf-8")
        )
        self.assertEqual(len(saved["rows"]), 2)

    def test_an_added_name_that_retokenizes_a_formula_needs_the_job(self) -> None:
        # A name containing an operator is the case that bites, and this
        # project's names are full of them ("Growth Adjustment - Paid"). Adding
        # "Total - CWOP" turns the unquoted subtraction below into a reference
        # to that one dataset, without its formula text ever moving.
        self._seed_table(
            [
                ["Total", "Triangle", "A Loss", False, ""],
                ["CWOP", "Triangle", "A Loss", False, ""],
                ["Ultimate", "Vector", "A Loss", True, "Total - CWOP"],
            ]
        )
        self._write_heartbeat()
        response = self._save(
            [
                ["Total", "Triangle", "A Loss", False, ""],
                ["CWOP", "Triangle", "A Loss", False, ""],
                ["Total - CWOP", "Triangle", "A Loss", False, ""],
                ["Ultimate", "Vector", "A Loss", True, "Total - CWOP"],
            ]
        )
        self.assertEqual(response["applied"], "job")

    def test_removing_a_type_needs_the_project_job(self) -> None:
        self._seed_table(
            [
                ["Paid", "Triangle", "A Loss", False, ""],
                ["Growth Adjustment - Counts", "Vector", "B Exposure", False, ""],
            ]
        )
        self._write_heartbeat()
        response = self._save([["Paid", "Triangle", "A Loss", False, ""]])
        self.assertEqual(response["applied"], "job")
        self.assertEqual(response["job"]["job_id"], self.REQUEST_ID)
        # The table itself is the Engine's to write, under the project lease.
        saved = json.loads(
            (self.project_dir / "dataset_types.json").read_text(encoding="utf-8")
        )
        self.assertEqual(len(saved["rows"]), 2)

    def test_formula_change_names_its_recalculation_roots(self) -> None:
        self._seed_table(
            [
                ["Paid", "Triangle", "A Loss", False, ""],
                ["Paid Ultimate", "Vector", "A Loss", True, '"Paid" * 2'],
            ]
        )
        self._write_heartbeat()
        response = self._save(
            [
                ["Paid", "Triangle", "A Loss", False, ""],
                ["Paid Ultimate", "Vector", "A Loss", True, '"Paid" * 3'],
            ]
        )
        self.assertEqual(response["applied"], "job")
        self.assertEqual(response["changed_formula_types"], ["Paid Ultimate"])

    def test_unresolved_formula_is_refused_before_any_job(self) -> None:
        self._seed_table([["Paid", "Triangle", "A Loss", False, ""]])
        self._write_heartbeat()
        with self.assertRaises(HTTPException) as raised:
            self._save(
                [
                    ["Paid", "Triangle", "A Loss", False, ""],
                    ["Paid Ultimate", "Vector", "A Loss", True, '"Missing" * 2'],
                ]
            )
        self.assertEqual(raised.exception.status_code, 400)
        self.assertIn("unresolved", str(raised.exception.detail))
        self.assertFalse((self.root / "requests").exists())

    # -- the preflight ---------------------------------------------------

    def test_submit_refuses_without_a_live_engine(self) -> None:
        with self.assertRaises(HTTPException) as raised:
            dataset_types_change_service.submit_dataset_types_change_job(
                PROJECT, [["Paid", "Triangle", "A Loss", False, ""]], []
            )
        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(str(raised.exception.detail), ENGINE_UNAVAILABLE_MESSAGE)
        self.assertFalse((self.root / "requests").exists())

    def test_submit_refuses_while_any_class_is_being_walked(self) -> None:
        self._write_heartbeat()
        lease = acquire_reserving_class_lease(self.root, PROJECT, CLASS_A)
        try:
            with self.assertRaises(HTTPException) as raised:
                dataset_types_change_service.submit_dataset_types_change_job(
                    PROJECT, [["Paid", "Triangle", "A Loss", False, ""]], []
                )
        finally:
            release_reserving_class_lease(lease)
        self.assertEqual(raised.exception.status_code, 423)
        self.assertIn(CLASS_A, str(raised.exception.detail))
        self.assertFalse(
            dataset_types_change_request_path(self.root, self.REQUEST_ID).exists()
        )

    def test_submit_refuses_while_another_project_job_holds_the_project(self) -> None:
        self._write_heartbeat()
        lease = acquire_project_scope_lease(self.root, PROJECT)
        try:
            with self.assertRaises(HTTPException) as raised:
                dataset_types_change_service.submit_dataset_types_change_job(
                    PROJECT, [["Paid", "Triangle", "A Loss", False, ""]], []
                )
        finally:
            release_project_scope_lease(lease)
        self.assertEqual(raised.exception.status_code, 423)
        self.assertIn("project-wide update", str(raised.exception.detail))

    def test_source_refresh_is_refused_while_the_project_job_runs(self) -> None:
        self._write_heartbeat()
        lease = acquire_project_scope_lease(self.root, PROJECT)
        try:
            with patch.object(
                source_refresh_service.user_identity_service,
                "get_windows_login_name",
                return_value="Test User",
            ):
                with self.assertRaises(HTTPException) as raised:
                    source_refresh_service.submit_source_table_refresh_job(
                        PROJECT, self.REQUEST_ID
                    )
        finally:
            release_project_scope_lease(lease)
        self.assertEqual(raised.exception.status_code, 423)
        self.assertIn("project-wide update", str(raised.exception.detail))

    # -- submission ------------------------------------------------------

    def test_submit_publishes_a_queued_status_and_the_request(self) -> None:
        self._write_heartbeat()
        submitted = dataset_types_change_service.submit_dataset_types_change_job(
            PROJECT,
            [["Paid", "Triangle", "A Loss", False, ""]],
            ["Paid"],
            request_id=self.REQUEST_ID,
        )
        self.assertEqual(submitted["job_id"], self.REQUEST_ID)
        self.assertEqual(submitted["status"], "queued")
        self.assertFalse(submitted["resumed"])

        request = json.loads(
            dataset_types_change_request_path(self.root, self.REQUEST_ID).read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(request["Function"], DATASET_TYPES_CHANGE_FUNCTION)
        self.assertEqual(request["ProjectName"], PROJECT)
        self.assertEqual(request["UserName"], "Test User")
        status = json.loads(
            dataset_types_change_status_path(self.root, self.REQUEST_ID).read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(status["status"], "queued")
        self.assertEqual(
            find_queued_dataset_types_change(self.root, PROJECT),
            {"reason": "queued", "job_id": self.REQUEST_ID},
        )

    def test_replaying_a_submitted_id_returns_the_same_job(self) -> None:
        self._write_heartbeat()
        first = dataset_types_change_service.submit_dataset_types_change_job(
            PROJECT, [["Paid", "Triangle", "A Loss", False, ""]], [], self.REQUEST_ID
        )
        second = dataset_types_change_service.submit_dataset_types_change_job(
            PROJECT, [["Paid", "Triangle", "A Loss", False, ""]], [], self.REQUEST_ID
        )
        self.assertFalse(first["resumed"])
        self.assertTrue(second["resumed"])
        self.assertEqual(first["job_id"], second["job_id"])

    def test_a_second_queued_change_is_refused(self) -> None:
        self._write_heartbeat()
        dataset_types_change_service.submit_dataset_types_change_job(
            PROJECT, [["Paid", "Triangle", "A Loss", False, ""]], [], self.REQUEST_ID
        )
        with self.assertRaises(HTTPException) as raised:
            dataset_types_change_service.submit_dataset_types_change_job(
                PROJECT, [["Paid", "Triangle", "A Loss", False, ""]], [], "0" * 32
            )
        self.assertEqual(raised.exception.status_code, 423)

    # -- status ----------------------------------------------------------

    def test_status_reports_the_job_and_whether_the_project_is_held(self) -> None:
        self._write_heartbeat()
        dataset_types_change_service.submit_dataset_types_change_job(
            PROJECT, [["Paid", "Triangle", "A Loss", False, ""]], [], self.REQUEST_ID
        )
        status = dataset_types_change_service.get_dataset_types_change_status(
            PROJECT, self.REQUEST_ID
        )
        self.assertTrue(status["found"])
        self.assertEqual(status["status"], "queued")
        self.assertFalse(status["busy"])

        lease = acquire_project_scope_lease(self.root, PROJECT)
        try:
            held = dataset_types_change_service.get_dataset_types_change_status(
                PROJECT, self.REQUEST_ID
            )
        finally:
            release_project_scope_lease(lease)
        self.assertTrue(held["busy"])
        self.assertEqual(held["busy_reason"], "project")

    def test_unknown_job_is_a_404(self) -> None:
        self._write_heartbeat()
        with self.assertRaises(HTTPException) as raised:
            dataset_types_change_service.get_dataset_types_change_status(
                PROJECT, self.REQUEST_ID
            )
        self.assertEqual(raised.exception.status_code, 404)


class DatasetTypeRemovalBlockerTests(unittest.TestCase):
    """A dataset type may only go once nothing reads its instances."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT))
        self.data_dir = Path(self.temp_dir.name) / "data"
        self.data_dir.mkdir(parents=True)
        self.patch = patch.object(
            calculated_dataset_service.config,
            "get_project_data_dir",
            side_effect=lambda name: str(self.data_dir),
        )
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.addCleanup(self.temp_dir.cleanup)

    def _sidecar(self, reserving_class: str, name: str, payload: dict) -> None:
        folder = self.data_dir / reserving_class / "sidecars"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / f"{name}.json").write_text(json.dumps(payload), encoding="utf-8")

    def test_an_instance_nothing_reads_is_not_a_blocker(self) -> None:
        self._sidecar(
            "HPPREF",
            "Growth Adjustment - Counts",
            {"dataset_type": "Growth Adjustment - Counts", "reserving_class": "HPPREF", "Dependents": []},
        )
        self.assertEqual(
            calculated_dataset_service.find_dataset_type_removal_blockers(
                PROJECT, ["Growth Adjustment - Counts"]
            ),
            [],
        )

    def test_an_instance_a_method_reads_blocks_the_removal(self) -> None:
        self._sidecar(
            "HPPREF",
            "Growth Adjustment - Counts",
            {
                "dataset_type": "Growth Adjustment - Counts",
                "reserving_class": "HPPREF",
                "Dependents": [{"dataset_name": "Selected Ultimate"}],
            },
        )
        self._sidecar(
            "HPPREF",
            "Selected Ultimate",
            {"dataset_type": "Selected Ultimate", "reserving_class": "HPPREF", "method_type": "DFM"},
        )
        blocked = calculated_dataset_service.find_dataset_type_removal_blockers(
            PROJECT, ["Growth Adjustment - Counts"]
        )
        self.assertEqual(len(blocked), 1)
        self.assertEqual(blocked[0]["dataset_type"], "Growth Adjustment - Counts")
        instance = blocked[0]["instances"][0]
        self.assertEqual(instance["reserving_class"], "HPPREF")
        self.assertEqual(instance["dataset_name"], "Growth Adjustment - Counts")
        self.assertEqual(instance["dependents"][0]["dataset_name"], "Selected Ultimate")
        self.assertEqual(instance["dependents"][0]["method_type"], "DFM")

    def test_a_dependent_leaving_in_the_same_change_is_not_a_blocker(self) -> None:
        # Both types are being removed, so the edge between them goes with them.
        self._sidecar(
            "HPPREF",
            "Growth Adjustment - Counts",
            {
                "dataset_type": "Growth Adjustment - Counts",
                "reserving_class": "HPPREF",
                "Dependents": [{"dataset_name": "Growth Adjustment - Paid"}],
            },
        )
        self._sidecar(
            "HPPREF",
            "Growth Adjustment - Paid",
            {"dataset_type": "Growth Adjustment - Paid", "reserving_class": "HPPREF"},
        )
        self.assertEqual(
            calculated_dataset_service.find_dataset_type_removal_blockers(
                PROJECT, ["Growth Adjustment - Counts", "Growth Adjustment - Paid"]
            ),
            [],
        )

    def test_a_type_that_is_not_being_removed_is_never_reported(self) -> None:
        self._sidecar(
            "HPPREF",
            "Paid",
            {
                "dataset_type": "Paid",
                "reserving_class": "HPPREF",
                "Dependents": [{"dataset_name": "Selected Ultimate"}],
            },
        )
        self.assertEqual(
            calculated_dataset_service.find_dataset_type_removal_blockers(PROJECT, []),
            [],
        )

    def test_the_scan_reports_one_step_per_reserving_class(self) -> None:
        for reserving_class in ("A Class", "B Class", "C Class"):
            self._sidecar(
                reserving_class,
                "Paid",
                {"dataset_type": "Paid", "reserving_class": reserving_class},
            )
        seen: list = []
        calculated_dataset_service.find_dataset_type_removal_blockers(
            PROJECT,
            ["Paid"],
            on_progress=lambda stage, label, completed, total: seen.append(
                (stage, completed, total)
            ),
        )
        self.assertEqual(seen, [("scanning", 1, 3), ("scanning", 2, 3), ("scanning", 3, 3)])


class GraphSignificanceTests(unittest.TestCase):
    """The projection that decides between a direct write and a project job."""

    def test_presentation_edits_do_not_need_the_job(self) -> None:
        previous = [["Paid", "Triangle", "A Loss", False, "", "", False]]
        for changed in (
            [["Paid", "Triangle", "Renamed Category", False, "", "", False]],
            [["Paid", "Triangle", "A Loss", False, "", "src", False]],
        ):
            self.assertFalse(
                dataset_types_service.change_needs_project_job(previous, changed)
            )

    def test_an_ordinary_addition_stays_out_of_the_job(self) -> None:
        previous = [
            ["Paid", "Triangle", "A Loss", False, "", "", False],
            ["Paid Ultimate", "Vector", "A Loss", True, '"Paid" * 2', "", False],
        ]
        added = previous + [["Growth Adjustment", "Vector", "B Exposure", False, "", "", False]]
        self.assertFalse(dataset_types_service.change_needs_project_job(previous, added))

    def test_an_addition_that_moves_a_formula_component_needs_the_job(self) -> None:
        previous = [
            ["Total", "Triangle", "A Loss", False, "", "", False],
            ["CWOP", "Triangle", "A Loss", False, "", "", False],
            ["Ultimate", "Vector", "A Loss", True, "Total - CWOP", "", False],
        ]
        added = [
            previous[0],
            previous[1],
            ["Total - CWOP", "Triangle", "A Loss", False, "", "", False],
            previous[2],
        ]
        self.assertTrue(dataset_types_service.change_needs_project_job(previous, added))

    def test_graph_bearing_edits_need_the_job(self) -> None:
        previous = [
            ["Paid", "Triangle", "A Loss", False, "", "", False],
            ["Paid Ultimate", "Vector", "A Loss", True, '"Paid" * 2', "", False],
        ]
        for changed in (
            # a type removed
            [["Paid", "Triangle", "A Loss", False, "", "", False]],
            # a formula edited
            [
                previous[0],
                ["Paid Ultimate", "Vector", "A Loss", True, '"Paid" * 3', "", False],
            ],
            # calculated turned off
            [previous[0], ["Paid Ultimate", "Vector", "A Loss", False, "", "", False]],
            # the data format changed
            [
                ["Paid", "Vector", "A Loss", False, "", "", False],
                previous[1],
            ],
            # the type became engine-generated
            [
                previous[0],
                ["Paid Ultimate", "Vector", "A Loss", True, '"Paid" * 2', "", True],
            ],
        ):
            self.assertTrue(
                dataset_types_service.change_needs_project_job(previous, changed),
                changed,
            )


if __name__ == "__main__":
    unittest.main()
