# <arcrho-macro>
# Title: Link Notes to Method Values
# Version: 1.1.0
# Release Note: Text highlighted in the Notes tab now limits the rewrite to that stretch; with nothing highlighted the whole note is still linked.
# Description: Rewrite the raw Notes text so every label repeated by hand becomes a
#   placeholder that reads it from the method, for example "(3) 32-44" becomes
#   "{ratio_development_label(3)}" and "AY 2025" becomes "AY {origin_label(6)}".
#   Highlight part of the note before running to rewrite only that stretch.
#   Ratio column, development, origin and average row labels, the method and
#   dataset names, and a month phrase such as "12 months" that states the origin
#   or development period length are all recognised. A phrase is replaced only
#   when its placeholder renders back to exactly the same characters, so the note
#   still reads the way it was written; text already inside braces is left alone,
#   so running the macro twice changes nothing.
# Scope: DFM
# Icon: wand
# </arcrho-macro>

from __future__ import annotations

import copy
import re
from typing import Any

MACRO_TITLE = "Link Notes to Method Values"

# Each entry names a list of labels the grouped method JSON already holds and
# the Notes name that reads one of them back by position. Nothing here derives
# a label the method does not carry, so the JSON stays the only source.
LABEL_SOURCES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("ratio_development_label", ("ratios_tab", "ratio_triangle", "development_labels")),
    ("development_label", ("data_tab", "development_labels")),
    ("origin_label", ("data_tab", "origin_labels")),
    ("average_formula_label", ("ratios_tab", "average_formulas", "label")),
)

# The single-value names, in the order a note is most likely to mean them.
NAME_SOURCES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("name", ("details_tab", "name")),
    ("input_triangle", ("details_tab", "input_triangle")),
    ("output_dataset", ("details_tab", "output_dataset")),
    ("output_type", ("details_tab", "output_type")),
    ("output_category", ("details_tab", "output_category")),
    ("ratio_basis_dataset", ("results_tab", "ratio_basis_dataset")),
)

# "12 months", "12 month", "12-month": the number is the period length, the
# rest stays literal so the sentence reads as it did.
MONTH_PHRASE = re.compile(r"(\d{1,3})(\s*-\s*|\s+)(months?)\b", re.IGNORECASE)
ORIGIN_WORDS = re.compile(r"origin|accident|policy|exposure|underwriting", re.IGNORECASE)

# A bare number this short says too little to be worth linking; a year does.
SHORTEST_NUMERIC_LABEL = 4


# ---------------------------------------------------------------------------
# Reading the method payload
# ---------------------------------------------------------------------------

def _node(payload: Any, path: tuple[str, ...]) -> Any:
    current = payload
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def _text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def _period_length(payload: Any, key: str) -> int | None:
    value = _node(payload, ("details_tab", key))
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def placeholder_candidates(payload: Any) -> list[tuple[str, str]]:
    """Every phrase worth linking, longest first, as (surface text, placeholder).

    A surface is kept only once: the first name that produces it wins, so a
    label shared by two lists is always read back the same way.
    """
    found: dict[str, str] = {}

    def offer(surface: Any, placeholder: str) -> None:
        text = _text(surface)
        if len(text) < 2:
            return
        if text.isdigit() and len(text) < SHORTEST_NUMERIC_LABEL:
            return
        found.setdefault(text, placeholder)

    for function_name, path in LABEL_SOURCES:
        labels = _node(payload, path)
        if not isinstance(labels, list):
            continue
        for position, label in enumerate(labels, start=1):
            offer(label, f"{{{function_name}({position})}}")

    for value_name, path in NAME_SOURCES:
        offer(_node(payload, path), f"{{{value_name}}}")

    return sorted(found.items(), key=lambda item: (-len(item[0]), item[0]))


# ---------------------------------------------------------------------------
# Text the macro must not touch
# ---------------------------------------------------------------------------

def _closing_brace(text: str, open_index: int) -> int:
    """Index of the `}` that closes the placeholder opened at `open_index`.

    Mirrors the brace rule owned by `ui/shared/tabs/notes/notes_expressions.js`:
    quotes and parentheses are respected and a newline ends the search.
    """
    depth = 0
    quote = ""
    index = open_index + 1
    while index < len(text):
        char = text[index]
        if quote:
            if char == "\\":
                index += 1
            elif char == quote:
                quote = ""
        elif char in ("'", '"'):
            quote = char
        elif char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        elif char == "}" and depth <= 0:
            return index
        elif char == "\n":
            return -1
        index += 1
    return -1


def protected_spans(text: str) -> list[tuple[int, int]]:
    """Regions to copy through untouched: placeholders, `{{`/`}}`, stray braces.

    A `{` with no closer is left alone together with the rest of its line,
    because a placeholder inserted after it would be swallowed as its closer.
    """
    spans: list[tuple[int, int]] = []
    index = 0
    while index < len(text):
        char = text[index]
        if char in ("{", "}") and text[index + 1: index + 2] == char:
            spans.append((index, index + 2))
            index += 2
            continue
        if char != "{":
            index += 1
            continue
        close = _closing_brace(text, index)
        if close < 0:
            line_end = text.find("\n", index)
            line_end = len(text) if line_end < 0 else line_end
            spans.append((index, line_end))
            index = line_end
            continue
        spans.append((index, close + 1))
        index = close + 1
    return spans


