from __future__ import annotations

import os
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest import mock


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
if str(FRONTEND_ROOT) not in sys.path:
    sys.path.insert(0, str(FRONTEND_ROOT))

from app_server.services import dataset_service


class DatasetSidecarParallelLoadTests(unittest.TestCase):
    def test_graph_metadata_reuses_shared_lookups_and_reads_sidecars_concurrently(self) -> None:
        main_payload = {
            "dataset_name": "Output",
            "dataset_type": "Output",
            "data_format": "Vector",
            "period_length": 12,
            "precedents": ["Input A", "Input B", "Input C", "Input D"],
            "dependents": ["Dependent"],
        }
        active = 0
        max_active = 0
        activity_lock = threading.Lock()

        def read_sidecar(path: str):
            nonlocal active, max_active
            name = Path(path).stem
            if name == "Output":
                return main_payload
            with activity_lock:
                active += 1
                max_active = max(max_active, active)
            time.sleep(0.02)
            with activity_lock:
                active -= 1
            return {
                "dataset_name": name,
                "dataset_type": name,
                "data_format": "Vector",
            }

        calculation_map = {
            "dependent": (True, "Input A + Input B"),
        }
        method_type_map = {
            f"input {letter}".lower(): "DFM"
            for letter in ("A", "B", "C", "D")
        }

        with (
            mock.patch.object(
                dataset_service,
                "_get_dataset_sidecar_path",
                side_effect=lambda _p, _rc, name, *args, **kwargs: os.path.join(
                    "sidecars",
                    f"{name}.json",
                ),
            ),
            mock.patch.object(dataset_service, "_read_dataset_sidecar", side_effect=read_sidecar),
            mock.patch.object(
                dataset_service,
                "_dataset_type_calculation_map",
                return_value=calculation_map,
            ) as calculation_lookup,
            mock.patch.object(
                dataset_service,
                "_dataset_index_method_type_map",
                return_value=method_type_map,
            ) as method_lookup,
        ):
            result = dataset_service.load_dataset_sidecar("Project", "Path", "Output")

        self.assertEqual(calculation_lookup.call_count, 1)
        self.assertEqual(method_lookup.call_count, 1)
        self.assertGreater(max_active, 1)
        self.assertEqual(
            [item["method_type"] for item in result["precedents"]],
            ["DFM", "DFM", "DFM", "DFM"],
        )
        self.assertEqual(result["dependents"][0]["formula"], "Input A + Input B")


if __name__ == "__main__":
    unittest.main()
