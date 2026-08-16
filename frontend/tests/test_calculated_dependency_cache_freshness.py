from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import call, patch

from fastapi import HTTPException


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
if str(FRONTEND_ROOT) not in sys.path:
    sys.path.insert(0, str(FRONTEND_ROOT))

from app_server import config
from app_server.services import (
    arcrho_runtime_service,
    calculated_dataset_service,
    engine_calculation_service,
    runtime_cache_provenance_service,
)


class CalculatedDependencyCacheFreshnessTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT))
        self.root = Path(self.temp_dir.name)
        self.data_path = (
            self.root
            / "data"
            / "Example RC"
            / config.DATASET_CACHE_DIR
            / "Calculated Loss@12@12@cum@dev.csv"
        )
        self.dependency_path = self.data_path.with_name("Paid Loss@12@12@cum@dev.csv")
        self.data_path.parent.mkdir(parents=True)
        self.data_path.write_text("2\n", encoding="utf-8")
        self.dependency_path.write_text("1\n", encoding="utf-8")
        dependency_stat = self.dependency_path.stat()
        self.pairs = [
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
        self.sidecar_path = Path(
            arcrho_runtime_service._dataset_sidecar_path(
                str(self.data_path),
                self.pairs,
            )
        )
        self.sidecar_path.parent.mkdir(parents=True)
        self.sidecar_payload = {
            "dataset_name": "Calculated Loss",
            "dataset_type": "Calculated Loss",
            "reserving_class": "Example RC",
            "project_name": "Example Project",
            "source_kind": "calculated",
            "data_format": "Triangle",
            "formula": '"Paid Loss" * 2',
            "Precedents": [
                {
                    "dataset_type_name": "Paid Loss",
                    "path": str(self.dependency_path),
                    "mtime_ns": dependency_stat.st_mtime_ns,
                    "size": dependency_stat.st_size,
                    "sha256": hashlib.sha256(self.dependency_path.read_bytes()).hexdigest(),
                }
            ],
        }
        self.sidecar_path.write_text(
            json.dumps(self.sidecar_payload),
            encoding="utf-8",
        )
        contracts = {
            "calculated loss": {
                "name": "Calculated Loss",
                "data_format": "Triangle",
                "formula": '"Paid Loss" * 2',
                "precedents": ["Paid Loss"],
            },
            "paid loss": {
                "name": "Paid Loss",
                "data_format": "Triangle",
                "formula": '"Raw Loss" * 2',
                "precedents": ["Raw Loss"],
            },
        }
        self.contract_patcher = patch.object(
            calculated_dataset_service,
            "calculated_dataset_contract",
            side_effect=lambda _project, name: contracts.get(str(name).strip().lower()),
        )
        self.contract_patcher.start()

    def tearDown(self) -> None:
        self.contract_patcher.stop()
        self.temp_dir.cleanup()

    def test_changed_dependency_rejects_the_calculated_cache(self) -> None:
        self.assertTrue(
            arcrho_runtime_service.arcrho_tri_cache_matches(
                str(self.data_path),
                self.pairs,
            )
        )
        self.dependency_path.write_text("100\n", encoding="utf-8")
        self.assertFalse(
            arcrho_runtime_service.arcrho_tri_cache_matches(
                str(self.data_path),
                self.pairs,
            )
        )

    def test_precheck_defers_calculated_dependency_content_hash_to_authoritative_validation(
        self,
    ) -> None:
        with patch.object(
            runtime_cache_provenance_service,
            "file_fingerprint",
            wraps=runtime_cache_provenance_service.file_fingerprint,
        ) as fingerprint:
            advisory = arcrho_runtime_service.arcrho_precheck(
                str(self.data_path),
                self.pairs,
            )
            self.assertTrue(advisory["cache_exists"])
            fingerprint.assert_not_called()

            self.assertTrue(
                arcrho_runtime_service.arcrho_tri_cache_matches(
                    str(self.data_path),
                    self.pairs,
                )
            )

        self.assertEqual(fingerprint.call_count, 1)

    def test_same_size_preserved_mtime_dependency_replacement_rejects_the_calculated_cache(self) -> None:
        original_stat = self.dependency_path.stat()
        self.assertTrue(
            arcrho_runtime_service.arcrho_tri_cache_matches(
                str(self.data_path),
                self.pairs,
            )
        )

        self.dependency_path.write_text("9\n", encoding="utf-8")
        self.assertEqual(self.dependency_path.stat().st_size, original_stat.st_size)
        os.utime(
            self.dependency_path,
            ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns),
        )
        self.assertEqual(self.dependency_path.stat().st_mtime_ns, original_stat.st_mtime_ns)

        self.assertFalse(
            arcrho_runtime_service.arcrho_tri_cache_matches(
                str(self.data_path),
                self.pairs,
            )
        )

    def test_stale_calculated_cache_is_recalculated_on_demand(self) -> None:
        self.dependency_path.write_text("100\n", encoding="utf-8")
        recalculated = {
            "ok": True,
            "status": "calculated",
            "data_path": str(self.data_path),
            "need_request": False,
        }
        with (
            patch.object(
                arcrho_runtime_service,
                "_recalculate_requested_app_dataset",
                return_value=recalculated,
            ) as recalculate,
            patch.object(
                engine_calculation_service,
                "send_request_like_vba",
            ) as send_engine_request,
        ):
            result = arcrho_runtime_service.run_arcrho_tri(
                self.pairs,
                str(self.data_path),
                timeout_sec=0.1,
                write_sidecar=False,
            )

        self.assertEqual(result, recalculated)
        recalculate.assert_called_once()
        send_engine_request.assert_not_called()

    def test_changed_formula_contract_rejects_unchanged_precedent_files(self) -> None:
        with patch.object(
            calculated_dataset_service,
            "calculated_dataset_contract",
            return_value={
                "name": "Calculated Loss",
                "formula": '"Paid Loss" * 3',
                "precedents": ["Paid Loss"],
            },
        ):
            self.assertFalse(
                arcrho_runtime_service.arcrho_tri_cache_matches(
                    str(self.data_path),
                    self.pairs,
                )
            )

    def test_removed_calculated_type_rejects_the_old_cache(self) -> None:
        with patch.object(
            calculated_dataset_service,
            "calculated_dataset_contract",
            return_value=None,
        ):
            self.assertFalse(
                arcrho_runtime_service.arcrho_tri_cache_matches(
                    str(self.data_path),
                    self.pairs,
                )
            )

    def test_current_dependency_contract_overrides_stored_source_ownership(self) -> None:
        payload = {
            **self.sidecar_payload,
            "Precedents": [
                {
                    **self.sidecar_payload["Precedents"][0],
                    "source_kind": "input",
                    "data_format": "Triangle",
                }
            ],
        }
        self.sidecar_path.write_text(json.dumps(payload), encoding="utf-8")
        with patch.object(
            calculated_dataset_service,
            "calculated_dataset_contract",
            return_value={
                "name": "Calculated Loss",
                "formula": '"Paid Loss" * 2',
                "precedents": ["Paid Loss"],
                "precedent_contracts": {
                    "paid loss": {
                        "name": "Paid Loss",
                        "data_format": "Triangle",
                        "generated": True,
                        "calculated": False,
                        "formula": "",
                    }
                },
            },
        ):
            self.assertFalse(
                arcrho_runtime_service.arcrho_tri_cache_matches(
                    str(self.data_path),
                    self.pairs,
                )
            )

    def test_precedent_path_outside_reserving_class_roots_is_rejected(self) -> None:
        outside_path = self.root / "outside.csv"
        outside_path.write_text("1\n", encoding="utf-8")
        outside_stat = outside_path.stat()
        payload = {
            **self.sidecar_payload,
            "Precedents": [
                {
                    "dataset_type_name": "Paid Loss",
                    "path": str(outside_path),
                    "mtime_ns": outside_stat.st_mtime_ns,
                    "size": outside_stat.st_size,
                    "sha256": hashlib.sha256(outside_path.read_bytes()).hexdigest(),
                }
            ],
        }
        self.sidecar_path.write_text(json.dumps(payload), encoding="utf-8")

        self.assertFalse(
            arcrho_runtime_service.arcrho_tri_cache_matches(
                str(self.data_path),
                self.pairs,
            )
        )

    def test_dependency_request_pairs_keep_exact_vector_and_triangle_variants(self) -> None:
        vector_descriptor = {
            "dataset_type_name": "Exposure",
            "dataset_name": "Custom Exposure",
            "path": str(self.data_path.with_name("Custom Exposure@3.csv")),
            "data_format": "Vector",
        }
        vector_pairs = arcrho_runtime_service._dependency_request_pairs(
            self.pairs,
            "Exposure",
            "Vector",
            instance_name="Custom Exposure",
            settings=arcrho_runtime_service._dependency_cache_settings(
                vector_descriptor,
                "Vector",
                vector_descriptor["path"],
            ),
        )
        vector_values = dict(vector_pairs)
        self.assertEqual(vector_values["Function"], "ArcRhoVec")
        self.assertEqual(vector_values["InstanceName"], "Custom Exposure")
        self.assertEqual(vector_values["OriginLength"], "3")
        self.assertEqual(vector_values["DevelopmentLength"], "3")
        self.assertNotIn("PeriodLength", vector_values)

        triangle_path = str(
            self.data_path.with_name("Paid Loss@3@6@inc@cal.csv")
        )
        triangle_pairs = arcrho_runtime_service._dependency_request_pairs(
            self.pairs,
            "Paid Loss",
            "Triangle",
            settings=arcrho_runtime_service._dependency_cache_settings(
                {"path": triangle_path},
                "Triangle",
                triangle_path,
            ),
        )
        triangle_values = dict(triangle_pairs)
        self.assertEqual(triangle_values["OriginLength"], "3")
        self.assertEqual(triangle_values["DevelopmentLength"], "6")
        self.assertEqual(triangle_values["Cumulative"], "False")
        self.assertEqual(triangle_values["Calendar"], "True")

    def test_exact_component_path_rejects_an_old_data_format_variant(self) -> None:
        vector_path = self.data_path.with_name("Paid Loss@12.csv")
        vector_path.write_text("1\n", encoding="utf-8")

        _values, _precedents, errors = calculated_dataset_service._load_components(
            "Example Project",
            "Example RC",
            ["Paid Loss"],
            {
                "origin_length": 12,
                "development_length": 12,
                "cumulative": True,
                "calendar": False,
            },
            component_paths={"paid loss": str(vector_path)},
            component_formats={"paid loss": "Triangle"},
        )

        self.assertEqual(errors, ["Invalid exact dependency path: Paid Loss"])

    def test_requesting_downstream_calculated_cache_refreshes_stale_upstream_first(self) -> None:
        upstream_path = self.dependency_path
        raw_path = upstream_path.with_name("Raw Loss@12@12@cum@dev.csv")
        raw_path.write_text("1\n", encoding="utf-8")
        raw_stat = raw_path.stat()
        upstream_pairs = [
            (
                key,
                "Paid Loss" if key in {"DatasetName", "InstanceName"} else value,
            )
            for key, value in self.pairs
        ]
        upstream_sidecar_path = Path(
            arcrho_runtime_service._dataset_sidecar_path(
                str(upstream_path),
                upstream_pairs,
            )
        )
        upstream_sidecar_path.write_text(
            json.dumps(
                {
                    "dataset_name": "Paid Loss",
                    "dataset_type": "Paid Loss",
                    "reserving_class": "Example RC",
                    "project_name": "Example Project",
                    "source_kind": "calculated",
                    "data_format": "Triangle",
                    "formula": '"Raw Loss" * 2',
                    "Precedents": [
                        {
                            "dataset_type_name": "Raw Loss",
                            "path": str(raw_path),
                            "mtime_ns": raw_stat.st_mtime_ns,
                            "size": raw_stat.st_size,
                            "sha256": hashlib.sha256(raw_path.read_bytes()).hexdigest(),
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        raw_path.write_text("100\n", encoding="utf-8")
        self.assertFalse(
            arcrho_runtime_service.arcrho_tri_cache_matches(
                str(upstream_path),
                upstream_pairs,
            )
        )

        dataset_type_rows = [
            {
                "name": "Raw Loss",
                "data_format": "Triangle",
                "formula": "",
                "calculated": False,
                "generated": False,
            },
            {
                "name": "Paid Loss",
                "data_format": "Triangle",
                "formula": '"Raw Loss" * 2',
                "calculated": True,
                "generated": False,
            },
            {
                "name": "Calculated Loss",
                "data_format": "Triangle",
                "formula": '"Paid Loss" * 2',
                "calculated": True,
                "generated": False,
            },
        ]
        calculated_paths = {
            "Paid Loss": str(upstream_path),
            "Calculated Loss": str(self.data_path),
        }

        def dependency_path(pairs):
            values = {str(key): str(value) for key, value in pairs}
            return calculated_paths[values["DatasetName"]]

        def recalculate(
            project_name,
            reserving_class,
            dataset_type_name,
            *,
            component_paths=None,
            component_method_sources=None,
        ):
            return {
                "ok": True,
                "dataset_type_name": dataset_type_name,
                "path": calculated_paths[dataset_type_name],
            }

        with (
            patch.object(
                calculated_dataset_service,
                "_dataset_type_rows",
                return_value=dataset_type_rows,
            ),
            patch.object(
                calculated_dataset_service,
                "recalculate_dataset",
                side_effect=recalculate,
            ) as recalculate_dataset,
            patch.object(
                arcrho_runtime_service,
                "set_data_path_like_vba",
                side_effect=dependency_path,
            ),
            patch.object(
                arcrho_runtime_service,
                "_recalculate_dependents_after_cache_write",
                return_value=None,
            ) as recalculate_dependents,
            patch.object(
                arcrho_runtime_service.dataset_instance_index_service,
                "rebuild_index",
            ) as rebuild_index,
            patch.object(
                engine_calculation_service,
                "send_request_like_vba",
            ) as send_engine_request,
        ):
            result = arcrho_runtime_service.run_arcrho_tri(
                self.pairs,
                str(self.data_path),
                timeout_sec=0.1,
                write_sidecar=False,
        )

        self.assertTrue(result["ok"], result)
        self.assertTrue(result.get("calculated"), result)
        self.assertEqual(
            [
                args.args[2]
                for args in recalculate_dataset.call_args_list
            ],
            ["Paid Loss", "Calculated Loss"],
        )
        send_engine_request.assert_not_called()
        recalculate_dependents.assert_not_called()
        rebuild_index.assert_not_called()

    def test_dependency_read_failure_keeps_the_calculated_csv(self) -> None:
        real_stat = arcrho_runtime_service.os.stat

        def stat_with_unavailable_dependency(path, *args, **kwargs):
            if str(path) == str(self.dependency_path):
                raise PermissionError("network unavailable")
            return real_stat(path, *args, **kwargs)

        with (
            patch.object(
                arcrho_runtime_service.os,
                "stat",
                side_effect=stat_with_unavailable_dependency,
            ),
            self.assertRaises(HTTPException) as raised,
        ):
            arcrho_runtime_service.arcrho_tri_cache_matches(
                str(self.data_path),
                self.pairs,
            )

        self.assertEqual(raised.exception.status_code, 503)
        self.assertTrue(self.data_path.is_file())

    def test_unavailable_dataset_type_contract_fails_without_empty_fallback(self) -> None:
        unavailable_path = self.root / "unavailable-share" / "dataset_types.json"
        with (
            patch.object(
                config,
                "get_dataset_types_path",
                return_value=str(unavailable_path),
            ),
            self.assertRaises(HTTPException) as raised,
        ):
            calculated_dataset_service._dataset_type_rows("Example Project")

        self.assertEqual(raised.exception.status_code, 503)
        self.assertTrue(self.data_path.is_file())


if __name__ == "__main__":
    unittest.main()