# ---------------------------------------------------------------------------
# Matching
# ---------------------------------------------------------------------------

def _left_is_clear(text: str, start: int, surface: str) -> bool:
    if start == 0:
        return True
    previous = text[start - 1]
    if previous.isalnum() or previous == "_":
        return False
    return not (surface[0].isdigit() and previous in ".,/-")


def _right_is_clear(text: str, end: int, surface: str) -> bool:
    if end >= len(text):
        return True
    following = text[end]
    if following.isalnum() or following == "_":
        return False
    if surface[-1].isdigit():
        if following in ",/":
            return False
        if following in ".-" and text[end + 1: end + 2].isdigit():
            return False
    return True


def _match_candidate(
    text: str, index: int, candidates: list[tuple[str, str]]
) -> tuple[str, str] | None:
    for surface, placeholder in candidates:
        if not text.startswith(surface, index):
            continue
        if _left_is_clear(text, index, surface) and _right_is_clear(text, index + len(surface), surface):
            return surface, placeholder
    return None


def _match_month_phrase(
    text: str, index: int, origin_length: int | None, development_length: int | None
) -> tuple[str, str] | None:
    match = MONTH_PHRASE.match(text, index)
    if not match:
        return None
    if index and (text[index - 1].isalnum() or text[index - 1] in "_.,"):
        return None
    number = int(match.group(1))
    nearby = text[max(0, index - 28):match.end() + 28]
    if number == origin_length and ORIGIN_WORDS.search(nearby):
        name = "origin_length"
    elif number == development_length:
        name = "development_length"
    elif number == origin_length:
        name = "origin_length"
    else:
        return None
    return match.group(0), f"{{{name}}}{match.group(2)}{match.group(3)}"


# ---------------------------------------------------------------------------
# The rewrite
# ---------------------------------------------------------------------------

def selected_region(notes: str, selection: Any) -> tuple[int, int]:
    """The part of the note to work on; the whole note when nothing is selected."""
    text = str(notes or "")
    if not isinstance(selection, dict):
        return 0, len(text)
    try:
        start = max(0, min(len(text), int(selection.get("start"))))
        end = max(0, min(len(text), int(selection.get("end"))))
    except (TypeError, ValueError):
        return 0, len(text)
    return (start, end) if start < end else (0, len(text))


def link_notes_to_method_values(
    notes: str, payload: Any, selection: Any = None
) -> tuple[str, list[tuple[str, str]]]:
    """Return the note with its labels linked, plus what was replaced.

    Only the selected region is rewritten, but the braces are read across the
    whole note: a `{` before the selection still swallows a `}` written into
    it, so its line stays untouched wherever it begins.
    """
    text = str(notes or "")
    region_start, region_end = selected_region(text, selection)
    candidates = placeholder_candidates(payload)
    origin_length = _period_length(payload, "origin_length")
    development_length = _period_length(payload, "development_length")
    skip = dict(protected_spans(text))

    pieces: list[str] = []
    replacements: list[tuple[str, str]] = []
    index = 0
    while index < len(text):
        end = skip.get(index)
        if end is not None:
            pieces.append(text[index:end])
            index = end
            continue
        hit = None
        if region_start <= index < region_end:
            hit = _match_candidate(text, index, candidates) or _match_month_phrase(
                text, index, origin_length, development_length
            )
        if hit and index + len(hit[0]) <= region_end:
            surface, placeholder = hit
            pieces.append(placeholder)
            replacements.append(hit)
            index += len(surface)
            continue
        pieces.append(text[index])
        index += 1
    return "".join(pieces), replacements


def _summary(replacements: list[tuple[str, str]], part: str) -> str:
    if not replacements:
        return f"No text in {part} matches a value the method can supply."
    distinct = sorted({surface for surface, _ in replacements})
    shown = ", ".join(f'"{surface}"' for surface in distinct[:5])
    more = f" and {len(distinct) - 5} more" if len(distinct) > 5 else ""
    return f"Linked {len(replacements)} phrase(s) in {part} to method values: {shown}{more}."


def run_macro(active_dfm=None, active_context=None):
    if active_dfm is None:
        return {
            "success": False,
            "message": "Open a DFM method before running this macro.",
        }
    original_notes = str(active_dfm.notes or "")
    payload = active_dfm.to_dict()
    selection = (active_context or {}).get("notesSelection") if isinstance(active_context, dict) else None
    start, end = selected_region(original_notes, selection)
    part = "the selected text" if (start, end) != (0, len(original_notes)) else "these notes"
    linked_notes, replacements = link_notes_to_method_values(original_notes, payload, selection)
    summary = _summary(replacements, part)
    if replacements:
        active_dfm.update_notes(linked_notes)

    preview = {
        "type": "notes_diff",
        "title": MACRO_TITLE,
        "summary": f"{summary} The note reads the same; review it before applying.",
        "original_notes": original_notes,
        "suggested_notes": linked_notes,
        "has_changes": linked_notes != original_notes,
        "changes": [f"{surface} -> {placeholder}" for surface, placeholder in replacements],
    }
    return {
        "success": True,
        "payload": copy.deepcopy(active_dfm.to_dict()),
        "preview": preview,
        "message": summary,
    }
