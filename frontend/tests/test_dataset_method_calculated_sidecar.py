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


class DatasetMethodCalculatedSidecarTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
