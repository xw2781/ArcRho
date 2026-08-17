"""Arcode SQL Server console: profile store, driver reuse, and query shaping."""
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

from app_server.services import mssql_odbc, source_table_service, sql_server_service
from app_server.services.sql_console_results import clamp_row_limit, json_safe_cell


class _FakeCursor:
    """Minimal pyodbc cursor: a scripted batch of result sets."""

    def __init__(self, sets):
        self._sets = list(sets)
        self._index = -1
        self.description = None
        self.rowcount = -1
        self.closed = False
        self.executed = ""

    def execute(self, statement):
        self.executed = statement
        self._index = 0
        self._apply()

    def _apply(self):
        current = self._sets[self._index]
        self.description = (
            [(name,) for name in current["columns"]] if current.get("columns") else None
        )
        self.rowcount = current.get("rowcount", -1)

    def fetchmany(self, size):
        return list(self._sets[self._index].get("rows", []))[:size]

    def nextset(self):
        if self._index + 1 >= len(self._sets):
            return False
        self._index += 1
        self._apply()
        return True

    def close(self):
        self.closed = True


class _FakeConnection:
    def __init__(self, cursor):
        self._cursor = cursor
        self.timeout = None

    def cursor(self):
        return self._cursor

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False


class _FakeDriver:
    def __init__(self, cursor):
        self._cursor = cursor
        self.connection_string = ""
        self.kwargs = {}

    def connect(self, connection_string, **kwargs):
        self.connection_string = connection_string
        self.kwargs = kwargs
        return _FakeConnection(self._cursor)


