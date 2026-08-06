"""Bootstrap contract parity against live ResQ output.

``fixtures/resq_bootstrap_f72a.json`` was captured read-only over the ResQ COM
API from project ``NJ_Annual_Prod_202605_Fake``, reserving class
``PRNJ - PA\\PA\\All States\\Direct Group\\COL``.  It pins both Over-dispersed
Poisson models plus one full ``Simulate()`` run so the stochastic layer has a
reference distribution to be checked against.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from arcrho_api.bootstrap_contract import (
    BST_JSON_FORMAT,
    BootstrapContractError,
    apply_owned_patch,
    bootstrap_output_variants,
    bootstrap_precedent_names,
    build_bootstrap_output_sidecar,
    normalize_bootstrap_method,
    recalculate_bootstrap_method,
)
from arcrho_api.bootstrap_simulation import (
    BootstrapCalculationError,
    BootstrapSimulationOptions,
    calculate_residuals,
    fit_dfm_projection,
    observed_triangle,
    scale_simulated_reserves,
    simulate_bootstrap,
    summarize_reserves,
)
from arcrho_api.io import persisted_json_text


FIXTURE = Path(__file__).parent / "fixtures" / "resq_bootstrap_f72a.json"
RESIDUAL_KEYS = (
    "unscaled",
    "unscaled_bias_adjusted",
    "scaled",
    "scaled_bias_adjusted",
    "scaled_bias_adjusted_zero_average",
)


@pytest.fixture(scope="module")
def fixture() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def _case(fixture: dict, key: str) -> dict:
    return fixture["methods"][key]


def _fit_for(case: dict):
    return fit_dfm_projection(
        observed_triangle(case["observed_triangle"]),
        case["selected_ratios"],
        case["total_development_periods"],
    )


def _relative(actual: float, expected: float) -> float:
    return abs(actual - expected) / max(abs(expected), 1e-9)


# ---------------------------------------------------------------------------
# Deterministic layer
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("key", ["odp_single_scale", "odp_varying_scale"])
def test_fitted_cumulative_matches_resq_predicted_values(fixture, key):
    case = _case(fixture, key)
    fit = _fit_for(case)
    for origin, row in enumerate(case["predicted_values"]):
        for column, expected in enumerate(row):
            if expected is None:
                continue
            assert _relative(fit.fitted_cumulative[origin][column], expected) <= 1e-12


@pytest.mark.parametrize("key", ["odp_single_scale", "odp_varying_scale"])
def test_residual_grids_match_resq_residuals_by_type(fixture, key):
    case = _case(fixture, key)
    residuals = calculate_residuals(_fit_for(case), model_type=case["model_type"])
    for index, name in enumerate(RESIDUAL_KEYS):
        expected_grid = case["residuals_by_type"][str(index)]
        compared = 0
        for origin, row in enumerate(expected_grid):
            for column, expected in enumerate(row):
                actual = residuals.grids[name][origin][column]
                if expected is None:
                    assert actual is None, f"{name} ({origin},{column}) should be excluded"
                    continue
                assert actual is not None, f"{name} ({origin},{column}) missing"
                assert _relative(actual, expected) <= 1e-9
                compared += 1
        assert compared == 53, f"{name} should cover the 53 usable residuals"


@pytest.mark.parametrize("key", ["odp_single_scale", "odp_varying_scale"])
def test_scale_parameters_and_counts_match_resq(fixture, key):
    case = _case(fixture, key)
    residuals = calculate_residuals(_fit_for(case), model_type=case["model_type"])
    # ResQ counts observed data cells, not usable residuals: 55 rather than 53.
    assert residuals.data_point_count == case["data_point_count"]
    assert residuals.parameter_count == case["parameter_count"]
    assert _relative(residuals.bias_factor, math.sqrt(55 / 36)) <= 1e-12
    for column, expected in enumerate(case["scale_values_residuals_unsmoothed"]):
        assert _relative(residuals.scale_unsmoothed[column], expected) <= 1e-9
    assert abs(residuals.residual_adjustment - case["residual_adjustment"]) <= 1e-12


def test_zero_residuals_are_excluded_not_counted(fixture):
    """The saturated cells drop out of the residual pool but stay data points."""

    case = _case(fixture, "odp_single_scale")
    fit = _fit_for(case)
    residuals = calculate_residuals(fit, model_type=case["model_type"])
    assert len(residuals.pool) == 53
    assert residuals.data_point_count == 55
    oldest_last = len(case["observed_triangle"][0]) - 1
    assert residuals.unscaled[0][oldest_last] is None
    assert residuals.unscaled[-1][0] is None


def test_varying_scale_uses_column_data_cell_count(fixture):
    """The first column divides by 10 observed cells, not by its 9 residuals."""

    case = _case(fixture, "odp_varying_scale")
    fit = _fit_for(case)
    residuals = calculate_residuals(fit, model_type="odp_varying_scale")
    column = [residuals.unscaled[w][0] for w in range(fit.origin_count)]
    usable = [value for value in column if value is not None]
    assert len(usable) == 9
    cells = sum(1 for row in case["observed_triangle"] if len(row) > 0)
    assert cells == 10
    expected = math.sqrt(sum(v * v for v in usable) / cells * (55 / 36))
    assert _relative(residuals.scale_unsmoothed[0], expected) <= 1e-12
    assert _relative(residuals.scale_unsmoothed[0], case["scale_values_residuals_unsmoothed"][0]) <= 1e-9


def test_varying_scale_tail_falls_back_to_lower_of_previous_two(fixture):
    case = _case(fixture, "odp_varying_scale")
    residuals = calculate_residuals(_fit_for(case), model_type="odp_varying_scale")
    scale = residuals.scale_unsmoothed
    assert scale[9] == pytest.approx(min(scale[7], scale[8]))
    assert scale[10] == pytest.approx(min(scale[7], scale[8]))


def test_mack_model_is_rejected_until_implemented(fixture):
    case = _case(fixture, "odp_single_scale")
    with pytest.raises(BootstrapCalculationError, match="Mack"):
        calculate_residuals(_fit_for(case), model_type="mack")


# ---------------------------------------------------------------------------
# Simulation layer
# ---------------------------------------------------------------------------


def _run(fixture, count: int, seed: int):
    case = _case(fixture, "odp_single_scale")
    reference = fixture["simulation_reference"]
    fit = _fit_for(case)
    residuals = calculate_residuals(fit, model_type=case["model_type"])
    options = BootstrapSimulationOptions(
        simulation_count=count,
        random_seed=seed,
        estimation_variance=reference["estimation_variance"],
        process_variance=reference["process_variance"],
        prevent_negative_data=reference["prevent_negative_data"],
        negative_mean_action=reference["negative_mean_action"],
    )
    return fit, residuals, simulate_bootstrap(fit, residuals, options)


def test_simulation_is_deterministic_for_a_seed(fixture):
    _, _, first = _run(fixture, 200, 4242)
    _, _, second = _run(fixture, 200, 4242)
    assert first.reserves == second.reserves
    _, _, other = _run(fixture, 200, 4243)
    assert other.reserves != first.reserves


def test_simulated_total_matches_resq_within_sampling_error(fixture):
    """ResQ's own 10,000-simulation run is itself a sample; compare on z."""

    reference = fixture["simulation_reference"]
    _, _, run = _run(fixture, 20000, 20260805)
    summary = summarize_reserves(run.reserves)
    resq_mean = reference["unscaled"]["mean"][0]
    resq_sd = reference["unscaled"]["standard_error"][0]
    resq_count = reference["simulation_count"]

    combined = math.sqrt(
        resq_sd**2 / resq_count + summary["standard_error"][0] ** 2 / len(run.reserves)
    )
    assert abs(summary["mean"][0] - resq_mean) / combined <= 3.0
    assert _relative(summary["standard_error"][0], resq_sd) <= 0.05


