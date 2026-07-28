from __future__ import annotations

from bisect import bisect_right
from dataclasses import dataclass
from typing import Iterable, Literal

from app_server.schemas.sql_formatting import SqlFormattingAdvisory, SqlDialect

from .lexing import TRIVIA_KINDS, Token, lex_sql, split_tsql_batches
from .openquery import find_openquery_regions


@dataclass(frozen=True, slots=True)
class _AdvisorySpec:
    code: str
    title: str
    message: str
    severity: Literal["info", "warning"] = "warning"


_SELECT_STAR = _AdvisorySpec(
    "SQL001",
    "Review SELECT * usage",
    "Select only the columns the caller needs; SELECT * is best reserved for projections such as EXISTS where values are not materialized.",
)
_DISTINCT = _AdvisorySpec(
    "SQL002",
    "Review DISTINCT",
    "DISTINCT adds duplicate-elimination work and can mask a join or filter issue.",
    "info",
)
_SELECT_INTO = _AdvisorySpec(
    "SQL003",
    "Review SELECT INTO",
    "Prefer creating durable tables explicitly before INSERT INTO; keep intentional structure-only or staging uses documented.",
    "info",
)
_DYNAMIC_SQL = _AdvisorySpec(
    "SQL004",
    "Review dynamic SQL and parameterization",
    "Use dynamic SQL only when required, and bind values as parameters rather than concatenating executable text.",
)
_CURSOR_CLEANUP = _AdvisorySpec(
    "SQL005",
    "Review cursor cleanup and options",
    "A declared cursor should be closed and deallocated; when a cursor is necessary, prefer the narrowest appropriate LOCAL, READ_ONLY, FORWARD_ONLY options.",
)
_TEMP_TABLE_CLEANUP = _AdvisorySpec(
    "SQL006",
    "Review temporary-table cleanup",
    "The temporary table is referenced without a matching DROP TABLE in this document.",
    "info",
)
_MISSING_SEMICOLON = _AdvisorySpec(
    "SQL007",
    "End statements with semicolons",
    "The final executable statement in this batch has no terminating semicolon; this is advisory and the formatter will not add one.",
    "info",
)


class _Collector:
    def __init__(
        self,
        source: str,
        dialect: SqlDialect,
        *,
        region_id: str | None = None,
        host_line_offset: int = 0,
    ) -> None:
        self.source = source
        self.dialect = dialect
        self.region_id = region_id
        self.host_line_offset = host_line_offset
        self._line_starts = _line_start_offsets(source)
        self._items: list[tuple[int, SqlFormattingAdvisory]] = []
        self._seen: set[tuple[str, int, str | None]] = set()

    def add(
        self,
        spec: _AdvisorySpec,
        token: Token,
        *,
        message: str | None = None,
    ) -> None:
        line, column = _line_column(
            self.source,
            token.start,
            line_starts=self._line_starts,
        )
        line += self.host_line_offset
        key = (spec.code, token.start, self.region_id)
        if key in self._seen:
            return
        self._seen.add(key)
        self._items.append(
            (
                token.start,
                SqlFormattingAdvisory(
                    code=spec.code,
                    title=spec.title,
                    message=message or spec.message,
                    severity=spec.severity,
                    line=line,
                    column=column,
                    dialect=self.dialect,
                    region_id=self.region_id,
                    evidence=_line_excerpt(self.source, token.start),
                ),
            )
        )

    def sorted_items(self) -> list[SqlFormattingAdvisory]:
        return [
            advisory
            for _, advisory in sorted(
                self._items,
                key=lambda item: (
                    item[0],
                    item[1].code,
                    item[1].region_id or "",
                ),
            )
        ]


