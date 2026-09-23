"""The export's ArcRho-to-ResQ average-row mapping is the exact inverse of the import.

``resq_migration.dfm.arcrho_average_rows_as_resq`` turns ArcRho's average
formula block into the ResQ definitions the export writes, and
``resq_average_rows_as_arcrho`` is the import's own reading of a ResQ row
(``export_dfm`` builds its settings from it). A row written one way and read
back the other must come out as the row ArcRho started with, for every row
kind the 2026-09-23 probe confirmed ResQ holds.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

_PYTHON_API = Path(__file__).resolve().parents[1]
for _path in (_PYTHON_API / "src", _PYTHON_API / "migration"):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from resq_migration import dfm as migration_dfm  # noqa: E402


def _average_formulas(rows, dev_count=4):
    """An ArcRho average formula block from (label, type, base, periods, exclude, formula) rows."""

    block = {
        "label": [],
        "custom_average_formula_settings": {"average_type": [], "base": [], "periods": [], "exclude": []},
        "inputs": [],
    }
    for label, average_type, base, periods, exclude, formula in rows:
        block["label"].append(label)
        settings = block["custom_average_formula_settings"]
        settings["average_type"].append(average_type)
        settings["base"].append(base)
        settings["periods"].append(periods)
        settings["exclude"].append(exclude)
        if isinstance(formula, list):
            block["inputs"].append(formula)
        elif formula:
            # The import's shape: the formula in every ratio column, the tail cell empty.
            block["inputs"].append([formula] * (dev_count - 1) + [""])
        else:
            block["inputs"].append([""] * dev_count)
    return block


def _resq_read_back(definitions):
    """What the import reads from ResQ rows holding *definitions*, as ResQ names them."""

    raw_names = [f"{index}: {entry['name']}" for index, entry in enumerate(definitions, start=1)]
    stored = [{"average_type": entry["average_type"], "formula": entry["formula"]} for entry in definitions]
    return migration_dfm.resq_average_rows_as_arcrho(raw_names, stored)


class ArcrhoAverageRowsAsResqTests(unittest.TestCase):
    ROWS = [
        ("Simple - all", "custom", "simple", "all", 0, ""),
        ("Volume - all", "custom", "volume", "all", 0, ""),
        ("Simple - 5", "custom", "simple", 5, 0, ""),
        ("Volume - 3 Ex hi/lo", "custom", "volume", 3, 1, ""),
        ("Simple - 6 Ex hi/lo x2", "custom", "simple", 6, 2, ""),
        ("Benchmark Pattern", "custom", "benchmark", "all", 0, ""),
        ("Calculated", "user_entry", "simple", "all", 0, '=("Simple - 5"+"Volume - 3 Ex hi/lo")/2'),
        ("User Entry", "user_entry", "simple", "all", 0, ""),
        ("User Entry 2", "user_entry", "simple", "all", 0, ""),
        ("Aug 2024", "user_entry", "simple", "all", 0, ""),
    ]

    def test_each_row_kind_maps_to_the_resq_fields_the_probe_confirmed(self):
        definitions = migration_dfm.arcrho_average_rows_as_resq(_average_formulas(self.ROWS))
        fields = [
            (d["name"], d["average_type"], d["weight_type"], d["periods_included"], d["exclude_high_low"], d["formula"])
            for d in definitions
        ]
        self.assertEqual(
            fields,
            [
                ("Simple - all", 0, 0, 0, 0, ""),
                ("Volume - all", 0, 1, 0, 0, ""),
                ("Simple - 5", 0, 0, 5, 0, ""),
                ("Volume - 3 Ex hi/lo", 0, 1, 3, 1, ""),
                ("Simple - 6 Ex hi/lo x2", 0, 0, 6, 2, ""),
                ("Benchmark Pattern", 9, None, None, None, ""),
                ("Calculated", 6, None, None, None, "(Average(3)+Average(4))/2"),
                ("User Entry", 5, None, None, None, ""),
                # ResQ names every User Entry row plainly; the import numbers the repeats.
                ("User Entry", 5, None, None, None, ""),
                ("Aug 2024", 5, None, None, None, ""),
            ],
        )

    def test_every_row_reads_back_through_the_import_as_the_arcrho_row(self):
        block = _average_formulas(self.ROWS)
        definitions = migration_dfm.arcrho_average_rows_as_resq(block)
        read_back = _resq_read_back(definitions)

        self.assertEqual(read_back, [d["arcrho"] for d in definitions])
        self.assertEqual([row["label"] for row in read_back], block["label"])
        settings = block["custom_average_formula_settings"]
        for index, row in enumerate(read_back):
            self.assertEqual(row["settings"]["average_type"], settings["average_type"][index], row["label"])
            if settings["average_type"][index] == "custom":
                self.assertEqual(row["settings"]["base"], settings["base"][index], row["label"])
                self.assertEqual(row["settings"]["periods"], settings["periods"][index], row["label"])
                self.assertEqual(row["settings"]["exclude"], settings["exclude"][index], row["label"])
        self.assertEqual(read_back[6]["formula"], '=("Simple - 5"+"Volume - 3 Ex hi/lo")/2')

    def test_a_resq_formula_survives_the_round_trip_the_other_way(self):
        """ResQ row -> import -> export gives ResQ back its own formula."""

        raw_names = ["1: Volume - all", "2: Simple - 5", "3: Simple - 3", "4: Benchmark"]
        stored = [
            {"average_type": 0, "formula": ""},
            {"average_type": 0, "formula": ""},
            {"average_type": 0, "formula": ""},
            {"average_type": 6, "formula": "(Average(2) + Average(3)) / 2"},
        ]
        imported = migration_dfm.resq_average_rows_as_arcrho(raw_names, stored)
        block = _average_formulas(
            [
                (row["label"], row["settings"]["average_type"], row["settings"]["base"],
                 row["settings"]["periods"], row["settings"]["exclude"], row["formula"])
                for row in imported
            ]
        )
        definitions = migration_dfm.arcrho_average_rows_as_resq(block)

        self.assertEqual(definitions[3]["average_type"], 6)
        self.assertEqual(
            migration_dfm.average_formula_key(definitions[3]["formula"]),
            migration_dfm.average_formula_key(stored[3]["formula"]),
        )
        self.assertEqual([d["name"] for d in definitions], ["Volume - all", "Simple - 5", "Simple - 3", "Benchmark"])

    def test_a_user_entry_row_without_one_row_wide_formula_stays_user_entry(self):
        block = _average_formulas(
            [
                ("Simple - 5", "custom", "simple", 5, 0, ""),
                # A per-cell adjustment formula in one column only.
                ("Adjusted", "user_entry", "simple", "all", 0, ['="Simple - 5"*1.02', "1.1", "1.05", ""]),
                # A constant formula names no row.
                ("Flat", "user_entry", "simple", "all", 0, "=1.05"),
                # A row named User Entry holds values in ResQ even with a formula.
                ("User Entry", "user_entry", "simple", "all", 0, '="Simple - 5"'),
            ]
        )
        definitions = migration_dfm.arcrho_average_rows_as_resq(block)

        self.assertEqual([d["average_type"] for d in definitions], [0, 5, 5, 5])
        self.assertEqual(_resq_read_back(definitions), [d["arcrho"] for d in definitions])

    def test_a_formula_that_cannot_name_its_rows_uniquely_declines(self):
        to_resq = migration_dfm._arcrho_formula_as_resq
        labels = ["Volume - all", "Simple - 5", "Simple - 5", "Calc"]

        self.assertEqual(to_resq('= "volume - ALL" * 2', labels, 3), "Average(1) * 2")
        self.assertIsNone(to_resq('="Simple - 5"*2', labels, 3))  # shared label
        self.assertIsNone(to_resq('="Calc"*2', labels, 3))  # the row itself
        self.assertIsNone(to_resq('="Missing"*2', labels, 3))
        self.assertIsNone(to_resq('=MAX("Volume - all",1)', labels, 3))
        self.assertIsNone(to_resq("=1.05", labels, 3))

    def test_settings_arrive_normalised_whatever_their_spelling(self):
        block = _average_formulas([("Simple - 5", "Custom", "Simple", "5", "0", "")])
        definition = migration_dfm.arcrho_average_rows_as_resq(block)[0]

        self.assertEqual((definition["weight_type"], definition["periods_included"], definition["exclude_high_low"]), (0, 5, 0))
        self.assertEqual(definition["arcrho"]["settings"], {"average_type": "custom", "base": "simple", "periods": 5, "exclude": 0})


if __name__ == "__main__":
    unittest.main()
