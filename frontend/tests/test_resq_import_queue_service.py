"""The hosted ResQ import publish writes the macro's request into the Bridge's import queue."""
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
for path in (FRONTEND_ROOT, REPOSITORY_ROOT / "python-api" / "src"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from arcrho_workspace_mutation_contract import WORKSPACE_MUTATION_KINDS  # noqa: E402

from app_server.services import resq_import_queue_service, user_identity_service  # noqa: E402

TEST_TEMP_ROOT = REPOSITORY_ROOT / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
BRIDGE_IMPORT_CONTRACT = (
    REPOSITORY_ROOT / "server-components" / "src" / "arcrho_bridge" / "resq_reserving_class_import_contract.json"
)
REQUEST_ID = "0123456789abcdef0123456789abcdef"


def _request(**changes):
    request = {
        "Function": "ImportResQReservingClass",
        "ContractVersion": 2,
        "RequestId": REQUEST_ID,
        "ProjectName": "Demo",
        "Path": r"Auto\PP",
        "UserName": "whoever the client said",
        "ExportMode": "configured",
        "SelectedNames": ["Paid Loss"],
    }
    request.update(changes)
    return request


class ResqImportQueueServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        self.addCleanup(self.temp_dir.cleanup)
        self.root = Path(self.temp_dir.name)
        patcher = patch.object(resq_import_queue_service.config, "get_root_path", return_value=str(self.root))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.request_path = self.root / resq_import_queue_service.REQUEST_RELATIVE_DIR / f"{REQUEST_ID}.json"
        self.status_path = self.root / resq_import_queue_service.STATUS_RELATIVE_DIR / f"{REQUEST_ID}.json"

    def test_the_mutation_is_registered_and_the_queue_is_the_bridge_contracts(self) -> None:
        spec = WORKSPACE_MUTATION_KINDS["resq_import_request_publish"]
        self.assertEqual((spec.module, spec.function), ("resq_import_queue_service", "publish_resq_import_request"))
        self.assertEqual(spec.required, ("project_name", "reserving_class", "request_id", "request"))
        contract = json.loads(BRIDGE_IMPORT_CONTRACT.read_text(encoding="utf-8"))
        self.assertEqual(resq_import_queue_service.REQUEST_RELATIVE_DIR.parts, tuple(contract["request_relative_dir"]))
        self.assertEqual(resq_import_queue_service.STATUS_RELATIVE_DIR.parts, tuple(contract["status_relative_dir"]))

    def test_publishes_the_macros_request_for_the_acting_user(self) -> None:
        with user_identity_service.acting_identity("jdoe", "Jane Doe"):
            response = resq_import_queue_service.publish_resq_import_request("Demo", r"Auto\PP", REQUEST_ID, _request())

        self.assertEqual(response, {"ok": True, "request_id": REQUEST_ID, "resumed": False})
        self.assertEqual(json.loads(self.request_path.read_text(encoding="utf-8")), _request(UserName="jdoe"))

    def test_a_request_id_already_in_the_queue_is_returned_untouched(self) -> None:
        resq_import_queue_service.publish_resq_import_request("Demo", r"Auto\PP", REQUEST_ID, _request())
        first = self.request_path.read_bytes()
        repeated = resq_import_queue_service.publish_resq_import_request(
            "Demo", r"Auto\PP", REQUEST_ID, _request(SelectedNames=["Other"])
        )
        self.assertTrue(repeated["resumed"])
        self.assertEqual(self.request_path.read_bytes(), first)

        self.request_path.unlink()
        self.status_path.parent.mkdir(parents=True, exist_ok=True)
        self.status_path.write_text("{}", encoding="utf-8")
        self.assertTrue(
            resq_import_queue_service.publish_resq_import_request("Demo", r"Auto\PP", REQUEST_ID, _request())["resumed"]
        )
        self.assertFalse(self.request_path.exists())

    def test_refuses_a_request_that_names_another_project_class_or_id(self) -> None:
        for args in (
            ("Other", r"Auto\PP", REQUEST_ID, _request()),
            ("Demo", r"Auto\PA", REQUEST_ID, _request()),
            ("Demo", r"Auto\PP", REQUEST_ID, _request(RequestId="f" * 32)),
            ("Demo", r"Auto\PP", "../escape", _request(RequestId="../escape")),
            ("Demo", r"Auto\PP", REQUEST_ID, ["not", "an", "object"]),
        ):
            with self.subTest(args=args[:3]):
                with self.assertRaises(HTTPException) as refused:
                    resq_import_queue_service.publish_resq_import_request(*args)
                self.assertEqual(refused.exception.status_code, 400)
        self.assertFalse((self.root / resq_import_queue_service.REQUEST_RELATIVE_DIR).exists())


if __name__ == "__main__":
    unittest.main()
