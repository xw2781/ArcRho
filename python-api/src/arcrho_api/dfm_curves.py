"""DFM Curves tab: curve fitting, tail factors, and the selected development factors.

This module owns the calculation behind the DFM Curves tab, the ArcRho
counterpart of ResQ's ``Curves | Data`` tab. The rules were verified against
the ResQ COM object of ``C 12 - CWP DFM w/ Selected LDFs`` in the fake project
on 2026-09-03 (``CurveFitA``/``CurveFitB``/``CurveFitC``/``CurveFitRSquared``,
``CurveValues``, ``TailFactorValue``) and against the ResQ scripting manual's
*Log regression fitting method* page:

* The **Initial Selection** column is the Ratios tab's selected factor per
  development period, and its tail is the Ratios tab's selected ``- Ult`` value.
* Four curves are fitted to the included Initial Selection factors ``r_t``
  (``t`` = 1 for the first development period) by ordinary linear regression
  in log space, with the R-squared of that regression:

  ================  ==============================  ======================
  Curve             Fitted form                     Regression
  ================  ==============================  ======================
  Exponential Decay ``1 + a * exp(b * t)``          ``ln(r-1)`` on ``t``
  Inverse Power     ``1 + a * (t + c) ** b``        ``ln(r-1)`` on ``ln(t+c)``
  Power             ``a ** (b ** t)``               ``ln(ln r)`` on ``t``
  Weibull           ``1 / (1 - exp(-a * t ** b))``  ``ln(-ln(1-1/r))`` on ``ln t``
  ================  ==============================  ======================

  ``c`` is chosen from ``(-0.5, 0, 1, 3, 5)`` by the highest R-squared, or,
  with *Free Fit C*, by a golden-section search over ``c > -1``.
* Each curve's **tail factor** is the product of its fitted values over the
  *Future Dev. Periods* that follow the last observed period. A user column's
  tail is entered directly.
* The **Selected Estimate Number** per period names the column the final
  factor is taken from (1 = Initial Selection, 2-5 = the curves, 6+ = user
  columns); the tail has its own selection. Those selected values are the
  development factors the method's ultimates and percentage developed use.

The frontend mirror is ``frontend/ui/method_pages/dfm/dfm_curve_fit.js``;
``python-api/tests/fixtures/dfm_curves_resq_c12.json`` pins both to ResQ.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from typing import Any

CURVE_KINDS: tuple[str, ...] = ("exponential_decay", "inverse_power", "power", "weibull")
CURVE_LABELS: dict[str, str] = {
    "exponential_decay": "Exponential Decay",
    "inverse_power": "Inverse Power",
    "power": "Power",
    "weibull": "Weibull",
}
INITIAL_SELECTION_LABEL = "Initial Selection"
# Initial Selection plus the four curves; user columns follow as column 6 onward.
FIXED_COLUMN_COUNT = 1 + len(CURVE_KINDS)
FITTING_METHODS: tuple[str, ...] = ("log_regression", "least_squares")
DEFAULT_FITTING_METHOD = "log_regression"
USER_COLUMN_TYPES: tuple[str, ...] = ("user_entry", "prior_analysis", "pattern", "benchmark")
DEFAULT_USER_COLUMN_LABEL = "User Entry"
DEFAULT_FUTURE_DEVELOPMENT_PERIODS = 1
MAX_FUTURE_DEVELOPMENT_PERIODS = 200
INVERSE_POWER_C_CANDIDATES: tuple[float, ...] = (-0.5, 0.0, 1.0, 3.0, 5.0)
FREE_FIT_C_LOWER = -0.999
FREE_FIT_C_UPPER = 10.0
FREE_FIT_C_LIMIT = -0.5
# ResQ's default inclusion thresholds: a factor above the first or below the
# second is left out of the fit until the user includes it explicitly.
DEFAULT_EXCLUDE_ABOVE = 2.0
DEFAULT_EXCLUDE_BELOW = 1.00001

FIT_UNFITTED = "unfitted"
FIT_OK = "ok"
FIT_LIMIT = "limit"
FIT_FAIL = "fail"
FIT_WARNING = "warning"

_GOLDEN = (math.sqrt(5.0) - 1.0) / 2.0


def _number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _factor(value: Any, default: float = 1.0) -> float:
    number = _number(value)
    return number if number is not None and number > 0 else default


def _flag(value: Any) -> int:
    if value in (1, True, "1", "true", "True"):
        return 1
    return 0


def _integer(value: Any, default: int, *, minimum: int, maximum: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, number))


def default_included(initial_selection: Sequence[Any]) -> list[int]:
    """ResQ's default inclusion: factors inside ``(1.00001, 2]`` take part in the fit."""

    out: list[int] = []
    for value in initial_selection:
        number = _number(value)
        out.append(1 if number is not None and DEFAULT_EXCLUDE_BELOW <= number <= DEFAULT_EXCLUDE_ABOVE else 0)
    return out


