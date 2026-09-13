from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
if str(FRONTEND_ROOT) not in sys.path:
    sys.path.insert(0, str(FRONTEND_ROOT))

from app_server.services import calculated_dataset_service, dataset_service
from dependent_propagation_workspace_stub import IsolatedPropagationWorkspace


class DatasetMethodCalculatedSidecarTests(unittest.TestCase):
    def setUp(self) -> None:
        self.propagation_workspace = IsolatedPropagationWorkspace().start()

    def tearDown(self) -> None:
        self.propagation_workspace.stop()

    def _save_and_capture(
        self,
        *,
        method_type: str,
        source_kind: str,
        values=None,
    ):
        written = {}

        def capture_sidecar(_path, payload):
            written["payload"] = copy.deepcopy(payload)

        def capture_csv_and_sidecar(_frame, _csv_path, _sidecar_path, payload):
            written["payload"] = copy.deepcopy(payload)

        with (
            patch.object(dataset_service, "_get_dataset_sidecar_path", return_value="sidecar.json"),
            patch.object(dataset_service, "_read_dataset_sidecar", return_value={}),
            patch.object(dataset_service, "_is_app_calculated_dataset_type", return_value=(False, "")),
            patch.object(dataset_service, "_current_user_name", return_value="tester"),
            patch.object(dataset_service, "_write_dataset_sidecar_payload", side_effect=capture_sidecar),
            patch.object(dataset_service, "_write_dataset_csv_and_sidecar", side_effect=capture_csv_and_sidecar),
            patch.object(dataset_service.config, "get_project_dataset_cache_dir", return_value="cache"),
            patch.object(calculated_dataset_service, "apply_sidecar_graph_fields"),
            patch.object(calculated_dataset_service, "recalculate_dependents", return_value=None),
            patch.object(
                dataset_service.dataset_sidecar_status_service,
                "refresh_method_statuses_for_dependents",
                return_value=[],
            ),
            patch.object(dataset_service.dataset_instance_index_service, "rebuild_index"),
        ):
            dataset_service.save_dataset_sidecar(
                "Project",
                "Class",
                "Output",
                source_kind=source_kind,
                method_type=method_type,
                data_format="Triangle",
                origin_length=12,
                development_length=12,
                status=0,
                values=values,
            )

        return written["payload"]

    def test_recognized_method_outputs_are_calculated_server_side(self) -> None:
        cases = (
            ("DFM", "dfm"),
            ("Result Selection", "result_selection"),
            ("Bornhuetter Ferguson", "bornhuetter_ferguson"),
            ("Cape Cod", "cape_cod"),
            ("Bootstrap", "bootstrap"),
            ("B&S Settlement Rate Adjustment", "berquist_sherman_sr"),
            ("B&S Case Reserve Adequacy Adjustment", "berquist_sherman_cra"),
            ("", "berquist_sherman_sr"),
            ("", "berquist_sherman_cra"),
        )
        for method_type, source_kind in cases:
            with self.subTest(method_type=method_type, source_kind=source_kind):
                payload = self._save_and_capture(
                    method_type=method_type,
                    source_kind=source_kind,
                )
                self.assertIs(payload["calculated"], True)

    def test_input_none_save_remains_not_calculated(self) -> None:
        payload = self._save_and_capture(
            method_type="None",
            source_kind="input",
            values=[[1.0]],
        )

        self.assertIs(payload["calculated"], False)
        self.assertEqual(payload["method_type"], "None")
        self.assertEqual(payload["source_kind"], "input")

        unknown_payload = self._save_and_capture(
            method_type="Unrecognized Method",
            source_kind="input",
            values=[[1.0]],
        )
        self.assertIs(unknown_payload["calculated"], False)


