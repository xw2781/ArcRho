from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable, Literal


TokenKind = Literal[
    "whitespace",
    "word",
    "number",
    "string",
    "line_comment",
    "block_comment",
    "bracket_identifier",
    "quoted_identifier",
    "operator",
    "punctuation",
]
PROTECTED_KINDS = {
    "string",
    "line_comment",
    "block_comment",
    "bracket_identifier",
    "quoted_identifier",
}
TRIVIA_KINDS = {"whitespace", "line_comment", "block_comment"}
_GO_LINE = re.compile(
    r"^\s*GO(?:\s+\d+)?(?:\s*--[^\r\n]*)?(?:\r\n|\r|\n)?$",
    re.IGNORECASE,
)
_SQLCMD_LINE = re.compile(
    r"^\s*:(?:setvar|r|on\s+error|connect|listvar|reset|error|out|perftrace)\b",
    re.IGNORECASE,
)


@dataclass(frozen=True, slots=True)
class Token:
    kind: TokenKind
    start: int
    end: int
    text: str


@dataclass(frozen=True, slots=True)
class BatchSegment:
    kind: Literal["sql", "separator", "sqlcmd"]
    text: str
    start: int
    end: int


def lex_sql(source: str) -> list[Token]:
    """Lex SQL while keeping protected text as indivisible tokens."""

    tokens: list[Token] = []
    index = 0
    length = len(source)

    while index < length:
        start = index
        char = source[index]

        if char.isspace():
            index += 1
            while index < length and source[index].isspace():
                index += 1
            tokens.append(Token("whitespace", start, index, source[start:index]))
            continue

        if source.startswith("--", index):
            newline = source.find("\n", index + 2)
            index = length if newline < 0 else newline
            tokens.append(Token("line_comment", start, index, source[start:index]))
            continue

        if source.startswith("/*", index):
            depth = 1
            index += 2
            while index < length and depth:
                if source.startswith("/*", index):
                    depth += 1
                    index += 2
                elif source.startswith("*/", index):
                    depth -= 1
                    index += 2
                else:
                    index += 1
            tokens.append(Token("block_comment", start, index, source[start:index]))
            continue

        if char == "$":
            delimiter_match = re.match(
                r"\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$",
                source[index:],
            )
            if delimiter_match:
                delimiter = delimiter_match.group(0)
                closing = source.find(delimiter, index + len(delimiter))
                if closing >= 0:
                    index = closing + len(delimiter)
                    tokens.append(Token("string", start, index, source[start:index]))
                    continue

        is_national_string = (
            char in "Nn"
            and index + 1 < length
            and source[index + 1] == "'"
            and (index == 0 or not _is_word_char(source[index - 1]))
        )
        if char == "'" or is_national_string:
            if is_national_string:
                index += 1
            index += 1
            while index < length:
                if source[index] != "'":
                    index += 1
                    continue
                if index + 1 < length and source[index + 1] == "'":
                    index += 2
                    continue
                index += 1
                break
            tokens.append(Token("string", start, index, source[start:index]))
            continue

        if char == "[":
            index += 1
            while index < length:
                if source[index] != "]":
                    index += 1
                    continue
                if index + 1 < length and source[index + 1] == "]":
                    index += 2
                    continue
                index += 1
                break
            tokens.append(Token("bracket_identifier", start, index, source[start:index]))
            continue

        if char == '"':
            index += 1
            while index < length:
                if source[index] != '"':
                    index += 1
                    continue
                if index + 1 < length and source[index + 1] == '"':
                    index += 2
                    continue
                index += 1
                break
            tokens.append(Token("quoted_identifier", start, index, source[start:index]))
            continue

        if _is_word_start(char):
            index += 1
            while index < length and _is_word_char(source[index]):
                index += 1
            tokens.append(Token("word", start, index, source[start:index]))
            continue

        if char.isdigit():
            index += 1
            while index < length and (
                source[index].isalnum() or source[index] in "._"
            ):
                index += 1
            tokens.append(Token("number", start, index, source[start:index]))
            continue

        matched = next(
            (
                operator
                for operator in (
                    "!<>",
                    "!>",
                    "!<",
                    "<=",
                    ">=",
                    "<>",
                    "!=",
                    "::",
                    "+=",
                    "-=",
                    "*=",
                    "/=",
                    "%=",
                    "&=",
                    "^=",
                    "|=",
                    "||",
                )
                if source.startswith(operator, index)
            ),
            None,
        )
        if matched:
            index += len(matched)
            tokens.append(Token("operator", start, index, matched))
            continue

        index += 1
        kind: TokenKind = "punctuation" if char in "(),.;" else "operator"
        tokens.append(Token(kind, start, index, char))

    return tokens


