from __future__ import annotations

import sys
import unittest
from pathlib import Path


_PYTHON_API_ROOT = Path(__file__).resolve().parents[1]
for _path in (_PYTHON_API_ROOT / "src", _PYTHON_API_ROOT / "migration"):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from resq_migration.dfm import dfm_methods_by_output_name


class _Output:
    def __init__(self, name):
        self.Name = name


class _Dfm:
    def __init__(self, name, output):
        self.Name = name
        self.OutputVector = _Output(output)


class _Collection:
    def __init__(self, items):
        self.items = items

    def __iter__(self):
        return iter(self.items)

    def Item(self, _name):
        raise AssertionError("lookup must reuse enumerated COM objects")


class _ReservingClass:
    def __init__(self, items):
        self.collection = _Collection(items)

    def DFMMethods(self):
        return self.collection


class ResqDfmOutputLookupTests(unittest.TestCase):
    def test_filters_normalized_method_names_without_collection_item_lookup(self):
        selected = _Dfm("Selected DFM ", "Ultimate Loss ")
        other = _Dfm("Other DFM", "Other Ultimate")

        result = dfm_methods_by_output_name(
            _ReservingClass([selected, other]),
            ["Selected DFM"],
        )

        self.assertEqual(list(result), ["ultimate loss"])
        self.assertEqual(result["ultimate loss"], ("Selected DFM", selected))


if __name__ == "__main__":
    unittest.main()
