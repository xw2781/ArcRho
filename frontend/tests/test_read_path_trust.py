"""Open fast path: trust sidecar status + index folder signature.

Dependent propagation is a single locked Engine-hosted job (business-logic
contract rule 15), so a current persisted ``index.json`` whose
``folder_signature`` matches a fresh listing is trustworthy evidence that a
calculated cache is current. These tests pin the trust short-circuit in
``arcrho_runtime_service._calculated_dependencies_match`` and its fallbacks.
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[2]
FRONTEND_ROOT = REPO_ROOT / "frontend"
PYTHON_API_SRC = REPO_ROOT / "python-api" / "src"
for path in (FRONTEND_ROOT, PYTHON_API_SRC):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from arcrho_api.dataset_index_contract import (
    INDEX_FILE_NAME,
    build_dataset_index_payload,
    write_index_json_unlocked,
)
from app_server import config
from app_server.services import (
    arcrho_runtime_service,
    calculated_dataset_service,
    runtime_cache_provenance_service,
)


class ReadPathTrustTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT))
        self.root = Path(self.temp_dir.name)
        self.rc_dir = self.root / "data" / "Example RC"
        self.data_path = (
            self.rc_dir / config.DATASET_CACHE_DIR / "Calculated Loss@12@12@cum@dev.csv"
        )
        self.dependency_path = self.data_path.with_name("Paid Loss@12@12@cum@dev.csv")
        self.data_path.parent.mkdir(parents=True)
        self.data_path.write_text("2\n", encoding="utf-8")
        self.dependency_path.write_text("1\n", encoding="utf-8")
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
            arcrho_runtime_service._dataset_sidecar_path(str(self.data_path), self.pairs)
        )
        self.sidecar_path.parent.mkdir(parents=True)
        self.sidecar_payload = {
            "dataset_name": "Calculated Loss",
            "dataset_type": "Calculated Loss",
            "reserving_class": "Example RC",
            "project_name": "Example Project",
            "source_kind": "calculated",
            "data_format": "Triangle",
            "status": 0,
            "precedents": [{"dataset_name": "Paid Loss"}],
        }
        self._write_sidecar()
        self._record_dependencies()
        contracts = {
            "calculated loss": {
                "name": "Calculated Loss",
                "data_format": "Triangle",
                "formula": '"Paid Loss" * 2',
                "precedents": ["Paid Loss"],
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

    def _write_sidecar(self) -> None:
        self.sidecar_path.write_text(
            json.dumps(self.sidecar_payload), encoding="utf-8"
        )

    def _record_dependencies(self, formula: str = '"Paid Loss" * 2') -> None:
        # The sidecar names the precedent only; the file it was read from and
        # its fingerprint are the technical record beside the CSV.
        runtime_cache_provenance_service.record_calculated(
            str(self.data_path),
            identity=runtime_cache_provenance_service.calculated_cache_identity(
                str(self.data_path),
                project_name="Example Project",
                reserving_class="Example RC",
                dataset_name="Calculated Loss",
                dataset_type="Calculated Loss",
            ),
            formula=formula,
            dependencies=[
                {
                    "dataset_type": "Paid Loss",
                    "dataset_name": "Paid Loss",
                    "path": str(self.dependency_path),
                    **runtime_cache_provenance_service.file_fingerprint(str(self.dependency_path)),
                }
            ],
        )

    def _write_current_index(self) -> None:
        payload = build_dataset_index_payload(
            "Example Project", "Example RC", self.rc_dir
        )
        write_index_json_unlocked(str(self.rc_dir / INDEX_FILE_NAME), payload)

    def test_trusted_class_skips_the_per_precedent_walk(self) -> None:
        self._write_current_index()
        with patch.object(
            arcrho_runtime_service,
            "_stored_file_fingerprint_matches",
            wraps=arcrho_runtime_service._stored_file_fingerprint_matches,
        ) as fingerprint_check:
            self.assertTrue(
                arcrho_runtime_service.arcrho_tri_cache_matches(
                    str(self.data_path), self.pairs
                )
            )
            fingerprint_check.assert_not_called()

    def test_moved_folder_signature_falls_back_to_deep_validation(self) -> None:
        self._write_current_index()
        self.dependency_path.write_text("100\n", encoding="utf-8")
        self.assertFalse(
            arcrho_runtime_service.arcrho_tri_cache_matches(
                str(self.data_path), self.pairs
            )
        )

    def test_review_needed_status_falls_back_to_deep_validation(self) -> None:
        self.sidecar_payload["status"] = 2
        self._write_sidecar()
        self._write_current_index()
        with patch.object(
            arcrho_runtime_service,
            "_stored_file_fingerprint_matches",
            wraps=arcrho_runtime_service._stored_file_fingerprint_matches,
        ) as fingerprint_check:
            self.assertTrue(
                arcrho_runtime_service.arcrho_tri_cache_matches(
                    str(self.data_path), self.pairs
                )
            )
            self.assertGreater(fingerprint_check.call_count, 0)

    def test_missing_index_keeps_deep_validation(self) -> None:
        with patch.object(
            arcrho_runtime_service,
            "_stored_file_fingerprint_matches",
            wraps=arcrho_runtime_service._stored_file_fingerprint_matches,
        ) as fingerprint_check:
            self.assertTrue(
                arcrho_runtime_service.arcrho_tri_cache_matches(
                    str(self.data_path), self.pairs
                )
            )
            self.assertGreater(fingerprint_check.call_count, 0)

    def test_invalid_index_json_falls_back_silently(self) -> None:
        (self.rc_dir / INDEX_FILE_NAME).write_text("{not json", encoding="utf-8")
        self.assertTrue(
            arcrho_runtime_service.arcrho_tri_cache_matches(
                str(self.data_path), self.pairs
            )
        )

    def test_contract_drift_rejects_even_when_class_is_trusted(self) -> None:
        # A Dataset Type formula change is config drift the folder signature
        # cannot see; the drift check stays ahead of the trust short-circuit.
        self._write_current_index()
        # The record beside the CSV says the cache was built with "* 2"; the
        # Dataset Type now says "* 3". Nothing in the class folder moved.
        with patch.object(
            calculated_dataset_service,
            "calculated_dataset_contract",
            return_value={
                "name": "Calculated Loss",
                "data_format": "Triangle",
                "formula": '"Paid Loss" * 3',
                "precedents": ["Paid Loss"],
            },
        ):
            self.assertFalse(
                arcrho_runtime_service.arcrho_tri_cache_matches(
                    str(self.data_path), self.pairs
                )
            )


if __name__ == "__main__":
    unittest.main()
