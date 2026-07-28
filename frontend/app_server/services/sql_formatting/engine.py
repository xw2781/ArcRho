from __future__ import annotations

import hashlib
import textwrap
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import sqlfluff
from sqlfluff.api import APIParsingError
from sqlfluff.core import FluffConfig

from app_server.schemas.sql_formatting import (
    OpenQueryMode,
    SqlDialect,
    SqlFormattingAdvisory,
    SqlFormattingDiagnostic,
    SqlFormattingNestedRegion,
    SqlFormattingPreviewResponse,
    SqlFormattingSafetyReport,
)

from .advisories import find_advisories
from .compat import mask_parser_quirks, restore_parser_quirks
from .layout import layout_tsql_whitespace
from .lexing import (
    has_unterminated_protected_region,
    lex_sql,
    protected_signature,
    split_tsql_batches,
    token_signature,
)
from .openquery import (
    OpenQueryRegion,
    decode_tsql_string,
    encode_tsql_string,
    find_openquery_regions,
)
from .version import SQLFLUFF_VERSION


CONFIG_PATH = Path(__file__).with_name("default.sqlfluff")
PROFILE_VERSION = "arcode-enterprise-v1"
OPENQUERY_MAX_BYTES = 8_000


@dataclass(slots=True)
class _CompositeResult:
    sql: str
    diagnostics: list[SqlFormattingDiagnostic]
    nested_regions: list[SqlFormattingNestedRegion]
    token_equivalent: bool
    protected_preserved: bool
    parsed_before: bool
    parsed_after: bool


class _UnsafeFormatError(RuntimeError):
    def __init__(
        self,
        diagnostic: SqlFormattingDiagnostic,
        *,
        parsed_before: bool = False,
    ) -> None:
        super().__init__(diagnostic.message)
        self.diagnostic = diagnostic
        self.parsed_before = parsed_before


