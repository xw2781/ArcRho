from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

from .lexing import TRIVIA_KINDS, Token, lex_sql


@dataclass(frozen=True, slots=True)
class OpenQueryRegion:
    region_id: str
    linked_server: str
    normalized_server: str
    literal_prefix: str
    literal_start: int
    literal_end: int
    encoded_literal: str
    decoded_sql: str
    dialect: Literal["snowflake"] | None


def decode_tsql_string(literal: str) -> tuple[str, str]:
    """Decode exactly one T-SQL single-quoted string layer."""

    prefix = ""
    quote_index = 0
    if len(literal) >= 2 and literal[0] in "Nn" and literal[1] == "'":
        prefix = literal[0]
        quote_index = 1
    if (
        len(literal) < quote_index + 2
        or literal[quote_index] != "'"
        or not literal.endswith("'")
    ):
        raise ValueError("OPENQUERY requires one complete single-quoted literal.")

    body = literal[quote_index + 1 : -1]
    decoded: list[str] = []
    index = 0
    while index < len(body):
        if body[index] != "'":
            if body[index] == "\x00":
                raise ValueError("NUL is not allowed in an OPENQUERY string.")
            decoded.append(body[index])
            index += 1
            continue
        if index + 1 >= len(body) or body[index + 1] != "'":
            raise ValueError("Malformed quote escape in OPENQUERY string.")
        decoded.append("'")
        index += 2
    return "".join(decoded), prefix


def encode_tsql_string(sql: str, prefix: str = "") -> str:
    """Encode one host T-SQL string layer without recursive escaping."""

    if prefix not in {"", "N", "n"}:
        raise ValueError(f"Unsupported T-SQL literal prefix: {prefix!r}")
    if "\x00" in sql:
        raise ValueError("NUL is not allowed in an OPENQUERY string.")
    return f"{prefix}'{sql.replace(chr(39), chr(39) * 2)}'"


def find_openquery_regions(
    source: str,
    *,
    mode: Literal["auto", "snowflake", "off"] = "auto",
) -> list[OpenQueryRegion]:
    tokens = lex_sql(source)
    regions: list[OpenQueryRegion] = []

    for index, token in enumerate(tokens):
        if token.kind != "word" or token.text.casefold() != "openquery":
            continue
        open_index = _next_code_token(tokens, index + 1)
        if open_index is None or tokens[open_index].text != "(":
            continue
        bounds = _openquery_argument_bounds(tokens, open_index)
        if bounds is None:
            continue
        comma_index, close_index = bounds

        server_tokens = _code_tokens_between(tokens, open_index + 1, comma_index)
        literal_tokens = _code_tokens_between(tokens, comma_index + 1, close_index)
        if len(server_tokens) != 1 or len(literal_tokens) != 1:
            continue
        server_token = server_tokens[0]
        literal_token = literal_tokens[0]
        if server_token.kind not in {
            "word",
            "bracket_identifier",
            "quoted_identifier",
        }:
            continue
        if literal_token.kind != "string":
            continue

        try:
            decoded, prefix = decode_tsql_string(literal_token.text)
        except ValueError:
            continue
        normalized = normalize_linked_server(server_token.text)
        dialect: Literal["snowflake"] | None = None
        if mode == "snowflake" or (
            mode == "auto"
            and (is_snowflake_server(normalized) or looks_like_snowflake_sql(decoded))
        ):
            dialect = "snowflake"
        regions.append(
            OpenQueryRegion(
                region_id=f"openquery-{len(regions) + 1}",
                linked_server=server_token.text,
                normalized_server=normalized,
                literal_prefix=prefix,
                literal_start=literal_token.start,
                literal_end=literal_token.end,
                encoded_literal=literal_token.text,
                decoded_sql=decoded,
                dialect=dialect,
            )
        )
    return regions


def normalize_linked_server(raw: str) -> str:
    value = raw.strip()
    if value.startswith("[") and value.endswith("]"):
        value = value[1:-1].replace("]]", "]")
    elif value.startswith('"') and value.endswith('"'):
        value = value[1:-1].replace('""', '"')
    return value.strip().upper()


def is_snowflake_server(normalized: str) -> bool:
    compact = normalized.replace("-", "_")
    return (
        "SNOWFLAKE" in compact
        or compact == "SF"
        or compact.startswith("SF_")
        or compact.endswith("_SF")
        or re.search(r"(?:^|_)SF(?:_|$)", compact) is not None
    )


def looks_like_snowflake_sql(sql: str) -> bool:
    """Recognize strong Snowflake syntax while ignoring protected text."""

    masked = "".join(
        (
            token.text
            if token.kind
            not in {
                "string",
                "line_comment",
                "block_comment",
                "bracket_identifier",
                "quoted_identifier",
            }
            else "".join("\n" if char == "\n" else " " for char in token.text)
        )
        for token in lex_sql(sql)
    )
    characteristic = re.compile(
        r"\b(?:"
        r"QUALIFY|ILIKE|MATCH_RECOGNIZE|IFF|COUNT_IF|APPROX_COUNT_DISTINCT|ZEROIFNULL|"
        r"OBJECT_CONSTRUCT|ARRAY_CONSTRUCT|ARRAY_FLATTEN|CONVERT_TIMEZONE|"
        r"DATE_TRUNC|FLATTEN|GET_PATH|PARSE_JSON|RESULT_SCAN|SPLIT_PART|"
        r"TRY_TO_(?:DATE|DECIMAL|NUMBER|TIMESTAMP)|TO_VARIANT|SYSTEM\$[A-Z0-9_]+"
        r")\b|"
        r"\bLATERAL\s+FLATTEN\b|"
        r"::\s*(?:VARIANT|OBJECT|ARRAY|TIMESTAMP_(?:LTZ|NTZ|TZ))\b|"
        r"\bTABLE\s*\(\s*GENERATOR\s*\(",
        re.IGNORECASE,
    )
    return bool(characteristic.search(masked))


def _next_code_token(tokens: list[Token], start: int) -> int | None:
    for index in range(start, len(tokens)):
        if tokens[index].kind not in TRIVIA_KINDS:
            return index
    return None


def _code_tokens_between(tokens: list[Token], start: int, end: int) -> list[Token]:
    return [token for token in tokens[start:end] if token.kind not in TRIVIA_KINDS]


def _openquery_argument_bounds(
    tokens: list[Token],
    open_index: int,
) -> tuple[int, int] | None:
    depth = 0
    commas: list[int] = []
    for index in range(open_index, len(tokens)):
        token = tokens[index]
        if token.kind != "punctuation":
            continue
        if token.text == "(":
            depth += 1
        elif token.text == ")":
            depth -= 1
            if depth == 0:
                return (commas[0], index) if len(commas) == 1 else None
            if depth < 0:
                return None
        elif token.text == "," and depth == 1:
            commas.append(index)
    return None
