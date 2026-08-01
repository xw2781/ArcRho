from __future__ import annotations

import json
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = FRONTEND_ROOT.parent
for candidate in (FRONTEND_ROOT, REPO_ROOT / "python-api" / "src", REPO_ROOT / "python-api" / "migration"):
    if str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))

from app_server.services import arcrho_runtime_service
from resq_migration import extractors


class EngineDatasetSidecarContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT))
        self.root = Path(self.temp_dir.name)
        self.runtime_rc = self.root / "runtime" / "rc"
        self.migration_rc = self.root / "migration" / "rc"
        for rc_dir in (self.runtime_rc, self.migration_rc):
            (rc_dir / "datasets").mkdir(parents=True)
            (rc_dir / "sidecars").mkdir()
        self.csv_name = "Ratio@12@12@cum@dev.csv"
        self.runtime_csv = self.runtime_rc / "datasets" / self.csv_name
        self.migration_csv = self.migration_rc / "datasets" / self.csv_name
        self.runtime_csv.write_text("1,2\n3,4\n", encoding="utf-8")
        self.migration_csv.write_text("1,2\n3,4\n", encoding="utf-8")
        self.provenance = {
            "config_hash": "sha256:canonical",
            "algorithm_version": "arcrho-data-processing-v1",
            "rules_format": "arcrho-data-processing-rules-v1",
            "rules_revision": 7,
        }
        self.generated_at = "2026-07-31T23:59:00Z"
        self.created_at = "2026-07-31T23:58:00Z"

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    @staticmethod
    def _apply_graph(payload, *_args, **_kwargs):
        payload["formula"] = ""
        payload["calculated"] = False
        payload["Precedents"] = []
        payload["Dependents"] = [{"name": "Downstream Ratio", "formula": '"Ratio" / "Other"'}]
        return payload

    def test_runtime_and_migration_emit_the_exact_same_engine_sidecar(self) -> None:
        runtime_sidecar = self.runtime_rc / "sidecars" / "Ratio.json"
        pairs = [
            ("ProjectName", "Demo"),
            ("Path", r"Auto\PP"),
            ("DatasetName", "Ratio"),
            ("InstanceName", "Ratio"),
            ("Function", "ArcRhoTri"),
            ("OriginLength", "12"),
            ("DevelopmentLength", "12"),
            ("Cumulative", "true"),
            ("Calendar", "false"),
        ]

        real_datetime = datetime

        class FixedDateTime:
            @staticmethod
            def utcnow():
                return real_datetime(2026, 7, 31, 23, 59, 0)

        with (
            patch.object(arcrho_runtime_service, "datetime", FixedDateTime),
            patch.object(arcrho_runtime_service, "_utc_timestamp_from_stat", return_value=self.created_at),
            patch.object(arcrho_runtime_service, "_dataset_sidecar_path", return_value=str(runtime_sidecar)),
            patch.object(arcrho_runtime_service.getpass, "getuser", return_value="tester"),
            patch.object(arcrho_runtime_service, "get_processing_provenance", return_value=self.provenance),
            patch.object(
                arcrho_runtime_service.dataset_number_format_service,
                "dataset_type_number_format_settings",
                return_value={"number_format": "0.0%", "decimal_places": 1},
            ),
            patch(
                "app_server.services.calculated_dataset_service.apply_sidecar_graph_fields",
                side_effect=self._apply_graph,
            ),
            patch.object(
                arcrho_runtime_service.dataset_sidecar_status_service,
                "refresh_method_statuses_for_dependents",
            ),
        ):
            arcrho_runtime_service._write_dataset_sidecar_impl(str(self.runtime_csv), pairs)

        runtime_payload = json.loads(runtime_sidecar.read_text(encoding="utf-8"))

        extractors.PROJECT_NAME = "Demo"
        with (
            patch.object(extractors.getpass, "getuser", return_value="tester"),
            patch.object(extractors, "_engine_cache_created_at", return_value=self.created_at),
            patch.object(extractors, "dataset_type_number_format", return_value="0.0%"),
            patch.object(extractors, "dataset_type_decimal_places", return_value=1),
            patch.object(extractors, "_apply_graph_meta_best_effort", side_effect=self._apply_graph),
        ):
            with patch.object(extractors, "datetime") as migration_datetime:
                migration_datetime.utcnow.return_value = real_datetime(2026, 7, 31, 23, 59, 0)
                extractors.write_engine_generated_export(
                    {
                        "name": "Ratio",
                        "dataset_type": "Ratio",
                        "data_format": 0,
                        "origin_length": 12,
                        "development_length": 12,
                        "origin_labels": ["wrong ResQ label"],
                        "development_labels": ["12", "24"],
                        "user": "ResQ User",
                        "created": "2000-01-01",
                        "modified": "2000-01-02",
                    },
                    r"Auto\PP",
                    self.migration_rc,
                    is_vector=False,
                    provenance=self.provenance,
                    csv_name=self.csv_name,
                    csv_path=self.migration_csv,
                )

        migration_payload = json.loads(
            (self.migration_rc / "sidecars" / "Ratio.json").read_text(encoding="utf-8")
        )
        self.assertEqual(migration_payload, runtime_payload)
        self.assertNotIn("origin_labels", migration_payload)
        self.assertNotIn("development_labels", migration_payload)
        self.assertNotIn(str(self.runtime_rc), json.dumps(runtime_payload))
        self.assertNotIn(str(self.migration_rc), json.dumps(migration_payload))


if __name__ == "__main__":
    unittest.main()
