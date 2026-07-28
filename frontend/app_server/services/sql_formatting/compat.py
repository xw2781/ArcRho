from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Literal

from .lexing import TRIVIA_KINDS, Token, lex_sql


@dataclass(frozen=True, slots=True)
class QuirkMask:
    marker: str
    kind: Literal[
        "bracket",
        "xmlnamespaces",
        "grouping_sets",
        "empty_grouping_set",
    ]
    original: str


def mask_parser_quirks(source: str, dialect: str) -> tuple[str, list[QuirkMask]]:
    """Mask a small, explicit set of valid constructs the pinned parser cannot parse."""

    if dialect != "tsql":
        return source, []
    tokens = lex_sql(source)
    masks: list[QuirkMask] = []
    replacements: list[tuple[int, int, str]] = []
    occupied: list[tuple[int, int]] = []

    for index, token in enumerate(tokens):
        if token.kind != "word" or token.text.casefold() != "xmlnamespaces":
            continue
        open_index = _next_code(tokens, index + 1)
        if open_index is None or tokens[open_index].text != "(":
            continue
        close_index = _matching_close(tokens, open_index)
        if close_index is None:
            continue
        marker = _marker(source, "XMLNS", len(masks) + 1)
        end = tokens[close_index].end
        original = source[token.start:end]
        replacements.append((token.start, end, f"{marker} AS (SELECT 1)"))
        occupied.append((token.start, end))
        masks.append(QuirkMask(marker, "xmlnamespaces", original))

    for index, token in enumerate(tokens):
        if token.kind != "word" or token.text.casefold() != "grouping":
            continue
        sets_index = _next_code(tokens, index + 1)
        open_index = _next_code(tokens, (sets_index or index) + 1)
        if (
            sets_index is None
            or tokens[sets_index].text.casefold() != "sets"
            or open_index is None
            or tokens[open_index].text != "("
        ):
            continue
        close_index = _matching_close(tokens, open_index)
        if close_index is None:
            continue
        marker = _marker(source, "GROUPING_SETS", len(masks) + 1)
        end = tokens[close_index].end
        original = source[token.start:end]
        replacements.append((token.start, end, marker))
        occupied.append((token.start, end))
        masks.append(QuirkMask(marker, "grouping_sets", original))

    grouping_ranges = _grouping_sets_ranges(tokens)
    code_indices = [
        index
        for index, token in enumerate(tokens)
        if token.kind not in TRIVIA_KINDS
    ]
    code_position = {
        token_index: position
        for position, token_index in enumerate(code_indices)
    }
    for token_index in code_indices:
        token = tokens[token_index]
        if token.text != "(":
            continue
        position = code_position[token_index]
        if (
            position + 1 >= len(code_indices)
            or tokens[code_indices[position + 1]].text != ")"
        ):
            continue
        end_token = tokens[code_indices[position + 1]]
        if any(
            start <= token.start and end_token.end <= end
            for start, end in occupied
        ):
            continue
        if not any(
            start < token.start and end_token.end < end
            for start, end in grouping_ranges
        ):
            continue
        marker = _marker(source, "EMPTY_GROUP", len(masks) + 1)
        replacements.append((token.start, end_token.end, f"({marker})"))
        occupied.append((token.start, end_token.end))
        masks.append(
            QuirkMask(
                marker,
                "empty_grouping_set",
                source[token.start:end_token.end],
            )
        )

    for token in tokens:
        if token.kind != "bracket_identifier" or "]]" not in token.text:
            continue
        if any(
            start <= token.start and token.end <= end for start, end in occupied
        ):
            continue
        marker = _marker(source, "BRACKET", len(masks) + 1)
        replacements.append((token.start, token.end, f"[{marker}]"))
        masks.append(QuirkMask(marker, "bracket", token.text))

    return _apply(source, replacements), masks


