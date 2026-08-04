"""The Bridge's persisted-JSON writer against its canonical owner.

The frozen Bridge loads ``arcrho_api`` from its data bundle rather than its
import graph, so ``bridge_utils`` cannot import the owner of the on-disk JSON
layout at module scope and keeps a copy instead.  A copy is only safe while it
is pinned, so this compares the two byte for byte on payload shapes the Bridge
actually writes -- DFM triangles, exclusion masks, and mixed nesting.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[2]
for _path in (_REPO_ROOT / "data-engine" / "src", _REPO_ROOT / "python-api" / "src"):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from arcrho_api.io import persisted_json_text as canonical_text  # noqa: E402
from arcrho_bridge.bridge_utils import persisted_json_text as bridge_text  # noqa: E402


_PAYLOADS = (
    {
        "json format": "arcrho-dfm-owned-patch-v1",
        "data tab": {
            "input data triangle values": [[100, 150, 180], [200, 300], [400]],
            "origin labels": ["2020", "2021", "2022"],
        },
        "ratios tab": {
            "ratio triangle": {
                "ratio values": [[1.5, 1.2], [1.5], []],
                "excluded": [[0, 1], [0], []],
            },
            "average formulas": {"selected": [[1, 0]], "values": [[1.35, 1.2]], "inputs": []},
        },
    },
    {"empty": {}, "nothing": [], "scalar": 1.5, "flag": True, "absent": None},
    {"rows": [[]], "text": "Ratio é", "vector": [1, 2, 3]},
    [[1, 2], [3]],
    {},
)


class BridgeJsonParityTests(unittest.TestCase):
    def test_bridge_copy_matches_the_canonical_text(self) -> None:
        for payload in _PAYLOADS:
            with self.subTest(payload=payload):
                self.assertEqual(bridge_text(payload), canonical_text(payload))

    def test_bridge_writer_produces_the_canonical_file(self) -> None:
        import tempfile

        from arcrho_bridge.bridge_utils import write_json_with_compact_rows

        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "payload.json"

        self.assertTrue(write_json_with_compact_rows(path, _PAYLOADS[0]))
        self.assertEqual(path.read_text(encoding="utf-8"), canonical_text(_PAYLOADS[0]))


if __name__ == "__main__":
    unittest.main()
