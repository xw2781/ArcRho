import sys
import tempfile
import unittest
from pathlib import Path

FRONTEND_ROOT = Path(__file__).resolve().parents[1]
if str(FRONTEND_ROOT) not in sys.path:
    sys.path.insert(0, str(FRONTEND_ROOT))

from app_server.services import scripting_service  # noqa: E402


class ScriptDirImportTests(unittest.TestCase):
    def test_cell_imports_module_beside_the_notebook(self):
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / "sibling_toolbox_for_test.py").write_text("VALUE = 42\n", encoding="utf-8")
            sid = "script-dir-test"
            try:
                missing = scripting_service.run_script("import sibling_toolbox_for_test", sid)
                self.assertFalse(missing["success"])
                self.assertIn("ModuleNotFoundError", missing["error"])

                found = scripting_service.run_script(
                    "import sibling_toolbox_for_test as t\nt.VALUE", sid, folder
                )
                self.assertTrue(found["success"], found["error"])
                self.assertEqual(found["output"], "42")
            finally:
                scripting_service._apply_session_script_dir(
                    scripting_service._get_or_create_session_state(sid), ""
                )
                sys.modules.pop("sibling_toolbox_for_test", None)
            self.assertNotIn(str(Path(folder).resolve()), [str(Path(p)) for p in sys.path if p])


if __name__ == "__main__":
    unittest.main()
