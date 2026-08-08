from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ENGINE_SRC = Path(__file__).resolve().parents[1] / "src"
if str(ENGINE_SRC) not in sys.path:
    sys.path.insert(0, str(ENGINE_SRC))

from arcrho_bridge import build_exe  # noqa: E402
from arcrho_bridge.bundled_sources import (  # noqa: E402
    BUNDLED_SOURCES,
    CANONICAL_HIDDEN_IMPORTS,
    CANONICAL_MODULE_ROOT,
)


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
        for bundled in BUNDLED_SOURCES:
            self.assertIn(repr(str(bundled.import_root)), command[2])
        self.assertIn(repr(str(CANONICAL_MODULE_ROOT)), command[2])

    def test_the_pyinstaller_command_freezes_the_canonical_modules(self):
        # ``resq_import_runner`` imports the durable-job lease directly, so the
        # data bundle alone would leave the frozen Bridge unable to start it.
        with patch.object(build_exe, "run") as run:
            build_exe.build_exe()

        command = [str(argument) for argument in run.call_args.args[0]]
        self.assertIn(str(CANONICAL_MODULE_ROOT), command)
        for module_name in CANONICAL_HIDDEN_IMPORTS:
            self.assertIn(module_name, command)

    def test_a_missing_canonical_module_aborts_the_build(self):
        with (
            patch.object(build_exe, "CANONICAL_MODULE_ROOT", build_exe.REPO_ROOT / "absent"),
            patch.object(build_exe, "run") as run,
            self.assertRaises(FileNotFoundError),
        ):
            build_exe.build_exe()

        run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
