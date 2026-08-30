"""Validate and canonicalize dataset cell formulas.

A manual-input dataset cell can calculate its value from a formula whose
operands are ArcRho dataset references, Excel references, and numbers::

    =[C 82 - Prior Qtr Selected][1:7] * 2
    =([Paid Claims][1:6, 2] + 'C:\\Folder\\[Book.xlsx]Sheet1'!B1:B6) / 1000

The grammar and the canonical stored text mirror the frontend's
``ui/shared/dataset/dataset_formula.js`` token for token, so the text a save
sends is the text it reads back. Formulas are evaluated in the client, which
owns the Excel reader; this module only owns what the sidecar may store.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List

from fastapi import HTTPException

from app_server.services.dataset_internal_link_service import (
    INTERNAL_REFERENCE_SYNTAX_HINT,
    canonical_internal_reference,
)

DATASET_FORMULA_SYNTAX_HINT = (
    "Enter an Excel link such as ='C:\\Folder\\[Book.xlsx]Sheet1'!A1:C3, a dataset "
    "link such as =[Dataset][1:6], or a formula that combines them with + - * / ^, "
    "for example =[Dataset][1:6] * 1.05."
)

_EXCEL_TOKEN_RE = re.compile(
    r"'((?:[^']|'')*)'!\$?([A-Z]+)\$?([0-9]+)(?::\$?([A-Z]+)\$?([0-9]+))?",
    re.IGNORECASE,
)
_NUMBER_TOKEN_RE = re.compile(r"(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?")
_BINARY_PRECEDENCE = {"+": 1, "-": 1, "*": 2, "/": 2, "^": 3}


def _scan_internal_reference(text: str, start: int) -> int:
    """End index (exclusive) of the ``[name][coords]`` reference at ``start``, or -1."""

    name_end = text.find("]", start + 1)
    if name_end < 0:
        return -1
    cursor = name_end + 1
    while cursor < len(text) and text[cursor].isspace():
        cursor += 1
    if cursor >= len(text) or text[cursor] != "[":
        return -1
    quote = ""
    for index in range(cursor + 1, len(text)):
        character = text[index]
        if quote:
            if character == quote:
                quote = ""
            continue
        if character in {'"', "'"}:
            quote = character
        elif character == "]":
            return index + 1
    return -1


def _canonical_excel_reference(match: "re.Match[str]") -> str:
    source = match.group(1).replace("''", "'")
    open_bracket = source.find("[")
    close_bracket = source.find("]", open_bracket + 1)
    if open_bracket < 0 or close_bracket <= open_bracket + 1 or close_bracket >= len(source) - 1:
        raise HTTPException(
            422,
            "Excel reference must be written as 'C:\\Folder\\[Book.xlsx]Sheet1'!A1 "
            "or a range such as !A1:C3.",
        )
    start = f"{match.group(2).upper()}{match.group(3)}"
    end = f"{match.group(4).upper()}{match.group(5)}" if match.group(4) else start
    address = start if end == start else f"{start}:{end}"
    return f"'{source.replace(chr(39), chr(39) * 2)}'!{address}"


def tokenize_dataset_formula(raw_text: Any) -> List[Dict[str, Any]]:
    """Split formula text into typed tokens; 422 when a character is not part of the grammar."""

    text = str(raw_text if raw_text is not None else "").strip()
    if text.startswith("="):
        text = text[1:]
    tokens: List[Dict[str, Any]] = []
    cursor = 0
    while cursor < len(text):
        character = text[cursor]
        if character.isspace():
            cursor += 1
            continue
        if character == "[":
            end = _scan_internal_reference(text, cursor)
            if end < 0:
                raise HTTPException(
                    422,
                    "Dataset reference is missing its coordinates. " + INTERNAL_REFERENCE_SYNTAX_HINT,
                )
            reference = text[cursor:end]
            tokens.append({
                "type": "reference",
                "kind": "internal",
                "text": reference,
                "canonical": canonical_internal_reference(reference)[1:],
            })
            cursor = end
            continue
        if character == "'":
            match = _EXCEL_TOKEN_RE.match(text, cursor)
            if not match:
                raise HTTPException(
                    422,
                    "Excel reference must be written as 'C:\\Folder\\[Book.xlsx]Sheet1'!A1 "
                    "or a range such as !A1:C3.",
                )
            tokens.append({
                "type": "reference",
                "kind": "excel",
                "text": match.group(0),
                "canonical": _canonical_excel_reference(match),
            })
            cursor = match.end()
            continue
        number = _NUMBER_TOKEN_RE.match(text, cursor)
        if number:
            tokens.append({"type": "number", "text": number.group(0)})
            cursor = number.end()
            continue
        if character in "+-*/^":
            tokens.append({"type": "operator", "text": character})
            cursor += 1
            continue
        if character in "()":
            tokens.append({"type": "paren", "text": character})
            cursor += 1
            continue
        raise HTTPException(422, f'Unexpected "{character}" in the formula. ' + DATASET_FORMULA_SYNTAX_HINT)
    if not tokens:
        raise HTTPException(422, DATASET_FORMULA_SYNTAX_HINT)
    return tokens


def _check_grammar(tokens: List[Dict[str, Any]]) -> None:
    """Walk the expression once, marking unary minus tokens; 422 on a malformed formula."""

    position = 0

    def fail(message: str) -> None:
        raise HTTPException(422, f"{message} {DATASET_FORMULA_SYNTAX_HINT}")

    def peek() -> Dict[str, Any] | None:
        return tokens[position] if position < len(tokens) else None

    def parse_binary(min_precedence: int) -> None:
        nonlocal position
        parse_unary()
        while True:
            token = peek()
            if not token or token["type"] != "operator":
                return
            precedence = _BINARY_PRECEDENCE[token["text"]]
            if precedence < min_precedence:
                return
            position += 1
            parse_binary(precedence if token["text"] == "^" else precedence + 1)

    def parse_unary() -> None:
        nonlocal position
        token = peek()
        if token and token["type"] == "operator" and token["text"] in "+-":
            token["unary"] = True
            position += 1
            parse_unary()
            return
        parse_primary()

    def parse_primary() -> None:
        nonlocal position
        token = peek()
        if token is None:
            fail("The formula ends before its last operand.")
            return
        if token["type"] in ("number", "reference"):
            position += 1
            return
        if token["type"] == "paren" and token["text"] == "(":
            position += 1
            parse_binary(1)
            closing = peek()
            if not closing or closing["type"] != "paren" or closing["text"] != ")":
                fail("The formula is missing a closing parenthesis.")
            position += 1
            return
        fail(f'Unexpected "{token["text"]}" in the formula.')

    parse_binary(1)
    if position < len(tokens):
        fail(f'Unexpected "{tokens[position]["text"]}" in the formula.')


def format_dataset_formula(tokens: List[Dict[str, Any]]) -> str:
    out = ""
    for token in tokens:
        if token["type"] == "operator":
            out = f"{out}{token['text']}" if token.get("unary") else f"{out.rstrip()} {token['text']} "
        elif token["type"] == "paren":
            out = f"{out}(" if token["text"] == "(" else f"{out.rstrip()})"
        elif token["type"] == "reference":
            out += token["canonical"]
        else:
            out += token["text"]
    return f"={out.rstrip()}"


def canonical_dataset_formula(raw_text: Any) -> str:
    """Return the normalized stored text for a valid formula; 422 otherwise."""

    tokens = tokenize_dataset_formula(raw_text)
    _check_grammar(tokens)
    if not any(token["type"] == "reference" for token in tokens):
        raise HTTPException(
            422,
            "A formula needs at least one dataset or Excel reference. " + DATASET_FORMULA_SYNTAX_HINT,
        )
    return format_dataset_formula(tokens)
