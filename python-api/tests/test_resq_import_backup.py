"""Where the pre-import backup runs, and what a repeat of one does.

The copy itself is covered by the import macro's own tests, which drive it
through this module. What is tested here is the part the macros cannot see:
that the copy is handed to the ArcRho Server when the app can reach it, that a
Client PC never takes it a second time over the share once the server may have
acted, and that the same backup id asked for twice leaves one copy.
"""

from __future__ import annotations

import json
import sys
import tempfile
import types
import unittest
from datetime import datetime
from pathlib import Path

TEST_TEMP_ROOT = Path(__file__).resolve().parents[2] / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
_SRC_DIR = Path(__file__).resolve().parents[1] / "src"
if str(_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(_SRC_DIR))

from arcrho_api import resq_import_backup as backup  # noqa: E402
from arcrho_workspace_mutation_contract import WORKSPACE_MUTATION_KINDS  # noqa: E402


class _AppServerStub:
    """The app server's two modules this transport asks for, and nothing else."""

    def __init__(self, *, run=None, service=None):
        self.calls: list[tuple[str, dict]] = []
        self.mutation_client = types.SimpleNamespace(run_workspace_mutation=self._run)
        self.service = types.SimpleNamespace(back_up_reserving_class_for_import=service)
        self._run_impl = run

    def _run(self, mutation_kind, kwargs, *, local):
        self.calls.append((mutation_kind, dict(kwargs)))
        if self._run_impl is None:
            return local()
        return self._run_impl(mutation_kind, dict(kwargs), local)

    def __enter__(self):
        services = types.ModuleType("app_server.services")
        services.workspace_mutation_client = self.mutation_client
        services.resq_import_backup_service = self.service
        package = types.ModuleType("app_server")
        package.services = services
        self._saved = {
            name: sys.modules.get(name) for name in ("app_server", "app_server.services")
        }
        sys.modules["app_server"] = package
        sys.modules["app_server.services"] = services
        return self

    def __exit__(self, *exc_info):
        for name, module in self._saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module
        return False


class BackupIdTests(unittest.TestCase):
    def test_an_id_carries_the_folder_stamp_and_a_tag_of_its_own(self):
        identifier = backup.new_backup_id(datetime(2026, 9, 4, 13, 15, 0))

        self.assertTrue(identifier.startswith("20260904-131500-"))
        self.assertEqual(backup.validate_backup_id(identifier), identifier)
        self.assertEqual(backup._backup_stamp(identifier), "20260904-131500")

    def test_anything_else_is_refused_before_a_file_is_touched(self):
        for value in ("", "latest", "20260904-131500", "../escape", "20260904-131500-zzzz"):
            with self.assertRaises(ValueError):
                backup.validate_backup_id(value)


class BackupTransportTests(unittest.TestCase):
    """Which machine takes the copy, and what happens when that is unclear."""

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(TEST_TEMP_ROOT))
        self.addCleanup(self.temp_dir.cleanup)
        self.server_root = Path(self.temp_dir.name)
        rc_dir = self.server_root / "projects" / "Demo" / "data" / "Auto_%2F_PP"
        (rc_dir / "methods").mkdir(parents=True)
        (rc_dir / "methods" / "DFM@A.json").write_text("{}", encoding="utf-8")
        (rc_dir / "index.json").write_text(
            json.dumps({"reserving_class": "Auto/PP"}), encoding="utf-8"
        )

    def test_outside_the_app_the_copy_is_taken_here(self):
        result = backup.back_up_reserving_class(self.server_root, "Demo", "Auto/PP")

        self.assertEqual(result["error"], "")
        self.assertEqual(result["methods"], 1)
        self.assertTrue(Path(result["path"]).is_dir())

    def test_inside_the_app_the_copy_is_asked_of_the_server(self):
        served = dict(backup._empty_backup("20260904-131500-aabbccdd"), methods=7, files=9)
        stub = _AppServerStub(run=lambda kind, kwargs, local: served)

        with stub:
            result = backup.back_up_reserving_class(
                self.server_root, "Demo", "Auto/PP", import_policy="overwrite"
            )

        self.assertEqual(result["methods"], 7)
        kind, kwargs = stub.calls[0]
        self.assertEqual(kind, "resq_import_backup")
        self.assertEqual(kwargs["project_name"], "Demo")
        self.assertEqual(kwargs["reserving_class"], "Auto/PP")
        self.assertEqual(kwargs["import_policy"], "overwrite")
        self.assertEqual(backup.validate_backup_id(kwargs["backup_id"]), kwargs["backup_id"])
        # Nothing was copied from this machine.
        self.assertFalse((self.server_root / "backups").exists())

    def test_the_local_fallback_the_transport_owns_takes_the_same_copy(self):
        # ``run_workspace_mutation`` calls ``local`` itself when the gateway is
        # unreachable or does not advertise the kind; the service it names is
        # the one that runs.
        taken: list[dict] = []

        def service(**kwargs):
            taken.append(kwargs)
            return backup.back_up_reserving_class_on_disk(
                self.server_root,
                kwargs["project_name"],
                kwargs["reserving_class"],
                backup_id=kwargs["backup_id"],
                import_policy=kwargs["import_policy"],
            )

        with _AppServerStub(service=service):
            result = backup.back_up_reserving_class(self.server_root, "Demo", "Auto/PP")

        self.assertEqual(result["methods"], 1)
        self.assertEqual(taken[0]["backup_id"], result["backup_id"])

    def test_a_copy_the_server_did_not_confirm_is_unknown_not_repeated(self):
        def refuse(kind, kwargs, local):
            raise RuntimeError("the ArcRho Server did not confirm this change")

        with _AppServerStub(run=refuse):
            result = backup.back_up_reserving_class(self.server_root, "Demo", "Auto/PP")

        self.assertTrue(result["unconfirmed"])
        self.assertIn("did not confirm", result["error"])
        # The share is not written to after the server may already have acted.
        self.assertFalse((self.server_root / "backups").exists())
        sentence = backup.backup_sentence(result)
        self.assertIn("did not confirm", sentence)
        self.assertIn("unknown", sentence)
        self.assertNotIn("there is no restore point", sentence)