def default_curves_tab(period_count: int, initial_selection: Sequence[Any] | None = None) -> dict[str, Any]:
    """The Curves tab of a method that has never chosen anything on it."""

    count = max(0, int(period_count))
    selection = list(initial_selection) if initial_selection is not None else []
    included = default_included(selection[:count]) + [0] * max(0, count - len(selection))
    return {
        "fitting_method": DEFAULT_FITTING_METHOD,
        "future_development_periods": DEFAULT_FUTURE_DEVELOPMENT_PERIODS,
        "free_fit_c": False,
        "included": included,
        "user_columns": [
            {
                "label": DEFAULT_USER_COLUMN_LABEL,
                "column_type": "user_entry",
                "values": [1.0] * count,
                "tail": 1.0,
            }
        ],
        "selected_estimates": [1] * count,
        "selected_tail_factor": 1,
        "selected_tail_curve": 1,
        "selected_values": [],
    }


def normalize_user_column(raw: Any, period_count: int) -> dict[str, Any]:
    source = raw if isinstance(raw, Mapping) else {}
    column_type = str(source.get("column_type") or "user_entry").strip().lower()
    if column_type not in USER_COLUMN_TYPES:
        column_type = "user_entry"
    values = source.get("values") if isinstance(source.get("values"), list) else []
    fitted = [_factor(values[index] if index < len(values) else None) for index in range(period_count)]
    return {
        "label": str(source.get("label") or DEFAULT_USER_COLUMN_LABEL).strip() or DEFAULT_USER_COLUMN_LABEL,
        "column_type": column_type,
        "values": fitted,
        "tail": _factor(source.get("tail")),
    }


def normalize_curves_tab(
    raw: Any,
    period_count: int,
    initial_selection: Sequence[Any] | None = None,
) -> dict[str, Any]:
    """Return the canonical ``curves_tab`` for ``period_count`` development periods.

    A payload without a Curves tab gets the defaults, so a method saved before
    the tab existed keeps selecting the Initial Selection everywhere and its
    factors do not move. ``selected_values`` is derived state that
    ``recalculate_dfm_method`` refreshes; it is carried through here so a
    normalized-but-not-recalculated payload still reports the stored chain.
    """

    count = max(0, int(period_count))
    if not isinstance(raw, Mapping) or not raw:
        return default_curves_tab(count, initial_selection)
    if count == 0:
        # No input geometry yet -- an owned payload before its snapshot is
        # applied -- so the stored choices keep their own length until a
        # recalculation fits them to the triangle.
        count = max(
            [len(raw.get(key)) for key in ("included", "selected_estimates") if isinstance(raw.get(key), list)]
            + [
                len(column.get("values"))
                for column in (raw.get("user_columns") if isinstance(raw.get("user_columns"), list) else [])
                if isinstance(column, Mapping) and isinstance(column.get("values"), list)
            ],
            default=0,
        )
    fitting_method = str(raw.get("fitting_method") or DEFAULT_FITTING_METHOD).strip().lower()
    if fitting_method not in FITTING_METHODS:
        fitting_method = DEFAULT_FITTING_METHOD
    # A period the stored flags do not reach -- a new development period, or a
    # method saved before the tab existed -- starts on ResQ's default inclusion.
    defaults = default_included(list(initial_selection or [])[:count]) + [0] * max(
        0, count - len(list(initial_selection or []))
    )
    included_source = raw.get("included") if isinstance(raw.get("included"), list) else []
    included = [
        _flag(included_source[index]) if index < len(included_source) else defaults[index] for index in range(count)
    ]
    user_columns_source = raw.get("user_columns") if isinstance(raw.get("user_columns"), list) else None
    if user_columns_source is None:
        user_columns = default_curves_tab(count)["user_columns"]
    else:
        user_columns = [normalize_user_column(item, count) for item in user_columns_source]
    column_count = FIXED_COLUMN_COUNT + len(user_columns)

    def column_number(value: Any) -> int:
        return _integer(value, 1, minimum=1, maximum=max(1, column_count))

    selected_source = raw.get("selected_estimates") if isinstance(raw.get("selected_estimates"), list) else []
    selected_estimates = [
        column_number(selected_source[index]) if index < len(selected_source) else 1 for index in range(count)
    ]
    selected_values_source = raw.get("selected_values") if isinstance(raw.get("selected_values"), list) else []
    selected_values = [
        _number(item) for item in selected_values_source[: count + 1]
    ] if len(selected_values_source) == count + 1 else []
    return {
        "fitting_method": fitting_method,
        "future_development_periods": _integer(
            raw.get("future_development_periods"),
            DEFAULT_FUTURE_DEVELOPMENT_PERIODS,
            minimum=1,
            maximum=MAX_FUTURE_DEVELOPMENT_PERIODS,
        ),
        "free_fit_c": bool(raw.get("free_fit_c")),
        "included": included,
        "user_columns": user_columns,
        "selected_estimates": selected_estimates,
        "selected_tail_factor": column_number(raw.get("selected_tail_factor")),
        "selected_tail_curve": column_number(raw.get("selected_tail_curve")),
        "selected_values": selected_values if all(item is not None for item in selected_values) else [],
    }


