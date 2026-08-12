from __future__ import annotations

import importlib.util
import hashlib
import json
import tempfile
import unittest
from pathlib import Path


_PYTHON_API_ROOT = Path(__file__).resolve().parents[1]
_PUBLISHER_PATH = _PYTHON_API_ROOT / "macros" / "publish_macro_library.py"
_TMP_ROOT = Path(__file__).resolve().parent / "logs" / "tmp"


def _load_publisher():
    spec = importlib.util.spec_from_file_location("publish_macro_library_under_test", _PUBLISHER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load the macro-library publisher.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PublishMacroLibrarySupportTests(unittest.TestCase):
    def test_publishes_canonical_resq_runtime_beside_macro_library(self):
        publisher = _load_publisher()
        _TMP_ROOT.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=_TMP_ROOT) as temp_name:
            library = Path(temp_name) / "shared" / "macros"
            library.mkdir(parents=True)

            changed, unchanged = publisher.publish_migration_support(library, False)

            pointer = json.loads(
                (library.parent / "python-api" / "current.json").read_text(encoding="utf-8")
            )
            support = (
                library.parent
                / "python-api"
                / pointer["relative_root"]
                / "migration"
            )
            self.assertGreater(changed, 0)
            self.assertEqual(unchanged, 0)
            self.assertEqual(
                (support / "resq_data_migration.py").read_bytes(),
                (_PYTHON_API_ROOT / "migration" / "resq_data_migration.py").read_bytes(),
            )
            self.assertEqual(
                (support / "resq_migration" / "sync.py").read_bytes(),
                (_PYTHON_API_ROOT / "migration" / "resq_migration" / "sync.py").read_bytes(),
            )
            release_root = support.parent
            self.assertEqual(
                (release_root / "macros" / "export_reserving_class_to_resq.py").read_bytes(),
                (_PYTHON_API_ROOT / "macros" / "export_reserving_class_to_resq.py").read_bytes(),
            )
            manifest = json.loads((release_root / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["release_id"], pointer["release_id"])
            self.assertIn("migration/resq_migration/sync.py", manifest["files"])
            self.assertIn("macros/export_reserving_class_to_resq.py", manifest["files"])
            self.assertEqual(manifest["sync_macro_version"], "1.0.1")
            self.assertEqual(
                manifest["sync_macro_sha256"],
                hashlib.sha256(
                    (_PYTHON_API_ROOT / "macros" / "sync_reserving_class_with_resq.py").read_bytes()
                ).hexdigest(),
            )
            self.assertTrue(pointer["manifest_sha256"])

            changed, unchanged = publisher.publish_migration_support(library, False)
            self.assertEqual(changed, 0)
            self.assertGreater(unchanged, 0)


if __name__ == "__main__":
    unittest.main()
