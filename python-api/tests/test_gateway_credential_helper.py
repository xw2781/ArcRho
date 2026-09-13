"""The frozen helper the Excel add-in runs when a PC has no credential.

It must install exactly the credential the desktop app installs, take the
server's own address rather than one built from the machine it runs on, and
never touch a credential that is already there.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
for import_root in (
    REPOSITORY_ROOT / "python-api" / "src",
    REPOSITORY_ROOT / "server-components" / "src",
):
    if str(import_root) not in sys.path:
        sys.path.insert(0, str(import_root))

from arcrho_api import hosted_save_enrollment  # noqa: E402
from arcrho_credential import main as credential_helper  # noqa: E402
from arcrho_hosted_save_http_contract import (  # noqa: E402
    CLIENT_CONFIG_FILE_NAME,
    default_gateway_config,
    normalize_client_config,
)

TEST_TEMP_ROOT = REPOSITORY_ROOT / "test"
SERVER_URL = "http://arcrho-server.test:28767"


class GatewayCredentialHelperTests(unittest.TestCase):
    def setUp(self) -> None:
        TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=str(TEST_TEMP_ROOT))
        base = Path(self.temporary.name)
        self.workspace = base / "ArcRho Server"
        (self.workspace / "config").mkdir(parents=True)
        self.appdata = base / "AppData"
        self.local_path = self.appdata / "ArcRho" / CLIENT_CONFIG_FILE_NAME
        self.shared_path = self.workspace / "config" / CLIENT_CONFIG_FILE_NAME

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _write_shared_registry(self, *, client_url: str = SERVER_URL) -> None:
        payload = default_gateway_config()
        payload["client_url"] = client_url
        self.shared_path.write_text(json.dumps(payload), encoding="utf-8")

    def _run(self) -> tuple[int, str, list[str]]:
        probed: list[str] = []
        output = StringIO()
        with (
            patch.dict(
                credential_helper.os.environ,
                {"APPDATA": str(self.appdata), "USERNAME": "Alice"},
            ),
            patch.object(
                hosted_save_enrollment,
                "probe_gateway_url",
                side_effect=lambda url: probed.append(url),
            ),
            redirect_stdout(output),
        ):
            code = credential_helper.main([str(self.workspace)])
        return code, output.getvalue().strip(), probed

    def test_first_run_installs_a_credential_the_gateway_accepts(self) -> None:
        self._write_shared_registry()

        code, printed, _ = self._run()

        self.assertEqual(code, 0)
        self.assertIn("installed", printed)
        installed = normalize_client_config(
            json.loads(self.local_path.read_text(encoding="utf-8"))
        )
        self.assertTrue(installed["enabled"])
        self.assertEqual(installed["user"], "Alice")
        shared = json.loads(self.shared_path.read_text(encoding="utf-8"))
        self.assertEqual(shared["users"]["alice"], installed["secret"])

    def test_the_shared_registry_owns_the_address(self) -> None:
        self._write_shared_registry()

        _, _, probed = self._run()

        installed = json.loads(self.local_path.read_text(encoding="utf-8"))
        self.assertEqual(installed["url"], SERVER_URL)
        self.assertEqual(probed, [SERVER_URL])
        shared = json.loads(self.shared_path.read_text(encoding="utf-8"))
        self.assertEqual(shared["client_url"], SERVER_URL)

    def test_an_existing_opt_out_is_left_alone(self) -> None:
        self._write_shared_registry()
        self.local_path.parent.mkdir(parents=True)
        self.local_path.write_text('{"enabled": false}\n', encoding="utf-8")

        code, printed, probed = self._run()

        self.assertEqual(code, 0)
        self.assertIn("already present", printed)
        self.assertEqual(probed, [])
        self.assertEqual(
            self.local_path.read_text(encoding="utf-8"), '{"enabled": false}\n'
        )
        shared = json.loads(self.shared_path.read_text(encoding="utf-8"))
        self.assertEqual(shared["users"], {})

    def test_a_registry_without_an_address_writes_nothing(self) -> None:
        self._write_shared_registry(client_url="")

        code, printed, probed = self._run()

        self.assertEqual(code, 1)
        self.assertIn("no Gateway address", printed)
        self.assertEqual(probed, [])
        self.assertFalse(self.local_path.exists())

    def test_an_unreachable_server_writes_nothing(self) -> None:
        self._write_shared_registry()
        with (
            patch.dict(
                credential_helper.os.environ,
                {"APPDATA": str(self.appdata), "USERNAME": "Alice"},
            ),
            patch.object(
                hosted_save_enrollment,
                "probe_gateway_url",
                side_effect=OSError("the server could not be reached"),
            ),
            redirect_stdout(StringIO()) as output,
        ):
            code = credential_helper.main([str(self.workspace)])

        self.assertEqual(code, 1)
        self.assertIn("could not be reached", output.getvalue())
        self.assertFalse(self.local_path.exists())
        shared = json.loads(self.shared_path.read_text(encoding="utf-8"))
        self.assertEqual(shared["users"], {})


if __name__ == "__main__":
    unittest.main()