def find_advisories(
    source: str,
    *,
    dialect: SqlDialect,
    openquery_mode: Literal["auto", "snowflake", "off"] = "auto",
) -> list[SqlFormattingAdvisory]:
    """Return deterministic findings without scanning inside protected tokens."""

    advisories = _find_document_advisories(source, dialect=dialect)
    if dialect != "tsql" or openquery_mode == "off":
        return advisories

    host_line_starts = _line_start_offsets(source)
    for region in find_openquery_regions(source, mode=openquery_mode):
        if region.dialect != "snowflake":
            continue
        host_line, _ = _line_column(
            source,
            region.literal_start,
            line_starts=host_line_starts,
        )
        advisories.extend(
            _find_document_advisories(
                region.decoded_sql,
                dialect="snowflake",
                region_id=region.region_id,
                host_line_offset=host_line - 1,
            )
        )
    return sorted(
        advisories,
        key=lambda item: (
            item.line or 0,
            item.column or 0,
            item.region_id or "",
            item.code,
        ),
    )


def _find_document_advisories(
    source: str,
    *,
    dialect: SqlDialect,
    region_id: str | None = None,
    host_line_offset: int = 0,
) -> list[SqlFormattingAdvisory]:
    collector = _Collector(
        source,
        dialect,
        region_id=region_id,
        host_line_offset=host_line_offset,
    )
    tokens = lex_sql(source)
    code_tokens = [
        token
        for token in tokens
        if token.kind
        not in {"whitespace", "line_comment", "block_comment", "string"}
    ]

    _find_select_star(code_tokens, collector)
    _find_distinct(code_tokens, collector)
    _find_select_into(code_tokens, collector)
    _find_dynamic_sql(tokens, collector)
    if dialect == "tsql":
        _find_cursor_cleanup(code_tokens, collector)
        _find_temp_table_cleanup(code_tokens, collector)
        _find_missing_tsql_semicolon(source, collector)
    else:
        _find_missing_semicolon(source, 0, collector)
    return collector.sorted_items()


def _find_select_star(tokens: list[Token], collector: _Collector) -> None:
    depths = _parenthesis_depths(tokens)
    for index, token in enumerate(tokens):
        if not _word(token, "select"):
            continue
        if _is_exists_projection(tokens, index):
            continue
        select_depth = depths[index]
        cursor = index + 1
        if cursor < len(tokens) and _word_in(tokens[cursor], {"all", "distinct"}):
            cursor += 1
        if cursor < len(tokens) and _word(tokens[cursor], "top"):
            cursor += 1
            if cursor < len(tokens) and tokens[cursor].text == "(":
                cursor = _after_balanced_parentheses(tokens, cursor)
            elif cursor < len(tokens):
                cursor += 1
            if cursor < len(tokens) and _word(tokens[cursor], "percent"):
                cursor += 1
            if (
                cursor + 1 < len(tokens)
                and _word(tokens[cursor], "with")
                and _word(tokens[cursor + 1], "ties")
            ):
                cursor += 2
        target_start = cursor
        for position in range(cursor, len(tokens)):
            candidate = tokens[position]
            depth = depths[position]
            if depth < select_depth:
                break
            if depth != select_depth:
                continue
            if _word_in(
                candidate,
                {"except", "from", "having", "intersect", "into", "union", "where"},
            ):
                break
            if candidate.text == ",":
                target_start = position + 1
                continue
            if candidate.text != "*":
                continue
            if position == target_start or _qualified_wildcard_target(
                tokens,
                target_start,
                position,
            ):
                collector.add(_SELECT_STAR, token)
                break


def _find_distinct(tokens: list[Token], collector: _Collector) -> None:
    for index, token in enumerate(tokens):
        if not _word(token, "select") or index + 1 >= len(tokens):
            continue
        if _word(tokens[index + 1], "distinct"):
            collector.add(_DISTINCT, tokens[index + 1])


def _find_select_into(tokens: list[Token], collector: _Collector) -> None:
    depths = _parenthesis_depths(tokens)
    for index, token in enumerate(tokens):
        if not _word(token, "select"):
            continue
        select_depth = depths[index]
        for cursor in range(index + 1, len(tokens)):
            candidate = tokens[cursor]
            depth = depths[cursor]
            if depth < select_depth:
                break
            if depth != select_depth:
                continue
            if candidate.text == ";" or _word_in(
                candidate,
                {"except", "intersect", "union"},
            ):
                break
            if _word(candidate, "into"):
                collector.add(_SELECT_INTO, token)
                break


