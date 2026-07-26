from __future__ import annotations

import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
if str(FRONTEND_ROOT) not in sys.path:
    sys.path.insert(0, str(FRONTEND_ROOT))


class BridgeRuntimeImportTests(unittest.TestCase):
    def test_runtime_server_root_overrides_local_workspace_preference(self) -> None:
        from app_server import config

        runtime_root = r"X:\Shared ArcRho Server"
        with (
            patch.dict(os.environ, {config.RUNTIME_SERVER_ROOT_ENV: runtime_root}),
            patch.object(
                config,
                "_read_json_file",
                return_value={
                    "workspace_root": r"C:\Users\tester\stale-workspace",
                    "paths": {"projects_dir": "projects", "requests_dir": "requests"},
                },
            ),
        ):
            resolved = config.load_workspace_paths()

        self.assertEqual(resolved["workspace_root"], runtime_root)

    def test_processing_service_import_does_not_create_full_fastapi_app(self) -> None:
        script = (
            "import sys; "
            f"sys.path.insert(0, {str(FRONTEND_ROOT)!r}); "
            "import app_server.services.data_processing_rules_service; "
            "assert 'app_server.main' not in sys.modules"
        )
        completed = subprocess.run(
            [sys.executable, "-c", script],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(
            completed.returncode,
            0,
            msg=completed.stdout + completed.stderr,
        )


if __name__ == "__main__":
    unittest.main()