class SavedSidecarAnswersTheDetailsTabTests(unittest.TestCase):
    """A save answers with everything a load would, so nobody reads it back.

    The Details tab renders the formula and the two graph lists from whichever
    of the two answers it holds. A field only the load carried would force a
    page that just saved to fetch the sidecar again — and off the server host
    that costs one round trip per file the load opens.
    """

    DETAILS_TAB_FIELDS = ("formula", "precedents", "dependents", "audit_log", "notes")

    def setUp(self) -> None:
        self.propagation_workspace = IsolatedPropagationWorkspace().start()

    def tearDown(self) -> None:
        self.propagation_workspace.stop()

    def test_the_save_answers_with_the_formula_the_load_answers_with(self) -> None:
        stored = {}

        with (
            patch.object(dataset_service, "_get_dataset_sidecar_path", return_value="sidecar.json"),
            patch.object(
                dataset_service,
                "_read_dataset_sidecar",
                side_effect=lambda *_a, **_k: dict(stored),
            ),
            patch.object(
                dataset_service,
                "_is_app_calculated_dataset_type",
                return_value=(True, "Input A + Input B"),
            ),
            patch.object(dataset_service, "_current_user_name", return_value="tester"),
            patch.object(
                dataset_service,
                "_write_dataset_sidecar_payload",
                side_effect=lambda _path, payload: stored.update(copy.deepcopy(payload)),
            ),
            patch.object(calculated_dataset_service, "apply_sidecar_graph_fields"),
            patch.object(calculated_dataset_service, "recalculate_dependents", return_value=None),
            patch.object(
                dataset_service.dataset_sidecar_status_service,
                "refresh_method_statuses_for_dependents",
                return_value=[],
            ),
            patch.object(dataset_service.dataset_instance_index_service, "rebuild_index"),
            patch.object(dataset_service, "_dataset_type_calculation_map", return_value={}),
            patch.object(dataset_service, "_dataset_index_entry_map", return_value={}),
        ):
            saved = dataset_service.save_dataset_sidecar(
                "Project",
                "Class",
                "Output",
                source_kind="berquist_sherman_sr",
                method_type="B&S Settlement Rate Adjustment",
                data_format="Triangle",
                origin_length=12,
                development_length=12,
                status=0,
                notes="a note",
            )
            loaded = dataset_service.load_dataset_sidecar("Project", "Class", "Output")

        self.assertEqual(saved["formula"], "Input A + Input B")
        for field in self.DETAILS_TAB_FIELDS:
            self.assertIn(field, saved, field)
            self.assertEqual(saved[field], loaded[field], field)


class GeneratedFormulaWalkTargetTests(unittest.TestCase):
    """The calculated tier rebuilds only what ArcRho evaluates.

    A generated formula is the Engine's to rebuild from the source table, so
    the walk must never try to recompute one, however many links now point at
    it. Its methods still refresh when it is itself republished.
    """

    ROWS = [
        {"name": "Earned Premium", "data_format": "Triangle", "calculated": False, "formula": "", "source": "Earned_Premium", "generated": True},
        {"name": "Remaining Budget Premium", "data_format": "Triangle", "calculated": False, "formula": "", "source": "Remaining_Budget_Premium", "generated": True},
        {"name": "Total Earned Premium", "data_format": "Triangle", "calculated": True, "formula": '"Earned Premium" + "Remaining Budget Premium"', "source": "Earned_Premium + Remaining_Budget_Premium", "generated": True},
    ]

    def setUp(self) -> None:
        self.propagation_workspace = IsolatedPropagationWorkspace().start()

    def tearDown(self) -> None:
        self.propagation_workspace.stop()

    def _walk_from(self, root: str):
        with (
            patch.object(
                calculated_dataset_service,
                "_dataset_type_rows",
                return_value=[dict(row) for row in self.ROWS],
            ),
            patch.object(
                calculated_dataset_service,
                "_existing_dataset_keys",
                return_value={"earned premium", "remaining budget premium", "total earned premium"},
            ),
            patch.object(calculated_dataset_service, "_refresh_link_driven_dependents", return_value=[]),
            patch.object(calculated_dataset_service, "recalculate_dataset") as recalculate,
            patch.object(
                calculated_dataset_service.dataset_sidecar_status_service,
                "refresh_method_statuses_for_dependents",
                return_value=[],
            ),
            patch("app_server.services.dfm_service.refresh_dependents", return_value={
                "ok": True,
                "updated": [],
                "status_refreshed": [],
                "skipped": [],
                "errors": [],
            }) as refresh_dfm,
            patch("app_server.services.result_selection_service.refresh_dependents", return_value={
                "ok": True,
                "updated": [],
                "errors": [],
            }),
            patch.object(calculated_dataset_service.dataset_instance_index_service, "rebuild_index"),
        ):
            result = calculated_dataset_service.recalculate_dependents(
                "Demo",
                "Auto",
                root,
                root,
                include_berquist_sherman=False,
                include_bornhuetter_ferguson=False,
                include_cape_cod=False,
                include_bootstrap=False,
            )
        return result, recalculate, refresh_dfm

    def test_a_root_that_feeds_a_generated_formula_never_targets_it(self) -> None:
        result, recalculate, _refresh_dfm = self._walk_from("Earned Premium")

        self.assertTrue(result["ok"], result)
        recalculate.assert_not_called()
        self.assertEqual(result["updated"], [])
        self.assertEqual(result["skipped"], [])

    def test_the_generated_formula_s_own_refresh_reaches_the_method_reading_it(self) -> None:
        _result, recalculate, refresh_dfm = self._walk_from("Total Earned Premium")

        recalculate.assert_not_called()
        refresh_dfm.assert_called_once()
        self.assertEqual(
            refresh_dfm.call_args.args[2],
            ["Total Earned Premium", "Total Earned Premium"],
        )


if __name__ == "__main__":
    unittest.main()