class SqlFormatter:
    """Parser-backed formatter with deterministic, atomic safety gates."""

    def __init__(self) -> None:
        if sqlfluff.__version__ != SQLFLUFF_VERSION:
            raise RuntimeError(
                f"SQL formatting requires sqlfluff {SQLFLUFF_VERSION}; "
                f"found {sqlfluff.__version__}."
            )
        config_text = CONFIG_PATH.read_text(encoding="utf-8")
        self._configs = {
            "tsql": FluffConfig.from_string(config_text),
            "snowflake": FluffConfig.from_string(
                config_text.replace("dialect = tsql", "dialect = snowflake", 1)
            ),
        }
        self._engine_lock = threading.RLock()

    def format(
        self,
        sql: str,
        *,
        dialect: SqlDialect,
        openquery_mode: OpenQueryMode = "auto",
    ) -> SqlFormattingPreviewResponse:
        started = time.perf_counter()
        source_hash = _hash_text(sql)
        advisories = find_advisories(
            sql,
            dialect=dialect,
            openquery_mode=openquery_mode,
        )
        newline = _detect_newline(sql)
        final_newline = sql.endswith(("\n", "\r"))
        normalized = _normalize_newlines(sql)

        if has_unterminated_protected_region(normalized):
            diagnostic = SqlFormattingDiagnostic(
                code="LEX_UNTERMINATED",
                message=(
                    "Formatting was not applied because a string, comment, or "
                    "quoted identifier is unterminated."
                ),
                severity="error",
                dialect=dialect,
            )
            return self._unchanged_response(
                sql,
                source_hash,
                [diagnostic],
                advisories=advisories,
                elapsed_ms=_elapsed_ms(started),
            )

        try:
            first = self._format_once(
                normalized,
                dialect=dialect,
                openquery_mode=openquery_mode,
            )
            second = self._format_once(
                first.sql,
                dialect=dialect,
                openquery_mode=openquery_mode,
            )
            idempotent = first.sql == second.sql
            if not idempotent:
                raise _UnsafeFormatError(
                    SqlFormattingDiagnostic(
                        code="SAFE_IDEMPOTENCE",
                        message=(
                            "The formatter did not reach a stable result in one "
                            "pass; the document was left unchanged."
                        ),
                        severity="error",
                        dialect=dialect,
                    ),
                    parsed_before=first.parsed_before,
                )

            formatted = _restore_document_shape(first.sql, newline, final_newline)
            safe = (
                first.parsed_before
                and first.parsed_after
                and first.token_equivalent
                and first.protected_preserved
                and idempotent
            )
            if not safe:
                raise _UnsafeFormatError(
                    SqlFormattingDiagnostic(
                        code="SAFE_COMPOSITE",
                        message=(
                            "A formatting safety invariant failed; the document "
                            "was left unchanged."
                        ),
                        severity="error",
                        dialect=dialect,
                    ),
                    parsed_before=first.parsed_before,
                )

            return SqlFormattingPreviewResponse(
                source_hash=source_hash,
                formatted_hash=_hash_text(formatted),
                formatted_sql=formatted,
                changed=formatted != sql,
                diagnostics=first.diagnostics,
                advisories=advisories,
                safety=SqlFormattingSafetyReport(
                    parsed_before=True,
                    parsed_after=True,
                    token_equivalent=True,
                    protected_regions_preserved=True,
                    idempotent=True,
                    safe_to_apply=True,
                    reasons=[],
                ),
                nested_regions=first.nested_regions,
                engine=formatter_engine_info(),
                elapsed_ms=_elapsed_ms(started),
            )
        except _UnsafeFormatError as exc:
            return self._unchanged_response(
                sql,
                source_hash,
                [exc.diagnostic],
                advisories=advisories,
                parsed_before=exc.parsed_before,
                elapsed_ms=_elapsed_ms(started),
            )
        except Exception:
            diagnostic = SqlFormattingDiagnostic(
                code="FORMAT_INTERNAL",
                message=(
                    "Formatting encountered an internal error; the document was "
                    "left unchanged."
                ),
                severity="error",
                dialect=dialect,
            )
            return self._unchanged_response(
                sql,
                source_hash,
                [diagnostic],
                advisories=advisories,
                elapsed_ms=_elapsed_ms(started),
            )

    def _format_once(
        self,
        source: str,
        *,
        dialect: SqlDialect,
        openquery_mode: OpenQueryMode,
    ) -> _CompositeResult:
        if not source.strip():
            return _CompositeResult(
                sql=source,
                diagnostics=[],
                nested_regions=[],
                token_equivalent=True,
                protected_preserved=True,
                parsed_before=True,
                parsed_after=True,
            )
        if dialect == "snowflake":
            return self._format_direct_snowflake(source)
        return self._format_tsql_composite(
            source,
            openquery_mode=openquery_mode,
        )

    def _format_direct_snowflake(self, source: str) -> _CompositeResult:
        formatted = self._format_fragment(source, "snowflake")
        equivalent = token_signature(source) == token_signature(formatted)
        protected_preserved = protected_signature(source) == protected_signature(
            formatted
        )
        if not equivalent or not protected_preserved:
            raise _UnsafeFormatError(
                SqlFormattingDiagnostic(
                    code="SAFE_TOKEN_CHANGE",
                    message=(
                        "Formatting changed a protected or non-layout Snowflake "
                        "token; the document was left unchanged."
                    ),
                    severity="error",
                    dialect="snowflake",
                ),
                parsed_before=True,
            )
        return _CompositeResult(
            sql=formatted,
            diagnostics=[],
            nested_regions=[],
            token_equivalent=True,
            protected_preserved=True,
            parsed_before=True,
            parsed_after=True,
        )

    def _format_tsql_composite(
        self,
        source: str,
        *,
        openquery_mode: OpenQueryMode,
    ) -> _CompositeResult:
        before_regions = find_openquery_regions(source, mode=openquery_mode)
        diagnostics: list[SqlFormattingDiagnostic] = []
        nested_formatted: dict[str, str] = {}

        openquery_word_count = sum(
            token.kind == "word" and token.text.casefold() == "openquery"
            for token in lex_sql(source)
        )
        if openquery_word_count > len(before_regions):
            diagnostics.append(
                SqlFormattingDiagnostic(
                    code="OPENQUERY_UNRECOGNIZED",
                    message=(
                        "At least one OPENQUERY call does not use a simple "
                        "two-argument literal form; that nested query was left opaque."
                    ),
                    severity="warning",
                    dialect="tsql",
                )
            )

        for region in before_regions:
            if region.dialect is None:
                if openquery_mode != "off":
                    diagnostics.append(
                        SqlFormattingDiagnostic(
                            code="OPENQUERY_DIALECT_UNKNOWN",
                            message=(
                                f"{region.linked_server} was not recognized as "
                                "Snowflake; choose Snowflake OPENQUERY mode to format it."
                            ),
                            severity="warning",
                            dialect="tsql",
                            region_id=region.region_id,
                        )
                    )
                continue

            normalized_nested = _dedent_embedded_query(region.decoded_sql)
            if len(normalized_nested.encode("utf-8")) > OPENQUERY_MAX_BYTES:
                raise _UnsafeFormatError(
                    SqlFormattingDiagnostic(
                        code="OPENQUERY_SIZE",
                        message=(
                            f"{region.linked_server} exceeds OPENQUERY's 8 KB "
                            "query limit; the document was left unchanged."
                        ),
                        severity="error",
                        dialect="snowflake",
                        region_id=region.region_id,
                    ),
                    parsed_before=True,
                )

            fixed_nested = self._format_fragment(
                normalized_nested,
                "snowflake",
            ).rstrip("\n")
            if len(fixed_nested.encode("utf-8")) > OPENQUERY_MAX_BYTES:
                raise _UnsafeFormatError(
                    SqlFormattingDiagnostic(
                        code="OPENQUERY_FORMATTED_SIZE",
                        message=(
                            f"Formatting {region.linked_server} would exceed "
                            "OPENQUERY's 8 KB limit; the document was left unchanged."
                        ),
                        severity="error",
                        dialect="snowflake",
                        region_id=region.region_id,
                    ),
                    parsed_before=True,
                )
            if token_signature(normalized_nested) != token_signature(fixed_nested):
                raise _UnsafeFormatError(
                    SqlFormattingDiagnostic(
                        code="OPENQUERY_TOKEN_CHANGE",
                        message=(
                            "Nested Snowflake formatting changed non-layout tokens; "
                            "the document was left unchanged."
                        ),
                        severity="error",
                        dialect="snowflake",
                        region_id=region.region_id,
                    ),
                    parsed_before=True,
                )
            if protected_signature(normalized_nested) != protected_signature(
                fixed_nested
            ):
                raise _UnsafeFormatError(
                    SqlFormattingDiagnostic(
                        code="OPENQUERY_PROTECTED_CHANGE",
                        message=(
                            "Nested Snowflake formatting changed a literal or "
                            "comment; the document was left unchanged."
                        ),
                        severity="error",
                        dialect="snowflake",
                        region_id=region.region_id,
                    ),
                    parsed_before=True,
                )
            if (
                self._format_fragment(fixed_nested, "snowflake").rstrip("\n")
                != fixed_nested
            ):
                raise _UnsafeFormatError(
                    SqlFormattingDiagnostic(
                        code="OPENQUERY_IDEMPOTENCE",
                        message=(
                            "Nested Snowflake formatting was not idempotent; the "
                            "document was left unchanged."
                        ),
                        severity="error",
                        dialect="snowflake",
                        region_id=region.region_id,
                    ),
                    parsed_before=True,
                )
            nested_formatted[region.region_id] = fixed_nested

        masked, sentinels = _mask_nested_literals(
            source,
            before_regions,
            nested_formatted,
        )
        formatted_outer = self._format_tsql_batches(masked)
        composed = _restore_nested_literals(
            formatted_outer,
            sentinels,
            nested_formatted,
        )

        after_regions = find_openquery_regions(composed, mode=openquery_mode)
        if [item.normalized_server for item in before_regions] != [
            item.normalized_server for item in after_regions
        ]:
            raise _UnsafeFormatError(
                SqlFormattingDiagnostic(
                    code="OPENQUERY_ASSOCIATION",
                    message=(
                        "OPENQUERY occurrences changed order or server association; "
                        "the document was left unchanged."
                    ),
                    severity="error",
                    dialect="tsql",
                ),
                parsed_before=True,
            )

        formatted_indexes = [
            index
            for index, item in enumerate(before_regions)
            if item.region_id in nested_formatted
        ]
        before_ranges = [
            (before_regions[index].literal_start, before_regions[index].literal_end)
            for index in formatted_indexes
        ]
        after_ranges = [
            (after_regions[index].literal_start, after_regions[index].literal_end)
            for index in formatted_indexes
        ]
        equivalent = token_signature(
            source,
            ignored_ranges=before_ranges,
        ) == token_signature(composed, ignored_ranges=after_ranges)
        protected_preserved = protected_signature(
            source,
            ignored_ranges=before_ranges,
        ) == protected_signature(composed, ignored_ranges=after_ranges)
        if not equivalent or not protected_preserved:
            raise _UnsafeFormatError(
                SqlFormattingDiagnostic(
                    code="SAFE_TOKEN_CHANGE",
                    message=(
                        "Formatting changed a protected or non-layout T-SQL token; "
                        "the document was left unchanged."
                    ),
                    severity="error",
                    dialect="tsql",
                ),
                parsed_before=True,
            )

        post_diagnostics: list[SqlFormattingDiagnostic] = []
        for segment in split_tsql_batches(composed):
            if segment.kind == "sql" and segment.text.strip():
                post_diagnostics.extend(
                    self._parse_diagnostics(segment.text, "tsql")
                )
        if post_diagnostics:
            raise _UnsafeFormatError(post_diagnostics[0], parsed_before=True)

        output_nested: list[SqlFormattingNestedRegion] = []
        for index, item in enumerate(after_regions):
            original = before_regions[index]
            was_formatted = original.region_id in nested_formatted
            output_nested.append(
                SqlFormattingNestedRegion(
                    region_id=item.region_id,
                    linked_server=item.linked_server,
                    dialect=item.dialect,
                    status="formatted" if was_formatted else "skipped",
                    host_start=item.literal_start,
                    host_end=item.literal_end,
                    original_sql=original.decoded_sql,
                    formatted_sql=item.decoded_sql if was_formatted else None,
                    diagnostics=[],
                )
            )

        return _CompositeResult(
            sql=composed,
            diagnostics=diagnostics,
            nested_regions=output_nested,
            token_equivalent=equivalent,
            protected_preserved=protected_preserved,
            parsed_before=True,
            parsed_after=True,
        )

    def _format_tsql_batches(self, source: str) -> str:
        output: list[str] = []
        for segment in split_tsql_batches(source):
            if segment.kind != "sql" or not segment.text.strip():
                output.append(segment.text)
                continue
            output.append(self._format_fragment(segment.text, "tsql"))
        return "".join(output)

    def _format_fragment(self, source: str, dialect: SqlDialect) -> str:
        if not source.strip():
            return source
        diagnostics = self._parse_diagnostics(source, dialect)
        if diagnostics:
            raise _UnsafeFormatError(diagnostics[0], parsed_before=False)
        current = source
        for _composite_pass in range(6):
            fixed, quirk_masks = mask_parser_quirks(current, dialect)
            fixed = self._run_sqlfluff_fix(fixed, dialect)
            try:
                restored = restore_parser_quirks(fixed, quirk_masks)
            except ValueError as exc:
                raise _UnsafeFormatError(
                    SqlFormattingDiagnostic(
                        code="SQLFLUFF_COMPAT_MARKER",
                        message=str(exc),
                        severity="error",
                        dialect=dialect,
                    ),
                    parsed_before=True,
                ) from exc

            laid_out = (
                layout_tsql_whitespace(restored)
                if dialect == "tsql"
                else restored
            )
            post = self._parse_diagnostics(laid_out, dialect)
            if post:
                raise _UnsafeFormatError(post[0], parsed_before=True)

            layout_changed = laid_out != restored
            if laid_out == current or not layout_changed:
                return laid_out
            current = laid_out

        raise _UnsafeFormatError(
            SqlFormattingDiagnostic(
                code="SQLFLUFF_COMPOSITE_STABILITY",
                message=(
                    f"{dialect.upper()} formatting did not stabilize after parser "
                    "and whitespace-layout passes."
                ),
                severity="error",
                dialect=dialect,
            ),
            parsed_before=True,
        )

    def _run_sqlfluff_fix(self, source: str, dialect: SqlDialect) -> str:
        fixed = source
        for _pass in range(4):
            try:
                with self._engine_lock:
                    next_value = sqlfluff.fix(
                        fixed,
                        config=self._configs[dialect],
                        fix_even_unparsable=False,
                    )
            except Exception as exc:
                raise _UnsafeFormatError(
                    SqlFormattingDiagnostic(
                        code="SQLFLUFF_INTERNAL",
                        message=(
                            f"{dialect.upper()} formatting encountered an internal "
                            "parser error; the document was left unchanged."
                        ),
                        severity="error",
                        dialect=dialect,
                    ),
                    parsed_before=True,
                ) from exc
            if next_value == fixed:
                break
            fixed = next_value
        else:
            raise _UnsafeFormatError(
                SqlFormattingDiagnostic(
                    code="SQLFLUFF_STABILITY",
                    message=(
                        f"{dialect.upper()} formatting did not stabilize within "
                        "four passes."
                    ),
                    severity="error",
                    dialect=dialect,
                ),
                parsed_before=True,
            )
        return fixed

    def _parse_diagnostics(
        self,
        source: str,
        dialect: SqlDialect,
    ) -> list[SqlFormattingDiagnostic]:
        parse_source, _ = mask_parser_quirks(source, dialect)
        try:
            with self._engine_lock:
                sqlfluff.parse(parse_source, config=self._configs[dialect])
            return []
        except APIParsingError as exc:
            diagnostics: list[SqlFormattingDiagnostic] = []
            for violation in exc.violations:
                code_value = getattr(violation, "rule_code", "PRS")
                code = str(code_value() if callable(code_value) else code_value)
                description = getattr(
                    violation,
                    "description",
                    "unsupported or malformed syntax",
                )
                diagnostics.append(
                    SqlFormattingDiagnostic(
                        code=f"SQLFLUFF_{code}",
                        message=f"{dialect.upper()} parsing failed: {description}",
                        severity="error",
                        line=int(getattr(violation, "line_no", 1) or 1),
                        column=int(getattr(violation, "line_pos", 1) or 1),
                        dialect=dialect,
                    )
                )
            return diagnostics
        except Exception:
            return [
                SqlFormattingDiagnostic(
                    code="SQLFLUFF_INTERNAL",
                    message=(
                        f"{dialect.upper()} parsing encountered an internal error; "
                        "the document was left unchanged."
                    ),
                    severity="error",
                    dialect=dialect,
                )
            ]

    def _unchanged_response(
        self,
        sql: str,
        source_hash: str,
        diagnostics: list[SqlFormattingDiagnostic],
        *,
        advisories: list[SqlFormattingAdvisory],
        parsed_before: bool = False,
        elapsed_ms: int,
    ) -> SqlFormattingPreviewResponse:
        reasons = [diagnostic.code for diagnostic in diagnostics]
        return SqlFormattingPreviewResponse(
            source_hash=source_hash,
            formatted_hash=source_hash,
            formatted_sql=sql,
            changed=False,
            diagnostics=diagnostics,
            advisories=advisories,
            safety=SqlFormattingSafetyReport(
                parsed_before=parsed_before,
                parsed_after=False,
                token_equivalent=False,
                protected_regions_preserved=False,
                idempotent=False,
                safe_to_apply=False,
                reasons=reasons,
            ),
            nested_regions=[],
            engine=formatter_engine_info(),
            elapsed_ms=elapsed_ms,
        )


