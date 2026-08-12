import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from arcrho_api.dataset_display_contract import (
    DEFAULT_SHOW_SUBTOTAL,
    normalize_show_subtotal,
)
from arcrho_api.engine_dataset_sidecar_contract import build_engine_dataset_sidecar


def _engine_sidecar(**overrides):
    values = {
        "project_name": "Demo",
        "reserving_class": r"Auto\PP",
        "dataset_name": "Paid Loss",
        "dataset_type": "Paid Loss",
        "data_format": "Triangle",
        "csv_file": "Paid Loss@12@12@cum@dev.csv",
        "user": "tester",
        "created": "2026-08-11T12:00:00Z",
        "updated_at": "2026-08-11T12:01:00Z",
        "number_format": "0,000",
        "decimal_places": 1,
        "origin_length": 12,
        "development_length": 12,
    }
    values.update(overrides)
    return build_engine_dataset_sidecar(**values)


class DatasetDisplayContractTests(unittest.TestCase):
    def test_show_subtotal_defaults_on_for_legacy_sidecars(self):
        self.assertIs(DEFAULT_SHOW_SUBTOTAL, True)
        self.assertIs(normalize_show_subtotal(None), True)
        self.assertIs(normalize_show_subtotal("false"), True)
        self.assertIs(_engine_sidecar()["show_subtotal"], True)

    def test_show_subtotal_preserves_an_explicit_false_value(self):
        self.assertIs(normalize_show_subtotal(False), False)
        self.assertIs(_engine_sidecar(show_subtotal=False)["show_subtotal"], False)


if __name__ == "__main__":
    unittest.main()