def restore_parser_quirks(source: str, masks: list[QuirkMask]) -> str:
    result = source
    for mask in masks:
        tokens = lex_sql(result)
        replacement: tuple[int, int, str] | None = None
        if mask.kind in {"bracket", "grouping_sets"}:
            for token in tokens:
                if (
                    mask.kind == "bracket"
                    and token.kind == "bracket_identifier"
                    and token.text == f"[{mask.marker}]"
                ):
                    replacement = (token.start, token.end, mask.original)
                    break
                if (
                    mask.kind == "grouping_sets"
                    and token.kind == "word"
                    and token.text == mask.marker
                ):
                    replacement = (token.start, token.end, mask.original)
                    break
        elif mask.kind == "xmlnamespaces":
            for index, token in enumerate(tokens):
                if token.kind != "word" or token.text != mask.marker:
                    continue
                as_index = _next_code(tokens, index + 1)
                open_index = _next_code(tokens, (as_index or index) + 1)
                if (
                    as_index is not None
                    and tokens[as_index].text.casefold() == "as"
                    and open_index is not None
                    and tokens[open_index].text == "("
                ):
                    close_index = _matching_close(tokens, open_index)
                    if close_index is not None:
                        replacement = (
                            token.start,
                            tokens[close_index].end,
                            mask.original,
                        )
                break
        else:
            for index, token in enumerate(tokens):
                if token.kind != "word" or token.text != mask.marker:
                    continue
                previous_index = _previous_code(tokens, index - 1)
                next_index = _next_code(tokens, index + 1)
                if (
                    previous_index is not None
                    and next_index is not None
                    and tokens[previous_index].text == "("
                    and tokens[next_index].text == ")"
                ):
                    replacement = (
                        tokens[previous_index].start,
                        tokens[next_index].end,
                        mask.original,
                    )
                break
        if replacement is None:
            raise ValueError(
                f"Parser compatibility marker was lost: {mask.marker}"
            )
        result = _apply(result, [replacement])
    return result


def _grouping_sets_ranges(tokens: list[Token]) -> list[tuple[int, int]]:
    ranges: list[tuple[int, int]] = []
    for index, token in enumerate(tokens):
        if token.kind != "word" or token.text.casefold() != "grouping":
            continue
        sets_index = _next_code(tokens, index + 1)
        open_index = _next_code(tokens, (sets_index or index) + 1)
        if (
            sets_index is None
            or tokens[sets_index].text.casefold() != "sets"
            or open_index is None
            or tokens[open_index].text != "("
        ):
            continue
        close_index = _matching_close(tokens, open_index)
        if close_index is not None:
            ranges.append((tokens[open_index].start, tokens[close_index].end))
    return ranges


def _matching_close(tokens: list[Token], open_index: int) -> int | None:
    depth = 0
    for index in range(open_index, len(tokens)):
        token = tokens[index]
        if token.kind != "punctuation":
            continue
        if token.text == "(":
            depth += 1
        elif token.text == ")":
            depth -= 1
            if depth == 0:
                return index
    return None


def _next_code(tokens: list[Token], start: int) -> int | None:
    for index in range(start, len(tokens)):
        if tokens[index].kind not in TRIVIA_KINDS:
            return index
    return None


def _previous_code(tokens: list[Token], start: int) -> int | None:
    for index in range(start, -1, -1):
        if tokens[index].kind not in TRIVIA_KINDS:
            return index
    return None


def _marker(source: str, label: str, ordinal: int) -> str:
    """Build a deterministic marker that cannot alias a user identifier."""

    source_folded = source.casefold()
    nonce = 0
    while True:
        digest = hashlib.sha256(
            f"{nonce}\0{source}".encode("utf-8")
        ).hexdigest()[:16]
        marker = f"ARCODE_{label}_{digest}_{ordinal}"
        if marker.casefold() not in source_folded:
            return marker
        nonce += 1


def _apply(source: str, replacements: list[tuple[int, int, str]]) -> str:
    result = source
    for start, end, replacement in sorted(replacements, reverse=True):
        result = result[:start] + replacement + result[end:]
    return result
