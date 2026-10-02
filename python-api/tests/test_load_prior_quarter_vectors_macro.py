from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

_MACRO_PATH = Path(__file__).resolve().parents[1] / "macros" / "load_prior_quarter_vectors.py"
_spec = importlib.util.spec_from_file_location("load_prior_quarter_vectors_under_test", _MACRO_PATH)
MACRO = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(MACRO)


def entry(name, data_format="Vector"):
    return {"name": name, "dataset_type": name, "data_format": data_format}


class FakeGateway:
    """Holds source vectors, and stores whatever a save sends so it reads back."""

    def __init__(self, source, written_lengths=None):
        self.source = source
        self.saved = {}
        self.saves = []

    def read(self, kind, **kwargs):
        if kind == "propagation_busy":
            return {"busy": False}
        name = kwargs["dataset_name"]
        if kwargs["project_name"] == "Aug":
            if name not in self.source:
                raise RuntimeError("404")
            return self.source[name]
        return self.saved[name]

    def save(self, kind, project, rc, name, **kwargs):
        self.saves.append((kind, project, rc, name, kwargs))
        self.saved[name] = {
            "values": kwargs["values"],
            "stored_origin_length": kwargs["origin_length"],
        }


class PlanClassTest(unittest.TestCase):
    def test_pairs_91_92_with_81_82_and_tolerates_double_spaces(self):
        source = {"files": [
            entry("C 91 -  Current Qtr Indicated"),
            entry("D 92 - Current Qtr Selected"),
            entry("E1 91 - Current Qtr Indicated"),
            entry("D 31 - Claim Count * Severity"),
            entry("D 91 - Current Qtr Indicated", "Triangle"),
        ]}
        target = {"files": [
            entry("C 81 -  Prior Qtr Indicated"),
            entry("D 82 - Prior Qtr Selected"),
            entry("D 92 - Current Qtr Selected"),
        ]}
        plan = MACRO.plan_class(source, target)
        self.assertEqual(
            [(s["name"], t["name"]) for s, t in plan["pairs"]],
            [
                ("C 91 -  Current Qtr Indicated", "C 81 -  Prior Qtr Indicated"),
                ("D 92 - Current Qtr Selected", "D 82 - Prior Qtr Selected"),
            ],
        )
        self.assertEqual(plan["no_target"], ["E1 91 - Current Qtr Indicated"])


class CopyVectorTest(unittest.TestCase):
    def setUp(self):
        self.source = {
            "D 91 - Current Qtr Indicated": {
                "values": [[None], [1.5], [2.25]],
                "stored_origin_length": 12,
                "origin_labels": ["2024", "2025", "2026"],
            },
            "D 92 - Current Qtr Selected": {"values": [[None], [None]], "stored_origin_length": 12},
        }
        self.gateway = FakeGateway(self.source)
        self.target = {"name": "D 81 - Prior Qtr Indicated", "dataset_type": "D 81 - Prior Qtr Indicated"}

    def copy(self, name):
        return MACRO.copy_vector(
            self.gateway, "Aug", "Sep", "RC", {"name": name}, self.target, lambda: None
        )

    def test_copy_takes_the_source_stored_length_and_values(self):
        self.assertEqual(self.copy("D 91 - Current Qtr Indicated"), "")
        _kind, project, _rc, name, kwargs = self.gateway.saves[0]
        self.assertEqual((project, name), ("Sep", "D 81 - Prior Qtr Indicated"))
        self.assertEqual(kwargs["origin_length"], 12)
        self.assertEqual(kwargs["source_kind"], "input")
        self.assertTrue(kwargs["stored_values_cleared"])
        self.assertEqual(kwargs["values"], [[None], [1.5], [2.25]])

    def test_empty_or_missing_source_is_skipped_untouched(self):
        self.assertIn("empty", self.copy("D 92 - Current Qtr Selected"))
        self.assertIn("could not be read", self.copy("D 99 - Missing"))
        self.assertEqual(self.gateway.saves, [])


if __name__ == "__main__":
    unittest.main()
