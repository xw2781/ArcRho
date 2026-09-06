from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
if str(FRONTEND_ROOT) not in sys.path:
    sys.path.insert(0, str(FRONTEND_ROOT))

from app_server.services import dataset_service


class DatasetSidecarGraphLookupTests(unittest.TestCase):
    """The Details graph costs one index read, not one read per chip.

    Over a network share every file open is a full round trip, so a method with
    a dozen precedents and dependents used to keep the Details tab empty for
    seconds. The reserving-class index already names every instance's dataset
    type and method type, so the neighbours resolve from that single read.
    """

    def test_the_graph_resolves_from_the_index_without_reading_neighbour_sidecars(self) -> None:
        main_payload = {
            "dataset_name": "Output",
            "dataset_type": "Output",
            "data_format": "Vector",
            "period_length": 12,
            "precedents": ["Input A", "Input B", "Input C", "Input D"],
            "dependents": ["Dependent"],
        }
        read_paths: list[str] = []

        def read_sidecar(path: str):
            read_paths.append(path)
            return main_payload if Path(path).stem == "Output" else {}

        calculation_map = {"dependent": (True, "Input A + Input B")}
        index_map = {
            f"input {letter}".lower(): {
                "dataset_name": f"Input {letter}",
                "dataset_type": f"Input {letter}",
                "method_type": "DFM",
            }
            for letter in ("A", "B", "C", "D")
        }
        index_map["dependent"] = {
            "dataset_name": "Dependent",
            "dataset_type": "Dependent",
            "method_type": "None",
        }

        with (
            mock.patch.object(
                dataset_service,
                "_get_dataset_sidecar_path",
                side_effect=lambda _p, _rc, name, *args, **kwargs: str(
                    Path("sidecars") / f"{name}.json"
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
                "_dataset_index_entry_map",
                return_value=index_map,
            ) as index_lookup,
        ):
            result = dataset_service.load_dataset_sidecar("Project", "Path", "Output")

        self.assertEqual(calculation_lookup.call_count, 1)
        self.assertEqual(index_lookup.call_count, 1)
        # Only the requested dataset's own sidecar is opened; the five chips add
        # no reads of their own.
        self.assertEqual([Path(path).stem for path in read_paths], ["Output"])
        self.assertEqual(
            [item["method_type"] for item in result["precedents"]],
            ["DFM", "DFM", "DFM", "DFM"],
        )
        self.assertEqual(result["dependents"][0]["formula"], "Input A + Input B")

    def test_the_load_answers_with_both_the_displayed_and_the_stored_shape(self) -> None:
        """The window reopens at the saved view; the stored pair says how fine
        the data underneath it really is."""

        payload = {
            "dataset_name": "Output",
            "dataset_type": "Output",
            "data_format": "Triangle",
            "origin_length": 12,
            "development_length": 12,
            "stored_origin_length": 1,
            "stored_development_length": 3,
        }

        with (
            mock.patch.object(dataset_service, "_get_dataset_sidecar_path", return_value="Output.json"),
            mock.patch.object(dataset_service, "_read_dataset_sidecar", return_value=payload),
            mock.patch.object(dataset_service, "_dataset_type_calculation_map", return_value={}),
            mock.patch.object(dataset_service, "_dataset_index_entry_map", return_value={}),
        ):
            result = dataset_service.load_dataset_sidecar("Project", "Path", "Output")

        self.assertEqual((result["origin_length"], result["development_length"]), (12, 12))
        self.assertEqual(
            (result["stored_origin_length"], result["stored_development_length"]),
            (1, 3),
        )

    def test_a_graphless_sidecar_never_reads_the_index(self) -> None:
        payload = {"dataset_name": "Output", "dataset_type": "Output", "data_format": "Triangle"}

        with (
            mock.patch.object(dataset_service, "_get_dataset_sidecar_path", return_value="Output.json"),
            mock.patch.object(dataset_service, "_read_dataset_sidecar", return_value=payload),
            mock.patch.object(dataset_service, "_dataset_type_calculation_map", return_value={}),
            mock.patch.object(dataset_service, "_dataset_index_entry_map", return_value={}) as index_lookup,
        ):
            dataset_service.load_dataset_sidecar("Project", "Path", "Output")

        self.assertEqual(index_lookup.call_count, 0)

    def test_an_unindexed_neighbour_still_answers_with_its_own_name(self) -> None:
        payload = {
            "dataset_name": "Output",
            "dataset_type": "Output",
            "data_format": "Triangle",
            "precedents": ["Not In The Index"],
        }

        with (
            mock.patch.object(dataset_service, "_get_dataset_sidecar_path", return_value="Output.json"),
            mock.patch.object(dataset_service, "_read_dataset_sidecar", return_value=payload),
            mock.patch.object(dataset_service, "_dataset_type_calculation_map", return_value={}),
            mock.patch.object(dataset_service, "_dataset_index_entry_map", return_value={}),
        ):
            result = dataset_service.load_dataset_sidecar("Project", "Path", "Output")

        entry = result["precedents"][0]
        self.assertEqual(entry["dataset_name"], "Not In The Index")
        self.assertEqual(entry["dataset_type"], "Not In The Index")
        self.assertEqual(entry["method_type"], dataset_service.dataset_sidecar_status_service.METHOD_TYPE_NONE)


if __name__ == "__main__":
    unittest.main()
