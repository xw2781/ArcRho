from __future__ import annotations

import unittest
from collections import defaultdict

from tools.build_monthly_insurance_demo_project import (
    AGGREGATE_BOTTOM_PATHS,
    ALL_DATASET_TYPES,
    CALCULATED_DATASET_TYPES,
    DEFAULT_SOURCE_CSV,
    EXPECTED_ACCIDENT_END,
    EXPECTED_ACCIDENT_MONTHS,
    EXPECTED_ACCIDENT_START,
    RAW_DATASET_TYPES,
    _dataset_request_payload,
    inspect_demo_csv,
    validate_builder_configuration,
    verify_aggregate_bottom_paths,
)


class _FakeTreeClient:
    def __init__(self, paths: tuple[str, ...]) -> None:
        children: dict[str, set[str]] = defaultdict(set)
        for path in paths:
            prefix = ""
            for segment in path.split("\\"):
                children[prefix].add(segment)
                prefix = f"{prefix}\\{segment}" if prefix else segment
        self.children = children
        self.calls: list[tuple[str, bool]] = []

    def get(self, _path, *, params, timeout_sec):
        del timeout_sec
        prefix = str(params.get("prefix") or "")
        self.calls.append((prefix, bool(params.get("force"))))
        return {
            "ok": True,
            "children": [
                {
                    "name": name,
                    "path": f"{prefix}\\{name}" if prefix else name,
                }
                for name in sorted(self.children.get(prefix, set()))
            ],
        }


class DemoProjectBuilderTests(unittest.TestCase):
    def test_builder_configuration_is_internally_consistent(self):
        validate_builder_configuration()
        names = [item.name for item in ALL_DATASET_TYPES]
        self.assertEqual(len(names), len(set(names)))
        self.assertTrue(any(item.materialize for item in RAW_DATASET_TYPES))
        self.assertTrue(any(item.materialize for item in CALCULATED_DATASET_TYPES))

    def test_demo_csv_has_ten_complete_accident_years(self):
        profile = inspect_demo_csv(DEFAULT_SOURCE_CSV)
        self.assertEqual(profile.accident_month_count, EXPECTED_ACCIDENT_MONTHS)
        self.assertEqual(profile.accident_start, EXPECTED_ACCIDENT_START)
        self.assertEqual(profile.accident_end, EXPECTED_ACCIDENT_END)
        self.assertGreater(profile.row_count, 0)

    def test_aggregate_path_verification_queries_each_prefix_once(self):
        client = _FakeTreeClient(AGGREGATE_BOTTOM_PATHS)
        actual = verify_aggregate_bottom_paths(
            client,
            "Demo Project",
            AGGREGATE_BOTTOM_PATHS,
        )
        self.assertEqual(actual, AGGREGATE_BOTTOM_PATHS)
        queried_prefixes = [prefix for prefix, _force in client.calls]
        self.assertEqual(len(queried_prefixes), len(set(queried_prefixes)))
        self.assertTrue(client.calls[0][1])
        self.assertTrue(all(not force for _prefix, force in client.calls[1:]))

    def test_dataset_request_uses_format_specific_endpoint_and_periods(self):
        triangle = next(item for item in RAW_DATASET_TYPES if item.data_format == "Triangle")
        vector = next(item for item in RAW_DATASET_TYPES if item.data_format == "Vector")

        tri_endpoint, tri_payload = _dataset_request_payload(
            "Demo",
            AGGREGATE_BOTTOM_PATHS[0],
            triangle,
            45.0,
        )
        vec_endpoint, vec_payload = _dataset_request_payload(
            "Demo",
            AGGREGATE_BOTTOM_PATHS[0],
            vector,
            45.0,
        )

        self.assertEqual(tri_endpoint, "/arcrho/tri")
        self.assertEqual(tri_payload["OriginLength"], 12)
        self.assertEqual(tri_payload["DevelopmentLength"], 12)
        self.assertEqual(vec_endpoint, "/arcrho/vec")
        self.assertEqual(vec_payload["PeriodLength"], 12)
        self.assertTrue(tri_payload["WriteSidecar"])
        self.assertTrue(vec_payload["WriteSidecar"])


if __name__ == "__main__":
    unittest.main()
