"""A server's identity: written once into its configuration, reported by its Gateway."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
for import_root in (
    REPOSITORY_ROOT / "server-components" / "src",
    REPOSITORY_ROOT / "python-api" / "src",
):
    if str(import_root) not in sys.path:
        sys.path.insert(0, str(import_root))
TEST_TEMP_ROOT = REPOSITORY_ROOT / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)

from arcrho_api import config as api_config  # noqa: E402
from arcrho_gateway import main as gateway_main  # noqa: E402
import server_config  # noqa: E402


class ServerIdentityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        self.root = Path(self.temp.name)
        self.config_path = self.root / "config" / "config.json"

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _stored(self) -> dict:
        return json.loads(self.config_path.read_text(encoding="utf-8"))

    def test_the_client_reads_the_file_the_server_writes(self) -> None:
        self.assertEqual(
            server_config.SERVER_CONFIG_RELATIVE_PATH, api_config.SERVER_CONFIG_RELATIVE_PATH
        )

    def test_ensure_server_config_writes_an_id_once(self) -> None:
        _, first = server_config.ensure_server_config(self.root)
        server_id = first[api_config.SERVER_ID_KEY]
        self.assertTrue(server_id)
        _, second = server_config.ensure_server_config(self.root)
        self.assertEqual(second[api_config.SERVER_ID_KEY], server_id)
        self.assertEqual(api_config.read_server_id(self.root), server_id)

    def test_ensure_server_id_adds_only_the_id(self) -> None:
        server_config.write_server_config(self.config_path, {"apps": {"engine": {"kill_all": True}}})
        server_id = server_config.ensure_server_id(self.root)
        self.assertEqual(
            self._stored(), {"apps": {"engine": {"kill_all": True}}, "server_id": server_id}
        )
        self.assertEqual(server_config.ensure_server_id(self.root), server_id)

    def test_a_reset_keeps_the_id(self) -> None:
        reset = server_config.with_server_id(
            server_config.default_server_config(self.root), keep_from={"server_id": "kept"}
        )
        self.assertEqual(reset["server_id"], "kept")

    def test_the_gateway_reports_its_roots_id(self) -> None:
        self.assertEqual(gateway_main.Gateway(self.root).capabilities()["server_id"], "")
        server_id = server_config.ensure_server_id(self.root)
        self.assertEqual(gateway_main.Gateway(self.root).capabilities()["server_id"], server_id)


if __name__ == "__main__":
    unittest.main()
