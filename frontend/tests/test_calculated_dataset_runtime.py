from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = FRONTEND_ROOT.parent
TEST_TEMP_ROOT = REPO_ROOT / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
if str(FRONTEND_ROOT) not in sys.path:
    sys.path.insert(0, str(FRONTEND_ROOT))

from app_server import config
from app_server.services import (
    arcrho_runtime_service,
    calculated_dataset_service,
    dataset_service,
    dataset_sidecar_status_service,
    engine_calculation_service,
)


class CalculatedDatasetRuntimeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(TEST_TEMP_ROOT))
        self.cache_dir = (
            Path(self.temp_dir.name)
            / "data"
            / "Example RC"
            / config.DATASET_CACHE_DIR
        )
        self.cache_dir.mkdir(parents=True)
        sidecar_patch = patch.object(config, "get_project_dataset_sidecar_dir", return_value=str(self.cache_dir.parent / "sidecars"))
        sidecar_patch.start()
        self.addCleanup(sidecar_patch.stop)
        self.pairs = [
            ("Function", "ArcRhoTri"),
            ("Path", "Example RC"),
            ("DatasetName", "Calculated Output"),
            ("InstanceName", "Calculated Output"),
            ("ProjectName", "Example Project"),
            ("Cumulative", "True"),
            ("Calendar", "False"),
            ("OriginLength", "12"),
            ("DevelopmentLength", "12"),
        ]

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_a_walk_reads_the_existing_dataset_names_once(self) -> None:
        """Nested walks reuse the outermost walk's snapshot instead of re-reading the index."""
        index = {"files": [{"name": "Paid", "dataset_type": "Paid"}, {"name": "Ultimate"}]}
        with patch.object(
            calculated_dataset_service.dataset_instance_index_service, "get_index", return_value=index
        ) as get_index:
            # Outside a walk every call asks the index, as before.
            calculated_dataset_service._existing_dataset_keys("Project", "Example RC")
            calculated_dataset_service._existing_dataset_keys("Project", "Example RC")
            self.assertEqual(get_index.call_count, 2)

            def fake_walk(*_args, **_kwargs):
                keys = calculated_dataset_service._existing_dataset_keys("Project", "Example RC")
                calculated_dataset_service._existing_dataset_keys("project", "example rc")
                self.assertEqual(keys, {"paid", "ultimate"})
                return {"ok": True}

            with patch.object(calculated_dataset_service, "_recalculate_dependents_impl", fake_walk):
                calculated_dataset_service.recalculate_dependents("Project", "Example RC", "Paid")
            self.assertEqual(get_index.call_count, 3)
            # The snapshot ends with the walk.
            calculated_dataset_service._existing_dataset_keys("Project", "Example RC")
            self.assertEqual(get_index.call_count, 4)

    def test_dependency_errors_include_structured_missing_names(self) -> None:
        row = {
            "name": "Calculated Output",
            "data_format": "Triangle",
            "formula": '"Generated Input" * 2',
            "calculated": True,
            "generated": False,
        }
        # The type exists in the library; only its instance file is missing.
        input_row = {
            "name": "Generated Input",
            "data_format": "Triangle",
            "formula": "",
            "calculated": False,
            "generated": True,
        }
        with (
            patch.object(calculated_dataset_service, "_dataset_type_rows", return_value=[input_row, row]),
            patch.object(calculated_dataset_service, "_existing_target_settings", return_value={}),
            patch.object(
                calculated_dataset_service,
                "_load_components",
                return_value=({}, [], ["Missing dependency: Generated Input"]),
            ),
        ):
            result = calculated_dataset_service.recalculate_dataset(
                "Example Project",
                "Example RC",
                "Calculated Output",
            )

        self.assertFalse(result["ok"])
        self.assertEqual(result["missing_dependencies"], ["Generated Input"])

    def test_failed_calculated_step_blocks_its_downstream_and_keeps_rs_in_review(self) -> None:
        rows = [
            {"name": "Source", "calculated": False, "generated": False, "formula": ""},
            {"name": "Calculated A", "calculated": True, "generated": False, "formula": "Source"},
            {"name": "Calculated B", "calculated": True, "generated": False, "formula": "Calculated A"},
        ]
        with (
            patch.object(calculated_dataset_service, "_dataset_type_rows", return_value=rows),
            patch.object(
                calculated_dataset_service,
                "_existing_downstream_keys",
                return_value=["calculated a", "calculated b"],
            ),
            patch.object(
                calculated_dataset_service,
                "recalculate_dataset",
                return_value={
                    "ok": False,
                    "dataset_type_name": "Calculated A",
                    "reason": "formula_error",
                    "errors": ["bad formula"],
                },
            ) as recalculate,
            patch.object(
                calculated_dataset_service.dataset_sidecar_status_service,
                "refresh_method_statuses_for_dependents",
                return_value=[],
            ),
            patch("app_server.services.result_selection_service.refresh_dependents", return_value={
                "ok": True,
                "updated": [],
                "errors": [],
            }) as refresh_rs,
            patch.object(calculated_dataset_service.dataset_instance_index_service, "rebuild_index"),
        ):
            result = calculated_dataset_service.recalculate_dependents(
                "Example Project",
                "Example RC",
                "Source",
                "Source",
            )

        self.assertFalse(result["ok"])
        recalculate.assert_called_once_with(
            "Example Project",
            "Example RC",
            "Calculated A",
            dataset_type_rows=rows,
        )
        self.assertEqual(result["skipped"][1]["reason"], "upstream_calculation_failed")
        refresh_rs.assert_called_once_with(
            "Example Project",
            "Example RC",
            ["Source", "Source"],
            rebuild_index=False,
            blocked_precedent_names=["Calculated A", "Calculated B"],
            finalize_method_review_status=False,
        )

    def test_calculated_exception_does_not_abort_an_independent_branch(self) -> None:
        rows = [
            {"name": "Source", "calculated": False, "generated": False, "formula": ""},
            {"name": "Broken", "calculated": True, "generated": False, "formula": "Source"},
            {"name": "Broken Child", "calculated": True, "generated": False, "formula": "Broken"},
            {"name": "Healthy", "calculated": True, "generated": False, "formula": "Source"},
        ]

        def recalculate(_project, _reserving, name, **_kwargs):
            if name == "Broken":
                raise OSError("network write failed")
            return {"ok": True, "dataset_type_name": name}

        with (
            patch.object(calculated_dataset_service, "_dataset_type_rows", return_value=rows),
            patch.object(
                calculated_dataset_service,
                "_existing_downstream_keys",
                return_value=["broken", "broken child", "healthy"],
            ),
            patch.object(calculated_dataset_service, "recalculate_dataset", side_effect=recalculate),
            patch.object(
                calculated_dataset_service.dataset_sidecar_status_service,
                "refresh_method_statuses_for_dependents",
                return_value=[],
            ),
            patch("app_server.services.result_selection_service.refresh_dependents", return_value={
                "ok": True,
                "updated": [],
                "errors": [],
            }) as refresh_rs,
            patch.object(calculated_dataset_service.dataset_instance_index_service, "rebuild_index"),
        ):
            result = calculated_dataset_service.recalculate_dependents(
                "Example Project", "Example RC", "Source", "Source",
            )

        self.assertFalse(result["ok"])
        self.assertEqual(result["updated"], [{
            "ok": True,
            "dataset_type_name": "Healthy",
            "status": "updated",
        }])
        self.assertEqual(result["skipped"][0]["reason"], "calculation_error")
        self.assertEqual(result["skipped"][1]["reason"], "upstream_calculation_failed")
        refresh_rs.assert_called_once_with(
            "Example Project",
            "Example RC",
            ["Source", "Source", "Healthy"],
            rebuild_index=False,
            blocked_precedent_names=["Broken", "Broken Child"],
            finalize_method_review_status=False,
        )

    def test_recalculation_preserves_registered_result_selection_dependent(self) -> None:
        row = {
            "name": "Calculated Output",
            "data_format": "Vector",
            "formula": "Source",
            "calculated": True,
            "generated": False,
        }
        source_row = {
            "name": "Source",
            "data_format": "Vector",
            "formula": "",
            "calculated": False,
            "generated": False,
        }
        csv_path = self.cache_dir / "Calculated Output@12.csv"
        sidecar_path = self.cache_dir.parent / config.DATASET_SIDECAR_DIR / "Calculated Output.json"
        sidecar_path.parent.mkdir(parents=True)
        sidecar_path.write_text(json.dumps({
            "dataset_name": "Calculated Output",
            "dataset_type": "Calculated Output",
            "project_name": "Example Project",
            "reserving_class": "Example RC",
            "dependents": [{"dataset_name": "Selection"}],
        }), encoding="utf-8")

        with (
            patch.object(calculated_dataset_service, "_calculated_rows_by_key", return_value={"calculated output": row}),
            patch.object(calculated_dataset_service, "_dataset_type_rows", return_value=[source_row, row]),
            patch.object(calculated_dataset_service.config, "get_project_dataset_cache_dir", return_value=str(self.cache_dir)),
            patch.object(calculated_dataset_service, "_existing_target_settings", return_value={}),
            patch.object(
                calculated_dataset_service,
                "_calculated_cache_settings",
                return_value=[{"origin_length": 12, "development_length": 12}],
            ),
            patch.object(
                calculated_dataset_service,
                "_load_components",
                return_value=({"_d0": [[1.0], [2.0]]}, ["Source"], []),
            ),
            patch.object(
                calculated_dataset_service,
                "_target_paths",
                return_value=(str(csv_path), str(sidecar_path)),
            ),
            patch.object(
                calculated_dataset_service,
                "sidecar_graph_fields",
                return_value={
                    "precedents": [{"dataset_name": "Source"}],
                    "dependents": [{"dataset_name": "Formula Output"}],
                },
            ),
            patch.object(
                calculated_dataset_service.dataset_sidecar_status_service,
                "read_sidecar",
                return_value={"method_type": "Result Selection", "source_kind": "result_selection"},
            ),
            patch.object(
                calculated_dataset_service.dataset_sidecar_status_service,
                "sidecar_path",
                return_value=str(sidecar_path),
            ),
            patch.object(
                calculated_dataset_service.dataset_sidecar_status_service,
                "refresh_method_statuses_for_dependents",
                return_value=[],
            ),
            patch.dict(config.DATASETS, {}, clear=True),
        ):
            result = calculated_dataset_service.recalculate_dataset(
                "Example Project",
                "Example RC",
                "Calculated Output",
            )

        self.assertTrue(result["ok"], result)
        saved = json.loads(sidecar_path.read_text(encoding="utf-8"))
        self.assertEqual(saved["dependents"], [
            {"dataset_name": "Formula Output"},
            {"dataset_name": "Selection"},
        ])

    def test_vector_recalculation_refreshes_each_existing_cache_period(self) -> None:
        row = {
            "name": "Calculated Output",
            "data_format": "Vector",
            "formula": "Source",
            "calculated": True,
            "generated": False,
        }
        source_row = {
            "name": "Source",
            "data_format": "Vector",
            "formula": "",
            "calculated": False,
            "generated": False,
        }
        sidecar_dir = self.cache_dir.parent / config.DATASET_SIDECAR_DIR
        sidecar_dir.mkdir(parents=True)
        sidecar_path = sidecar_dir / "Calculated Output.json"
        sidecar_path.write_text(json.dumps({
            "dataset_name": "Calculated Output",
            "dataset_type": "Calculated Output",
            "project_name": "Example Project",
            "reserving_class": "Example RC",
            "data_format": "Vector",
            "origin_length": 12,
            "development_length": 12,
            "stored_period_length": 12,
            "csv_file": "Calculated Output@12.csv",
            "dependents": [],
        }), encoding="utf-8")
        for period in (3, 12):
            (self.cache_dir / f"Calculated Output@{period}.csv").write_text(
                "0\n", encoding="utf-8"
            )

        def load_components(_project, _reserving, _components, settings, **_kwargs):
            period = int(settings["origin_length"])
            self.assertEqual(period, 3)
            return {"_d0": np.array([[1.0], [2.0], [3.0], [4.0]])}, [], []

        with (
            patch.object(calculated_dataset_service.config, "get_project_dataset_cache_dir", return_value=str(self.cache_dir)),
            patch.object(calculated_dataset_service.config, "get_project_dataset_sidecar_dir", return_value=str(sidecar_dir)),
            patch.object(calculated_dataset_service, "_dataset_type_rows", return_value=[source_row, row]),
            patch.object(calculated_dataset_service, "_load_components", side_effect=load_components),
            patch.object(calculated_dataset_service, "apply_sidecar_graph_fields", side_effect=lambda payload, *_args: payload.update({"precedents": [], "dependents": []})),
            patch.object(calculated_dataset_service.dataset_number_format_service, "dataset_type_number_format_settings", return_value={"number_format": "0", "decimal_places": 0}),
            patch.object(calculated_dataset_service.dataset_sidecar_status_service, "refresh_method_statuses_for_dependents", return_value=[]),
            patch.object(dataset_service, "valuation_months", return_value=12),
            patch.dict(config.DATASETS, {}, clear=True),
        ):
            result = calculated_dataset_service.recalculate_dataset(
                "Example Project",
                "Example RC",
                "Calculated Output",
            )

        self.assertTrue(result["ok"], result)
        self.assertEqual(
            [Path(path).name for path in result["cache_paths"]],
            ["Calculated Output@3.csv", "Calculated Output@12.csv"],
        )
        self.assertEqual((self.cache_dir / "Calculated Output@3.csv").read_text(encoding="utf-8").strip(), "1.0\n2.0\n3.0\n4.0")
        self.assertEqual((self.cache_dir / "Calculated Output@12.csv").read_text(encoding="utf-8").strip(), "10.0")
        saved = json.loads(sidecar_path.read_text(encoding="utf-8"))
        self.assertEqual(saved["csv_file"], "Calculated Output@3.csv")
        self.assertEqual(saved["stored_period_length"], 3)

    def test_missing_app_calculated_cache_is_rebuilt_before_engine_request(self) -> None:
        calculated_path = str(
            self.cache_dir / "Calculated Output@12@12@cum@dev.csv"
        )
        with (
            patch.object(
                arcrho_runtime_service,
                "resolve_local_triangle_cache",
                return_value={"ok": False, "status": "cache_missing"},
            ),
            patch.object(
                calculated_dataset_service,
                "calculated_dataset_contract",
                return_value={
                    "name": "Calculated Output",
                    "formula": '"Input" * 2',
                    "precedents": [],
                    "precedent_contracts": {},
                },
            ),
            patch.object(
                calculated_dataset_service,
                "recalculate_dataset",
                return_value={"ok": True, "path": calculated_path},
            ) as recalculate,
            patch.object(
                arcrho_runtime_service,
                "_recalculate_dependents_after_cache_write",
                return_value={"ok": True, "steps": []},
            ),
            patch.object(
                arcrho_runtime_service,
                "_register_arcrho_dataset",
                return_value="arcrhotri_calculated",
            ),
            patch.object(
                arcrho_runtime_service.dataset_instance_index_service,
                "rebuild_index",
            ),
            patch.object(
                engine_calculation_service,
                "send_request_like_vba",
                side_effect=AssertionError("app-calculated datasets must not be sent to the data engine"),
            ),
        ):
            result = arcrho_runtime_service.run_arcrho_tri(
                self.pairs,
                calculated_path,
                timeout_sec=1.0,
                write_sidecar=False,
            )

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["local_cache_status"], "calculated")
        self.assertEqual(result["ds_id"], "arcrhotri_calculated")
        self.assertTrue(result["sidecar_written"])
        recalculate.assert_called_once_with(
            "Example Project",
            "Example RC",
            "Calculated Output",
            component_paths={},
        )

    def test_new_engine_cache_skips_dependents_without_sidecar_write(self) -> None:
        generated_path = str(
            self.cache_dir / "Generated Input@12@12@cum@dev.csv"
        )
        with (
            patch.object(
                arcrho_runtime_service,
                "resolve_local_triangle_cache",
                return_value={
                    "ok": False,
                    "status": "cache_missing",
                    "manual_source_found": False,
                    "generated_source_found": True,
                },
            ),
            patch.object(arcrho_runtime_service, "_recalculate_requested_app_dataset", return_value=None),
            patch.object(arcrho_runtime_service, "arcrho_tri_cache_matches", return_value=False),
            patch.object(arcrho_runtime_service.os, "makedirs"),
            patch.object(engine_calculation_service, "send_request_like_vba", return_value="request.txt"),
            patch.object(engine_calculation_service, "wait_for_file", return_value=True),
            patch.object(
                arcrho_runtime_service,
                "_require_runtime_cache_provenance",
                return_value=True,
            ),
            patch.object(arcrho_runtime_service, "_refresh_dataset_instance_index_after_cache_write"),
            patch.object(arcrho_runtime_service, "_register_arcrho_dataset", return_value="arcrhotri_generated"),
            patch.object(
                arcrho_runtime_service,
                "_recalculate_dependents_after_cache_write",
            ) as recalculate_dependents,
        ):
            result = arcrho_runtime_service.run_arcrho_tri(
                self.pairs,
                generated_path,
                timeout_sec=1.0,
                write_sidecar=False,
            )

        self.assertTrue(result["ok"], result)
        self.assertTrue(result["need_request"])
        self.assertFalse(result["sidecar_written"])
        self.assertIsNone(result["calculated_updates"])
        self.assertTrue(result["cache_provenance_recorded"])
        recalculate_dependents.assert_not_called()

    def test_generated_dependency_is_materialized_before_calculation(self) -> None:
        calculated_path = str(
            self.cache_dir / "Calculated Output@12@12@cum@dev.csv"
        )
        with (
            patch.object(
                arcrho_runtime_service,
                "resolve_local_triangle_cache",
                return_value={"ok": False, "status": "cache_missing"},
            ),
            patch.object(
                calculated_dataset_service,
                "calculated_dataset_contract",
                return_value={
                    "name": "Calculated Output",
                    "formula": '"Generated Input" * 2',
                    "precedents": ["Generated Input"],
                    "precedent_contracts": {
                        "generated input": {
                            "name": "Generated Input",
                            "data_format": "Triangle",
                            "generated": True,
                        },
                    },
                },
            ),
            patch.object(
                calculated_dataset_service,
                "recalculate_dataset",
                return_value={"ok": True, "path": calculated_path},
            ) as recalculate,
            patch.object(
                arcrho_runtime_service,
                "_materialize_calculated_dependencies",
                return_value=[{"ok": True, "dataset_type_name": "Generated Input"}],
            ) as materialize,
            patch.object(
                arcrho_runtime_service,
                "_recalculate_dependents_after_cache_write",
                return_value={"ok": True, "steps": []},
            ),
            patch.object(
                arcrho_runtime_service,
                "_register_arcrho_dataset",
                return_value="arcrhotri_calculated",
            ),
            patch.object(
                arcrho_runtime_service.dataset_instance_index_service,
                "rebuild_index",
            ),
        ):
            result = arcrho_runtime_service.run_arcrho_tri(
                self.pairs,
                calculated_path,
                timeout_sec=1.0,
                write_sidecar=False,
            )

        self.assertTrue(result["ok"], result)
        self.assertEqual(recalculate.call_count, 1)
        materialize.assert_called_once()

    def test_late_link_refresh_continues_into_methods_in_the_same_walk(self) -> None:
        def refresh_links(_project, _reserving, roots, visited, report):
            if "Method" in roots and "linked" not in visited:
                visited.add("linked")
                report["refreshed"].append("Linked")
                return ["Linked"]
            return []

        def refresh_dfm(_project, _reserving, roots, **_options):
            return {
                "ok": True,
                "updated": [{"dataset_name": "Method" if "Root" in roots else "Tail", "output_changed": False}],
                "errors": [],
            }

        with (
            patch.object(calculated_dataset_service, "_dataset_type_rows", return_value=[]),
            patch.object(calculated_dataset_service, "_existing_downstream_keys", return_value=[]),
            patch.object(calculated_dataset_service, "_refresh_link_driven_dependents", side_effect=refresh_links),
            patch.object(dataset_sidecar_status_service, "refresh_method_statuses_for_dependents", return_value=[]),
            patch("app_server.services.dfm_service.refresh_dependents", side_effect=refresh_dfm) as methods,
            patch.object(calculated_dataset_service.dataset_instance_index_service, "rebuild_index"),
        ):
            result = calculated_dataset_service.recalculate_dependents(
                "Example Project", "Example RC", "Root",
                include_result_selection=False,
                include_berquist_sherman=False,
                include_bornhuetter_ferguson=False,
                include_cape_cod=False,
                include_bootstrap=False,
            )

        self.assertTrue(result["ok"], result)
        self.assertEqual(methods.call_count, 2)
        self.assertIn("Linked", methods.call_args_list[1].args[2])
        self.assertEqual([entry["dataset_name"] for entry in result["dfm_updates"]["updated"]], ["Method", "Tail"])
        self.assertEqual(result["link_updates"]["refreshed"], ["Linked"])
        self.assertIsNone(calculated_dataset_service._link_refresh_visited.get())

    def test_dfm_outputs_that_held_are_handed_to_result_selection_for_refresh(self) -> None:
        rows = [{"name": "Source", "calculated": False, "generated": False, "formula": ""}]
        dfm_wave = {
            "ok": True,
            "updated": [
                {"dataset_name": "C 12 - CWP DFM", "dataset_type": "C 12 - CWP DFM", "output_changed": False},
                {"dataset_name": "C 32 - Reported DFM", "dataset_type": "C 32 - Reported DFM", "output_changed": True},
            ],
            "status_refreshed": [{"dataset_name": "C 42 - Reported ex CWOP DFM"}],
            "skipped": [{"dataset_name": "F 13 - Paid DFM", "reason": "not_updated"}],
            "errors": [],
        }
        with (
            patch.object(calculated_dataset_service, "_dataset_type_rows", return_value=rows),
            patch.object(calculated_dataset_service, "_existing_downstream_keys", return_value=[]),
            patch.object(calculated_dataset_service, "_refresh_link_driven_dependents", return_value=[]),
            patch.object(
                calculated_dataset_service.dataset_sidecar_status_service,
                "refresh_method_statuses_for_dependents",
                return_value=[],
            ),
            patch("app_server.services.dfm_service.refresh_dependents", return_value=dfm_wave),
            patch("app_server.services.result_selection_service.refresh_dependents", return_value={
                "ok": True,
                "updated": [],
                "errors": [],
            }) as refresh_rs,
            patch.object(calculated_dataset_service.dataset_instance_index_service, "rebuild_index"),
        ):
            result = calculated_dataset_service.recalculate_dependents(
                "Example Project",
                "Example RC",
                "Source",
                "Source",
                include_berquist_sherman=False,
                include_bornhuetter_ferguson=False,
                include_cape_cod=False,
                include_bootstrap=False,
            )

        self.assertTrue(result["ok"], result)
        refresh_rs.assert_called_once_with(
            "Example Project",
            "Example RC",
            ["Source", "Source", "C 12 - CWP DFM", "C 12 - CWP DFM", "C 32 - Reported DFM", "C 32 - Reported DFM"],
            rebuild_index=False,
            blocked_precedent_names=[],
            finalize_method_review_status=False,
        )