def split_tsql_batches(source: str) -> list[BatchSegment]:
    """Split utility GO and SQLCMD lines while preserving them byte-for-byte."""

    protected = [token for token in lex_sql(source) if token.kind in PROTECTED_KINDS]
    segments: list[BatchSegment] = []
    batch_start = 0
    offset = 0

    for line in source.splitlines(keepends=True):
        stripped_start = len(line) - len(line.lstrip(" \t"))
        code_start = offset + stripped_start
        line_end = offset + len(line)
        protected_at_start = any(
            token.start <= code_start < token.end for token in protected
        )
        kind: Literal["separator", "sqlcmd"] | None = None
        if not protected_at_start and _GO_LINE.fullmatch(line):
            kind = "separator"
        elif not protected_at_start and _SQLCMD_LINE.match(line):
            kind = "sqlcmd"

        if kind:
            if batch_start < offset:
                segments.append(
                    BatchSegment("sql", source[batch_start:offset], batch_start, offset)
                )
            segments.append(BatchSegment(kind, line, offset, line_end))
            batch_start = line_end
        offset = line_end

    if batch_start < len(source):
        segments.append(
            BatchSegment("sql", source[batch_start:], batch_start, len(source))
        )
    elif not segments and source == "":
        segments.append(BatchSegment("sql", "", 0, 0))

    return segments


def token_signature(
    source: str,
    *,
    ignored_ranges: Iterable[tuple[int, int]] = (),
) -> tuple[str, ...]:
    """Build a case-insensitive non-layout signature, with exact protected text."""

    ranges = sorted(ignored_ranges)
    signature: list[str] = []
    ignored_index = 0
    ignored_ordinal = 0

    for token in lex_sql(source):
        while ignored_index < len(ranges) and ranges[ignored_index][1] <= token.start:
            ignored_index += 1
        if ignored_index < len(ranges):
            start, end = ranges[ignored_index]
            if token.start >= start and token.end <= end:
                if token.start == start:
                    signature.append(f"<nested:{ignored_ordinal}>")
                    ignored_ordinal += 1
                continue
        if token.kind == "whitespace":
            continue
        if token.kind == "word":
            signature.append(f"word:{token.text.casefold()}")
        else:
            signature.append(f"{token.kind}:{token.text}")
    return tuple(signature)


def protected_signature(
    source: str,
    *,
    ignored_ranges: Iterable[tuple[int, int]] = (),
) -> tuple[tuple[str, str], ...]:
    ranges = sorted(ignored_ranges)
    result: list[tuple[str, str]] = []
    for token in lex_sql(source):
        if token.kind not in PROTECTED_KINDS:
            continue
        if any(token.start >= start and token.end <= end for start, end in ranges):
            continue
        result.append((token.kind, token.text))
    return tuple(result)


def has_unterminated_protected_region(source: str) -> bool:
    for token in lex_sql(source):
        if token.kind == "string":
            if token.text.startswith("$"):
                marker_match = re.match(
                    r"\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$",
                    token.text,
                )
                if marker_match and not token.text.endswith(marker_match.group(0)):
                    return True
            elif not token.text.endswith("'"):
                return True
        if token.kind == "block_comment" and not token.text.endswith("*/"):
            return True
        if token.kind == "bracket_identifier" and not token.text.endswith("]"):
            return True
        if token.kind == "quoted_identifier" and not token.text.endswith('"'):
            return True
    return False


def _is_word_start(char: str) -> bool:
    return char.isalpha() or char in "_@#$"


def _is_word_char(char: str) -> bool:
    return char.isalnum() or char in "_@#$"