def _find_dynamic_sql(tokens: list[Token], collector: _Collector) -> None:
    executable = [token for token in tokens if token.kind not in TRIVIA_KINDS]
    for index, token in enumerate(executable):
        if _word(token, "sp_executesql"):
            collector.add(_DYNAMIC_SQL, token)
            continue
        if not _word_in(token, {"exec", "execute"}):
            continue
        if index + 1 >= len(executable):
            continue
        next_token = executable[index + 1]
        if (
            next_token.text == "("
            or next_token.kind == "string"
            or (next_token.kind == "word" and next_token.text.startswith("@"))
        ):
            collector.add(_DYNAMIC_SQL, token)


def _find_cursor_cleanup(tokens: list[Token], collector: _Collector) -> None:
    declarations: list[tuple[int, Token | None]] = []
    for index, token in enumerate(tokens):
        if not _word(token, "cursor"):
            continue
        declare_index = _previous_word_index(tokens, index - 1, "declare")
        name = None
        if declare_index is not None and declare_index + 1 < index:
            candidate = tokens[declare_index + 1]
            if candidate.kind in {"word", "bracket_identifier", "quoted_identifier"}:
                name = candidate
        declarations.append((index, name))

    for cursor_index, name in declarations:
        tail = tokens[cursor_index + 1 :]
        has_close = _has_named_cleanup(tail, "close", name)
        has_deallocate = _has_named_cleanup(tail, "deallocate", name)
        if has_close and has_deallocate:
            continue
        missing = []
        if not has_close:
            missing.append("CLOSE")
        if not has_deallocate:
            missing.append("DEALLOCATE")
        collector.add(
            _CURSOR_CLEANUP,
            tokens[cursor_index],
            message=(
                f"This cursor has no matching {' and '.join(missing)} after its "
                "declaration; also review whether LOCAL, READ_ONLY, FORWARD_ONLY "
                "options are appropriate."
            ),
        )


def _find_temp_table_cleanup(tokens: list[Token], collector: _Collector) -> None:
    created: dict[str, Token] = {}
    dropped: set[str] = set()

    for index, token in enumerate(tokens):
        if _word(token, "create"):
            cursor = index + 1
            if cursor < len(tokens) and _word(tokens[cursor], "table"):
                cursor += 1
                if cursor < len(tokens) and _is_temp_table(tokens[cursor]):
                    created.setdefault(tokens[cursor].text.casefold(), tokens[cursor])
        if _word(token, "into") and index > 0:
            cursor = index + 1
            if cursor < len(tokens) and _is_temp_table(tokens[cursor]):
                if _select_before_at_same_depth(tokens, index) is not None:
                    created.setdefault(tokens[cursor].text.casefold(), tokens[cursor])
        if not _word(token, "drop"):
            continue
        cursor = index + 1
        if cursor >= len(tokens) or not _word(tokens[cursor], "table"):
            continue
        cursor += 1
        if (
            cursor + 1 < len(tokens)
            and _word(tokens[cursor], "if")
            and _word(tokens[cursor + 1], "exists")
        ):
            cursor += 2
        if cursor < len(tokens) and _is_temp_table(tokens[cursor]):
            dropped.add(tokens[cursor].text.casefold())

    for name, token in created.items():
        if name in dropped:
            continue
        collector.add(
            _TEMP_TABLE_CLEANUP,
            token,
            message=(
                f"{token.text} is referenced without a matching DROP TABLE in this document."
            ),
        )
        break


def _find_missing_tsql_semicolon(source: str, collector: _Collector) -> None:
    for segment in split_tsql_batches(source):
        if segment.kind != "sql":
            continue
        _find_missing_semicolon(segment.text, segment.start, collector)


def _find_missing_semicolon(
    source: str,
    source_offset: int,
    collector: _Collector,
) -> None:
    tokens = [token for token in lex_sql(source) if token.kind not in TRIVIA_KINDS]
    if not tokens or tokens[-1].text == ";":
        return
    last = tokens[-1]
    collector.add(
        _MISSING_SEMICOLON,
        Token(last.kind, last.start + source_offset, last.end + source_offset, last.text),
    )