class GeneratedFormulaSidecarGraphTests(unittest.TestCase):
    """A dataset the Engine builds from a formula gets the same links as any other.

    The fake project's example: two source columns feed one formula the Engine
    evaluates, and an app-calculated ratio reads that formula's output.
    """

    ROWS = [
        {"name": "Earned Premium", "data_format": "Triangle", "calculated": False, "formula": "", "source": "Earned_Premium", "generated": True},
        {"name": "Remaining Budget Premium", "data_format": "Triangle", "calculated": False, "formula": "", "source": "Remaining_Budget_Premium", "generated": True},
        {"name": "Total Earned Premium", "data_format": "Triangle", "calculated": True, "formula": '"Earned Premium" + "Remaining Budget Premium"', "source": "Earned_Premium + Remaining_Budget_Premium", "generated": True},
        {"name": "Written Premium", "data_format": "Triangle", "calculated": False, "formula": "", "source": "Written_Premium", "generated": True},
        {"name": "Premium Ratio", "data_format": "Triangle", "calculated": True, "formula": '"Total Earned Premium" / "Written Premium"', "source": "", "generated": False},
    ]
    # Every type but Written Premium has an instance in the class.
    EXISTING = {"earned premium", "remaining budget premium", "total earned premium", "premium ratio"}

    def setUp(self) -> None:
        rows_patcher = patch.object(
            calculated_dataset_service,
            "_dataset_type_rows",
            return_value=[dict(row) for row in self.ROWS],
        )
        rows_patcher.start()
        self.addCleanup(rows_patcher.stop)
        keys_patcher = patch.object(
            calculated_dataset_service,
            "_existing_dataset_keys",
            return_value=set(self.EXISTING),
        )
        keys_patcher.start()
        self.addCleanup(keys_patcher.stop)

    @staticmethod
    def _graph(dataset_type_name: str):
        fields = calculated_dataset_service.sidecar_graph_fields(
            "Demo",
            dataset_type_name,
            reserving_class="Auto",
        )
        return (
            dataset_sidecar_status_service.entry_names(fields["precedents"]),
            dataset_sidecar_status_service.entry_names(fields["dependents"]),
        )

    def test_the_formula_lists_its_inputs_and_each_input_lists_the_formula(self) -> None:
        self.assertEqual(
            self._graph("Total Earned Premium"),
            (["Earned Premium", "Remaining Budget Premium"], ["Premium Ratio"]),
        )
        self.assertEqual(self._graph("Earned Premium"), ([], ["Total Earned Premium"]))
        self.assertEqual(self._graph("Remaining Budget Premium"), ([], ["Total Earned Premium"]))

    def test_a_generated_input_without_an_instance_is_left_out_and_an_app_calculated_one_is_kept(self) -> None:
        with patch.object(
            calculated_dataset_service,
            "_existing_dataset_keys",
            return_value={"earned premium", "total earned premium", "premium ratio"},
        ):
            self.assertEqual(
                self._graph("Total Earned Premium"),
                (["Earned Premium"], ["Premium Ratio"]),
            )
            # Written Premium has no instance either, but an app-calculated
            # formula that cannot find its input has a real problem and says so.
            self.assertEqual(
                self._graph("Premium Ratio")[0],
                ["Total Earned Premium", "Written Premium"],
            )

    def test_a_method_dependent_survives_the_link_rewrite(self) -> None:
        payload = {
            "dataset_name": "Total Earned Premium",
            "dataset_type": "Total Earned Premium",
            "project_name": "Demo",
            "reserving_class": "Auto",
            "source_kind": "engine",
            "method_type": "None",
            "precedents": [],
            "dependents": [{"dataset_name": "D 13 - Paid DFM w/ Selected LDFs"}],
        }
        with (
            patch.object(
                calculated_dataset_service.dataset_sidecar_status_service,
                "sidecar_path",
                return_value="dfm.json",
            ),
            patch.object(
                calculated_dataset_service.dataset_sidecar_status_service,
                "read_sidecar",
                return_value={"method_type": "DFM", "source_kind": "dfm"},
            ),
        ):
            calculated_dataset_service.apply_sidecar_graph_fields(payload)

        self.assertEqual(
            dataset_sidecar_status_service.entry_names(payload["precedents"]),
            ["Earned Premium", "Remaining Budget Premium"],
        )
        self.assertEqual(
            dataset_sidecar_status_service.entry_names(payload["dependents"]),
            ["Premium Ratio", "D 13 - Paid DFM w/ Selected LDFs"],
        )

    def test_details_shows_the_formula_s_inputs_and_the_input_s_reader(self) -> None:
        sidecars = {
            "Total Earned Premium": {
                "dataset_name": "Total Earned Premium",
                "dataset_type": "Total Earned Premium",
                "source_kind": "engine",
                "precedents": [{"dataset_name": "Earned Premium"}, {"dataset_name": "Remaining Budget Premium"}],
                "dependents": [],
            },
            "Earned Premium": {
                "dataset_name": "Earned Premium",
                "dataset_type": "Earned Premium",
                "source_kind": "engine",
                "precedents": [],
                "dependents": [{"dataset_name": "Total Earned Premium"}],
            },
        }
        index_map = {
            name.lower(): {"dataset_name": name, "dataset_type": name, "method_type": "None"}
            for name in ("Earned Premium", "Remaining Budget Premium", "Total Earned Premium")
        }

        def read(path: str):
            return dict(sidecars[Path(path).stem])

        with (
            patch.object(dataset_service, "_get_dataset_sidecar_path", side_effect=lambda _p, _rc, ds: f"{ds}.json"),
            patch.object(dataset_service, "_read_dataset_sidecar", side_effect=read),
            patch.object(dataset_service, "_dataset_index_entry_map", return_value=index_map),
        ):
            formula_output = dataset_service.load_dataset_sidecar("Demo", "Auto", "Total Earned Premium")
            source_column = dataset_service.load_dataset_sidecar("Demo", "Auto", "Earned Premium")

        self.assertEqual(
            [item["dataset_name"] for item in formula_output["precedents"]],
            ["Earned Premium", "Remaining Budget Premium"],
        )
        self.assertEqual(
            [item["dataset_name"] for item in source_column["dependents"]],
            ["Total Earned Premium"],
        )
        # The reader chip carries the Engine's formula, the way a calculated
        # dependent's chip always has.
        self.assertEqual(
            source_column["dependents"][0]["formula"],
            '"Earned Premium" + "Remaining Budget Premium"',
        )


if __name__ == "__main__":
    unittest.main()
