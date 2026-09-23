"""Arco's bootstrap against ResQ's saved run, for all five reference segments.

``fixtures/resq_bootstrap_consolidation_total.json.gz`` holds the five
``F 72 A - Bootstrap Net Incurred with PV`` methods of the fake project's
All States Direct Group, simulated and saved in ResQ (plan step 1).  Arco's
random stream differs from ResQ's, so the simulated statistics are compared at
the plan's parity bar: within three standard errors of the two runs' combined
sampling error.  The deterministic quantities (latest diagonal, DFM reserves,
the scaled means Additive scaling lands on) match to 1e-9.
"""

from __future__ import annotations

import gzip
import json
import math
from pathlib import Path

import pytest

from arcrho_api.bootstrap_contract import (
    BST_JSON_FORMAT,
    bootstrap_simulated_reserves,
    recalculate_bootstrap_method,
    summarize_bootstrap_simulations,
)
from arcrho_api.bootstrap_simulation import percentile_key, summarize_reserves


FIXTURE = Path(__file__).parent / "fixtures" / "resq_bootstrap_consolidation_total.json.gz"
SEGMENTS = ("BI Total", "CMPxCAT", "COL", "MP+PIP", "PD+UMPD")
BODY_PERCENTILES = tuple(range(5, 100, 5))
Z_LIMIT = 3.0
REL_TOL = 1e-9


@pytest.fixture(scope="module")
def reference() -> dict:
    with gzip.open(FIXTURE, "rt", encoding="utf-8") as handle:
        fixture = json.load(handle)
    return {seg["reserving_class"].rsplit("\\", 1)[-1]: seg for seg in fixture["segments"]}


def _payload(segment: dict) -> dict:
    settings = segment["settings"]
    return {
        "json_format": BST_JSON_FORMAT,
        "details_tab": {
            "name": segment["name"],
            "output_type": "F 00 - Ultimate Net Loss",
            "origin_length": settings["origin_length"],
            "development_length": settings["development_length"],
            "model_type": settings["model_type"],
            "dfm_method": settings["dfm"],
        },
        "simulation_tab": {
            "estimation_variance": settings["estimation_variance"],
            "process_variance": settings["process_variance"],
            "simulation_count": settings["simulation_count"],
            "random_seed": settings["random_seed"],
            "prevent_negative_data": settings["prevent_negative_data"],
            "negative_mean_action": "normal" if settings["use_normal_on_negative_mean"] else "value_0_01",
        },
        "results_tab": {
            "target_ultimate": settings["target_ultimate"],
            "target_scaling_methods": segment["target_scaling_methods"],
        },
    }


def _dfm_snapshot(segment: dict) -> dict:
    settings = segment["settings"]
    ratio_count = settings["total_development_periods"] - 1
    return {
        "name": settings["dfm"],
        "origin_labels": segment["origin_labels"],
        "development_labels": [f"{12 * (index + 1)}" for index in range(ratio_count)],
        "origin_length": settings["origin_length"],
        "development_length": settings["development_length"],
        "total_development_periods": settings["total_development_periods"],
        "observed_triangle": segment["observed_triangle"],
        "selected_ratios": segment["selected_ratios"],
        # Every observed ratio is re-estimated (volume, all periods); the tail is held.
        "refit_ratios": [index < ratio_count - 1 for index in range(ratio_count)],
    }


def _target_snapshot(segment: dict) -> dict:
    return {
        "name": segment["settings"]["target_ultimate"],
        "origin_labels": segment["origin_labels"],
        "values": segment["target_ultimates"],
    }


@pytest.fixture(scope="module")
def arco(reference) -> dict:
    runs = {}
    for name in SEGMENTS:
        segment = reference[name]
        method = recalculate_bootstrap_method(
            _payload(segment),
            dfm_snapshot=_dfm_snapshot(segment),
            target_snapshot=_target_snapshot(segment),
            timestamp="2026-09-23T00:00:00Z",
            simulate=False,
        )
        simulations = bootstrap_simulated_reserves(method)
        runs[name] = {
            "method": method,
            "simulations": simulations,
            "summary": summarize_bootstrap_simulations(simulations),
        }
    return runs


def _moments(values: list[float]) -> tuple[float, float, float]:
    """Mean, standard deviation (divisor n, as ResQ), and the standard error of that deviation."""

    n = len(values)
    mean = math.fsum(values) / n
    m2 = math.fsum((v - mean) ** 2 for v in values) / n
    m4 = math.fsum((v - mean) ** 4 for v in values) / n
    sd = math.sqrt(m2)  # ResQ's standard deviation divides by n
    se_sd = math.sqrt(max(m4 - m2 * m2, 0.0) / (4.0 * m2 * n)) if m2 > 0 else 0.0
    return mean, sd, se_sd


def _quantile_with_error(values: list[float], fraction: float) -> tuple[float, float]:
    """ResQ's percentile and its distribution-free standard error from the order statistics."""

    ordered = sorted(values)
    n = len(ordered)
    position = min(n - 1, int(math.floor(fraction * n + 1e-9)))
    value = ordered[position]
    half = math.sqrt(n * fraction * (1 - fraction))
    low = ordered[max(0, int(math.floor(position - half)))]
    high = ordered[min(n - 1, int(math.ceil(position + half)))]
    return value, (high - low) / 2.0


