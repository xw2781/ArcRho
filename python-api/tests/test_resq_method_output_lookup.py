from __future__ import annotations

import sys
import unittest
from pathlib import Path


_PYTHON_API_ROOT = Path(__file__).resolve().parents[1]
for _path in (_PYTHON_API_ROOT / "src", _PYTHON_API_ROOT / "migration"):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from resq_migration import extractors
from resq_migration.core import (
    METHOD_TYPE_BS_CRA_CODE,
    METHOD_TYPE_BS_SR_CODE,
)


class _Output:
    def __init__(self, name: str):
        self.Name = name


class _Method:
    def __init__(self, name: str, output_name: str, output_member: str):
        self.Name = name
        setattr(self, output_member, _Output(output_name))


class _NameFirstCollection:
    """Model ResQ Item(), which may resolve a method name before an output."""

    def __init__(self, items: list[_Method]):
        self.items = items

    def __iter__(self):
        return iter(self.items)

    def Item(self, name: str):
        for item in self.items:
            if item.Name.casefold() == name.casefold():
                return item
        raise KeyError(name)


class _ReservingClass:
    def __init__(self, methods: list[_Method]):
        self.methods = methods
        self.collection = _NameFirstCollection(methods)

    def BFMethods(self):
        return self.collection

    def CapeCodMethods(self):
        return self.collection

    def ResultSelections(self):
        return self.collection

    def BerquistShermanSRs(self):
        return self.collection

    def BerquistShermanCRAs(self):
        return self.collection

    def GetResultSelection(self, name: str):
        return self.collection.Item(name)

    def GetBerquistShermanSR(self, name: str):
        return self.collection.Item(name)

    def GetBerquistShermanCRA(self, name: str):
        return self.collection.Item(name)


class ResqMethodOutputLookupTests(unittest.TestCase):
    def setUp(self):
        self.wrong_name_match_vector = _Method("Foo", "Bar", "OutputVector")
        self.correct_vector = _Method("Baz", "Foo", "OutputVector")
        self.wrong_name_match_triangle = _Method("Foo", "Bar", "OutputTriangle")
        self.correct_triangle = _Method("Baz", "Foo", "OutputTriangle")

    def test_vector_method_lookups_require_output_identity(self):
        reserving_class = _ReservingClass(
            [self.wrong_name_match_vector, self.correct_vector]
        )

        for label, lookup in (
            ("BF", extractors._find_bornhuetter_ferguson_for_vector),
            ("Cape Cod", extractors._find_cape_cod_for_vector),
            ("Result Selection", extractors._find_result_selection_for_vector),
        ):
            with self.subTest(method=label):
                self.assertIs(lookup(reserving_class, "Foo"), self.correct_vector)

    def test_berquist_sherman_lookups_require_output_identity(self):
        reserving_class = _ReservingClass(
            [self.wrong_name_match_triangle, self.correct_triangle]
        )

        for method_type, expected_variant in (
            (METHOD_TYPE_BS_SR_CODE, "sr"),
            (METHOD_TYPE_BS_CRA_CODE, "cra"),
        ):
            with self.subTest(method_type=method_type):
                variant, method = extractors._find_berquist_sherman_for_triangle(
                    reserving_class,
                    "Foo",
                    method_type,
                )
                self.assertEqual(variant, expected_variant)
                self.assertIs(method, self.correct_triangle)

    def test_duplicate_vector_output_owners_fail_closed(self):
        reserving_class = _ReservingClass(
            [
                _Method("First", "Foo", "OutputVector"),
                _Method("Second", "Foo", "OutputVector"),
            ]
        )

        for label, lookup in (
            ("BF", extractors._find_bornhuetter_ferguson_for_vector),
            ("Cape Cod", extractors._find_cape_cod_for_vector),
            ("Result Selection", extractors._find_result_selection_for_vector),
        ):
            with self.subTest(method=label):
                with self.assertRaisesRegex(ValueError, "Multiple ResQ"):
                    lookup(reserving_class, "Foo")

    def test_duplicate_berquist_sherman_output_owners_fail_closed(self):
        reserving_class = _ReservingClass(
            [
                _Method("First", "Foo", "OutputTriangle"),
                _Method("Second", "Foo", "OutputTriangle"),
            ]
        )

        for method_type in (METHOD_TYPE_BS_SR_CODE, METHOD_TYPE_BS_CRA_CODE):
            with self.subTest(method_type=method_type):
                with self.assertRaisesRegex(ValueError, "Multiple ResQ"):
                    extractors._find_berquist_sherman_for_triangle(
                        reserving_class,
                        "Foo",
                        method_type,
                    )


if __name__ == "__main__":
    unittest.main()
