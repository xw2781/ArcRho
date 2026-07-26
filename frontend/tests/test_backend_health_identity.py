from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
if str(FRONTEND_ROOT) not in sys.path:
    sys.path.insert(0, str(FRONTEND_ROOT))

from app_server import arcode_main, main


class BackendHealthIdentityTests(unittest.TestCase):
    def test_arcrho_health_reports_the_packaged_artifact_identity(self) -> None:
        with patch.dict(
            os.environ,
            {
                "ARCRHO_BACKEND_TOKEN": "launch-token",
                "ARCRHO_BACKEND_ARTIFACT_ID": "sha256:arcrho-backend",
            },
            clear=True,
        ):
            health = main.app_health()

        self.assertEqual(health["token"], "launch-token")
        self.assertEqual(
            health["backend_artifact_id"],
            "sha256:arcrho-backend",
        )
        self.assertNotIn("build_version", health)

    def test_arcode_health_prefers_its_artifact_identity(self) -> None:
        with patch.dict(
            os.environ,
            {
                "ARCODE_BACKEND_TOKEN": "arcode-token",
                "ARCODE_BACKEND_ARTIFACT_ID": "sha256:arcode-backend",
                "ARCRHO_BACKEND_ARTIFACT_ID": "sha256:shared-backend",
            },
            clear=True,
        ):
            health = arcode_main.app_health()

        self.assertEqual(health["token"], "arcode-token")
        self.assertEqual(
            health["backend_artifact_id"],
            "sha256:arcode-backend",
        )
        self.assertNotIn("build_version", health)


if __name__ == "__main__":
    unittest.main()