class _StoreTestCase(unittest.TestCase):
    """Every test writes to its own throwaway per-user profile file."""

    def setUp(self) -> None:
        self._temp = tempfile.TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.store_path = str(Path(self._temp.name) / "sql_server_connections.json")
        patcher = mock.patch.object(
            sql_server_service.config, "SQL_SERVER_CONNECTIONS_PATH", self.store_path
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        # Driver probing is a real pyodbc call; the store tests never need it.
        driver_patcher = mock.patch.object(
            sql_server_service.mssql_odbc,
            "installed_odbc_driver",
            return_value="ODBC Driver 18 for SQL Server",
        )
        driver_patcher.start()
        self.addCleanup(driver_patcher.stop)

    def _saved_payload(self) -> dict:
        with open(self.store_path, "r", encoding="utf-8") as handle:
            return json.load(handle)


class OdbcOwnershipTests(unittest.TestCase):
    """One module owns driver selection, so no consumer can drift from it."""

    def test_source_table_import_uses_the_canonical_connection_string(self) -> None:
        with mock.patch.object(
            mssql_odbc, "installed_odbc_driver", return_value="ODBC Driver 17 for SQL Server"
        ):
            expected = mssql_odbc.windows_connection_string("SRV", "DB")
            built = source_table_service._connection_string(
                {"server": "SRV", "database": "DB"}
            )
        self.assertEqual(built, expected)
        self.assertIn("Trusted_Connection=yes", built)
        self.assertNotIn("PWD", built.upper())

    def test_missing_driver_reports_the_runtime_the_user_must_fix(self) -> None:
        with mock.patch.object(mssql_odbc, "pyodbc", None), mock.patch.object(
            mssql_odbc.config, "app_runtime_name", return_value="Arcode"
        ):
            with self.assertRaises(mssql_odbc.MssqlDriverUnavailableError) as caught:
                mssql_odbc.get_pyodbc()
        self.assertIn("Arcode Python runtime", str(caught.exception))

    def test_source_table_service_maps_a_missing_driver_to_503(self) -> None:
        with mock.patch.object(mssql_odbc, "pyodbc", None):
            with self.assertRaises(HTTPException) as caught:
                source_table_service._require_driver()
        self.assertEqual(caught.exception.status_code, 503)


class ConnectionStoreTests(_StoreTestCase):
    def test_first_saved_profile_becomes_the_default(self) -> None:
        result = sql_server_service.save_connection(
            "", {"name": "Actuarial", "server": "SRV", "database": "Claims"}
        )
        self.assertEqual(result["defaultConnection"], "Actuarial")
        self.assertEqual(
            result["connections"]["Actuarial"],
            {
                "name": "Actuarial",
                "server": "SRV",
                "database": "Claims",
                "authentication": "windows",
            },
        )
        self.assertEqual(self._saved_payload()["version"], sql_server_service.CONNECTIONS_VERSION)

    def test_renaming_a_profile_moves_it_instead_of_copying_it(self) -> None:
        sql_server_service.save_connection(
            "", {"name": "Old", "server": "SRV", "database": "Claims"}
        )
        result = sql_server_service.save_connection(
            "Old", {"name": "New", "server": "SRV", "database": "Claims"}
        )
        self.assertEqual(list(result["connections"]), ["New"])
        # The renamed profile keeps the default it held under its old name.
        self.assertEqual(result["defaultConnection"], "New")

    def test_deleting_the_default_falls_back_to_a_remaining_profile(self) -> None:
        sql_server_service.save_connection(
            "", {"name": "First", "server": "S1", "database": "D1"}
        )
        sql_server_service.save_connection(
            "", {"name": "Second", "server": "S2", "database": "D2"}, make_default=True
        )
        result = sql_server_service.delete_connection("Second")
        self.assertEqual(list(result["connections"]), ["First"])
        self.assertEqual(result["defaultConnection"], "First")

    def test_deleting_an_unknown_profile_reports_not_found(self) -> None:
        with self.assertRaises(HTTPException) as caught:
            sql_server_service.delete_connection("Missing")
        self.assertEqual(caught.exception.status_code, 404)

    def test_an_incomplete_profile_is_refused_before_it_is_stored(self) -> None:
        with self.assertRaises(HTTPException) as caught:
            sql_server_service.save_connection("", {"name": "Partial", "server": "SRV"})
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("database", caught.exception.detail)
        self.assertFalse(Path(self.store_path).exists())

    def test_sql_login_is_refused_while_only_windows_auth_is_wired_up(self) -> None:
        with self.assertRaises(HTTPException) as caught:
            sql_server_service.save_connection(
                "",
                {
                    "name": "Login",
                    "server": "SRV",
                    "database": "DB",
                    "authentication": "sql_login",
                },
            )
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("Windows authentication", caught.exception.detail)

    def test_the_stored_payload_never_carries_a_credential_field(self) -> None:
        sql_server_service.save_connection(
            "",
            {
                "name": "Actuarial",
                "server": "SRV",
                "database": "DB",
                "user": "someone",
                "password": "secret",
            },
        )
        text = Path(self.store_path).read_text(encoding="utf-8")
        self.assertNotIn("password", text)
        self.assertNotIn("secret", text)

    def test_an_unreadable_store_reports_no_connections_instead_of_failing(self) -> None:
        Path(self.store_path).write_text("{ not json", encoding="utf-8")
        result = sql_server_service.load_connections()
        self.assertEqual(result["connections"], {})
        self.assertEqual(result["defaultConnection"], "")


class QueryExecutionTests(_StoreTestCase):
    def setUp(self) -> None:
        super().setUp()
        sql_server_service.save_connection(
            "", {"name": "Actuarial", "server": "SRV", "database": "Claims"}
        )

    def _run(self, cursor, sql="select 1", connection="", limit=None):
        driver = _FakeDriver(cursor)
        with mock.patch.object(
            sql_server_service.mssql_odbc, "get_pyodbc", return_value=driver
        ), mock.patch.object(
            sql_server_service.mssql_odbc,
            "windows_connection_string",
            return_value="DRIVER={x};SERVER=SRV;DATABASE=Claims;Trusted_Connection=yes;",
        ):
            return sql_server_service.run_query(sql, connection, limit), driver

    def test_a_select_returns_columns_rows_and_the_connection_it_ran_on(self) -> None:
        cursor = _FakeCursor([{ "columns": ["Id", "Name"], "rows": [[1, "a"], [2, "b"]]}])
        result, driver = self._run(cursor)
        self.assertTrue(result["ok"])
        self.assertEqual(result["columns"], ["Id", "Name"])
        self.assertEqual(result["rows"], [[1, "a"], [2, "b"]])
        self.assertEqual(result["rowCount"], 2)
        self.assertFalse(result["truncated"])
        self.assertEqual(result["connection"], "Actuarial")
        self.assertTrue(driver.kwargs.get("autocommit"))
        self.assertTrue(cursor.closed)

    def test_a_result_larger_than_the_limit_is_reported_as_truncated(self) -> None:
        rows = [[index] for index in range(10)]
        cursor = _FakeCursor([{"columns": ["N"], "rows": rows}])
        result, _ = self._run(cursor, limit=3)
        self.assertEqual(result["rowCount"], 3)
        self.assertTrue(result["truncated"])

    def test_statements_before_the_first_grid_report_their_affected_rows(self) -> None:
        cursor = _FakeCursor([
            {"columns": None, "rowcount": 4},
            {"columns": ["Id"], "rows": [[7]]},
        ])
        result, _ = self._run(cursor, sql="update t set x=1; select id from t;")
        self.assertTrue(result["ok"])
        self.assertEqual(result["columns"], ["Id"])
        self.assertEqual(result["rowsAffected"], 4)

    def test_a_batch_with_no_result_set_still_succeeds(self) -> None:
        cursor = _FakeCursor([{"columns": None, "rowcount": 2}])
        result, _ = self._run(cursor, sql="update t set x=1")
        self.assertTrue(result["ok"])
        self.assertEqual(result["columns"], [])
        self.assertEqual(result["rowsAffected"], 2)

    def test_empty_sql_never_opens_a_connection(self) -> None:
        cursor = _FakeCursor([{"columns": ["N"], "rows": [[1]]}])
        result, driver = self._run(cursor, sql="   ")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "SQL is empty.")
        self.assertEqual(driver.connection_string, "")

    def test_a_driver_failure_is_returned_as_a_failed_query_not_an_http_error(self) -> None:
        class _Failing(_FakeDriver):
            def connect(self, connection_string, **kwargs):
                raise RuntimeError("Login failed for user 'DOMAIN\\\\user'.")

        driver = _Failing(None)
        with mock.patch.object(
            sql_server_service.mssql_odbc, "get_pyodbc", return_value=driver
        ), mock.patch.object(
            sql_server_service.mssql_odbc,
            "windows_connection_string",
            return_value="DRIVER={x};",
        ):
            result = sql_server_service.run_query("select 1", "Actuarial")
        self.assertFalse(result["ok"])
        self.assertIn("Login failed", result["error"])

    def test_a_missing_driver_is_reported_without_reaching_a_server(self) -> None:
        with mock.patch.object(
            sql_server_service.mssql_odbc,
            "get_pyodbc",
            side_effect=mssql_odbc.MssqlDriverUnavailableError("no driver"),
        ):
            result = sql_server_service.run_query("select 1", "Actuarial")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "no driver")

    def test_an_unknown_connection_name_is_a_404(self) -> None:
        with self.assertRaises(HTTPException) as caught:
            sql_server_service.run_query("select 1", "Nope")
        self.assertEqual(caught.exception.status_code, 404)

    def test_an_empty_connection_name_runs_on_the_stored_default(self) -> None:
        cursor = _FakeCursor([{"columns": ["N"], "rows": [[1]]}])
        result, _ = self._run(cursor, connection="")
        self.assertEqual(result["connection"], "Actuarial")


class ResultShapingTests(unittest.TestCase):
    def test_the_row_limit_is_bounded_at_both_ends(self) -> None:
        # 0 and None both mean "the caller did not choose", not "no rows".
        self.assertEqual(clamp_row_limit(0), 1000)
        self.assertEqual(clamp_row_limit(None), 1000)
        self.assertEqual(clamp_row_limit(-5), 1)
        self.assertEqual(clamp_row_limit("bad"), 1000)
        self.assertEqual(clamp_row_limit(10_000_000), 5000)

    def test_driver_values_are_converted_to_renderable_json(self) -> None:
        import datetime
        import decimal

        self.assertEqual(json_safe_cell(None), None)
        self.assertEqual(json_safe_cell(3), 3)
        self.assertEqual(json_safe_cell(decimal.Decimal("1.50")), "1.50")
        self.assertEqual(json_safe_cell(datetime.date(2026, 8, 17)), "2026-08-17")
        self.assertEqual(json_safe_cell(b"\x00\xff"), "00ff")


if __name__ == "__main__":
    unittest.main()