OWNED_CURVES_FIELDS: tuple[str, ...] = (
    "fitting_method",
    "future_development_periods",
    "free_fit_c",
    "included",
    "user_columns",
    "selected_estimates",
    "selected_tail_factor",
    "selected_tail_curve",
)


def owned_curves_tab(curves_tab: Mapping[str, Any]) -> dict[str, Any]:
    """The person's Curves-tab choices, without the derived ``selected_values``."""

    return {key: curves_tab.get(key) for key in OWNED_CURVES_FIELDS}


def curves_tab_is_default(curves_tab: Mapping[str, Any], initial_selection: Sequence[Any]) -> bool:
    """True when the tab still selects the Initial Selection everywhere with default settings.

    A method saved before the Curves tab existed normalizes to exactly this
    state, and its factors are unchanged by the tab, so its stored revisions
    must not move: the revision projections leave the tab out while it is
    default and a file written before the tab fingerprints the same as after.
    """

    count = len(initial_selection)
    return owned_curves_tab(normalize_curves_tab(curves_tab, count, initial_selection)) == owned_curves_tab(
        default_curves_tab(count, initial_selection)
    )


# ---------------------------------------------------------------------------
# Fitting
# ---------------------------------------------------------------------------


def _linear_regression(xs: Sequence[float], ys: Sequence[float]) -> tuple[float, float, float] | None:
    """Return ``(intercept, slope, r_squared)`` of ``y`` on ``x``, or None when degenerate."""

    n = len(xs)
    if n < 2:
        return None
    mean_x = sum(xs) / n
    mean_y = sum(ys) / n
    sxx = sum((x - mean_x) ** 2 for x in xs)
    sxy = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys))
    syy = sum((y - mean_y) ** 2 for y in ys)
    if sxx <= 0:
        return None
    slope = sxy / sxx
    intercept = mean_y - slope * mean_x
    r_squared = (sxy * sxy) / (sxx * syy) if syy > 0 else 1.0
    return intercept, slope, r_squared


def _log_points(kind: str, points: Sequence[tuple[int, float]], c: float = 0.0) -> tuple[list[float], list[float]]:
    xs: list[float] = []
    ys: list[float] = []
    for t, value in points:
        if value <= 1.0:
            # Log regression cannot take the log of a non-positive excess.
            continue
        if kind == "exponential_decay":
            xs.append(float(t))
            ys.append(math.log(value - 1.0))
        elif kind == "inverse_power":
            if t + c <= 0:
                continue
            xs.append(math.log(t + c))
            ys.append(math.log(value - 1.0))
        elif kind == "power":
            xs.append(float(t))
            ys.append(math.log(math.log(value)))
        elif kind == "weibull":
            xs.append(math.log(float(t)))
            ys.append(math.log(-math.log(1.0 - 1.0 / value)))
    return xs, ys


def _fit_kind(kind: str, points: Sequence[tuple[int, float]], c: float = 0.0) -> dict[str, Any] | None:
    xs, ys = _log_points(kind, points, c)
    regression = _linear_regression(xs, ys)
    if regression is None:
        return None
    intercept, slope, r_squared = regression
    if kind == "power":
        a, b = math.exp(math.exp(intercept)), math.exp(slope)
    else:
        a, b = math.exp(intercept), slope
    return {"a": a, "b": b, "c": c if kind == "inverse_power" else 0.0, "r_squared": r_squared}


def _inverse_power_r_squared(points: Sequence[tuple[int, float]], c: float) -> float:
    fit = _fit_kind("inverse_power", points, c)
    return fit["r_squared"] if fit is not None else -1.0


