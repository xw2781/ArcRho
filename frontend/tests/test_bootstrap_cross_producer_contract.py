"""A Bootstrap imported from ResQ equals the one the app server saves.

The ResQ import builds the method from ResQ's settings and the Arco DFM it has
just written; the app server builds it from the page's settings and the same
DFM on disk. Fed the same inputs, both must write the same method JSON, the
same output CSV and an equivalent output sidecar.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


REPO_ROOT = Path(__file__).resolve().parents[2]
TEST_TEMP_ROOT = REPO_ROOT / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
for path in (
    REPO_ROOT / "frontend",
    REPO_ROOT / "python-api" / "src",
    REPO_ROOT / "python-api" / "migration",
    REPO_ROOT / "python-api" / "tests",
):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from arcrho_api.io import persisted_json_text
from app_server.services import (
    bootstrap_service,
    calculated_dataset_service,
    dataset_sidecar_status_service,
)
from dependent_propagation_workspace_stub import IsolatedPropagationWorkspace
from resq_migration import extractors
from resq_migration.number_formats import configure_number_formats_path
from test_resq_bootstrap_migration import (
    DFM_NAME,
    DFM_OUTPUT_DATASET,
    MODIFIED,
    SEGMENT,
    _Bootstrap,
    dfm_payload,
    expected_owned,
)

PROJECT = "NJ_Annual_Prod_202605_Fake"
RESERVING_CLASS = SEGMENT["reserving_class"]
TARGET_NAME = SEGMENT["settings"]["target_ultimate"].strip()
BOOTSTRAP_NAME = SEGMENT["name"]
# Fields a save stamps with who saved it; the import stamps ResQ's user.
_ACTOR_FIELDS = {"modified_by", "audit_log"}


class BootstrapCrossProducerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        root = Path(self.temp.name)
        self.service_dir = root / "service"
        self.import_dir = root / "import"
        for base in (self.service_dir, self.import_dir):
            for folder in ("methods", "datasets", "sidecars"):
                (base / folder).mkdir(parents=True)
        settings = root / "general_settings.json"
        settings.write_text(
            '{"origin_start_date":"201701","origin_end_date":"202612","development_end_date":"202612"}',
            encoding="utf-8",
        )
        self.patchers = [
            IsolatedPropagationWorkspace(),
            mock.patch.object(bootstrap_service.config, "get_general_settings_path", return_value=str(settings)),
            mock.patch.object(
                bootstrap_service.config,
                "get_project_method_data_dir",
                return_value=str(self.service_dir / "methods"),
            ),
            mock.patch.object(
                bootstrap_service.config,
                "get_project_dataset_cache_dir",
                return_value=str(self.service_dir / "datasets"),
            ),
            mock.patch.object(
                dataset_sidecar_status_service,
                "sidecar_path",
                side_effect=lambda _p, _r, name: str(self.service_dir / "sidecars" / f"{name}.json"),
            ),
            mock.patch.object(dataset_sidecar_status_service, "update_precedent_dependents", return_value={}),
            mock.patch.object(calculated_dataset_service, "_dataset_type_rows", return_value=[]),
            mock.patch.object(calculated_dataset_service, "_existing_dataset_keys", return_value=set()),
            mock.patch.object(bootstrap_service, "_now", return_value=MODIFIED),
            mock.patch.object(
                bootstrap_service.user_identity_service, "get_current_display_name", return_value="Moore, Kelly"
            ),
        ]
        for patcher in self.patchers:
            patcher.start()
        configure_number_formats_path(root)
        extractors.configure_extractors(
            project_name=PROJECT,
            rs_json_format="arcrho-result-selection-v4",
            method_data_dir="methods",
        )
        self.dfm = dfm_payload()
        self._write_service_precedents()

    def tearDown(self) -> None:
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.temp.cleanup()

    def _write(self, path: Path, payload: dict) -> None:
        path.write_text(persisted_json_text(payload), encoding="utf-8", newline="\n")

    def _write_service_precedents(self) -> None:
        labels = SEGMENT["origin_labels"]
        self._write(self.service_dir / "methods" / f"DFM@{DFM_NAME}.json", self.dfm)
        for name, method_type, source_kind in (
            (DFM_OUTPUT_DATASET, dataset_sidecar_status_service.METHOD_TYPE_DFM, "dfm"),
            (TARGET_NAME, dataset_sidecar_status_service.METHOD_TYPE_RESULT_SELECTION, "result_selection"),
        ):
            self._write(
                self.service_dir / "sidecars" / f"{name}.json",
                {
                    "dataset_name": name,
                    "dataset_type": "F 00 - Ultimate Net Loss",
                    "method_name": DFM_NAME if source_kind == "dfm" else name,
                    "method_type": method_type,
                    "source_kind": source_kind,
                    "data_format": "Vector",
                    "period_length": 12,
                    "stored_period_length": 12,
                    "csv_file": f"{name}@12.csv",
                    "status": dataset_sidecar_status_service.STATUS_CURRENT,
                    "origin_labels": labels,
                    "precedents": [],
                    "dependents": [],
                },
            )
        (self.service_dir / "datasets" / f"{TARGET_NAME}@12.csv").write_text(
            "".join(f"{value!r}\n" for value in SEGMENT["target_ultimates"]),
            encoding="utf-8",
            newline="\n",
        )

    def _service_save(self) -> None:
        # The page sends only what the user owns; the DFM snapshot is the server's.
        owned = expected_owned()
        with mock.patch.object(
            calculated_dataset_service,
            "recalculate_dependents",
            return_value={"ok": True, "updated": [], "index_ok": True, "index_error": ""},
        ):
            bootstrap_service.save_bootstrap_method(PROJECT, RESERVING_CLASS, owned)

    def _import(self) -> None:
        payload = extractors.export_bootstrap(_Bootstrap(), dfm_payload=self.dfm)
        extractors.write_bootstrap_export(
            payload, RESERVING_CLASS, self.import_dir, dfm_payload=self.dfm
        )

    def test_import_writes_what_the_app_server_saves(self) -> None:
        self._service_save()
        self._import()
        method_file = f"BST@{BOOTSTRAP_NAME}.json"
        self.assertEqual(
            (self.import_dir / "methods" / method_file).read_text(encoding="utf-8"),
            (self.service_dir / "methods" / method_file).read_text(encoding="utf-8"),
        )
        csv_file = f"{BOOTSTRAP_NAME}@12.csv"
        self.assertEqual(
            (self.import_dir / "datasets" / csv_file).read_text(encoding="utf-8"),
            (self.service_dir / "datasets" / csv_file).read_text(encoding="utf-8"),
        )
        sidecar_file = f"{BOOTSTRAP_NAME}.json"
        imported = json.loads((self.import_dir / "sidecars" / sidecar_file).read_text(encoding="utf-8"))
        saved = json.loads((self.service_dir / "sidecars" / sidecar_file).read_text(encoding="utf-8"))
        for payload in (imported, saved):
            for field in _ACTOR_FIELDS:
                payload.pop(field, None)
        # The import carries ResQ's method notes; a first save has none yet.
        self.assertEqual(imported.pop("notes"), _Bootstrap.Notes)
        saved.pop("notes")
        self.assertEqual(imported, saved)
        self.assertEqual(
            [entry["dataset_name"] for entry in imported["precedents"]],
            [DFM_OUTPUT_DATASET, TARGET_NAME],
        )


if __name__ == "__main__":
    unittest.main()