def test_simulated_percentiles_track_resq_across_the_body(fixture):
    reference = fixture["simulation_reference"]
    _, _, run = _run(fixture, 20000, 20260805)
    summary = summarize_reserves(run.reserves)
    resq_sd = reference["unscaled"]["standard_error"][0]
    for step in range(5, 100, 5):
        expected = reference["unscaled"]["percentiles"][f"{step / 100:.2f}"][0]
        actual = summary["percentiles"][str(step)][0]
        assert abs(actual - expected) <= 0.12 * resq_sd, f"percentile {step}%"


def test_expected_reserve_tracks_the_dfm_reserve(fixture):
    fit, _, run = _run(fixture, 20000, 7)
    summary = summarize_reserves(run.reserves)
    for origin, dfm_reserve in enumerate(fit.dfm_reserves):
        error = summary["standard_error"][origin + 1] / math.sqrt(len(run.reserves))
        assert abs(summary["mean"][origin + 1] - dfm_reserve) <= max(6.0 * error, 1.0)


def test_projection_anchors_on_the_pseudo_latest_diagonal(fixture):
    """The observed diagonal would understate the newest origin's variance."""

    case = _case(fixture, "odp_single_scale")
    reference = fixture["simulation_reference"]
    fit = _fit_for(case)
    residuals = calculate_residuals(fit, model_type=case["model_type"])
    options = BootstrapSimulationOptions(
        simulation_count=4000, random_seed=11, negative_mean_action="normal"
    )
    run = simulate_bootstrap(fit, residuals, options)
    summary = summarize_reserves(run.reserves)
    newest = summary["standard_error"][fit.origin_count]
    assert newest == pytest.approx(reference["unscaled"]["standard_error"][-1], rel=0.06)