def _free_fit_c(points: Sequence[tuple[int, float]]) -> float:
    """Golden-section search for the ``c`` with the highest log-regression R-squared."""

    low, high = FREE_FIT_C_LOWER, FREE_FIT_C_UPPER
    x1 = high - _GOLDEN * (high - low)
    x2 = low + _GOLDEN * (high - low)
    f1 = _inverse_power_r_squared(points, x1)
    f2 = _inverse_power_r_squared(points, x2)
    for _ in range(200):
        if f1 < f2:
            low, x1, f1 = x1, x2, f2
            x2 = low + _GOLDEN * (high - low)
            f2 = _inverse_power_r_squared(points, x2)
        else:
            high, x2, f2 = x2, x1, f1
            x1 = high - _GOLDEN * (high - low)
            f1 = _inverse_power_r_squared(points, x1)
        if high - low < 1e-12:
            break
    return (low + high) / 2.0


def unfitted() -> dict[str, Any]:
    return {"a": None, "b": None, "c": None, "r_squared": None, "result": FIT_UNFITTED}


def fit_curves(
    initial_selection: Sequence[Any],
    included: Sequence[Any],
    *,
    free_fit_c: bool = False,
) -> dict[str, dict[str, Any]]:
    """Fit the four curves to the included factors; ``t`` is 1 for the first period."""

    points: list[tuple[int, float]] = []
    for index, value in enumerate(initial_selection):
        number = _number(value)
        if number is None or not (index < len(included) and _flag(included[index])):
            continue
        points.append((index + 1, number))
    fits: dict[str, dict[str, Any]] = {}
    for kind in CURVE_KINDS:
        if kind == "inverse_power":
            if free_fit_c:
                c = _free_fit_c(points)
                fit = _fit_kind(kind, points, c)
                if fit is None:
                    fits[kind] = unfitted()
                    continue
                first_period = min((t for t, _ in points), default=1)
                if first_period + c <= 0:
                    fit["result"] = FIT_WARNING
                elif c < FREE_FIT_C_LIMIT:
                    fit["result"] = FIT_LIMIT
                else:
                    fit["result"] = FIT_OK
                fits[kind] = fit
                continue
            best: dict[str, Any] | None = None
            for candidate in INVERSE_POWER_C_CANDIDATES:
                fit = _fit_kind(kind, points, candidate)
                if fit is not None and (best is None or fit["r_squared"] > best["r_squared"]):
                    best = fit
            fits[kind] = {**best, "result": FIT_OK} if best is not None else unfitted()
            continue
        fit = _fit_kind(kind, points)
        fits[kind] = {**fit, "result": FIT_OK} if fit is not None else unfitted()
    return fits


def curve_value(kind: str, fit: Mapping[str, Any], t: int) -> float | None:
    """The fitted development factor of ``kind`` at period ``t`` (1-based)."""

    a = _number(fit.get("a"))
    b = _number(fit.get("b"))
    if a is None or b is None:
        return None
    try:
        if kind == "exponential_decay":
            value = 1.0 + a * math.exp(b * t)
        elif kind == "inverse_power":
            base = t + (_number(fit.get("c")) or 0.0)
            if base <= 0:
                return None
            value = 1.0 + a * base ** b
        elif kind == "power":
            value = a ** (b ** t)
        elif kind == "weibull":
            value = 1.0 / (1.0 - math.exp(-a * t ** b))
        else:
            return None
    except (OverflowError, ValueError, ZeroDivisionError):
        return None
    return value if math.isfinite(value) else None


def _product(values: Sequence[float | None]) -> float | None:
    out = 1.0
    for value in values:
        if value is None:
            return None
        out *= value
    return out


# ---------------------------------------------------------------------------
# The Curves | Data table
# ---------------------------------------------------------------------------


