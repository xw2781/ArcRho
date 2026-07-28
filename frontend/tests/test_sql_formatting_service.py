from __future__ import annotations

import hashlib
import time
import unittest
from unittest.mock import patch

from app_server.schemas.sql_formatting import SqlFormattingPreviewRequest
from app_server.services.sql_formatting.advisories import find_advisories
from app_server.services.sql_formatting.engine import SqlFormatter
from app_server.services.sql_formatting.version import SQLFLUFF_VERSION
from app_server.services.sql_formatting_service import preview


class SqlFormattingServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.formatter = SqlFormatter()

    def test_tsql_formatting_preserves_protected_text_and_is_idempotent(self) -> None:
        source = (
            "select 'from where join on' as label, cast(1 as varchar(10)) as value\r\n"
            "from dbo.sample -- select * from ignored\r\n"
            "where id=1;\r\n"
        )

        result = self.formatter.format(source, dialect="tsql")

        self.assertTrue(result.safety.safe_to_apply)
        self.assertEqual(
            result.source_hash,
            hashlib.sha256(source.encode("utf-8")).hexdigest(),
        )
        self.assertIn("'from where join on'", result.formatted_sql)
        self.assertIn("-- select * from ignored", result.formatted_sql)
        self.assertIn("varchar(10)", result.formatted_sql)
        self.assertIn("\r\n", result.formatted_sql)
        self.assertTrue(result.formatted_sql.endswith("\r\n"))

        second = self.formatter.format(result.formatted_sql, dialect="tsql")
        self.assertTrue(second.safety.safe_to_apply)
        self.assertFalse(second.changed)
        self.assertEqual(second.formatted_sql, result.formatted_sql)

    def test_malformed_sql_fails_closed(self) -> None:
        source = "select 'unterminated"

        result = self.formatter.format(source, dialect="tsql")

        self.assertFalse(result.safety.safe_to_apply)
        self.assertFalse(result.changed)
        self.assertEqual(result.formatted_sql, source)
        self.assertEqual(result.formatted_hash, result.source_hash)
        self.assertEqual(result.diagnostics[0].code, "LEX_UNTERMINATED")

    def test_user_defined_function_and_type_casing_is_preserved(self) -> None:
        source = (
            "select dbo.MyFunction(input_value), convert(MyType, input_value) "
            "from dbo.sample;\n"
        )

        result = self.formatter.format(source, dialect="tsql")

        self.assertTrue(result.safety.safe_to_apply)
        self.assertIn("dbo.MyFunction", result.formatted_sql)
        self.assertIn("MyType", result.formatted_sql)

    def test_skipped_openquery_literals_remain_inside_outer_safety_checks(self) -> None:
        source = (
            "select remote_id from openquery(REMOTE, "
            "'select secret_value from remote_table') as remote_rows;\n"
        )

        with patch.object(
            self.formatter,
            "_format_tsql_batches",
            side_effect=lambda value: value.replace("secret_value", "changed_value"),
        ):
            result = self.formatter.format(
                source,
                dialect="tsql",
                openquery_mode="auto",
            )

        self.assertFalse(result.safety.safe_to_apply)
        self.assertFalse(result.changed)
        self.assertEqual(result.formatted_sql, source)
        self.assertEqual(result.diagnostics[0].code, "SAFE_TOKEN_CHANGE")

    def test_standalone_snowflake_and_nested_openquery_are_dialect_aware(self) -> None:
        snowflake = "select iff(flag=1, 'yes', 'no') as state from analytics.events;\n"
        standalone = self.formatter.format(
            snowflake,
            dialect="snowflake",
            openquery_mode="off",
        )
        self.assertTrue(standalone.safety.safe_to_apply)
        self.assertEqual(
            self.formatter.format(
                standalone.formatted_sql,
                dialect="snowflake",
                openquery_mode="off",
            ).formatted_sql,
            standalone.formatted_sql,
        )

        tsql = (
            "select remote_id from openquery(SNOWFLAKE, "
            "'select remote_id from analytics.events where flag=1') as remote_rows;\n"
        )
        nested = self.formatter.format(
            tsql,
            dialect="tsql",
            openquery_mode="snowflake",
        )
        self.assertTrue(nested.safety.safe_to_apply)
        self.assertEqual(len(nested.nested_regions), 1)
        self.assertEqual(nested.nested_regions[0].dialect, "snowflake")
        self.assertIn(nested.nested_regions[0].status, {"formatted", "unchanged"})
        self.assertEqual(
            self.formatter.format(
                nested.formatted_sql,
                dialect="tsql",
                openquery_mode="snowflake",
            ).formatted_sql,
            nested.formatted_sql,
        )

    def test_advisories_use_code_tokens_not_comments_or_strings(self) -> None:
        protected_only = (
            "select 'SELECT *; SELECT DISTINCT; EXEC(@sql);' as sample "
            "-- SELECT * INTO #fake\n"
            "from dbo.source;\n"
        )
        self.assertEqual(find_advisories(protected_only, dialect="tsql"), [])

        source = (
            "SELECT DISTINCT * INTO #work FROM dbo.source;\n"
            "DECLARE work_cursor CURSOR FOR SELECT id FROM #work;\n"
            "EXEC(@sql)\n"
        )
        codes = {item.code for item in find_advisories(source, dialect="tsql")}
        self.assertTrue(
            {"SQL001", "SQL002", "SQL003", "SQL004", "SQL005", "SQL006", "SQL007"}
            <= codes
        )

    def test_advisory_line_mapping_scales_linearly(self) -> None:
        source = "".join(
            f"SELECT DISTINCT value_{line} FROM dbo.source;\n"
            for line in range(1, 2_001)
        )

        started = time.perf_counter()
        findings = find_advisories(source, dialect="tsql")
        elapsed_seconds = time.perf_counter() - started

        distinct_findings = [item for item in findings if item.code == "SQL002"]
        self.assertEqual(len(distinct_findings), 2_000)
        self.assertEqual(distinct_findings[0].line, 1)
        self.assertEqual(distinct_findings[-1].line, 2_000)
        self.assertLess(elapsed_seconds, 2.0)

    def test_service_returns_the_typed_canonical_preview(self) -> None:
        source = "select 1;\n"
        result = preview(
            SqlFormattingPreviewRequest(
                sql=source,
                dialect="tsql",
                openquery_mode="auto",
            )
        )

        self.assertEqual(
            result.source_hash,
            hashlib.sha256(source.encode("utf-8")).hexdigest(),
        )
        self.assertTrue(result.safety.safe_to_apply)
        self.assertEqual(result.engine["version"], SQLFLUFF_VERSION)
        self.assertEqual(result.engine["profile"], "arcode-enterprise-v1")

    def test_formatter_rejects_a_noncanonical_sqlfluff_runtime(self) -> None:
        with patch(
            "app_server.services.sql_formatting.engine.sqlfluff.__version__",
            "unexpected-version",
        ):
            with self.assertRaisesRegex(RuntimeError, f"requires sqlfluff {SQLFLUFF_VERSION}"):
                SqlFormatter()


if __name__ == "__main__":
    unittest.main()