# ---------------------------------------------------------------------------
# Scaling
# ---------------------------------------------------------------------------


def test_additive_scaling_hits_the_target_and_preserves_dispersion(fixture):
    reference = fixture["simulation_reference"]
    _, _, run = _run(fixture, 3000, 99)
    targets = reference["target_reserve_values"]
    scaled = scale_simulated_reserves(
        run.reserves,
        target_means=targets,
        scaling_methods=reference["target_scaling_methods"],
    )
    unscaled_summary = summarize_reserves(run.reserves)
    scaled_summary = summarize_reserves(scaled)
    for origin, target in enumerate(targets):
        assert scaled_summary["mean"][origin + 1] == pytest.approx(target, abs=1e-6)
        assert scaled_summary["standard_error"][origin + 1] == pytest.approx(
            unscaled_summary["standard_error"][origin + 1], rel=1e-12
        )


def test_multiplicative_scaling_preserves_the_coefficient_of_variation(fixture):
    _, _, run = _run(fixture, 2000, 5)
    origins = len(run.reserves[0])
    targets = [-1000.0] * origins
    scaled = scale_simulated_reserves(
        run.reserves, target_means=targets, scaling_methods=["multiplicative"] * origins
    )
    unscaled_summary = summarize_reserves(run.reserves)
    scaled_summary = summarize_reserves(scaled)
    for origin in range(origins):
        mean = unscaled_summary["mean"][origin + 1]
        if abs(mean) < 1e-6 or unscaled_summary["standard_error"][origin + 1] == 0:
            continue
        expected = abs(unscaled_summary["standard_error"][origin + 1] / mean * targets[origin])
        assert scaled_summary["standard_error"][origin + 1] == pytest.approx(expected, rel=1e-9)


def test_unscaled_scaling_is_a_passthrough(fixture):
    _, _, run = _run(fixture, 500, 3)
    origins = len(run.reserves[0])
    scaled = scale_simulated_reserves(
        run.reserves, target_means=[0.0] * origins, scaling_methods=["unscaled"] * origins
    )
    assert scaled == [list(row) for row in run.reserves]


# ---------------------------------------------------------------------------
# Payload contract
# ---------------------------------------------------------------------------