class BackupIdempotencyTests(unittest.TestCase):
    """The same request asked for twice leaves one copy."""

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory(dir=str(TEST_TEMP_ROOT))
        self.addCleanup(self.temp_dir.cleanup)
        self.server_root = Path(self.temp_dir.name)
        rc_dir = self.server_root / "projects" / "Demo" / "data" / "Auto_%2F_PP"
        (rc_dir / "methods").mkdir(parents=True)
        (rc_dir / "methods" / "DFM@A.json").write_text("{}", encoding="utf-8")
        self.identifier = "20260904-131500-aabbccdd"

    def _class_backup_dir(self) -> Path:
        return self.server_root / "backups" / "pre-import" / "Demo" / "Auto_%2F_PP"

    def test_a_repeat_of_one_id_reports_the_copy_it_already_took(self):
        first = backup.back_up_reserving_class_on_disk(
            self.server_root, "Demo", "Auto/PP", backup_id=self.identifier
        )
        second = backup.back_up_reserving_class_on_disk(
            self.server_root, "Demo", "Auto/PP", backup_id=self.identifier
        )

        self.assertEqual(first["path"], second["path"])
        self.assertTrue(second["reused"])
        self.assertEqual(second["methods"], 1)
        self.assertEqual([item.name for item in self._class_backup_dir().iterdir()], ["20260904-131500"])

    def test_another_request_in_the_same_second_gets_its_own_folder(self):
        backup.back_up_reserving_class_on_disk(
            self.server_root, "Demo", "Auto/PP", backup_id=self.identifier
        )
        other = backup.back_up_reserving_class_on_disk(
            self.server_root, "Demo", "Auto/PP", backup_id="20260904-131500-11223344"
        )

        self.assertEqual(Path(other["path"]).name, "20260904-131500-2")
        self.assertFalse(other["reused"])

    def test_a_copy_that_stopped_part_way_is_never_reported_as_a_restore_point(self):
        partial = self._class_backup_dir() / "20260904-131500"
        partial.mkdir(parents=True)

        result = backup.back_up_reserving_class_on_disk(
            self.server_root, "Demo", "Auto/PP", backup_id=self.identifier
        )

        self.assertFalse(result["reused"])
        self.assertEqual(Path(result["path"]).name, "20260904-131500-2")

    def test_the_manifest_names_the_id_and_the_person_the_copy_was_taken_for(self):
        result = backup.back_up_reserving_class_on_disk(
            self.server_root, "Demo", "Auto/PP", backup_id=self.identifier, taken_by="jdoe"
        )

        manifest = json.loads((Path(result["path"]) / "backup.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["backup_id"], self.identifier)
        self.assertEqual(manifest["taken_by"], "jdoe")


class BackupContractTests(unittest.TestCase):
    def test_the_mutation_is_registered_with_the_arguments_the_copy_takes(self):
        spec = WORKSPACE_MUTATION_KINDS[backup.BACKUP_MUTATION_KIND]

        self.assertEqual(spec.module, "resq_import_backup_service")
        self.assertEqual(spec.function, "back_up_reserving_class_for_import")
        self.assertEqual(spec.required, ("project_name", "reserving_class", "backup_id"))
        self.assertEqual(spec.optional, ("import_policy",))


if __name__ == "__main__":
    unittest.main()