def formatter_engine_info() -> dict[str, str]:
    return {
        "name": "SQLFluff composite formatter",
        "version": sqlfluff.__version__,
        "expected_version": SQLFLUFF_VERSION,
        "profile": PROFILE_VERSION,
        "dialects": "tsql,snowflake",
    }


def _mask_nested_literals(
    source: str,
    regions: list[OpenQueryRegion],
    nested_formatted: dict[str, str],
) -> tuple[str, dict[str, tuple[OpenQueryRegion, str]]]:
    replacements: list[tuple[int, int, str]] = []
    sentinels: dict[str, tuple[OpenQueryRegion, str]] = {}
    digest = hashlib.sha256(source.encode("utf-8")).hexdigest()[:12]
    for ordinal, region in enumerate(regions, start=1):
        if region.region_id not in nested_formatted:
            continue
        marker = f"__ARCODE_OPENQUERY_{digest}_{ordinal}__"
        if marker in source:
            raise _UnsafeFormatError(
                SqlFormattingDiagnostic(
                    code="OPENQUERY_SENTINEL_COLLISION",
                    message=(
                        "A collision-proof OPENQUERY sentinel unexpectedly occurs "
                        "in the source."
                    ),
                    severity="error",
                    dialect="tsql",
                    region_id=region.region_id,
                ),
                parsed_before=True,
            )
        encoded = encode_tsql_string(marker, region.literal_prefix)
        replacements.append((region.literal_start, region.literal_end, encoded))
        sentinels[marker] = (region, encoded)
    return _apply_replacements(source, replacements), sentinels


