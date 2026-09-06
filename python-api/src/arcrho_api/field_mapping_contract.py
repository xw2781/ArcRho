"""Canonical contract for a project's field mapping date roles.

`field_mapping.json` records which source-table columns carry a reserving
period, and — since the stored/display split — how fine the dates in those
columns are. That granularity is the shape an Engine-generated dataset can be
rebuilt at, whatever period it happened to be generated at last, so it is what
a generated dataset's sidecar records as its stored shape.

This module owns three things: the date-role vocabulary, the rule that turns
one date value into months per period, and the field the recorded answer is
persisted under. The app server reads all three from here. The Engine runs
inside its own frozen bundle and mirrors the rule in
``arcrho_engine.data_processing``; ``server-components/tests/
test_engine_source_granularity.py`` fails when the mirror drifts.
"""

from __future__ import annotations

from typing import Any, Mapping


# --- Date roles -----------------------------------------------------------
DATE_ROLE_ORIGIN = "Origin Date"
DATE_ROLE_DEVELOPMENT = "Development Date"
# The significances whose mapped field carries a reserving period.
DATE_ROLE_SIGNIFICANCES = (DATE_ROLE_ORIGIN, DATE_ROLE_DEVELOPMENT)

# --- Granularity ----------------------------------------------------------
SOURCE_PERIOD_MONTHS_FIELD = "source_period_months"
ANNUAL_PERIOD_MONTHS = 12
MONTHLY_PERIOD_MONTHS = 1
# A date-role value is either a year (YYYY) or a year and month (YYYYMM).
ANNUAL_DATE_DIGITS = 4


def period_months_from_date_value(value: Any) -> int:
    """Months per period the date-role value *value* is written at.

    A four-digit value is a year, so each period covers twelve months; every
    other readable value is a ``YYYYMM`` month. Returns ``0`` when the value is
    not a number at all, which callers read as "this column says nothing".
    """

    try:
        period = int(value)
    except (TypeError, ValueError):
        return 0
    if len(str(abs(period))) == ANNUAL_DATE_DIGITS:
        return ANNUAL_PERIOD_MONTHS
    return MONTHLY_PERIOD_MONTHS


def source_period_months(payload: Mapping[str, Any]) -> dict[str, int]:
    """The months per period *payload* records for each date role.

    A role the mapping has not been able to measure is simply absent, so a
    caller can tell "annual" from "not recorded".
    """

    recorded = payload.get(SOURCE_PERIOD_MONTHS_FIELD) if isinstance(payload, Mapping) else None
    if not isinstance(recorded, Mapping):
        return {}
    months: dict[str, int] = {}
    for role in DATE_ROLE_SIGNIFICANCES:
        try:
            value = int(recorded.get(role))
        except (TypeError, ValueError):
            continue
        if value > 0:
            months[role] = value
    return months


def source_period_months_field(months_by_role: Mapping[str, Any]) -> dict[str, Any]:
    """The persisted field carrying *months_by_role*, ordered by date role."""

    return {SOURCE_PERIOD_MONTHS_FIELD: source_period_months(
        {SOURCE_PERIOD_MONTHS_FIELD: months_by_role}
    )}
