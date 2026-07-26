from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
if str(FRONTEND_ROOT) not in sys.path:
    sys.path.insert(0, str(FRONTEND_ROOT))

from app_server.services import (
    arcrho_runtime_service,
    calculated_dataset_service,
)


class CalculatedDfmDependencyIdentityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT))
        self.root = Path(self.temp_dir.name)
        self.dataset_folder = self.root / "datasets"
        self.method_folder = self.root / "methods"
        self.dataset_folder.mkdir()
        self.method_folder.mkdir()
        self.input_path = (
            self.dataset_folder
            / "Paid Loss@12@12@cum@dev.csv"
        )
        self.input_path.write_text("100\n", encoding="utf-8")
        self.method_path = self.method_folder / "DFM@Selected.json"
        self.method_payload = {
            "details tab": {
                "name": "Selected DFM",
                "output type": "Ultimate Loss",
                "input triangle": "Paid Loss",
            },
            "data tab": {
                "input data triangle csv path": str(self.input_path),
                "development labels": ["12"],
                "origin labels": ["2025"],
            },
            "ratios tab": {
                "average formulas": {
                    "selected": [[1]],
                    "values": [[1]],
                }
            },
        }
        self.method_path.write_text(
            json.dumps(self.method_payload),
            encoding="utf-8",
        )
        (self.method_folder / "DFM@Other.json").write_text(
            json.dumps(
                {
                    **self.method_payload,
                    "details tab": {
                        **self.method_payload["details tab"],
                        "name": "Other DFM",
                    },
                }
            ),
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def _path_patches(self):
        return (
            patch.object(
                calculated_dataset_service.config,
                "get_project_dataset_cache_dir",
                return_value=str(self.dataset_folder),
            ),
            patch.object(
                calculated_dataset_service.config,
                "get_project_method_data_dir",
                return_value=str(self.method_folder),
            ),
        )

    def test_exact_dfm_source_avoids_ambiguous_method_rescan(self) -> None:
        dataset_patch, method_patch = self._path_patches()
        with dataset_patch, method_patch:
            values, precedents, errors = (
                calculated_dataset_service._load_components(
                    "Example Project",
                    "Example RC",
                    ["Ultimate Loss"],
                    {
                        "origin_length": 12,
                        "development_length": 12,
                        "cumulative": True,
                        "calendar": False,
                    },
                    component_method_sources={
                        "ultimate loss": {
                            "path": str(self.method_path),
                            "input_path": str(self.input_path),
                        }
                    },
                )
            )

        self.assertEqual(errors, [])
        self.assertEqual(values["_d0"].tolist(), [[100.0]])
        self.assertEqual(len(precedents), 1)
        self.assertEqual(precedents[0]["source_kind"], "dfm_method")
        self.assertEqual(precedents[0]["path"], str(self.method_path))
        self.assertEqual(precedents[0]["input_path"], str(self.input_path))

    def test_out_of_root_method_source_is_not_read(self) -> None:
        outside_method = self.root / "DFM@Outside.json"
        outside_method.write_text(
            json.dumps(self.method_payload),
            encoding="utf-8",
        )

        dataset_patch, method_patch = self._path_patches()
        with dataset_patch, method_patch:
            values, precedents, errors = (
                calculated_dataset_service._load_components(
                    "Example Project",
                    "Example RC",
                    ["Ultimate Loss"],
                    {
                        "origin_length": 12,
                        "development_length": 12,
                        "cumulative": True,
                        "calendar": False,
                    },
                    component_method_sources={
                        "ultimate loss": {
                            "path": str(outside_method),
                            "input_path": str(self.input_path),
                        },
                    },
                )
            )

        self.assertEqual(values, {})
        self.assertEqual(precedents, [])
        self.assertEqual(
            errors,
            ["Ambiguous DFM dependency: Ultimate Loss"],
        )

    def test_out_of_root_input_override_uses_canonical_method_input(self) -> None:
        outside_input = self.root / "outside.csv"
        outside_input.write_text("999\n", encoding="utf-8")

        dataset_patch, method_patch = self._path_patches()
        with dataset_patch, method_patch:
            values, precedents, errors = (
                calculated_dataset_service._load_components(
                    "Example Project",
                    "Example RC",
                    ["Ultimate Loss"],
                    {
                        "origin_length": 12,
                        "development_length": 12,
                        "cumulative": True,
                        "calendar": False,
                    },
                    component_method_sources={
                        "ultimate loss": {
                            "path": str(self.method_path),
                            "input_path": str(outside_input),
                        },
                    },
                )
            )

        self.assertEqual(errors, [])
        self.assertEqual(values["_d0"].tolist(), [[100.0]])
        self.assertEqual(precedents[0]["input_path"], str(self.input_path))

    def test_relocated_dfm_paths_resolve_by_canonical_file_name(self) -> None:
        old_root = self.root / "old-drive" / "Example RC"
        old_method_path = old_root / "methods" / self.method_path.name
        old_input_path = old_root / "datasets" / self.input_path.name
        relocated_payload = {
            **self.method_payload,
            "data tab": {
                **self.method_payload["data tab"],
                "input data triangle csv path": str(old_input_path),
            },
        }
        self.method_path.write_text(
            json.dumps(relocated_payload),
            encoding="utf-8",
        )

        dataset_patch, method_patch = self._path_patches()
        with dataset_patch, method_patch:
            values, precedents, errors = (
                calculated_dataset_service._load_components(
                    "Example Project",
                    "Example RC",
                    ["Ultimate Loss"],
                    {
                        "origin_length": 12,
                        "development_length": 12,
                        "cumulative": True,
                        "calendar": False,
                    },
                    component_method_sources={
                        "ultimate loss": {
                            "path": str(old_method_path),
                            "input_path": str(old_input_path),
                        },
                    },
                )
            )

        self.assertEqual(errors, [])
        self.assertEqual(values["_d0"].tolist(), [[100.0]])
        self.assertEqual(precedents[0]["path"], str(self.method_path))
        self.assertEqual(precedents[0]["input_path"], str(self.input_path))

    def test_changed_dfm_method_uses_its_current_input_path(self) -> None:
        current_input_path = (
            self.dataset_folder
            / "Reported Loss@12@12@cum@dev.csv"
        )
        current_input_path.write_text("250\n", encoding="utf-8")
        current_payload = {
            **self.method_payload,
            "details tab": {
                **self.method_payload["details tab"],
                "input triangle": "Reported Loss",
            },
            "data tab": {
                **self.method_payload["data tab"],
                "input data triangle csv path": str(current_input_path),
            },
        }
        self.method_path.write_text(
            json.dumps(current_payload),
            encoding="utf-8",
        )

        dataset_patch, method_patch = self._path_patches()
        with dataset_patch, method_patch:
            values, precedents, errors = (
                calculated_dataset_service._load_components(
                    "Example Project",
                    "Example RC",
                    ["Ultimate Loss"],
                    {
                        "origin_length": 12,
                        "development_length": 12,
                        "cumulative": True,
                        "calendar": False,
                    },
                    component_method_sources={
                        "ultimate loss": {
                            "path": str(self.method_path),
                            "input_path": str(self.input_path),
                        }
                    },
                )
            )

        self.assertEqual(errors, [])
        self.assertEqual(values["_d0"].tolist(), [[250.0]])
        self.assertEqual(
            precedents[0]["input_path"],
            str(current_input_path),
        )

    def test_runtime_forwards_recorded_dfm_source_to_recalculation(self) -> None:
        requested_path = (
            self.dataset_folder
            / "Calculated Loss@12@12@cum@dev.csv"
        )
        pairs = [
            ("Function", "ArcRhoTri"),
            ("Path", "Example RC"),
            ("DatasetName", "Calculated Loss"),
            ("InstanceName", "Calculated Loss"),
            ("ProjectName", "Example Project"),
            ("OriginLength", "12"),
            ("DevelopmentLength", "12"),
            ("Cumulative", "True"),
            ("Calendar", "False"),
        ]
        requested_sidecar = {
            "Precedents": [
                {
                    "dataset_type_name": "Ultimate Loss",
                    "source_kind": "dfm_method",
                    "path": str(self.method_path),
                    "input_path": str(self.input_path),
                }
            ],
        }
        contract = {
            "name": "Calculated Loss",
            "formula": '"Ultimate Loss"',
            "precedents": ["Ultimate Loss"],
            "precedent_contracts": {
                "ultimate loss": {
                    "name": "Ultimate Loss",
                    "data_format": "Vector",
                    "generated": False,
                    "calculated": False,
                    "formula": "",
                }
            },
        }
        recalculated = {
            "ok": True,
            "path": str(requested_path),
        }

        with (
            patch.object(
                calculated_dataset_service,
                "calculated_dataset_contract",
                return_value=contract,
            ),
            patch.object(
                arcrho_runtime_service,
                "_read_existing_cache_json",
                return_value=requested_sidecar,
            ),
            patch.object(
                arcrho_runtime_service,
                "_materialize_calculated_dependencies",
                return_value=[],
            ),
            patch.object(
                calculated_dataset_service,
                "recalculate_dataset",
                return_value=recalculated,
            ) as recalculate_dataset,
        ):
            result = (
                arcrho_runtime_service._recalculate_requested_app_dataset(
                    pairs,
                    str(requested_path),
                    timeout_sec=0.1,
                    local_only=False,
                    allow_derived=True,
                    recalculate_dependents=False,
                    refresh_index=False,
                )
            )

        self.assertTrue(result["ok"], result)
        recalculate_dataset.assert_called_once_with(
            "Example Project",
            "Example RC",
            "Calculated Loss",
            component_paths={},
            component_method_sources={
                "ultimate loss": {
                    "path": str(self.method_path),
                    "input_path": str(self.input_path),
                }
            },
        )

    def test_current_generated_ownership_replaces_recorded_dfm_source(self) -> None:
        requested_path = (
            self.dataset_folder
            / "Calculated Loss@12@12@cum@dev.csv"
        )
        generated_path = (
            self.dataset_folder
            / "Ultimate Loss@12.csv"
        )
        pairs = [
            ("Function", "ArcRhoTri"),
            ("Path", "Example RC"),
            ("DatasetName", "Calculated Loss"),
            ("InstanceName", "Calculated Loss"),
            ("ProjectName", "Example Project"),
            ("OriginLength", "12"),
            ("DevelopmentLength", "12"),
            ("Cumulative", "True"),
            ("Calendar", "False"),
        ]
        contract = {
            "name": "Calculated Loss",
            "formula": '"Ultimate Loss"',
            "precedents": ["Ultimate Loss"],
            "precedent_contracts": {
                "ultimate loss": {
                    "name": "Ultimate Loss",
                    "data_format": "Vector",
                    "generated": True,
                    "calculated": False,
                    "formula": "",
                }
            },
        }
        requested_sidecar = {
            "Precedents": [
                {
                    "dataset_type_name": "Ultimate Loss",
                    "source_kind": "dfm_method",
                    "path": str(self.method_path),
                    "input_path": str(self.input_path),
                }
            ],
        }

        with (
            patch.object(
                calculated_dataset_service,
                "calculated_dataset_contract",
                return_value=contract,
            ),
            patch.object(
                arcrho_runtime_service,
                "_read_existing_cache_json",
                return_value=requested_sidecar,
            ),
            patch.object(
                arcrho_runtime_service,
                "_materialize_calculated_dependencies",
                return_value=[
                    {
                        "ok": True,
                        "dataset_type_name": "Ultimate Loss",
                        "data_path": str(generated_path),
                    }
                ],
            ),
            patch.object(
                calculated_dataset_service,
                "recalculate_dataset",
                return_value={
                    "ok": True,
                    "path": str(requested_path),
                },
            ) as recalculate_dataset,
        ):
            result = (
                arcrho_runtime_service._recalculate_requested_app_dataset(
                    pairs,
                    str(requested_path),
                    timeout_sec=0.1,
                    local_only=False,
                    allow_derived=True,
                    recalculate_dependents=False,
                    refresh_index=False,
                )
            )

        self.assertTrue(result["ok"], result)
        recalculate_dataset.assert_called_once_with(
            "Example Project",
            "Example RC",
            "Calculated Loss",
            component_paths={
                "ultimate loss": str(generated_path),
            },
        )


if __name__ == "__main__":
    unittest.main()
