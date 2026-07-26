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

from fastapi import HTTPException

from app_server import config
from app_server.api.data_processing_rules_router import (
    get_data_processing_rules as get_data_processing_rules_route,
)
from app_server.services import (
    arcrho_runtime_service,
    data_processing_rules_service,
    data_processing_values_service,
    reserving_class_service,
)


class DataProcessingRulesServiceTests(unittest.TestCase):
    project_name = "Example Project"

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT))
        self.root = Path(self.temp_dir.name)
        self.projects_dir = self.root / "projects"
        self.project_dir = self.projects_dir / self.project_name
        self.project_dir.mkdir(parents=True)
        self.table_path = self.project_dir / "source.csv"
        self.table_path.write_text(
            "STATE_CD,IBNRCAT,Earned_Premium\n"
            "NJ,BI,100\n"
            "NJ,UMBI,50\n"
            "PA,PD,75\n",
            encoding="utf-8",
        )
        self._write_json(
            "field_mapping.json",
            {
                "project_name": self.project_name,
                "table_path": str(self.table_path),
                "rows": [
                    {
                        "field_name": "IBNRCAT",
                        "significance": "Reserving Class",
                        "dataset_type": None,
                        "level": 5,
                    },
                    {
                        "field_name": "Earned_Premium",
                        "significance": "Dataset",
                        "dataset_type": "Earned Premium",
                        "level": None,
                    },
                ],
            },
        )
        self._write_json(
            "reserving_class_values.json",
            {
                "fields": [
                    {
                        "field_name": "IBNRCAT",
                        "level": 5,
                        "distinct_values": ["BI", "UMBI", "PD"],
                    }
                ]
            },
        )
        self._write_json(
            "reserving_class_types.json",
            {
                "columns": ["Name", "Level", "Formula", "Source"],
                "rows": [
                    ["BI", "5", "", '"BI"'],
                    ["UMBI", "5", "", '"UMBI"'],
                    ["PD", "5", "", '"PD"'],
                    ["TOTAL PA", "5", "BI + UMBI + PD", '"BI" + "UMBI" + "PD"'],
                ],
            },
        )
        self._write_json(
            "dataset_types.json",
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
                    [
                        "Earned Premium",
                        "Triangle",
                        "Premium",
                        False,
                        "",
                        "Earned_Premium",
                        True,
                    ]
                ],
            },
        )
        self._write_json(
            "general_settings.json",
            {
                "project_name": self.project_name,
                "origin_start_date": "202001",
                "origin_end_date": "202012",
                "development_end_date": "202112",
            },
        )
        self.project_root_patch = patch.object(
            config,
            "PROJECT_SETTINGS_DIR",
            str(self.projects_dir),
        )
        self.project_root_patch.start()

    def tearDown(self) -> None:
        self.project_root_patch.stop()
        self.temp_dir.cleanup()

    def _write_json(self, name: str, payload: dict) -> None:
        (self.project_dir / name).write_text(
            json.dumps(payload, indent=2),
            encoding="utf-8",
        )

    def _candidate(self, member: str = "BI") -> dict:
        return {
            "rules": [
                {
                    "id": "earned-premium-nj-total-pa",
                    "name": "NJ Earned Premium",
                    "enabled": True,
                    "target": {"source_measure": "Earned_Premium"},
                    "request_conditions": {
                        "all": [
                            {
                                "field": "IBNRCAT",
                                "level": 5,
                                "operator": "equals",
                                "value": "TOTAL PA",
                            }
                        ]
                    },
                    "row_conditions": {
                        "all": [
                            {
                                "field": "STATE_CD",
                                "operator": "equals",
                                "value": "NJ",
                            }
                        ]
                    },
                    "action": {
                        "type": "exclude_members",
                        "field": "IBNRCAT",
                        "level": 5,
                        "members": [member],
                    },
                }
            ]
        }

    def test_get_missing_file_returns_canonical_empty_document_and_options(self) -> None:
        result = data_processing_rules_service.get_data_processing_rules(self.project_name)

        self.assertFalse(result["exists"])
        self.assertEqual(result["data"]["revision"], 0)
        self.assertEqual(result["data"]["json_format"], config.DATA_PROCESSING_RULES_FORMAT)
        self.assertTrue(result["validation"]["valid"])
        self.assertEqual(result["options"]["source_measures"], ["Earned_Premium"])
        self.assertEqual(
            result["options"]["source_fields"][1]["values_by_measure"]["Earned_Premium"],
            ["BI", "PD", "UMBI"],
        )
        self.assertEqual(
            result["options"]["source_vocabulary"]["json_format"],
            config.DATA_PROCESSING_VALUES_FORMAT,
        )
        self.assertEqual(
            result["options"]["reserving_class_fields"][0]["types"],
            ["BI", "UMBI", "PD", "TOTAL PA"],
        )

    def test_mapped_dataset_absence_is_a_warning_not_a_validation_error(self) -> None:
        self.table_path.write_text(
            "STATE_CD,IBNRCAT\nNJ,BI\n",
            encoding="utf-8",
        )

        result = data_processing_rules_service.validate_data_processing_rules(
            self.project_name,
            self._candidate(),
        )

        self.assertTrue(result["valid"], result["errors"])
        self.assertTrue(
            any("absent from the current source table" in warning for warning in result["warnings"]),
            result["warnings"],
        )
        self.assertTrue(
            any("has no current source rows" in warning for warning in result["warnings"]),
            result["warnings"],
        )
        ibnrcat = next(
            item
            for item in result["options"]["source_fields"]
            if item["field"] == "IBNRCAT"
        )
        self.assertEqual(ibnrcat["values_by_measure"]["Earned_Premium"], [])
        self.assertEqual(ibnrcat["values"], [])

    def test_impossible_cached_action_combination_warns_without_blocking(self) -> None:
        self.table_path.write_text(
            "STATE_CD,IBNRCAT,Earned_Premium\nNJ,BI,100\n",
            encoding="utf-8",
        )

        result = data_processing_rules_service.validate_data_processing_rules(
            self.project_name,
            self._candidate(member="UMBI"),
        )

        self.assertTrue(result["valid"], result["errors"])
        self.assertTrue(
            any("match no current complete source-key combination" in warning for warning in result["warnings"]),
            result["warnings"],
        )

    def test_validate_and_save_use_revision_and_semantic_no_op_detection(self) -> None:
        validation = data_processing_rules_service.validate_data_processing_rules(
            self.project_name,
            self._candidate(),
        )
        self.assertTrue(validation["valid"], validation["errors"])

        saved = data_processing_rules_service.save_data_processing_rules(
            self.project_name,
            expected_revision=0,
            data=self._candidate(),
        )
        self.assertTrue(saved["changed"])
        self.assertEqual(saved["data"]["revision"], 1)
        self.assertEqual(saved["impact"]["affected_source_measures"], ["Earned_Premium"])
        self.assertEqual(saved["impact"]["affected_dataset_types"], ["Earned Premium"])

        no_op = data_processing_rules_service.save_data_processing_rules(
            self.project_name,
            expected_revision=1,
            data={
                "rules": [
                    {
                        **self._candidate()["rules"][0],
                        "action": {
                            **self._candidate()["rules"][0]["action"],
                            "members": ["BI", "BI"],
                        },
                    }
                ]
            },
        )
        self.assertFalse(no_op["changed"])
        self.assertEqual(no_op["data"]["revision"], 1)

        with self.assertRaises(data_processing_rules_service.RulesRevisionConflictError):
            data_processing_rules_service.save_data_processing_rules(
                self.project_name,
                expected_revision=0,
                data=self._candidate(),
            )

    def test_rule_reorder_persists_without_invalidating_processing_caches(self) -> None:
        candidate = self._candidate()
        second_rule = json.loads(json.dumps(candidate["rules"][0]))
        second_rule["id"] = "earned-premium-nj-total-pa-second"
        second_rule["name"] = "NJ Earned Premium Second"
        candidate["rules"].append(second_rule)

        first = data_processing_rules_service.save_data_processing_rules(
            self.project_name,
            expected_revision=0,
            data=candidate,
        )
        processing_hash = data_processing_rules_service.get_processing_config_hash(
            self.project_name
        )
        reordered_rules = list(reversed(candidate["rules"]))

        reordered = data_processing_rules_service.save_data_processing_rules(
            self.project_name,
            expected_revision=first["data"]["revision"],
            data={"rules": reordered_rules},
        )

        persisted = json.loads(
            (self.project_dir / config.DATA_PROCESSING_RULES_FILE).read_text(encoding="utf-8")
        )
        self.assertTrue(reordered["changed"])
        self.assertEqual(reordered["data"]["revision"], 2)
        self.assertEqual(
            [rule["id"] for rule in persisted["rules"]],
            [rule["id"] for rule in reordered_rules],
        )
        self.assertEqual(reordered["impact"]["invalidated_count"], 0)
        self.assertEqual(
            data_processing_rules_service.get_processing_config_hash(self.project_name),
            processing_hash,
        )

    def test_invalid_atomic_member_is_rejected(self) -> None:
        result = data_processing_rules_service.validate_data_processing_rules(
            self.project_name,
            self._candidate(member="NOT_A_MEMBER"),
        )
        self.assertFalse(result["valid"])
        self.assertTrue(
            any("not an atomic source value" in error for error in result["errors"]),
            result["errors"],
        )

    def test_request_conditions_accept_negative_scalar_and_list_operators(self) -> None:
        for operator, value in (
            ("not_equals", "PD"),
            ("not_in", ["PD", "UMBI"]),
        ):
            candidate = self._candidate()
            candidate["rules"][0]["request_conditions"]["all"][0].update(
                {"operator": operator, "value": value}
            )
            with self.subTest(operator=operator):
                result = data_processing_rules_service.validate_data_processing_rules(
                    self.project_name,
                    candidate,
                )
                self.assertTrue(result["valid"], result["errors"])

    def test_negative_request_condition_narrows_keep_member_scope(self) -> None:
        candidate = self._candidate()
        rule = candidate["rules"][0]
        rule["action"]["type"] = "keep_members"
        rule["request_conditions"]["all"] = [
            {
                "field": "IBNRCAT",
                "level": 5,
                "operator": "in",
                "value": ["TOTAL PA", "PD"],
            },
            {
                "field": "IBNRCAT",
                "level": 5,
                "operator": "not_equals",
                "value": "PD",
            },
        ]

        result = data_processing_rules_service.validate_data_processing_rules(
            self.project_name,
            candidate,
        )

        self.assertTrue(result["valid"], result["errors"])

    def _keep_rule(self, request_value: str, member: str) -> dict:
        return {
            "rules": [
                {
                    "id": "keep-composite",
                    "name": "Keep composite",
                    "enabled": True,
                    "target": {"source_measure": "Earned_Premium"},
                    "request_conditions": {
                        "all": [
                            {
                                "field": "IBNRCAT",
                                "level": 5,
                                "operator": "equals",
                                "value": request_value,
                            }
                        ]
                    },
                    "row_conditions": {"all": []},
                    "action": {
                        "type": "keep_members",
                        "field": "IBNRCAT",
                        "level": 5,
                        "members": [member],
                    },
                }
            ]
        }

    def test_keep_members_accepts_composite_membership_label(self) -> None:
        # A measure stored at an aggregate label: "PD+UMPD" is a composite type and
        # a real source value; "TOTAL AUTO" reaches it via its Formula tree.
        self.table_path.write_text(
            "STATE_CD,IBNRCAT,Earned_Premium\n"
            "NJ,PD+UMPD,120\n"
            "NJ,COL,40\n",
            encoding="utf-8",
        )
        self._write_json(
            "reserving_class_values.json",
            {"fields": [{"field_name": "IBNRCAT", "level": 5,
                         "distinct_values": ["PD", "UMPD", "PD+UMPD", "COL"]}]},
        )
        self._write_json(
            "reserving_class_types.json",
            {
                "columns": ["Name", "Level", "Formula", "Source"],
                "rows": [
                    ["PD", "5", "", '"PD"'],
                    ["UMPD", "5", "", '"UMPD"'],
                    ["COL", "5", "", '"COL"'],
                    ["PD+UMPD", "5", "PD + UMPD", '"PD" + "UMPD"'],
                    ["TOTAL AUTO", "5", '"PD+UMPD"', '"PD" + "UMPD"'],
                ],
            },
        )

        # keeping the composite label is valid (it is in TOTAL AUTO's membership tree)
        ok = data_processing_rules_service.validate_data_processing_rules(
            self.project_name, self._keep_rule("TOTAL AUTO", "PD+UMPD")
        )
        self.assertTrue(ok["valid"], ok["errors"])

        # keeping an out-of-tree member is still rejected as base-excluded
        bad = data_processing_rules_service.validate_data_processing_rules(
            self.project_name, self._keep_rule("TOTAL AUTO", "COL")
        )
        self.assertFalse(bad["valid"])
        self.assertTrue(
            any("base-excluded" in error for error in bad["errors"]),
            bad["errors"],
        )

    def test_write_lock_contention_is_distinct(self) -> None:
        rules_path = config.get_data_processing_rules_path(self.project_name)
        lock = data_processing_rules_service._lock_for_path(rules_path)
        lock.acquire()
        try:
            with (
                patch.object(data_processing_rules_service, "_RULE_LOCK_TIMEOUT_SECONDS", 0),
                self.assertRaises(data_processing_rules_service.RulesWriteLockedError),
            ):
                data_processing_rules_service.save_data_processing_rules(
                    self.project_name,
                    expected_revision=0,
                    data=self._candidate(),
                )
        finally:
            lock.release()

    def test_vocabulary_lock_contention_maps_to_http_423(self) -> None:
        with patch.object(
            data_processing_rules_service,
            "get_data_processing_rules",
            side_effect=data_processing_values_service.DataProcessingValuesLockedError(
                "Vocabulary cache is busy."
            ),
        ):
            with self.assertRaises(HTTPException) as raised:
                get_data_processing_rules_route(self.project_name)

        self.assertEqual(raised.exception.status_code, 423)
        self.assertIn("Vocabulary cache is busy", str(raised.exception.detail))

    def test_malformed_stored_file_fails_explicitly(self) -> None:
        (self.project_dir / config.DATA_PROCESSING_RULES_FILE).write_text(
            "{not valid json",
            encoding="utf-8",
        )
        with self.assertRaises(data_processing_rules_service.StoredRulesContractError):
            data_processing_rules_service.get_data_processing_rules(self.project_name)

    def test_processing_hash_rejects_malformed_config_instead_of_hashing_empty_data(self) -> None:
        (self.project_dir / "dataset_types.json").write_text(
            "{not valid json",
            encoding="utf-8",
        )
        with self.assertRaises(data_processing_rules_service.StoredRulesContractError):
            data_processing_rules_service.get_processing_config_hash(self.project_name)

    def test_processing_hash_reports_an_unavailable_project_folder(self) -> None:
        unavailable_path = self.root / "unavailable" / config.DATA_PROCESSING_RULES_FILE
        with (
            patch.object(
                config,
                "get_data_processing_rules_path",
                return_value=str(unavailable_path),
            ),
            self.assertRaises(OSError),
        ):
            data_processing_rules_service.get_processing_config_hash(self.project_name)

    def test_semantic_save_clears_only_temporary_view_caches(self) -> None:
        datasets_dir = self.project_dir / "data" / "All States" / config.DATASET_CACHE_DIR
        temporary_dir = datasets_dir / config.TEMPORARY_VIEW_DATASET_CACHE_DIR
        temporary_dir.mkdir(parents=True)
        temporary_cache = temporary_dir / "Earned Premium@12@12@cum@dev.csv"
        durable_input = datasets_dir / "Manual Input@12@12@cum@dev.csv"
        temporary_cache.write_text("1\n", encoding="utf-8")
        durable_input.write_text("2\n", encoding="utf-8")

        result = data_processing_rules_service.save_data_processing_rules(
            self.project_name,
            expected_revision=0,
            data=self._candidate(),
        )

        self.assertFalse(temporary_cache.exists())
        self.assertTrue(durable_input.exists())
        self.assertEqual(result["impact"]["temporary_view_caches_cleared"], 1)
        self.assertGreaterEqual(result["impact"]["invalidated_count"], 1)

    def test_processing_hash_ignores_audit_only_changes(self) -> None:
        first = data_processing_rules_service.get_processing_config_hash(self.project_name)
        dataset_types_path = self.project_dir / "dataset_types.json"
        payload = json.loads(dataset_types_path.read_text(encoding="utf-8"))
        payload["updated_at"] = "2099-01-01T00:00:00Z"
        dataset_types_path.write_text(json.dumps(payload), encoding="utf-8")
        second = data_processing_rules_service.get_processing_config_hash(self.project_name)
        self.assertEqual(first, second)

    def test_processing_hash_changes_with_source_table_content(self) -> None:
        first = data_processing_rules_service.get_processing_config_hash(self.project_name)
        with self.table_path.open("a", encoding="utf-8") as handle:
            handle.write("NJ,PD,25\n")
        second = data_processing_rules_service.get_processing_config_hash(self.project_name)
        self.assertNotEqual(first, second)


