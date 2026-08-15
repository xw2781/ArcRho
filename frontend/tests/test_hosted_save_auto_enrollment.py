from __future__ import annotations

import json
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = FRONTEND_ROOT.parent
PYTHON_API_SRC = REPOSITORY_ROOT / "python-api" / "src"
for path in (FRONTEND_ROOT, PYTHON_API_SRC):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from arcrho_api.hosted_save_enrollment import provision_gateway_user
from arcrho_hosted_save_http_contract import default_gateway_config
from app_server.services import hosted_save_enrollment_service


class HostedSaveAutoEnrollmentTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT))
        self.root = Path(self.temporary.name)
        (self.root / "config").mkdir()
        self.local_path = self.root / "local" / "hosted_save_gateway.json"

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _write_server_config(self, *, client_url: str = "http://gateway.test:28767") -> None:
        payload = default_gateway_config()
        payload["client_url"] = client_url
        (self.root / "config" / "hosted_save_gateway.json").write_text(
            json.dumps(payload), encoding="utf-8"
        )

    def _auto_enroll(self):
        with (
            patch.object(
                hosted_save_enrollment_service.config,
                "get_hosted_save_gateway_config_path",
                return_value=str(self.local_path),
            ),
            patch.object(
                hosted_save_enrollment_service.config,
                "get_root_path",
                return_value=str(self.root),
            ),
            patch.object(
                hosted_save_enrollment_service.user_identity_service,
                "get_windows_login_name",
                return_value="Alice",
            ),
        ):
            return hosted_save_enrollment_service.auto_enroll_current_user()

    def test_startup_enrolls_current_user_when_gateway_is_reachable(self) -> None:
        self._write_server_config()
        with patch.object(
            hosted_save_enrollment_service.hosted_save_http_client,
            "probe_gateway",
            return_value={"hosted_save_http": True},
        ) as probe:
            result = self._auto_enroll()

        self.assertEqual(result["status"], "enrolled")
        probe.assert_called_once_with({"url": "http://gateway.test:28767"})
        local = json.loads(self.local_path.read_text(encoding="utf-8"))
        shared = json.loads(
            (self.root / "config" / "hosted_save_gateway.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(local["user"], "Alice")
        self.assertEqual(local["url"], "http://gateway.test:28767")
        self.assertEqual(shared["users"]["alice"], local["secret"])

    def test_existing_local_config_is_never_replaced(self) -> None:
        self.local_path.parent.mkdir(parents=True)
        self.local_path.write_text('{"enabled": false}\n', encoding="utf-8")
        with patch.object(
            hosted_save_enrollment_service.hosted_save_http_client,
            "probe_gateway",
        ) as probe:
            result = self._auto_enroll()

        self.assertEqual(result["status"], "existing")
        probe.assert_not_called()
        self.assertEqual(
            self.local_path.read_text(encoding="utf-8"), '{"enabled": false}\n'
        )

    def test_unreachable_gateway_leaves_smb_default_untouched(self) -> None:
        self._write_server_config()
        with patch.object(
            hosted_save_enrollment_service.hosted_save_http_client,
            "probe_gateway",
            side_effect=RuntimeError("offline"),
        ):
            result = self._auto_enroll()

        self.assertEqual(result["status"], "unavailable")
        self.assertFalse(self.local_path.exists())

    def test_missing_client_url_does_not_enroll(self) -> None:
        self._write_server_config(client_url="")
        result = self._auto_enroll()
        self.assertEqual(result["status"], "not_configured")
        self.assertFalse(self.local_path.exists())

    def test_concurrent_provisioning_preserves_multiple_users(self) -> None:
        self._write_server_config()
        alice_path = self.root / "alice" / "hosted_save_gateway.json"
        bob_path = self.root / "bob" / "hosted_save_gateway.json"
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [
                executor.submit(
                    provision_gateway_user,
                    server_root=self.root,
                    user=user,
                    client_output=path,
                )
                for user, path in (("Alice", alice_path), ("Bob", bob_path))
            ]
            for future in futures:
                future.result(timeout=5)

        shared = json.loads(
            (self.root / "config" / "hosted_save_gateway.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(set(shared["users"]), {"alice", "bob"})
        self.assertEqual(
            shared["users"]["alice"],
            json.loads(alice_path.read_text(encoding="utf-8"))["secret"],
        )
        self.assertEqual(
            shared["users"]["bob"],
            json.loads(bob_path.read_text(encoding="utf-8"))["secret"],
        )


if __name__ == "__main__":
    unittest.main()
