"""A Stochastic Consolidation imported from ResQ equals the one the app server saves.

The ResQ import builds the method from ResQ's settings and the segment
bootstraps already in Arco; the app server builds it from the page's settings
and the same bootstraps on disk. Fed the same inputs, both must write the same
method JSON, the same output CSV and an equivalent output sidecar.
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

from app_server import config
from app_server.services import (
    calculated_dataset_service,
    stochastic_consolidation_service as service,
)
from dependent_propagation_workspace_stub import IsolatedPropagationWorkspace
from resq_migration import extractors
from resq_migration.core import _encode_rc_folder
from resq_migration.number_formats import configure_number_formats_path
from test_resq_stochastic_consolidation_migration import (
    CONSOLIDATION,
    HOST_CLASS,
    MODIFIED,
    PROJECT,
    _Consolidation,
    expected_owned,
    included,
    write_segment_bootstraps,
)

NAME = CONSOLIDATION["name"]
# Fields a save stamps with who saved it; the import stamps ResQ's user.
_ACTOR_FIELDS = {"modified_by", "audit_log"}


class StochasticConsolidationCrossProducerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        root = Path(self.temp.name)
        # Both producers read the same segment bootstraps; each writes its own host class.
        self.data_dir = root / "data"
        self.service_dir = self.data_dir / _encode_rc_folder(HOST_CLASS)
        self.import_dir = root / "import"
        for folder in ("methods", "datasets", "sidecars"):
            (self.import_dir / folder).mkdir(parents=True)
        settings = root / "general_settings.json"
        settings.write_text(
            '{"origin_start_date":"201701","origin_end_date":"202612","development_end_date":"202612"}',
            encoding="utf-8",
        )
        self.patchers = [
            IsolatedPropagationWorkspace(),
            mock.patch.object(config, "get_project_data_dir", return_value=str(self.data_dir)),
            mock.patch.object(config, "get_general_settings_path", return_value=str(settings)),
            mock.patch.object(calculated_dataset_service, "_dataset_type_rows", return_value=[]),
            mock.patch.object(calculated_dataset_service, "_existing_dataset_keys", return_value=set()),
            mock.patch.object(
                calculated_dataset_service,
                "recalculate_dependents",
                return_value={"ok": True, "updated": [], "index_ok": True, "index_error": ""},
            ),
            mock.patch.object(service, "_now", return_value=MODIFIED),
            mock.patch.object(
                service.user_identity_service, "get_current_display_name", return_value="Robot Worker"
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
        write_segment_bootstraps(self.data_dir)

    def tearDown(self) -> None:
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.temp.cleanup()

    def test_import_writes_what_the_app_server_saves(self) -> None:
        # The page sends only what the user owns.
        saved = service.save_stochastic_consolidation_method(PROJECT, HOST_CLASS, expected_owned())
        self.assertTrue(saved["consolidated"])
        payload = extractors.export_stochastic_consolidation(_Consolidation(), project_data_dir=self.data_dir)
        self.assertEqual(payload["_import_problem"], "")
        extractors.write_stochastic_consolidation_export(payload, HOST_CLASS, self.import_dir)

        method_file = f"SCON@{NAME}.json"
        self.assertEqual(
            (self.import_dir / "methods" / method_file).read_text(encoding="utf-8"),
            (self.service_dir / "methods" / method_file).read_text(encoding="utf-8"),
        )
        csv_file = f"{NAME}@12.csv"
        self.assertEqual(
            (self.import_dir / "datasets" / csv_file).read_text(encoding="utf-8"),
            (self.service_dir / "datasets" / csv_file).read_text(encoding="utf-8"),
        )
        sidecar_file = f"{NAME}.json"
        imported = json.loads((self.import_dir / "sidecars" / sidecar_file).read_text(encoding="utf-8"))
        published = json.loads((self.service_dir / "sidecars" / sidecar_file).read_text(encoding="utf-8"))
        for sidecar in (imported, published):
            for field in _ACTOR_FIELDS:
                sidecar.pop(field, None)
        # The import carries ResQ's method notes; a first save has none yet.
        self.assertEqual(imported.pop("notes"), _Consolidation.Notes)
        published.pop("notes")
        self.assertEqual(imported, published)
        self.assertEqual(
            [(entry["dataset_name"], entry.get("reserving_class")) for entry in imported["precedents"]],
            [(item["method_name"], item["reserving_class"]) for item in included()],
        )

    def test_an_imported_consolidation_reopens_up_to_date_in_the_app_server(self) -> None:
        payload = extractors.export_stochastic_consolidation(_Consolidation(), project_data_dir=self.data_dir)
        extractors.write_stochastic_consolidation_export(payload, HOST_CLASS, self.service_dir)

        loaded = service.load_stochastic_consolidation_method(PROJECT, HOST_CLASS, NAME)
        self.assertEqual(loaded["run_state"], service.STATE_UP_TO_DATE)
        self.assertEqual(loaded["stale_segments"], [])
        self.assertEqual([row["problems"] for row in loaded["segments"]], [[]] * len(included()))


if __name__ == "__main__":
    unittest.main()
