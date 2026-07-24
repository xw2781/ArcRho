import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
if str(FRONTEND_ROOT) not in sys.path:
    sys.path.insert(0, str(FRONTEND_ROOT))

from app_server import config
from app_server.services import data_processing_values_service


class DataProcessingValuesServiceTests(unittest.TestCase):
    project_name = "Vocabulary Project"

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT))
        self.root = Path(self.temp_dir.name)
        self.projects_dir = self.root / "projects"
        self.project_dir = self.projects_dir / self.project_name
        self.project_dir.mkdir(parents=True)
        self.table_path = self.project_dir / "source.csv"
        self.table_path.write_text(
            "STATE_CD,IBNRCAT,Earned_Premium,Paid_Loss,Paid_Loss_Copy\n"
            "NJ,BI,100,,\n"
            "NJ,PD,,50,50\n"
            "PA,BI,75,,\n"
            ",BI,25,,\n"
            "NJ,,10,,\n"
            "NJ,UMBI,,0,0\n",
            encoding="utf-8",
        )
        self._write_mapping()
        self.project_root_patch = patch.object(
            config,
            "PROJECT_SETTINGS_DIR",
            str(self.projects_dir),
        )
        self.project_root_patch.start()

    def tearDown(self) -> None:
        self.project_root_patch.stop()
        self.temp_dir.cleanup()

    def _write_mapping(self, earned_label: str = "Earned Premium") -> None:
        payload = {
            "project_name": self.project_name,
            "table_path": str(self.table_path),
            "rows": [
                {
                    "field_name": "STATE_CD",
                    "significance": "Reserving Class",
                    "dataset_type": None,
                    "level": 1,
                },
                {
                    "field_name": "IBNRCAT",
                    "significance": "Reserving Class",
                    "dataset_type": None,
                    "level": 5,
                },
                {
                    "field_name": "Earned_Premium",
                    "significance": "Dataset",
                    "dataset_type": earned_label,
                    "level": None,
                },
                {
                    "field_name": "Paid_Loss",
                    "significance": "Dataset",
                    "dataset_type": "Paid Loss",
                    "level": None,
                },
                {
                    "field_name": "Paid_Loss_Copy",
                    "significance": "Dataset",
                    "dataset_type": "Paid Loss Copy",
                    "level": None,
                },
            ],
        }
        (self.project_dir / config.FIELD_MAPPING_FILE).write_text(
            json.dumps(payload, indent=2),
            encoding="utf-8",
        )

    @staticmethod
    def _dataset_combinations(payload: dict, source_measure: str) -> list:
        dataset = payload["datasets"][source_measure]
        return payload["combination_sets"][dataset["combination_set_id"]]

    def test_builds_chunked_dataset_vocabularies_and_omits_incomplete_keys(self) -> None:
        with patch.object(data_processing_values_service, "_CSV_CHUNK_SIZE", 2):
            payload = data_processing_values_service.get_data_processing_values(
                self.project_name
            )

        self.assertEqual(
            payload["json_format"], config.DATA_PROCESSING_VALUES_CACHE_FORMAT
        )
        self.assertEqual(
            payload["key_fields"],
            [{"field": "STATE_CD", "level": 1}, {"field": "IBNRCAT", "level": 5}],
        )
        earned = payload["datasets"]["Earned_Premium"]
        self.assertEqual(earned["dataset_type"], "Earned Premium")
        self.assertEqual(earned["row_count"], 4)
        self.assertNotIn("combination_count", earned)
        self.assertNotIn("combinations", earned)
        self.assertEqual(
            self._dataset_combinations(payload, "Earned_Premium"),
            [["NJ", "BI"], ["PA", "BI"]],
        )
        paid = payload["datasets"]["Paid_Loss"]
        self.assertEqual(paid["row_count"], 2)
        self.assertEqual(
            self._dataset_combinations(payload, "Paid_Loss"),
            [["NJ", "PD"], ["NJ", "UMBI"]],
        )
        self.assertEqual(
            paid["combination_set_id"],
            payload["datasets"]["Paid_Loss_Copy"]["combination_set_id"],
        )
        self.assertEqual(len(payload["combination_sets"]), 2)
        self.assertEqual(payload["missing_columns"], [])

        cache_path = Path(config.get_data_processing_values_path(self.project_name))
        self.assertTrue(cache_path.is_file())
        self.assertEqual(json.loads(cache_path.read_text(encoding="utf-8")), payload)
        self.assertEqual(list(self.project_dir.glob("*.tmp")), [])

    def test_current_cache_is_reused_and_source_fingerprint_invalidates_it(self) -> None:
        first = data_processing_values_service.get_data_processing_values(self.project_name)
        with patch.object(
            data_processing_values_service,
            "_build_cache_payload",
            side_effect=AssertionError("current cache should be reused"),
        ):
            reused = data_processing_values_service.get_data_processing_values(
                self.project_name
            )
        self.assertEqual(reused, first)

        with self.table_path.open("a", encoding="utf-8") as handle:
            handle.write("CT,COL,20,\n")
        refreshed = data_processing_values_service.get_data_processing_values(
            self.project_name
        )
        self.assertNotEqual(
            refreshed["source_table_fingerprint"],
            first["source_table_fingerprint"],
        )
        self.assertEqual(refreshed["datasets"]["Earned_Premium"]["row_count"], 5)
        self.assertIn(
            ["CT", "COL"],
            self._dataset_combinations(refreshed, "Earned_Premium"),
        )

    def test_mapping_signature_invalidates_dataset_label(self) -> None:
        first = data_processing_values_service.get_data_processing_values(self.project_name)
        self._write_mapping(earned_label="Written Premium")
        second = data_processing_values_service.get_data_processing_values(self.project_name)

        self.assertNotEqual(first["mapping_signature"], second["mapping_signature"])
        self.assertEqual(
            second["datasets"]["Earned_Premium"]["dataset_type"],
            "Written Premium",
        )

    def test_refresh_retries_once_when_the_source_changes_during_scan(self) -> None:
        original_build = data_processing_values_service._build_cache_payload
        build_count = 0

        def build_and_change_once(contract: dict, fingerprint: dict) -> dict:
            nonlocal build_count
            build_count += 1
            payload = original_build(contract, fingerprint)
            if build_count == 1:
                with self.table_path.open("a", encoding="utf-8") as handle:
                    handle.write("CT,COL,20,\n")
            return payload

        with patch.object(
            data_processing_values_service,
            "_build_cache_payload",
            side_effect=build_and_change_once,
        ):
            payload = data_processing_values_service.get_data_processing_values(
                self.project_name
            )

        self.assertEqual(build_count, 2)
        self.assertEqual(payload["datasets"]["Earned_Premium"]["row_count"], 5)
        self.assertIn(
            ["CT", "COL"],
            self._dataset_combinations(payload, "Earned_Premium"),
        )

    def test_cache_lock_contention_has_a_typed_error(self) -> None:
        cache_path = config.get_data_processing_values_path(self.project_name)
        lock = data_processing_values_service._lock_for_path(cache_path)
        lock.acquire()
        try:
            with (
                patch.object(data_processing_values_service, "_CACHE_LOCK_TIMEOUT_SECONDS", 0),
                self.assertRaises(
                    data_processing_values_service.DataProcessingValuesLockedError
                ),
            ):
                data_processing_values_service.get_data_processing_values(
                    self.project_name
                )
        finally:
            lock.release()

    def test_public_options_omit_the_source_path_and_fingerprint(self) -> None:
        payload = data_processing_values_service.get_data_processing_values(
            self.project_name
        )
        options = data_processing_values_service.source_vocabulary_options(payload)

        self.assertNotIn("source_table_fingerprint", options)
        self.assertNotIn("mapping_signature", options)
        self.assertNotIn("combination_sets", options)
        self.assertEqual(options["json_format"], config.DATA_PROCESSING_VALUES_FORMAT)
        self.assertNotIn(
            "combination_set_id", options["datasets"]["Earned_Premium"]
        )
        self.assertEqual(
            options["datasets"]["Earned_Premium"],
            {
                "dataset_type": "Earned Premium",
                "row_count": 4,
                "combination_count": 2,
                "combinations": [["NJ", "BI"], ["PA", "BI"]],
            },
        )

    def test_old_or_malformed_cache_is_rebuilt_as_compact_v2(self) -> None:
        cache_path = Path(config.get_data_processing_values_path(self.project_name))
        original = data_processing_values_service.get_data_processing_values(
            self.project_name
        )

        old_format = dict(original)
        old_format["json_format"] = config.DATA_PROCESSING_VALUES_FORMAT
        cache_path.write_text(json.dumps(old_format), encoding="utf-8")
        rebuilt = data_processing_values_service.get_data_processing_values(self.project_name)
        self.assertEqual(
            rebuilt["json_format"], config.DATA_PROCESSING_VALUES_CACHE_FORMAT
        )

        malformed = dict(rebuilt)
        malformed["combination_sets"] = {}
        cache_path.write_text(json.dumps(malformed), encoding="utf-8")
        repaired = data_processing_values_service.get_data_processing_values(self.project_name)
        self.assertEqual(
            repaired["json_format"], config.DATA_PROCESSING_VALUES_CACHE_FORMAT
        )
        self.assertEqual(
            self._dataset_combinations(repaired, "Earned_Premium"),
            [["NJ", "BI"], ["PA", "BI"]],
        )


if __name__ == "__main__":
    unittest.main()
