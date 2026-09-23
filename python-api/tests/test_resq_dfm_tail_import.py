"""The ResQ import keeps a tail typed on a computed average row (plan step 20).

``fixtures/resq_dfm_mp_pip_f25.json.gz`` is every COM read the import makes of
ResQ's ``MP+PIP`` ``F 25 - Incurred DFM Bootstrap`` in the fake project,
recorded by ``tools/resq_dfm_recording.py`` on 2026-09-23, with the ultimates
ResQ's own output vector held. Its tail column selects the computed
``Volume - all`` row, whose ``TailFactor`` is a typed 1.0018. Replaying the
recording runs the real import (``export_dfm``, which ends in the DFM
contract's recalculation) on ResQ's real answers.
"""
from __future__ import annotations

import gzip
import json
import sys
import unittest
from copy import deepcopy
from pathlib import Path

_TESTS = Path(__file__).resolve().parent
_PYTHON_API = _TESTS.parent
sys.path.insert(0, str(_PYTHON_API / "src"))
sys.path.insert(0, str(_PYTHON_API / "migration"))
sys.path.insert(0, str(_TESTS))

from resq_com_replay import ReplayObject  # noqa: E402
from resq_migration import dfm as migration_dfm  # noqa: E402

_FIXTURE = _TESTS / "fixtures" / "resq_dfm_mp_pip_f25.json.gz"
_TAIL_ROW = "Volume - all"
_RESQ_TAIL = 1.0018


def _load_fixture() -> dict:
    with gzip.open(_FIXTURE, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def _import(reads: dict, reserving_class: str) -> tuple[dict, list]:
    dfm = ReplayObject(reads)
    payload = migration_dfm.export_dfm(dfm, reserving_class, _TESTS, strict=True)
    return payload, dfm.misses


class ResqDfmTailImportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = _load_fixture()
        cls.payload, cls.misses = _import(cls.fixture["reads"], cls.fixture["reserving_class"])

    def test_the_replay_answers_every_read_the_import_makes(self) -> None:
        self.assertEqual(self.misses, [])

    def test_resq_types_the_tail_on_the_computed_volume_all_row(self) -> None:
        rows = {row["name"].split(": ", 1)[1]: row for row in self.fixture["resq_average_rows"]}
        self.assertEqual(rows[_TAIL_ROW]["average_type"], 0)
        self.assertEqual(rows[_TAIL_ROW]["tail_factor"], _RESQ_TAIL)

    def test_the_imported_dfm_keeps_the_tail_and_selects_it(self) -> None:
        formulas = self.payload["ratios_tab"]["average_formulas"]
        row = formulas["label"].index(_TAIL_ROW)
        self.assertEqual(formulas["custom_average_formula_settings"]["average_type"][row], "custom")
        self.assertEqual(formulas["values"][row][-1], _RESQ_TAIL)
        self.assertEqual(formulas["selected"][row][-1], 1)

    def test_every_ultimate_equals_resq_to_1e_9(self) -> None:
        arco = self.payload["results_tab"]["ultimate_vector"]
        resq = self.fixture["resq_output_ultimates"]
        self.assertEqual(len(arco), len(resq))
        for origin, (ours, theirs) in enumerate(zip(arco, resq)):
            self.assertLessEqual(abs(ours - theirs), 1e-9 * abs(theirs), f"origin {origin + 1}")

    def test_the_oldest_origin_carries_the_tail_reserve(self) -> None:
        latest = self.payload["data_tab"]["input_data_triangle_values"][0][-1]
        ultimate = self.payload["results_tab"]["ultimate_vector"][0]
        self.assertAlmostEqual(ultimate / latest, _RESQ_TAIL, places=12)
        self.assertAlmostEqual(ultimate - latest, 215.598, places=2)

    def test_the_fixture_can_tell_a_lost_tail(self) -> None:
        # Without the typed tail the oldest origin has no reserve at all, so a
        # regression that drops the tail cannot pass the tests above.
        reads = deepcopy(self.fixture["reads"])
        row = next(r["row"] for r in self.fixture["resq_average_rows"] if r["name"].endswith(_TAIL_ROW))
        reads[f'dfm.CustomAverages[[{row}], {{}}].TailFactor'] = {"v": 1.0}
        payload, misses = _import(reads, self.fixture["reserving_class"])
        self.assertEqual(misses, [])
        latest = payload["data_tab"]["input_data_triangle_values"][0][-1]
        self.assertEqual(payload["results_tab"]["ultimate_vector"][0], latest)


if __name__ == "__main__":
    unittest.main()