def _restore_nested_literals(
    source: str,
    sentinels: dict[str, tuple[OpenQueryRegion, str]],
    nested_formatted: dict[str, str],
) -> str:
    found: dict[str, list[tuple[int, int, str]]] = {
        marker: [] for marker in sentinels
    }
    for token in lex_sql(source):
        if token.kind != "string":
            continue
        try:
            decoded, prefix = decode_tsql_string(token.text)
        except ValueError:
            continue
        if decoded in found:
            found[decoded].append((token.start, token.end, prefix))

    replacements: list[tuple[int, int, str]] = []
    for marker, matches in found.items():
        if len(matches) != 1:
            raise _UnsafeFormatError(
                SqlFormattingDiagnostic(
                    code="OPENQUERY_SENTINEL_LOST",
                    message=(
                        "An OPENQUERY sentinel was lost or duplicated during outer "
                        "formatting."
                    ),
                    severity="error",
                    dialect="tsql",
                ),
                parsed_before=True,
            )
        start, end, _ = matches[0]
        region, _encoded_sentinel = sentinels[marker]
        embedded = _indent_embedded_query(
            source,
            start,
            nested_formatted[region.region_id],
        )
        replacements.append(
            (start, end, encode_tsql_string(embedded, region.literal_prefix))
        )
    return _apply_replacements(source, replacements)


