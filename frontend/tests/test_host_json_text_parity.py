"""The Electron host's persisted-JSON writer against its canonical owner.

``arcrho_api/io.py`` owns the on-disk text of every persisted ArcRho JSON file.
The host process cannot import Python, so ``electron/persisted_json_text.js``
keeps a mirror for the files the host writes itself. A mirror is only safe
while it is pinned, so this renders the same payloads through both and
compares the text byte for byte -- the same check ``data-engine/tests/
test_bridge_json_parity.py`` applies to the frozen Bridge's copy.

Numbers are limited to integers and short decimals on purpose. JavaScript has
one number type, so ``1.0`` cannot survive a round trip through the host; that
is why persisted project data is never written from the host at all.
"""

from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = FRONTEND_ROOT.parent
for path in (FRONTEND_ROOT, REPO_ROOT / "python-api" / "src"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from arcrho_api.io import persisted_json_text  # noqa: E402


NODE = FRONTEND_ROOT / "node-portable" / "node.exe"
MODULE = FRONTEND_ROOT / "electron" / "persisted_json_text.js"

_PAYLOADS = (
    {
        "json_format": "arcrho-dfm-owned-patch-v4",
        "data_tab": {
            "input_data_triangle_values": [[100, 150, 180], [200, 300], [400]],
            "origin_labels": ["2020", "2021", "2022"],
        },
        "ratios_tab": {
            "ratio_triangle": {
                "ratio_values": [[1.5, 1.2], [1.5], []],
                "excluded": [[0, 1], [0], []],
            },
            "average_formulas": {"selected": [[1, 0]], "values": [[1.35, 1.2]], "inputs": []},
        },
    },
    {"empty": {}, "nothing": [], "scalar": 1.5, "flag": True, "absent": None},
    {"rows": [[]], "text": "Ratio é \"quoted\" \\ back", "vector": [1, 2, 3]},
    {"nested": [{"a": [[True, False], [None]]}, [1, [2, [3]]]]},
    [[1, 2], [3]],
    {},
)


def _host_text(payload: object) -> str:
    script = (
        "const { formatJsonForSave } = require(process.argv[1]);"
        "process.stdout.write(JSON.stringify(formatJsonForSave(JSON.parse(process.argv[2]))));"
    )
    completed = subprocess.run(
        [str(NODE), "-e", script, str(MODULE), json.dumps(payload)],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=30,
    )
    return json.loads(completed.stdout)


@unittest.skipUnless(NODE.is_file(), "bundled portable Node runtime is required")
class HostJsonTextParityTests(unittest.TestCase):
    def test_host_copy_matches_the_canonical_text(self) -> None:
        for payload in _PAYLOADS:
            with self.subTest(payload=payload):
                self.assertEqual(_host_text(payload), persisted_json_text(payload))


if __name__ == "__main__":
    unittest.main()