class GeneratedCacheProcessingHashTests(DataProcessingRulesServiceTests):
    def _pairs(
        self,
        origin_length: int = 12,
        development_length: int = 12,
    ) -> list[tuple[str, str]]:
        return [
            ("Function", "ArcRhoTri"),
            ("Path", "All States"),
            ("DatasetName", "Earned Premium"),
            ("ProjectName", self.project_name),
            ("OriginLength", str(origin_length)),
            ("DevelopmentLength", str(development_length)),
            ("Cumulative", "True"),
            ("Calendar", "False"),
        ]

    def _cache_paths(self) -> tuple[Path, Path]:
        datasets_dir = self.project_dir / "data" / "All States" / "datasets"
        sidecars_dir = self.project_dir / "data" / "All States" / "sidecars"
        datasets_dir.mkdir(parents=True, exist_ok=True)
        sidecars_dir.mkdir(parents=True, exist_ok=True)
        csv_path = datasets_dir / "Earned Premium@12@12@cum@dev.csv"
        csv_path.write_text("1\n", encoding="utf-8")
        return csv_path, sidecars_dir / "Earned Premium.json"

    def _sidecar(self, **changes) -> dict:
        payload = {
            "dataset_name": "Earned Premium",
            "dataset_type": "Earned Premium",
            "project_name": self.project_name,
            "reserving_class": "All States",
            "source_kind": "engine",
            "data_format": "Triangle",
            "csv_file": "Earned Premium@12@12@cum@dev.csv",
        }
        payload.update(changes)
        return payload

    def test_engine_cache_requires_current_processing_hash(self) -> None:
        csv_path, sidecar_path = self._cache_paths()
        sidecar_path.write_text(json.dumps(self._sidecar()), encoding="utf-8")
        self.assertFalse(
            arcrho_runtime_service.arcrho_tri_cache_matches(
                str(csv_path),
                self._pairs(),
            )
        )

        provenance = data_processing_rules_service.get_processing_provenance(self.project_name)
        sidecar_path.write_text(
            json.dumps(self._sidecar(processing=provenance)),
            encoding="utf-8",
        )
        self.assertTrue(
            arcrho_runtime_service.arcrho_tri_cache_matches(
                str(csv_path),
                self._pairs(),
            )
        )

    def test_input_and_resq_import_snapshots_do_not_require_processing_hash(self) -> None:
        csv_path, sidecar_path = self._cache_paths()
        for payload in (
            self._sidecar(source_kind="input"),
            self._sidecar(source_kind="engine", source="resq_triangle"),
        ):
            with self.subTest(payload=payload):
                sidecar_path.write_text(json.dumps(payload), encoding="utf-8")
                self.assertTrue(
                    arcrho_runtime_service.arcrho_tri_cache_matches(
                        str(csv_path),
                        self._pairs(),
                    )
                )

    def test_rules_save_makes_an_existing_engine_cache_stale(self) -> None:
        csv_path, sidecar_path = self._cache_paths()
        sidecar_path.write_text(
            json.dumps(
                self._sidecar(
                    processing=data_processing_rules_service.get_processing_provenance(
                        self.project_name
                    )
                )
            ),
            encoding="utf-8",
        )
        self.assertTrue(
            arcrho_runtime_service.arcrho_tri_cache_matches(
                str(csv_path),
                self._pairs(),
            )
        )

        data_processing_rules_service.save_data_processing_rules(
            self.project_name,
            expected_revision=0,
            data=self._candidate(),
        )

        self.assertFalse(
            arcrho_runtime_service.arcrho_tri_cache_matches(
                str(csv_path),
                self._pairs(),
            )
        )

    def test_processing_provenance_is_scoped_to_each_csv_variant(self) -> None:
        csv_path, sidecar_path = self._cache_paths()
        second_path = csv_path.with_name("Earned Premium@6@6@cum@dev.csv")
        second_path.write_text("1\n", encoding="utf-8")
        provenance = data_processing_rules_service.get_processing_provenance(self.project_name)
        sidecar_path.write_text(
            json.dumps(
                self._sidecar(
                    processing=provenance,
                    processing_by_csv={csv_path.name: provenance},
                )
            ),
            encoding="utf-8",
        )

        self.assertTrue(
            arcrho_runtime_service.arcrho_tri_cache_matches(
                str(csv_path),
                self._pairs(),
            )
        )
        self.assertFalse(
            arcrho_runtime_service.arcrho_tri_cache_matches(
                str(second_path),
                self._pairs(6, 6),
            )
        )


