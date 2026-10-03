from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "migration" / "validation"))

import prior_quarter_vectors_side_by_side_review as REVIEW


class PriorQuarterDisplayLengthTest(unittest.TestCase):
    def read(self, vectors, arcrho, exporter):
        rc = SimpleNamespace(Vectors=lambda: vectors)
        with patch.object(REVIEW, "export_vector", side_effect=exporter):
            return REVIEW._read_resq_prior_qtr_vectors(rc, lambda message: None, arcrho)

    def test_each_vector_uses_its_arco_display_length_and_restores_resq(self):
        vectors = [
            SimpleNamespace(Name="C 81 - Prior Qtr Indicated", PeriodLength=3),
            SimpleNamespace(Name="D 82 - Prior Qtr Selected", PeriodLength=12),
            SimpleNamespace(Name="C 91 - Current Qtr Indicated", PeriodLength=3),
        ]
        arcrho = {
            ("Vector", vectors[0].Name): {"origin_length": 12},
            ("Vector", vectors[1].Name): {"origin_length": 6},
        }
        observed = []

        def export(vector):
            observed.append((vector.Name, vector.PeriodLength))
            return {"values": [vector.PeriodLength]}

        result = self.read(vectors, arcrho, export)
        self.assertEqual(observed, [(vectors[0].Name, 12), (vectors[1].Name, 6)])
        self.assertEqual(set(result), set(arcrho))
        self.assertEqual([v.PeriodLength for v in vectors], [3, 12, 3])

    def test_resq_only_vector_keeps_its_display_length(self):
        vector = SimpleNamespace(Name="C 81", PeriodLength=3)
        result = self.read([vector], {}, lambda v: {"period_length": v.PeriodLength})
        self.assertEqual(result[("Vector", "C 81")], {"period_length": 3})

    def test_refused_length_is_flagged(self):
        class ReadOnlyVector:
            Name = "C 81"

            @property
            def PeriodLength(self):
                return 3

        key = ("Vector", "C 81")
        result = self.read(
            [ReadOnlyVector()], {key: {"origin_length": 12}},
            lambda v: {"period_length": v.PeriodLength},
        )
        self.assertEqual(result[key], {"period_length": 3, "shape_switch_refused": True})

    def test_export_failure_restores_resq_display_length(self):
        vector = SimpleNamespace(Name="C 81", PeriodLength=3)
        with self.assertRaisesRegex(RuntimeError, "read failed"):
            self.read([vector], {("Vector", "C 81"): {"origin_length": 12}}, RuntimeError("read failed"))
        self.assertEqual(vector.PeriodLength, 3)


if __name__ == "__main__":
    unittest.main()