def _after_balanced_parentheses(tokens: list[Token], open_index: int) -> int:
    depth = 0
    for index in range(open_index, len(tokens)):
        if tokens[index].text == "(":
            depth += 1
        elif tokens[index].text == ")":
            depth -= 1
            if depth == 0:
                return index + 1
    return len(tokens)


def _is_exists_projection(tokens: list[Token], select_index: int) -> bool:
    return (
        select_index >= 2
        and tokens[select_index - 1].text == "("
        and _word(tokens[select_index - 2], "exists")
    )


def _qualified_wildcard_target(
    tokens: list[Token],
    target_start: int,
    star_index: int,
) -> bool:
    if star_index <= target_start or tokens[star_index - 1].text != ".":
        return False
    expect_identifier = True
    for token in tokens[target_start:star_index]:
        if expect_identifier:
            if token.kind not in {"word", "bracket_identifier", "quoted_identifier"}:
                return False
        elif token.text != ".":
            return False
        expect_identifier = not expect_identifier
    return expect_identifier


def _previous_word_index(
    tokens: list[Token],
    start: int,
    expected: str,
) -> int | None:
    for index in range(start, -1, -1):
        token = tokens[index]
        if token.text == ";":
            return None
        if _word(token, expected):
            return index
    return None


def _has_named_cleanup(
    tokens: list[Token],
    action: str,
    name: Token | None,
) -> bool:
    for index, token in enumerate(tokens):
        if not _word(token, action):
            continue
        if name is None:
            return True
        cursor = index + 1
        if cursor < len(tokens) and _word_in(tokens[cursor], {"global", "local"}):
            cursor += 1
        if cursor < len(tokens) and _same_identifier(tokens[cursor], name):
            return True
    return False


def _same_identifier(left: Token, right: Token) -> bool:
    return left.kind == right.kind and left.text.casefold() == right.text.casefold()


def _select_before_at_same_depth(tokens: list[Token], into_index: int) -> int | None:
    depths = _parenthesis_depths(tokens)
    target_depth = depths[into_index]
    for index in range(into_index - 1, -1, -1):
        if depths[index] < target_depth or tokens[index].text == ";":
            return None
        if depths[index] == target_depth and _word(tokens[index], "select"):
            return index
    return None


def _parenthesis_depths(tokens: Iterable[Token]) -> list[int]:
    depth = 0
    result: list[int] = []
    for token in tokens:
        result.append(depth)
        if token.text == "(":
            depth += 1
        elif token.text == ")":
            depth = max(0, depth - 1)
    return result


def _is_temp_table(token: Token) -> bool:
    return token.kind == "word" and len(token.text) > 1 and token.text.startswith("#")


def _word(token: Token, expected: str) -> bool:
    return token.kind == "word" and token.text.casefold() == expected.casefold()


def _word_in(token: Token, expected: set[str]) -> bool:
    return token.kind == "word" and token.text.casefold() in expected


def _line_start_offsets(source: str) -> tuple[int, ...]:
    starts = [0]
    index = 0
    while index < len(source):
        char = source[index]
        if char == "\r":
            if index + 1 < len(source) and source[index + 1] == "\n":
                index += 1
            starts.append(index + 1)
        elif char == "\n":
            starts.append(index + 1)
        index += 1
    return tuple(starts)


def _line_column(
    source: str,
    offset: int,
    *,
    line_starts: tuple[int, ...] | None = None,
) -> tuple[int, int]:
    limit = max(0, min(len(source), offset))
    starts = line_starts if line_starts is not None else _line_start_offsets(source)
    line_index = max(0, bisect_right(starts, limit) - 1)
    return line_index + 1, limit - starts[line_index] + 1


def _line_excerpt(source: str, offset: int, limit: int = 180) -> str:
    start_lf = source.rfind("\n", 0, max(0, offset))
    start_cr = source.rfind("\r", 0, max(0, offset))
    start = max(start_lf, start_cr) + 1
    end_lf = source.find("\n", max(0, offset))
    end_cr = source.find("\r", max(0, offset))
    endings = [value for value in (end_lf, end_cr) if value >= 0]
    end = min(endings) if endings else len(source)
    text = source[start:end].strip()
    if len(text) > limit:
        return text[: limit - 1].rstrip() + "…"
    return text
