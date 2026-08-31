"""Validate and canonicalize dataset cell formulas.

A manual-input dataset cell can calculate its value from a formula whose
operands are ArcRho dataset references, Excel references, and numbers::

    =[C 82 - Prior Qtr Selected][1:7] * 2
    =([Paid Claims][1:6, 2] + 'C:\\Folder\\[Book.xlsx]Sheet1'!B1:B6) / 1000

The grammar, the canonical stored text, and the arithmetic semantics are owned
by ``arcrho_api.dataset_link_contract`` (mirrored token for token by the
frontend's ``ui/shared/dataset/dataset_formula.js``); this module translates
its refusals into the ``422`` responses the save routes contract to return.
"""

from __future__ import annotations

from typing import Any, Dict, List

from fastapi import HTTPException

from arcrho_api.dataset_link_contract import (
    DATASET_FORMULA_SYNTAX_HINT,
    DatasetLinkError,
)
from arcrho_api import dataset_link_contract


def tokenize_dataset_formula(raw_text: Any) -> List[Dict[str, Any]]:
    """Split formula text into typed tokens; 422 when a character is not part of the grammar."""

    try:
        return dataset_link_contract.tokenize_dataset_formula(raw_text)
    except DatasetLinkError as err:
        raise HTTPException(422, str(err))


def canonical_dataset_formula(raw_text: Any) -> str:
    """Return the normalized stored text for a valid formula; 422 otherwise."""

    try:
        return dataset_link_contract.canonical_dataset_formula(raw_text)
    except DatasetLinkError as err:
        raise HTTPException(422, str(err))