def _snapshot_from_fixture(case: dict) -> dict:
    ratio_count = case["total_development_periods"] - 1
    return {
        "name": "F 25 - Incurred DFM Bootstrap",
        "origin_labels": case["origin_labels"],
        "development_labels": [f"{5 + 12 * index}m" for index in range(ratio_count)],
        "origin_length": 12,
        "development_length": 12,
        "total_development_periods": case["total_development_periods"],
        "observed_triangle": case["observed_triangle"],
        "selected_ratios": case["selected_ratios"],
        "refit_ratios": [index < ratio_count - 1 for index in range(ratio_count)],
        "ratio_average_base": ["volume"] * ratio_count,
        "ratio_average_periods": [None] * ratio_count,
        "ratio_exclude_high_low": [False] * ratio_count,
        "excluded_ratios": [],
        "dfm_ultimate_values": [],
    }


def _seed_payload(case: dict, reference: dict) -> dict:
    return {
        "json_format": BST_JSON_FORMAT,
        "details_tab": {
            "name": case["name"],
            "output_type": "F 00 - Ultimate Net Loss",
            "dataset_category": "F Net Loss",
            "origin_length": 12,
            "development_length": 12,
            "model_type": case["model_type"],
            "dfm_method": "F 25 - Incurred DFM Bootstrap",
        },
        "residuals_tab": {},
        "simulation_tab": {
            "estimation_variance": reference["estimation_variance"],
            "process_variance": reference["process_variance"],
            "simulation_count": 400,
            "random_seed": reference["random_seed"],
            "prevent_negative_data": reference["prevent_negative_data"],
            "negative_mean_action": reference["negative_mean_action"],
        },
        "results_tab": {
            "target_ultimate": "F 92 - Current Qtr Selected",
            "target_scaling_methods": reference["target_scaling_methods"],
        },
        "output_tab": {},
        "method_metadata": {},
    }


def _target_snapshot(case: dict, reference: dict) -> dict:
    return {
        "name": "F 92 - Current Qtr Selected",
        "origin_labels": case["origin_labels"],
        "values": [
            target + latest
            for target, latest in zip(
                reference["target_reserve_values"], reference["dfm_latest_values"]
            )
        ],
    }


@pytest.fixture(scope="module")
def method(fixture) -> dict:
    case = _case(fixture, "odp_single_scale")
    reference = fixture["simulation_reference"]
    return recalculate_bootstrap_method(
        _seed_payload(case, reference),
        dfm_snapshot=_snapshot_from_fixture(case),
        target_snapshot=_target_snapshot(case, reference),
        timestamp="2026-08-05T00:00:00Z",
    )


def test_recalculate_is_deterministic_and_normalization_is_idempotent(fixture, method):
    case = _case(fixture, "odp_single_scale")
    reference = fixture["simulation_reference"]
    again = recalculate_bootstrap_method(
        _seed_payload(case, reference),
        dfm_snapshot=_snapshot_from_fixture(case),
        target_snapshot=_target_snapshot(case, reference),
        timestamp="2026-08-05T00:00:00Z",
    )
    assert persisted_json_text(again) == persisted_json_text(method)
    assert persisted_json_text(normalize_bootstrap_method(method)) == persisted_json_text(method)


def test_recalculated_residuals_and_counts_match_resq(fixture, method):
    case = _case(fixture, "odp_single_scale")
    residuals = method["residuals_tab"]
    assert residuals["data_point_count"] == 55
    assert residuals["parameter_count"] == 19
    assert residuals["scale_values_residuals"]["selected"][0] == pytest.approx(
        case["scale_values_residuals_unsmoothed"][0], rel=1e-6
    )
    grid = residuals["residual_values"]["scaled_bias_adjusted_zero_average"]
    expected = case["residuals_by_type"]["4"]
    for origin, row in enumerate(expected):
        for column, value in enumerate(row):
            if value is None:
                continue
            # The persisted grid is stored at the canonical six-decimal
            # precision; the calculation behind it is exact.
            assert grid[origin][column] == pytest.approx(value, abs=1e-6)


def test_additive_target_scaling_publishes_the_target_ultimate(fixture, method):
    reference = fixture["simulation_reference"]
    for origin, latest in enumerate(reference["dfm_latest_values"]):
        target_ultimate = reference["target_reserve_values"][origin] + latest
        assert method["results_tab"]["bootstrap_ultimate"][origin] == pytest.approx(
            target_ultimate, abs=1e-4
        )