def curves_table(
    initial_selection: Sequence[Any],
    initial_tail: Any,
    curves_tab: Mapping[str, Any],
) -> dict[str, Any]:
    """Every column and derived row of the Curves tab for one method.

    ``initial_selection`` holds the Ratios tab's selected factor per development
    period and ``initial_tail`` its selected ``- Ult`` value. The result is a
    plain structure: ``columns`` (each with its per-period ``values``, its
    ``future`` values for the tail pattern rows, and its ``tail``), the
    selected column per period, and the cumulative chain.
    """

    period_count = len(initial_selection)
    tab = normalize_curves_tab(curves_tab, period_count, initial_selection)
    future_count = int(tab["future_development_periods"])
    selection = [_factor(value) for value in initial_selection]
    tail = _factor(initial_tail)
    fits = fit_curves(selection, tab["included"], free_fit_c=bool(tab["free_fit_c"]))

    columns: list[dict[str, Any]] = [
        {
            "number": 1,
            "key": "initial_selection",
            "label": INITIAL_SELECTION_LABEL,
            "column_type": "value",
            "values": list(selection),
            # A non-fitted column runs off its whole tail in the first future period.
            "future": [tail] + [1.0] * (future_count - 1),
            "tail": tail,
            "fit": None,
        }
    ]
    for offset, kind in enumerate(CURVE_KINDS):
        fit = fits[kind]
        values = [curve_value(kind, fit, t) for t in range(1, period_count + 1)]
        future = [curve_value(kind, fit, t) for t in range(period_count + 1, period_count + 1 + future_count)]
        columns.append(
            {
                "number": 2 + offset,
                "key": kind,
                "label": CURVE_LABELS[kind],
                "column_type": "curve",
                "values": values,
                "future": future,
                "tail": _product(future) if fit["result"] != FIT_UNFITTED else None,
                "fit": fit,
            }
        )
    for offset, column in enumerate(tab["user_columns"]):
        columns.append(
            {
                "number": FIXED_COLUMN_COUNT + 1 + offset,
                "key": f"user_{offset + 1}",
                "label": column["label"],
                "column_type": column["column_type"],
                "values": list(column["values"]),
                "future": [column["tail"]] + [1.0] * (future_count - 1),
                "tail": column["tail"],
                "fit": None,
            }
        )
    by_number = {column["number"]: column for column in columns}

    def pick(number: int, fallback: int = 1) -> dict[str, Any]:
        return by_number.get(number) or by_number[fallback]

    selected_values: list[float] = []
    for index in range(period_count):
        column = pick(tab["selected_estimates"][index])
        value = column["values"][index] if index < len(column["values"]) else None
        selected_values.append(value if value is not None else selection[index])
    tail_column = pick(tab["selected_tail_factor"])
    selected_tail = tail_column["tail"] if tail_column["tail"] is not None else tail
    pattern_column = pick(tab["selected_tail_curve"])

    chain = selected_values + [selected_tail]
    cumulative: list[float] = [0.0] * len(chain)
    running = 1.0
    for index in range(len(chain) - 1, -1, -1):
        running *= chain[index]
        cumulative[index] = running
    cumulative_percentage = [1.0 / value if value else None for value in cumulative]
    incremental_percentage: list[float | None] = []
    previous = 0.0
    for index, value in enumerate(cumulative_percentage):
        if index == len(cumulative_percentage) - 1:
            # The tail row carries everything still to come after the last observed period.
            incremental_percentage.append(1.0 - previous if value is not None else None)
            continue
        incremental_percentage.append(value - previous if value is not None else None)
        if value is not None:
            previous = value

    # The first future period still carries the whole selected tail; each later
    # row is what remains once the pattern column's earlier periods have run off.
    tail_rows: list[dict[str, Any]] = []
    running_future = cumulative[-1] if cumulative else 1.0
    cumulative_future: list[float | None] = [None] * future_count
    for index in range(future_count):
        cumulative_future[index] = running_future
        value = pattern_column["future"][index] if index < len(pattern_column["future"]) else None
        running_future = running_future / value if value else running_future
    for index in range(future_count):
        selected_future = pattern_column["future"][index] if index < len(pattern_column["future"]) else None
        cumulative_value = cumulative_future[index]
        tail_rows.append(
            {
                "period": period_count + 1 + index,
                "values": {column["number"]: column["future"][index] for column in columns},
                "selected_value": selected_future,
                "cumulative_value": cumulative_value,
                "cumulative_percentage": 1.0 / cumulative_value if cumulative_value else None,
            }
        )
    for index, row in enumerate(tail_rows):
        prior = tail_rows[index - 1]["cumulative_percentage"] if index else cumulative_percentage[-2] if len(
            cumulative_percentage
        ) > 1 else 0.0
        current = row["cumulative_percentage"]
        row["incremental_percentage"] = (current - (prior or 0.0)) if current is not None else None

    return {
        "curves_tab": tab,
        "columns": columns,
        "fits": fits,
        "selected_values": selected_values,
        "selected_tail": selected_tail,
        "selected_tail_column": tail_column["number"],
        "selected_tail_pattern_column": pattern_column["number"],
        "cumulative": cumulative,
        "cumulative_percentage": cumulative_percentage,
        "incremental_percentage": incremental_percentage,
        "tail_rows": tail_rows,
    }


def selected_development_factors(
    initial_selection: Sequence[Any],
    initial_tail: Any,
    curves_tab: Mapping[str, Any],
) -> list[float]:
    """The final factor per development period followed by the selected tail."""

    table = curves_table(initial_selection, initial_tail, curves_tab)
    return list(table["selected_values"]) + [table["selected_tail"]]
