"""The hosted pre-import backup copies the class on the configured workspace."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

FRONTEND_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = FRONTEND_ROOT.parent
SERVER_COMPONENTS_SRC = REPOSITORY_ROOT / "server-components" / "src"
PYTHON_API_SRC = REPOSITORY_ROOT / "python-api" / "src"
for path in (FRONTEND_ROOT, SERVER_COMPONENTS_SRC, PYTHON_API_SRC):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from arcrho_api import resq_import_backup as backup  # noqa: E402
from arcrho_workspace_mutation_contract import WORKSPACE_MUTATION_KINDS  # noqa: E402

from app_server.services import resq_import_backup_service, user_identity_service  # noqa: E402

BACKUP_ID = "20260904-131500-aabbccdd"


class ResqImportBackupServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT))
        self.addCleanup(self.temp_dir.cleanup)
        self.root = Path(self.temp_dir.name)
        patcher = patch.object(
            resq_import_backup_service.config,
            "load_workspace_paths",
            return_value={"workspace_root": str(self.root), "paths": {}},
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        rc_dir = self.root / "projects" / "Demo" / "data" / "Auto_%5C_PP"
        (rc_dir / "methods").mkdir(parents=True)
        (rc_dir / "methods" / "DFM@A.json").write_text("{}", encoding="utf-8")
        (rc_dir / "sidecars").mkdir()
        (rc_dir / "sidecars" / "Net Loss--Paid.json").write_text(
            json.dumps({"source_kind": "engine", "csv_file": "Net Loss--Paid@12.csv"}),
            encoding="utf-8",
        )
        (rc_dir / "index.json").write_text(
            json.dumps({"reserving_class": r"Auto\PP"}), encoding="utf-8"
        )
        self.rc_dir = rc_dir

    def test_the_mutation_is_registered_with_the_arguments_the_service_takes(self) -> None:
        spec = WORKSPACE_MUTATION_KINDS[backup.BACKUP_MUTATION_KIND]

        self.assertEqual(spec.module, "resq_import_backup_service")
        self.assertEqual(spec.function, "back_up_reserving_class_for_import")
        self.assertEqual(spec.required, ("project_name", "reserving_class", "backup_id"))
        self.assertEqual(spec.optional, ("import_policy",))

    def test_copies_the_class_under_the_configured_root_for_the_acting_user(self) -> None:
        with user_identity_service.acting_identity("jdoe", "Jane Doe"):
            result = resq_import_backup_service.back_up_reserving_class_for_import(
                "Demo", r"Auto\PP", BACKUP_ID, "overwrite"
            )

        self.assertEqual(result["error"], "")
        self.assertEqual(result["methods"], 1)
        self.assertEqual(result["engine_datasets_skipped"], 1)
        target = Path(result["path"])
        self.assertEqual(target.name, "20260904-131500")
        self.assertTrue(target.is_relative_to(self.root / "backups" / "pre-import"))
        manifest = json.loads((target / "backup.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["taken_by"], "jdoe")
        self.assertEqual(manifest["backup_id"], BACKUP_ID)
        self.assertEqual(manifest["import_policy"], "overwrite")

    def test_the_same_id_twice_leaves_one_copy(self) -> None:
        first = resq_import_backup_service.back_up_reserving_class_for_import(
            "Demo", r"Auto\PP", BACKUP_ID
        )
        second = resq_import_backup_service.back_up_reserving_class_for_import(
            "Demo", r"Auto\PP", BACKUP_ID
        )

        self.assertEqual(first["path"], second["path"])
        self.assertTrue(second["reused"])
        class_dir = Path(first["path"]).parent
        self.assertEqual([item.name for item in class_dir.iterdir()], ["20260904-131500"])

    def test_an_id_this_host_did_not_write_is_refused(self) -> None:
        with self.assertRaises(HTTPException) as raised:
            resq_import_backup_service.back_up_reserving_class_for_import(
                "Demo", r"Auto\PP", "../escape"
            )

        self.assertEqual(raised.exception.status_code, 400)

    def test_a_class_the_project_does_not_hold_yet_copies_nothing(self) -> None:
        result = resq_import_backup_service.back_up_reserving_class_for_import(
            "Demo", r"New\Class", BACKUP_ID
        )

        self.assertEqual(result["files"], 0)
        self.assertEqual(result["reason"], "no_class_folder")
        self.assertEqual(result["error"], "")


if __name__ == "__main__":
    unittest.main()