def _z(a: float, b: float, *errors: float) -> float:
    combined = math.sqrt(sum(error * error for error in errors))
    return abs(a - b) / combined if combined else (0.0 if a == b else math.inf)


@pytest.mark.parametrize("name", SEGMENTS)
@pytest.mark.parametrize("block", ("unscaled", "scaled"))
def test_summary_statistics_equal_resq_when_fed_resq_simulations(reference, name, block):
    """Mean, standard deviation and every captured percentile use ResQ's definitions."""

    segment = reference[name]
    totals = segment[f"{block}_total_by_simulation"]
    summary = summarize_reserves([[value] for value in totals], percentiles=())
    resq = segment[block]
    assert summary["mean"][0] == pytest.approx(resq["mean"][0], rel=1e-12)
    assert summary["standard_error"][0] == pytest.approx(resq["standard_error"][0], rel=1e-12)
    fractions = [float(key) for key in resq["percentiles"]]
    ladder = summarize_reserves([[value] for value in totals], percentiles=[100 * f for f in fractions])
    for key, fraction in zip(resq["percentiles"], fractions):
        assert ladder["percentiles"][percentile_key(100 * fraction)][0] == resq["percentiles"][key][0], f"{name} {key}"


@pytest.mark.parametrize("name", SEGMENTS)
def test_deterministic_inputs_match_resq(reference, arco, name):
    segment = reference[name]
    simulations = arco[name]["simulations"]
    assert simulations["simulation_count"] == segment["settings"]["simulation_count"]
    for got, want in zip(simulations["latest_values"], segment["latest_values"]):
        assert got == pytest.approx(want, rel=REL_TOL)
    for got, want in zip(arco[name]["method"]["results_tab"]["target_reserve_values"], segment["target_reserve_values"]):
        assert got == pytest.approx(want, rel=REL_TOL, abs=1e-6)


@pytest.mark.parametrize("name", SEGMENTS)
def test_scaled_means_land_on_resq_scaled_means(reference, arco, name):
    got = arco[name]["summary"]["scaled"]["mean"]
    want = reference[name]["scaled"]["mean"]
    scale = max(abs(value) for value in want)
    for index, (a, b) in enumerate(zip(got, want)):
        assert abs(a - b) <= REL_TOL * scale, f"{name} scaled mean index {index}"


@pytest.mark.parametrize("name", SEGMENTS)
def test_unscaled_total_mean_and_spread_match_resq_within_sampling_error(reference, arco, name):
    resq_mean, resq_sd, resq_se_sd = _moments(reference[name]["unscaled_total_by_simulation"])
    arco_mean, arco_sd, arco_se_sd = _moments(arco[name]["simulations"]["unscaled"]["totals"])
    n_resq = len(reference[name]["unscaled_total_by_simulation"])
    n_arco = len(arco[name]["simulations"]["unscaled"]["totals"])
    # The captured totals reproduce ResQ's own summary.
    assert resq_mean == pytest.approx(reference[name]["unscaled"]["mean"][0], rel=1e-9)
    assert resq_sd == pytest.approx(reference[name]["unscaled"]["standard_error"][0], rel=1e-9)
    assert _z(arco_mean, resq_mean, resq_sd / math.sqrt(n_resq), arco_sd / math.sqrt(n_arco)) <= Z_LIMIT
    assert _z(arco_sd, resq_sd, resq_se_sd, arco_se_sd) <= Z_LIMIT


@pytest.mark.parametrize("name", SEGMENTS)
def test_unscaled_origin_means_match_resq_within_sampling_error(reference, arco, name):
    resq = reference[name]["unscaled"]
    arco_summary = arco[name]["summary"]["unscaled"]
    n = reference[name]["settings"]["simulation_count"]
    for index in range(1, len(resq["mean"])):
        errors = (resq["standard_error"][index] / math.sqrt(n), arco_summary["standard_error"][index] / math.sqrt(n))
        assert _z(arco_summary["mean"][index], resq["mean"][index], *errors) <= Z_LIMIT, f"{name} origin {index}"


@pytest.mark.parametrize("name", SEGMENTS)
def test_unscaled_total_percentiles_match_resq_within_sampling_error(reference, arco, name):
    resq_totals = reference[name]["unscaled_total_by_simulation"]
    arco_totals = arco[name]["simulations"]["unscaled"]["totals"]
    stored = arco[name]["summary"]["unscaled"]["percentiles"]
    for step in BODY_PERCENTILES:
        fraction = step / 100.0
        resq_value, resq_error = _quantile_with_error(resq_totals, fraction)
        arco_value, arco_error = _quantile_with_error(arco_totals, fraction)
        assert resq_value == pytest.approx(reference[name]["unscaled"]["percentiles"][f"{fraction:.3f}"][0], rel=1e-9)
        assert arco_value == pytest.approx(stored[percentile_key(step)][0], rel=1e-12)
        assert _z(arco_value, resq_value, resq_error, arco_error) <= Z_LIMIT, f"{name} {step}%"
