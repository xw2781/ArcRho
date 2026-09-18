"""A calculated formula reads a precedent at the shape the formula runs at.

A hand-entered precedent may be held finer than the grid it is shown and
calculated at -- an Excel-linked annual triangle saved one column per month is
the case this came from. Its own CSV then has a column for every stored period
and a cumulative 0 in every cell the annual view does not read, so a formula
evaluated on the raw file either fails to broadcast against its other
precedent or divides the wrong cells. The loader aggregates it to the output's
own shape first, the same in-memory read the methods' precedent resolver makes.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
FRONTEND_ROOT = REPO_ROOT / "frontend"
PYTHON_API_SRC = REPO_ROOT / "python-api" / "src"
TEST_TEMP_ROOT = REPO_ROOT / "test"
for path in (FRONTEND_ROOT, PYTHON_API_SRC):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from app_server import config
from app_server.services import calculated_dataset_service, dataset_service

# Three annual origins valued at 36 months: the newest cell of every row sits
# in its own 12th, 24th or 36th month, so a monthly store holds each row's
# annual figures in columns 11, 23 and 35 whatever calendar year it started.
ANNUAL_LOSS = [[100.0, 400.0, 900.0], [200.0, 500.0, None], [300.0, None, None]]
COUNTS = [[10.0, 20.0, 20.0], [8.0, 16.0, None], [5.0, None, None]]
VALUATION_MONTHS = 36


def _csv(rows: list[list[float | None]], width: int) -> str:
    return "\n".join(
        ",".join(
            "" if index >= len(row) or row[index] is None else str(row[index])
            for index in range(width)
        )
        for row in rows
    ) + "\n"


class CalculatedComponentStoredShapeTests(unittest.TestCase):
    def setUp(self) -> None:
        TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=str(TEST_TEMP_ROOT))
        root = Path(self.temp.name)
        self.datasets = root / config.DATASET_CACHE_DIR
        self.sidecars = root / config.DATASET_SIDECAR_DIR
        self.datasets.mkdir()
        self.sidecars.mkdir()
        self.patchers = [
            mock.patch.object(
                calculated_dataset_service.config,
                "get_project_dataset_cache_dir",
                return_value=str(self.datasets),
            ),
            mock.patch.object(
                calculated_dataset_service.precedent_cache_service.config,
                "get_project_dataset_cache_dir",
                return_value=str(self.datasets),
            ),
        ]
        for patcher in self.patchers:
            patcher.start()
        self.write_counts()

    def tearDown(self) -> None:
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.temp.cleanup()

    def write_source(self, name: str, csv_file: str, csv_text: str, sidecar: dict) -> None:
        (self.datasets / csv_file).write_text(csv_text, encoding="utf-8")
        payload = {
            "dataset_name": name,
            "dataset_type": name,
            "source_kind": "input",
            "data_format": "Triangle",
            "csv_file": csv_file,
            "cumulative": True,
            "calendar": False,
            "origin_length": 12,
            "development_length": 12,
            "stored_origin_length": 12,
            "stored_development_length": 12,
            **sidecar,
        }
        (self.sidecars / f"{name}.json").write_text(
            json.dumps(payload, indent=2) + "\n", encoding="utf-8"
        )

    def write_counts(self) -> None:
        self.write_source("Counts", "Counts@12@12@cum@dev.csv", _csv(COUNTS, 3), {})

    def load(self) -> dict:
        with mock.patch.object(dataset_service, "valuation_months", return_value=VALUATION_MONTHS):
            values, _precedents, errors = calculated_dataset_service._load_components(
                "Project",
                "Class",
                ["Loss", "Counts"],
                {"origin_length": 12, "development_length": 12, "cumulative": True, "calendar": False},
            )
        self.assertEqual(errors, [])
        return values

    def assert_annual_loss(self, matrix) -> None:
        rows = [[None if value != value else value for value in row] for row in matrix.tolist()]
        self.assertEqual(rows, ANNUAL_LOSS)

    def test_a_precedent_stored_at_its_display_shape_is_read_unchanged(self) -> None:
        self.write_source("Loss", "Loss@12@12@cum@dev.csv", _csv(ANNUAL_LOSS, 3), {})

        values = self.load()

        self.assert_annual_loss(values["_d0"])
        self.assertEqual(values["_d0"].shape, values["_d1"].shape)

    def test_a_precedent_stored_monthly_is_rolled_up_to_the_display_shape(self) -> None:
        monthly: list[list[float | None]] = [[None] * 36 for _ in ANNUAL_LOSS]
        for row_index, row in enumerate(ANNUAL_LOSS):
            for column_index, value in enumerate(row):
                if value is not None:
                    monthly[row_index][11 + 12 * column_index] = value
        self.write_source(
            "Loss",
            "Loss@12@1@cum@dev.csv",
            _csv(monthly, 36),
            {"stored_development_length": 1},
        )

        values = self.load()

        # Read raw, this precedent is 36 columns wide against the other's 3.
        self.assert_annual_loss(values["_d0"])
        self.assertEqual(values["_d0"].shape, values["_d1"].shape)

    def test_a_vector_precedent_resolves_to_the_copy_its_sidecar_names(self) -> None:
        # A vector keeps one period, so the ``@3`` and ``@6`` files beside its
        # own copy are coarser views an earlier release left behind. They share
        # the one sidecar and a vector states its period under
        # ``period_length``, so nothing in the candidate scoring can separate
        # them and the formula used to fail with "Ambiguous dependency".
        name = "Expected Net Loss % of Earned Premium"
        for period, rows in ((3, 12), (6, 6), (12, 3)):
            (self.datasets / f"{name}@{period}.csv").write_text(
                _csv([[float(index)] for index in range(rows)], 1), encoding="utf-8"
            )
        (self.sidecars / f"{name}.json").write_text(
            json.dumps(
                {
                    "dataset_name": name,
                    "dataset_type": name,
                    "source_kind": "input",
                    "data_format": "Vector",
                    "csv_file": f"{name}@12.csv",
                    "period_length": 12,
                    "stored_period_length": 12,
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )

        candidates = calculated_dataset_service._candidate_csvs(
            "Project",
            "Class",
            name,
            {"origin_length": 12, "development_length": 12, "cumulative": True, "calendar": False},
            expected_data_format="Vector",
        )

        self.assertEqual(
            [Path(item["path"]).name for item in candidates], [f"{name}@12.csv"]
        )

        quarterly_candidates = calculated_dataset_service._candidate_csvs(
            "Project",
            "Class",
            name,
            {"origin_length": 3, "development_length": 3, "cumulative": True, "calendar": False},
            expected_data_format="Vector",
        )

        self.assertEqual(
            [Path(item["path"]).name for item in quarterly_candidates], [f"{name}@3.csv"]
        )

        _values, _precedents, errors = calculated_dataset_service._load_components(
            "Project",
            "Class",
            [name],
            {"origin_length": 12, "development_length": 12, "cumulative": True, "calendar": False},
        )
        self.assertEqual(errors, [])

    def test_a_generated_precedents_source_granularity_is_not_rolled_up(self) -> None:
        # An engine dataset's stored pair says how fine the project's source
        # table is, not what shape the cache beside it holds, so its own CSV is
        # read as it stands.
        self.write_source(
            "Loss",
            "Loss@12@12@cum@dev.csv",
            _csv(ANNUAL_LOSS, 3),
            {"source_kind": "engine", "stored_origin_length": 1, "stored_development_length": 1},
        )

        values = self.load()

        self.assert_annual_loss(values["_d0"])

    def test_a_generated_precedent_at_another_period_is_rebuilt_at_the_formulas(self) -> None:
        # A quarterly formula vector reads a quarterly hand-entered vector as it
        # stands, but its Engine-generated precedent has only the annual cache
        # its sidecar names. That cache cannot be rolled up, so the loader asks
        # the Engine for the quarterly one, as a method reading it would.
        quarterly = {"origin_length": 3, "development_length": 3, "cumulative": True, "calendar": False}
        expected = "Expected Net Loss % of Earned Premium"
        premium = "Earned Premium"
        (self.datasets / f"{expected}@3.csv").write_text(
            _csv([[0.5]] * 12, 1), encoding="utf-8"
        )
        (self.sidecars / f"{expected}.json").write_text(
            json.dumps(
                {
                    "dataset_name": expected,
                    "dataset_type": expected,
                    "source_kind": "input",
                    "data_format": "Vector",
                    "csv_file": f"{expected}@3.csv",
                    "period_length": 3,
                    "stored_period_length": 3,
                }
            )
            + "\n",
            encoding="utf-8",
        )
        (self.datasets / f"{premium}@12.csv").write_text(
            _csv([[1200.0]] * 3, 1), encoding="utf-8"
        )
        (self.sidecars / f"{premium}.json").write_text(
            json.dumps(
                {
                    "dataset_name": premium,
                    "dataset_type": premium,
                    "source_kind": "engine",
                    "data_format": "Vector",
                    "csv_file": f"{premium}@12.csv",
                    "period_length": 12,
                    "stored_period_length": 1,
                }
            )
            + "\n",
            encoding="utf-8",
        )

        def materialize(project, reserving_class, dataset_name, sidecar, origin_length, development_length=None):
            path = self.datasets / f"{dataset_name}@{origin_length}.csv"
            path.write_text(_csv([[300.0]] * 12, 1), encoding="utf-8")
            return str(path)

        with mock.patch.object(
            calculated_dataset_service.precedent_cache_service,
            "materialize_engine_source",
            side_effect=materialize,
        ) as rebuilt:
            values, precedents, errors = calculated_dataset_service._load_components(
                "Project", "Class", [expected, premium], quarterly
            )

        self.assertEqual(errors, [])
        rebuilt.assert_called_once()
        self.assertEqual(rebuilt.call_args.args[2:5][::2], (premium, 3))
        self.assertEqual(rebuilt.call_args.kwargs, {"development_length": 3})
        self.assertEqual(values["_d0"].shape, (12, 1))
        self.assertEqual(values["_d1"].shape, (12, 1))
        self.assertEqual(Path(precedents[1]["path"]).name, f"{premium}@3.csv")

        # The annual formula reads the annual cache the sidecar names as is.
        with mock.patch.object(
            calculated_dataset_service.precedent_cache_service, "materialize_engine_source"
        ) as rebuilt:
            _values, _precedents, errors = calculated_dataset_service._load_components(
                "Project",
                "Class",
                [premium],
                {"origin_length": 12, "development_length": 12, "cumulative": True, "calendar": False},
            )
        self.assertEqual(errors, [])
        rebuilt.assert_not_called()


if __name__ == "__main__":
    unittest.main()
