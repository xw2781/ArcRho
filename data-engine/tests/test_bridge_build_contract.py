from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ENGINE_SRC = Path(__file__).resolve().parents[1] / "src"
if str(ENGINE_SRC) not in sys.path:
    sys.path.insert(0, str(ENGINE_SRC))

from arcrho_bridge import build_exe  # noqa: E402


class BridgeBuildContractTests(unittest.TestCase):
    def test_requirements_include_frontend_provenance_runtime_dependency(self):
        requirements = {
            line.strip().split("#", 1)[0].strip().casefold()
            for line in build_exe.REQ_FILE.read_text(encoding="utf-8").splitlines()
        }

        self.assertTrue(any(item.startswith("fastapi") for item in requirements))

    def test_build_preflight_imports_both_provenance_entry_points(self):
        with patch.object(build_exe, "run") as run:
            build_exe.validate_resq_import_environment()

        command = run.call_args.args[0]
        self.assertEqual(command[:2], [build_exe.VENV_PYTHON, "-c"])
        self.assertIn("resq_migration.engine", command[2])
        self.assertIn("data_processing_rules_service", command[2])
        self.assertIn(repr(str(build_exe.RESQ_PYTHON_API_SOURCE)), command[2])
        self.assertIn(repr(str(build_exe.REPO_ROOT / "frontend")), command[2])


if __name__ == "__main__":
    unittest.main()