def test_precedents_cover_the_dfm_and_the_target(method):
    assert bootstrap_precedent_names(method) == [
        "F 25 - Incurred DFM Bootstrap",
        "F 92 - Current Qtr Selected",
    ]


def test_output_sidecar_matches_the_canonical_dataset_sidecar_shape(method):
    sidecar = build_bootstrap_output_sidecar(
        method,
        project_name="NJ",
        reserving_class="COL",
        csv_file="F 72 A@12.csv",
        notes="hello",
        user="tester",
        timestamp="2026-08-05T00:00:00Z",
    )
    assert sidecar["method_type"] == "Bootstrap"
    assert sidecar["method_type_code"] == 6
    assert sidecar["source_kind"] == "bootstrap"
    assert sidecar["data_format"] == "Vector"
    assert sidecar["data_format_code"] == 1
    assert sidecar["calculated"] is True
    assert sidecar["notes"] == "hello"
    assert sidecar["csv_file"] == "F 72 A@12.csv"
    assert sidecar["period_length"] == method["details_tab"]["origin_length"]
    assert sidecar["development_labels"] == ["Ultimate"]
    assert sidecar["origin_count"] == len(method["results_tab"]["origin_labels"])
    assert sidecar["publication_revision"] == method["method_metadata"]["publication_revision"]
    # The dependency graph is keyed by dataset name, so precedents are stored in
    # the same {"dataset_type_name": ...} shape every other method writes.
    assert sidecar["Precedents"] == [
        {"dataset_type_name": "F 25 - Incurred DFM Bootstrap"},
        {"dataset_type_name": "F 92 - Current Qtr Selected"},
    ]
    assert sidecar["audit_log"][-1]["action"] == "Insert"


def test_output_sidecar_accepts_resolved_graph_precedents(method):
    # A DFM that publishes under a different dataset name must reach the graph
    # by that dataset name, not by its method name.
    sidecar = build_bootstrap_output_sidecar(
        method,
        project_name="NJ",
        reserving_class="COL",
        csv_file="F 72 A@12.csv",
        precedents=["F 25 Ultimate", "F 92 - Current Qtr Selected"],
    )
    assert sidecar["Precedents"] == [
        {"dataset_type_name": "F 25 Ultimate"},
        {"dataset_type_name": "F 92 - Current Qtr Selected"},
    ]


def test_output_variants_expose_the_native_length(method):
    variants = bootstrap_output_variants(method)
    assert set(variants) == {12}
    assert len(variants[12]) == len(method["results_tab"]["origin_labels"])


def test_persisted_payload_stays_small_enough_for_a_network_drive(method):
    text = persisted_json_text(method)
    assert len(text) < 200 * 1024
    assert "simulation_summary" in text
    # The simulated reserve array itself must never be persisted.
    assert len(text.splitlines()) < 2000


def test_changing_the_dfm_clears_the_embedded_snapshot(method):
    patch = dict(method)
    patch["details_tab"] = {**method["details_tab"], "dfm_method": "Another DFM"}
    rebased = apply_owned_patch(method, patch)
    assert rebased["details_tab"]["dfm_method"] == "Another DFM"
    assert rebased["details_tab"]["dfm_snapshot"]["observed_triangle"] == []
    assert rebased["details_tab"]["dfm_source_revision"] == ""


def test_owned_patch_preserves_derived_state_when_only_owned_values_change(method):
    patch = dict(method)
    patch["simulation_tab"] = {**method["simulation_tab"], "simulation_count": 5000}
    rebased = apply_owned_patch(method, patch)
    assert rebased["simulation_tab"]["simulation_count"] == 5000
    assert (
        rebased["method_metadata"]["owned_revision"]
        != method["method_metadata"]["owned_revision"]
    )
    assert (
        rebased["residuals_tab"]["residual_values"]
        == method["residuals_tab"]["residual_values"]
    )


def test_unknown_json_format_is_rejected(method):
    bad = dict(method)
    bad["json_format"] = "arcrho-bootstrap-method-by-tab-v0"
    with pytest.raises(BootstrapContractError):
        normalize_bootstrap_method(bad)