def _apply_replacements(
    source: str,
    replacements: list[tuple[int, int, str]],
) -> str:
    result = source
    for start, end, replacement in sorted(replacements, reverse=True):
        result = result[:start] + replacement + result[end:]
    return result


def _dedent_embedded_query(source: str) -> str:
    lines = source.strip().splitlines()
    if not lines:
        return ""
    first = lines[0].strip()
    if len(lines) == 1:
        return first
    rest = textwrap.dedent("\n".join(lines[1:])).rstrip()
    return f"{first}\n{rest}" if rest else first


def _indent_embedded_query(host: str, literal_start: int, nested_sql: str) -> str:
    lines = nested_sql.rstrip("\n").splitlines()
    if len(lines) <= 1:
        return nested_sql.rstrip("\n")
    line_start = host.rfind("\n", 0, literal_start) + 1
    host_line = host[line_start:literal_start]
    host_indent = len(host_line) - len(host_line.lstrip(" \t"))
    continuation = " " * (host_indent + 4)
    return lines[0] + "\n" + "\n".join(continuation + line for line in lines[1:])


def _normalize_newlines(source: str) -> str:
    return source.replace("\r\n", "\n").replace("\r", "\n")


def _detect_newline(source: str) -> str:
    if "\r\n" in source:
        return "\r\n"
    if "\r" in source:
        return "\r"
    return "\n"


def _restore_document_shape(
    source: str,
    newline: str,
    final_newline: bool,
) -> str:
    normalized = source.rstrip("\n")
    if final_newline:
        normalized += "\n"
    return normalized.replace("\n", newline)


def _hash_text(source: str) -> str:
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


def _elapsed_ms(started: float) -> int:
    return max(0, round((time.perf_counter() - started) * 1_000))
