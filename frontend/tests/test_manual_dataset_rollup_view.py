"""A coarser view of a hand-entered dataset is built fresh, never read back."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

FRONTEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = FRONTEND_ROOT.parent
TEST_TEMP_ROOT = REPO_ROOT / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
if str(FRONTEND_ROOT) not in sys.path:
    sys.path.insert(0, str(FRONTEND_ROOT))

from app_server import config
from app_server.services import (
    arcrho_runtime_service,
    dataset_service,
    engine_calculation_service,
    precedent_cache_service,
)

# The text a worksheet formula receives for the yearly view of the monthly
# triangle these tests store. Written out rather than compared against a file,
# because no coarser view is ever written to disk: this is the one place the
# spelling of those numbers is pinned.
EXPECTED_VIEW_CSV_TEXT = "7800.0,22200.0\r\n7800.0,\r\n"

# The same, for the yearly view of the monthly vector: twelve months added up
# into one figure per year.
EXPECTED_VECTOR_VIEW_CSV_TEXT = "7800.0\r\n22200.0\r\n"


class ManualDatasetRollupViewTests(unittest.TestCase):
    project_name = "Example Project"
    reserving_class = "Example Reserving Class"
    dataset_name = "Paid Losses"

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(TEST_TEMP_ROOT))
        root = Path(self.temp_dir.name)
        self.cache_dir = root / "data" / self.reserving_class / config.DATASET_CACHE_DIR
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.sidecar_dir = self.cache_dir.parent / config.DATASET_SIDECAR_DIR
        self.sidecar_dir.mkdir(parents=True, exist_ok=True)
        # Twenty-four monthly origins valued at the end of the second year, so
        # the yearly view is valued at 12 and 24 months of age.
        settings_path = root / "general_settings.json"
        settings_path.write_text(
            '{"origin_start_date":"202301","origin_end_date":"202412","development_end_date":"202412"}',
            encoding="utf-8",
        )
        self._settings_patch = patch.object(
            config, "get_general_settings_path", return_value=str(settings_path)
        )
        self._settings_patch.start()
        self.addCleanup(self._settings_patch.stop)

        self.stored_csv = self.cache_dir / f"{self.dataset_name}@1@1@cum@dev.csv"
        self.view_csv = self.cache_dir / f"{self.dataset_name}@12@12@cum@dev.csv"
        self.add_in_view_dir = self.cache_dir / config.TEMPORARY_VIEW_DATASET_CACHE_DIR
        self.add_in_view_csv = self.add_in_view_dir / self.view_csv.name
        self._write_stored_rows(100.0)

        sidecar = {
            "dataset_name": self.dataset_name,
            "dataset_type": self.dataset_name,
            "reserving_class": self.reserving_class,
            "project_name": self.project_name,
            "source_kind": "input",
            "data_format": "Triangle",
            "csv_file": self.stored_csv.name,
            "cumulative": True,
            "calendar": False,
            "origin_length": 12,
            "development_length": 12,
            "stored_origin_length": 1,
            "stored_development_length": 1,
        }
        (self.sidecar_dir / f"{self.dataset_name}.json").write_text(
            json.dumps(sidecar, indent=2), encoding="utf-8"
        )

    def tearDown(self) -> None:
        config.DATASETS.clear()
        config.DATASET_ROLLUPS.clear()
        self.temp_dir.cleanup()

    def _write_stored_rows(self, scale: float) -> None:
        """A 24-month cumulative triangle whose every cell is scale x age."""
        lines = []
        for row in range(24):
            cells = [f"{scale * (col + 1):.1f}" for col in range(24 - row)]
            cells += [""] * row
            lines.append(",".join(cells))
        self.stored_csv.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def _pairs(self) -> list:
        return [
            ("Function", "ArcRhoTri"),
            ("Path", self.reserving_class),
            ("DatasetName", self.dataset_name),
            ("InstanceName", self.dataset_name),
            ("ProjectName", self.project_name),
            ("Cumulative", "True"),
            ("Calendar", "False"),
            ("OriginLength", "12"),
            ("DevelopmentLength", "12"),
        ]

    def _resolve_view(self) -> dict:
        return arcrho_runtime_service.resolve_local_triangle_cache(
            str(self.view_csv),
            self._pairs(),
        )

    def _view_values(self, result: dict) -> list:
        ds_id = arcrho_runtime_service._register_arcrho_dataset(
            str(result["data_path"]), self._pairs()
        )
        rolled_up = dataset_service._rolled_up_dataset(ds_id)
        self.assertIsNotNone(rolled_up, "the coarser view is not served from memory")
        frame = rolled_up[0]
        return frame.values.tolist()

    def test_coarser_view_is_derived_without_writing_a_variant(self) -> None:
        result = self._resolve_view()

        self.assertTrue(result["ok"])
        self.assertEqual(result["status"], "cache_derived")
        self.assertTrue(result["derived"]["in_memory"])
        self.assertFalse(
            self.view_csv.exists(),
            "a coarser copy of a hand-entered dataset was written beside it",
        )
        values = self._view_values(result)
        self.assertEqual(len(values), 2)
        self.assertEqual(values[0][0], 7800.0)

    def test_edited_figures_reach_the_coarser_view(self) -> None:
        first = self._view_values(self._resolve_view())
        self._write_stored_rows(200.0)
        second = self._view_values(self._resolve_view())

        self.assertEqual(first[0][0], 7800.0)
        self.assertEqual(second[0][0], 15600.0)

    def test_a_leftover_coarser_copy_is_never_served(self) -> None:
        self.view_csv.write_text("1,2\n3,4\n", encoding="utf-8")

        result = self._resolve_view()

        self.assertEqual(result["status"], "cache_derived")
        self.assertTrue(result["derived"]["in_memory"])
        self.assertEqual(self.view_csv.read_text(encoding="utf-8"), "1,2\n3,4\n")
        self.assertEqual(self._view_values(result)[0][0], 7800.0)

    def _cache_dir_patches(self) -> ExitStack:
        stack = ExitStack()
        stack.enter_context(
            patch.object(
                config, "get_project_dataset_cache_dir", return_value=str(self.cache_dir)
            )
        )
        stack.enter_context(
            patch.object(
                config,
                "get_project_temporary_view_dataset_cache_dir",
                return_value=str(self.add_in_view_dir),
            )
        )
        return stack

    def _hosted_answer(self) -> dict:
        with self._cache_dir_patches():
            return arcrho_runtime_service.run_arcrho_dataset_csv(
                self._pairs(), timeout_sec=15.0
            )

    def test_the_hosted_text_is_the_view_without_the_file(self) -> None:
        """Excel gets the figures themselves, and nothing is written down."""

        answer = self._hosted_answer()

        self.assertTrue(answer["ok"])
        self.assertEqual(answer["local_cache_status"], "cache_derived")
        self.assertTrue(answer["derived"]["in_memory"])
        self.assertEqual(answer["csv_text"], EXPECTED_VIEW_CSV_TEXT)
        self.assertFalse(
            self.view_csv.exists(), "a coarser copy was written beside the stored data"
        )
        self.assertFalse(
            self.add_in_view_dir.exists(),
            "a coarser copy was written into the reserving class's view cache",
        )

    def test_the_hosted_text_follows_the_edited_figures(self) -> None:
        first = self._hosted_answer()["csv_text"]
        self._write_stored_rows(200.0)
        second = self._hosted_answer()["csv_text"]

        self.assertEqual(float(first.splitlines()[0].split(",")[0]), 7800.0)
        self.assertEqual(float(second.splitlines()[0].split(",")[0]), 15600.0)


class ManualVectorRollupViewTests(unittest.TestCase):
    """A hand-entered vector read at a coarser period than it is stored at.

    There is nothing behind such a vector to produce it again, so a yearly
    reading of a monthly one has to be added up from the figures that were
    typed in. Asking the data engine for it instead is what put a
    configuration error into a worksheet cell.
    """

    project_name = "Example Project"
    reserving_class = "Example Reserving Class"
    dataset_name = "Prior Selected"

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(TEST_TEMP_ROOT))
        root = Path(self.temp_dir.name)
        self.cache_dir = root / "data" / self.reserving_class / config.DATASET_CACHE_DIR
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.sidecar_dir = self.cache_dir.parent / config.DATASET_SIDECAR_DIR
        self.sidecar_dir.mkdir(parents=True, exist_ok=True)
        settings_path = root / "general_settings.json"
        settings_path.write_text(
            '{"origin_start_date":"202301","origin_end_date":"202412","development_end_date":"202412"}',
            encoding="utf-8",
        )
        self._settings_patch = patch.object(
            config, "get_general_settings_path", return_value=str(settings_path)
        )
        self._settings_patch.start()
        self.addCleanup(self._settings_patch.stop)

        self.stored_csv = self.cache_dir / f"{self.dataset_name}@1.csv"
        self.view_csv = self.cache_dir / f"{self.dataset_name}@12.csv"
        self.add_in_view_dir = self.cache_dir / config.TEMPORARY_VIEW_DATASET_CACHE_DIR
        self._write_stored_rows(100.0)

        sidecar = {
            "dataset_name": self.dataset_name,
            "dataset_type": self.dataset_name,
            "reserving_class": self.reserving_class,
            "project_name": self.project_name,
            "source_kind": "input",
            "data_format": "Vector",
            "csv_file": self.stored_csv.name,
            "period_length": 12,
            "stored_period_length": 1,
        }
        (self.sidecar_dir / f"{self.dataset_name}.json").write_text(
            json.dumps(sidecar, indent=2), encoding="utf-8"
        )

    def tearDown(self) -> None:
        config.DATASETS.clear()
        config.DATASET_ROLLUPS.clear()
        self.temp_dir.cleanup()

    def _write_stored_rows(self, scale: float) -> None:
        """Twenty-four monthly figures, the nth of them scale x n."""
        lines = [f"{scale * (row + 1):.1f}" for row in range(24)]
        self.stored_csv.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def _pairs(self) -> list:
        return [
            ("Function", "ArcRhoVec"),
            ("Path", self.reserving_class),
            ("DatasetName", self.dataset_name),
            ("ProjectName", self.project_name),
            ("Cumulative", "True"),
            ("Transposed", "False"),
            ("OriginLength", "12"),
            ("DevelopmentLength", "12"),
        ]

    def _hosted_answer(self) -> dict:
        def refuse(*args, **kwargs):
            self.fail("the data engine was asked to produce a hand-entered vector")

        with ExitStack() as stack:
            stack.enter_context(
                patch.object(
                    config,
                    "get_project_dataset_cache_dir",
                    return_value=str(self.cache_dir),
                )
            )
            stack.enter_context(
                patch.object(
                    config,
                    "get_project_temporary_view_dataset_cache_dir",
                    return_value=str(self.add_in_view_dir),
                )
            )
            stack.enter_context(
                patch.object(
                    engine_calculation_service, "run_engine_calculation", refuse
                )
            )
            return arcrho_runtime_service.run_arcrho_dataset_csv(
                self._pairs(), timeout_sec=15.0
            )

    def test_the_yearly_reading_adds_the_stored_months_up(self) -> None:
        answer = self._hosted_answer()

        self.assertTrue(answer["ok"])
        self.assertEqual(answer["local_cache_status"], "cache_derived")
        self.assertTrue(answer["derived"]["in_memory"])
        self.assertEqual(answer["csv_text"], EXPECTED_VECTOR_VIEW_CSV_TEXT)

    def test_nothing_is_written_beside_the_stored_figures(self) -> None:
        self._hosted_answer()

        self.assertFalse(
            self.view_csv.exists(),
            "a coarser copy of a hand-entered vector was written beside it",
        )
        self.assertFalse(
            self.add_in_view_dir.exists(),
            "a coarser copy was written into the reserving class's view cache",
        )

    def test_a_leftover_coarser_copy_is_never_served(self) -> None:
        self.view_csv.write_text("1\n2\n", encoding="utf-8")

        answer = self._hosted_answer()

        self.assertEqual(answer["csv_text"], EXPECTED_VECTOR_VIEW_CSV_TEXT)
        self.assertEqual(self.view_csv.read_text(encoding="utf-8"), "1\n2\n")

    def test_the_reading_follows_the_edited_figures(self) -> None:
        first = self._hosted_answer()["csv_text"]
        self._write_stored_rows(200.0)
        second = self._hosted_answer()["csv_text"]

        self.assertEqual(float(first.splitlines()[0]), 7800.0)
        self.assertEqual(float(second.splitlines()[0]), 15600.0)


def _project_development_headers(
    _ds_id: str,
    _path: str,
    _project_name: str,
    period_length: int,
    *,
    period_type: int = 0,
    transposed: bool = False,
    calendar: bool = False,
) -> list:
    """The project's own development ages at the period asked for.

    Origins run 2023-2024 and the valuation date is the end of 2024, so a
    yearly view is aged 12m and 24m and a quarterly file is aged 3m upward.
    """

    step = max(1, int(period_length))
    return [str(step * (index + 1)) for index in range(36 // step)]


class CallerNamedLengthsReadTests(unittest.TestCase):
    """A dataset read at the lengths the caller names, not its file's own.

    A cell link counts its index in the periods of the grid it was typed
    into, so the reader has to serve any source at that grid's lengths: a
    finer hand-entered one is added up, a generated one is produced again,
    and one that cannot be brought there is refused instead of answering
    with the rows its file happens to hold.
    """

    project_name = "Example Project"
    reserving_class = "Example Reserving Class"

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(TEST_TEMP_ROOT))
        root = Path(self.temp_dir.name)
        self.cache_dir = root / config.DATASET_CACHE_DIR
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        settings_path = root / "general_settings.json"
        settings_path.write_text(
            '{"origin_start_date":"202301","origin_end_date":"202412","development_end_date":"202412"}',
            encoding="utf-8",
        )
        # A hand-entered vector kept one figure per month, the case the user
        # types "=[A][1]" against while looking at a yearly grid.
        self.vector_csv = self.cache_dir / "Exposure@1.csv"
        self.vector_csv.write_text(
            "\n".join(f"{100.0 * (row + 1):.1f}" for row in range(24)) + "\n",
            encoding="utf-8",
        )
        self.vector_sidecar = {
            "dataset_name": "Exposure",
            "dataset_type": "Exposure",
            "data_format": "Vector",
            "source_kind": "input",
            "csv_file": self.vector_csv.name,
            "period_length": 12,
            "stored_period_length": 1,
        }
        # A hand-entered triangle kept at yearly origins and quarterly columns.
        self.triangle_csv = self.cache_dir / "Case@12@3@cum@dev.csv"
        first = ",".join(str(3 * (column + 1)) for column in range(8))
        second = ",".join(str(3 * (column + 1)) for column in range(4)) + "," * 4
        self.triangle_csv.write_text(f"{first}\n{second}\n", encoding="utf-8")
        self.triangle_sidecar = {
            "dataset_name": "Case",
            "dataset_type": "Case",
            "data_format": "Triangle",
            "source_kind": "input",
            "csv_file": self.triangle_csv.name,
            "cumulative": True,
            "calendar": False,
            "origin_length": 12,
            "development_length": 12,
            "stored_origin_length": 12,
            "stored_development_length": 3,
        }
        # A generated triangle, whose stored pair records how fine the
        # project's source table is rather than the shape of its own cache.
        self.engine_csv = self.cache_dir / "Ultimate@12@12@cum@dev.csv"
        self.engine_csv.write_text("40,80\n40,\n", encoding="utf-8")
        self.engine_sidecar = {
            "dataset_name": "Ultimate",
            "dataset_type": "Ultimate",
            "data_format": "Triangle",
            "source_kind": "engine",
            "csv_file": "Ultimate@1@1@cum@dev.csv",
            "cumulative": True,
            "calendar": False,
            "origin_length": 12,
            "development_length": 12,
            "stored_origin_length": 1,
            "stored_development_length": 1,
        }
        self.sidecar = self.vector_sidecar
        patches = [
            patch.object(
                config, "get_project_dataset_cache_dir", return_value=str(self.cache_dir)
            ),
            patch.object(config, "get_general_settings_path", return_value=str(settings_path)),
            patch.object(dataset_service, "_get_dataset_sidecar_path", return_value="sidecar.json"),
            patch.object(
                dataset_service,
                "_read_dataset_sidecar",
                side_effect=lambda _path: self.sidecar,
            ),
            patch.object(
                dataset_service,
                "_resolve_origin_labels",
                side_effect=lambda _id, _path, _project, _period, count: [
                    str(index) for index in range(count)
                ],
            ),
            patch.object(
                dataset_service,
                "_load_project_header_labels",
                side_effect=_project_development_headers,
            ),
        ]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)

    def tearDown(self) -> None:
        config.DATASETS.clear()
        config.DATASET_ROLLUPS.clear()
        self.temp_dir.cleanup()

    def _load(self, dataset_name: str, **kwargs: object) -> dict:
        return dataset_service.load_cached_dataset_values(
            self.project_name, self.reserving_class, dataset_name, **kwargs
        )

    def test_a_monthly_vector_answers_a_yearly_reader_in_years(self) -> None:
        result = self._load("Exposure", at_lengths=(12, 12))

        self.assertEqual(result["values"], [[7800.0], [22200.0]])
        self.assertEqual(result["origin_length"], 12)
        self.assertEqual(result["development_length"], 12)
        self.assertEqual(result["stored_period_length"], 1)
        # The file stays the only copy of the figures.
        self.assertEqual(result["csv_file"], self.vector_csv.name)
        self.assertFalse(Path(result["path"]).exists())

    def test_the_stored_lengths_read_the_file_as_before(self) -> None:
        result = self._load("Exposure", at_lengths=(1, 1))

        self.assertEqual(len(result["values"]), 24)
        self.assertEqual(result["values"][0], [100.0])
        self.assertEqual(result["origin_length"], 1)
        self.assertEqual(result["path"], str(self.vector_csv))
        self.assertEqual(config.DATASET_ROLLUPS, {})

    def test_a_quarterly_triangle_reads_as_the_yearly_grid_it_is_shown_at(self) -> None:
        self.sidecar = self.triangle_sidecar

        named = self._load("Case", at_lengths=(12, 12))
        shown = self._load("Case", at_display_shape=True)

        self.assertEqual(named["values"], [[12.0, 24.0], [12.0, None]])
        self.assertEqual(named["values"], shown["values"])
        self.assertEqual(
            (named["origin_length"], named["development_length"]),
            (shown["origin_length"], shown["development_length"]),
        )
        self.assertEqual(named["dev_labels"], ["12", "24"])

    def test_a_finer_reader_than_the_file_is_refused(self) -> None:
        self.sidecar = self.triangle_sidecar

        with self.assertRaises(HTTPException) as caught:
            self._load("Case", at_lengths=(12, 1))

        self.assertEqual(caught.exception.status_code, 422)
        self.assertIn("'Case'", caught.exception.detail)
        self.assertIn("12-month origins and 3-month development periods", caught.exception.detail)
        self.assertIn("12-month origins and 1-month development periods", caught.exception.detail)
        self.assertIn("finer to coarser", caught.exception.detail)

    def test_a_reader_that_is_not_a_whole_multiple_is_refused(self) -> None:
        self.sidecar = self.triangle_sidecar

        with self.assertRaises(HTTPException) as caught:
            self._load("Case", at_lengths=(12, 8))

        self.assertEqual(caught.exception.status_code, 422)
        self.assertIn("'Case'", caught.exception.detail)
        self.assertIn("whole multiples", caught.exception.detail)

    def test_a_generated_dataset_is_produced_again_at_those_lengths(self) -> None:
        self.sidecar = self.engine_sidecar

        with patch.object(
            precedent_cache_service,
            "materialize_engine_source",
            return_value=str(self.engine_csv),
        ) as materialize:
            result = self._load("Ultimate", at_lengths=(12, 12))

        materialize.assert_called_once_with(
            self.project_name, self.reserving_class, "Ultimate", self.engine_sidecar, 12, 12
        )
        self.assertEqual(result["csv_file"], self.engine_csv.name)
        self.assertEqual(result["values"], [[40.0, 80.0], [40.0, None]])
        self.assertEqual((result["origin_length"], result["development_length"]), (12, 12))
        self.assertEqual(config.DATASET_ROLLUPS, {})

    def test_a_generated_dataset_that_cannot_be_built_is_refused(self) -> None:
        self.sidecar = self.engine_sidecar

        with patch.object(
            precedent_cache_service,
            "materialize_engine_source",
            side_effect=RuntimeError("the data engine is unavailable"),
        ):
            with self.assertRaises(HTTPException) as caught:
                self._load("Ultimate", at_lengths=(12, 12))

        self.assertEqual(caught.exception.status_code, 422)
        self.assertIn("'Ultimate'", caught.exception.detail)
        self.assertIn("the data engine is unavailable", caught.exception.detail)

    def test_no_lengths_keeps_the_file_the_answer(self) -> None:
        self.sidecar = self.triangle_sidecar

        result = self._load("Case")

        self.assertEqual(len(result["values"][0]), 8)
        self.assertEqual((result["origin_length"], result["development_length"]), (12, 3))


if __name__ == "__main__":
    unittest.main()
