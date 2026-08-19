"""Arcode Database Connections: profile editing and session reset per engine.

Both engines are edited through one shell dialog, so their stores must behave
the same way: a rename moves a profile in place, a delete removes exactly one,
and Reconnect says what it did to the session a Run starts from.
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi import HTTPException

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
FRONTEND_ROOT = REPOSITORY_ROOT / "frontend"
PYTHON_API_SRC = REPOSITORY_ROOT / "python-api" / "src"
for import_root in (PYTHON_API_SRC, FRONTEND_ROOT):
    if str(import_root) not in sys.path:
        sys.path.insert(0, str(import_root))

from app_server.services import snowflake_service, sql_server_service


SNOWFLAKE_PROFILE = {
    "name": "analytics",
    "account": "acme-prod",
    "user": "actuary",
    "authenticator": "externalbrowser",
    "role": "ANALYST",
    "warehouse": "WH_SMALL",
    "database": "RESERVING",
    "schema_name": "PUBLIC",
}


class SnowflakeProfileStoreTests(unittest.TestCase):
    """The Snowflake store is edited the same way the SQL Server store is."""

    def setUp(self) -> None:
        self._temp = tempfile.TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.store_path = str(Path(self._temp.name) / "snowflake_connections.json")
        patcher = mock.patch.object(
            snowflake_service.config, "SNOWFLAKE_CONNECTIONS_PATH", self.store_path
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        # The seeded example profile is a machine-specific import path.
        import_patcher = mock.patch.object(
            snowflake_service, "SNOWFLAKE_CONFIG_IMPORT_PATH", str(Path(self._temp.name) / "absent.txt")
        )
        import_patcher.start()
        self.addCleanup(import_patcher.stop)

    def _saved_payload(self) -> dict:
        with open(self.store_path, "r", encoding="utf-8") as handle:
            return json.load(handle)

    def test_saving_a_new_profile_stores_every_field(self) -> None:
        result = snowflake_service.save_connection("", SNOWFLAKE_PROFILE)

        stored = result["connections"]["analytics"]
        self.assertEqual(stored["account"], "acme-prod")
        self.assertEqual(stored["warehouse"], "WH_SMALL")
        # The request model spells it `schema_name`; the store spells it `schema`.
        self.assertEqual(stored["schema"], "PUBLIC")
        self.assertIn("analytics", self._saved_payload()["connections"])

    def test_renaming_a_profile_moves_it_instead_of_copying_it(self) -> None:
        snowflake_service.save_connection("", SNOWFLAKE_PROFILE)

        renamed = dict(SNOWFLAKE_PROFILE, name="reserving")
        result = snowflake_service.save_connection("analytics", renamed)

        self.assertEqual(list(result["connections"]), ["reserving"])

    def test_saving_without_a_name_is_rejected(self) -> None:
        with self.assertRaises(HTTPException) as raised:
            snowflake_service.save_connection("", dict(SNOWFLAKE_PROFILE, name=""))
        self.assertEqual(raised.exception.status_code, 400)

    def test_deleting_removes_only_the_named_profile(self) -> None:
        snowflake_service.save_connection("", SNOWFLAKE_PROFILE)
        snowflake_service.save_connection("", dict(SNOWFLAKE_PROFILE, name="pricing"))

        result = snowflake_service.delete_connection("analytics")

        self.assertEqual(list(result["connections"]), ["pricing"])

    def test_deleting_an_unknown_profile_is_not_found(self) -> None:
        with self.assertRaises(HTTPException) as raised:
            snowflake_service.delete_connection("absent")
        self.assertEqual(raised.exception.status_code, 404)


class ReconnectTests(unittest.TestCase):
    """Reconnect ends the session a Run would otherwise inherit."""

    def test_snowflake_reconnect_closes_the_cached_session(self) -> None:
        with mock.patch.object(snowflake_service, "_close_cached_connection") as closed:
            result = snowflake_service.reset_connection("analytics")

        closed.assert_called_once_with("analytics")
        self.assertTrue(result["ok"])
        self.assertIn("new session", result["message"])

    def test_sql_server_reconnect_reports_its_per_run_connection(self) -> None:
        store = {"connections": {}, "default": ""}
        with mock.patch.object(sql_server_service, "_read_store", return_value=store):
            result = sql_server_service.reset_connection("reporting")

        self.assertTrue(result["ok"])
        self.assertEqual(result["connection"], "reporting")
        # SQL Server opens a connection per Run, so there is no session to drop.
        self.assertIn("new connection for every Run", result["message"])

    def test_sql_server_reconnect_answers_even_without_a_stored_profile(self) -> None:
        """Nothing is opened or closed, so an unset name is answered, not refused."""

        store = {"connections": {}, "default": ""}
        with mock.patch.object(sql_server_service, "_read_store", return_value=store):
            result = sql_server_service.reset_connection("")

        self.assertTrue(result["ok"])
        self.assertEqual(result["connection"], "")
        self.assertIn("SQL Server opens a new connection", result["message"])


if __name__ == "__main__":
    unittest.main()
