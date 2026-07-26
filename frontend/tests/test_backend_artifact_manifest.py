from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
if str(FRONTEND_ROOT) not in sys.path:
    sys.path.insert(0, str(FRONTEND_ROOT))

from build import write_backend_artifact_manifest


class BackendArtifactManifestTests(unittest.TestCase):
    def test_identity_covers_executable_and_collected_sibling_assets(self) -> None:
        with tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT)) as temp_dir:
            root = Path(temp_dir)
            executable = root / "arcrho_server.exe"
            sibling = root / "_internal" / "ui" / "index.html"
            sibling.parent.mkdir(parents=True)
            executable.write_bytes(b"same executable")
            sibling.write_text("first UI", encoding="utf-8")

            first = write_backend_artifact_manifest.build_manifest(root)
            sibling.write_text("newer UI", encoding="utf-8")
            second = write_backend_artifact_manifest.build_manifest(root)

        self.assertNotEqual(first["artifact_id"], second["artifact_id"])
        self.assertEqual(first["file_count"], 2)
        self.assertEqual(second["file_count"], 2)

    def test_written_manifest_is_excluded_from_subsequent_identity(self) -> None:
        with tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT)) as temp_dir:
            root = Path(temp_dir)
            (root / "arcrho_server.exe").write_bytes(b"server")

            output_path = write_backend_artifact_manifest.write_manifest(root)
            first = write_backend_artifact_manifest.build_manifest(root)
            second = write_backend_artifact_manifest.build_manifest(root)

        self.assertEqual(output_path.name, "backend-artifact.json")
        self.assertEqual(first, second)
        self.assertEqual(first["file_count"], 1)


if __name__ == "__main__":
    unittest.main()