class ReservingClassEexRemovalTests(unittest.TestCase):
    def test_legacy_eex_json_column_is_ignored(self) -> None:
        normalized = reserving_class_service.normalize_reserving_class_types_data(
            {
                "columns": ["Name", "Level", "Formula", "EEX Formula", "Source"],
                "rows": [["TOTAL PA", "5", "BI + PD", "PD", '"BI" + "PD"']],
            }
        )

        self.assertEqual(
            normalized,
            {
                "columns": ["Name", "Level", "Formula", "Source"],
                "rows": [["TOTAL PA", "5", "BI + PD", '"BI" + "PD"']],
            },
        )

        normalized_without_source = reserving_class_service.normalize_reserving_class_types_data(
            {
                "columns": ["Name", "Level", "Formula", "EEX Formula"],
                "rows": [["TOTAL PA", "5", "BI + PD", "PD"]],
            }
        )
        self.assertEqual(
            normalized_without_source["rows"],
            [["TOTAL PA", "5", "BI + PD", ""]],
        )

    def test_legacy_eex_xlsx_import_error_is_explicit(self) -> None:
        with tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT)) as temp_dir:
            path = Path(temp_dir) / "legacy.xlsx"
            workbook = reserving_class_service.openpyxl.Workbook()
            worksheet = workbook.active
            worksheet.append(["Name", "Level", "Formula", "EEX Formula"])
            worksheet.append(["TOTAL PA", "5", "BI + PD", "PD"])
            workbook.save(path)
            workbook.close()

            with self.assertRaises(HTTPException) as raised:
                reserving_class_service.parse_local_reserving_class_types_file(str(path))
            self.assertEqual(raised.exception.status_code, 400)
            self.assertIn("Data Processing", str(raised.exception.detail))


if __name__ == "__main__":
    unittest.main()
