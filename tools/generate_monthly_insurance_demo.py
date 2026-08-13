"""Generate ArcRho's synthetic monthly detailed insurance demo source table.

The output is intentionally deterministic and uses only fictional channel codes.
It is a long-form incremental development table suitable for ArcRho field mapping.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import math
import random
from dataclasses import dataclass
from pathlib import Path


SEED = 20260812
START_ACCIDENT_MONTH = 201601
END_ACCIDENT_MONTH = 202512
VALUATION_MONTH = 202605

HEADERS = (
    "LineOfBusiness",
    "StateCode",
    "ChannelCode",
    "Coverage",
    "AccidentMonth",
    "EvaluationMonth",
    "GrossPaidLoss",
    "PaidClaimExpense",
    "SalvageRecovery",
    "SubrogationRecovery",
    "CaseReserveChange",
    "NetPaidLoss",
    "GrossReportedLoss",
    "NetReportedLoss",
    "ClosedClaimsWithPayment",
    "ClosedClaimsWithoutPayment",
    "ReportedClaims",
    "EarnedPremium",
    "EarnedCoverageExposure",
)


@dataclass(frozen=True)
class StateConfig:
    code: str
    exposure_factor: float
    premium_factor: float
    loss_factor: float


@dataclass(frozen=True)
class ChannelConfig:
    code: str
    exposure_factor: float
    premium_factor: float
    loss_factor: float


@dataclass(frozen=True)
class CoverageConfig:
    name: str
    monthly_premium: float
    annual_frequency: float
    average_severity: float
    report_scale: float
    report_shape: float
    paid_scale: float
    paid_shape: float
    close_scale: float
    close_shape: float
    development_months: int
    expense_ratio: float
    salvage_ratio: float
    subrogation_ratio: float
    zero_payment_ratio: float
    seasonal_amplitude: float
    seasonal_peak_month: int


@dataclass(frozen=True)
class LobConfig:
    name: str
    base_monthly_exposure: float
    annual_exposure_growth: float
    annual_rate_trend: float
    annual_severity_trend: float
    coverages: tuple[CoverageConfig, ...]


STATES = (
    StateConfig("CA", 1.15, 1.07, 1.08),
    StateConfig("TX", 1.00, 1.03, 1.04),
    StateConfig("OH", 0.72, 0.92, 0.90),
)

CHANNELS = (
    ChannelConfig("CH01", 1.00, 1.00, 0.98),
    ChannelConfig("CH02", 0.78, 0.98, 1.01),
    ChannelConfig("CH03", 0.58, 0.96, 1.04),
)

LOBS = (
    LobConfig(
        name="Personal Auto",
        base_monthly_exposure=2_800,
        annual_exposure_growth=0.018,
        annual_rate_trend=0.052,
        annual_severity_trend=0.056,
        coverages=(
            CoverageConfig(
                "Bodily Injury Liability",
                42.0,
                0.012,
                26_000,
                2.8,
                0.78,
                15.0,
                0.88,
                18.0,
                0.92,
                60,
                0.115,
                0.000,
                0.015,
                0.12,
                0.05,
                1,
            ),
            CoverageConfig(
                "Property Damage Liability",
                30.0,
                0.048,
                4_300,
                1.7,
                0.84,
                7.0,
                0.92,
                9.0,
                0.96,
                36,
                0.075,
                0.000,
                0.025,
                0.10,
                0.04,
                1,
            ),
            CoverageConfig(
                "Collision",
                62.0,
                0.060,
                6_500,
                1.2,
                0.90,
                4.8,
                1.02,
                6.0,
                1.04,
                36,
                0.055,
                0.035,
                0.005,
                0.08,
                0.10,
                1,
            ),
            CoverageConfig(
                "Comprehensive",
                28.0,
                0.045,
                3_700,
                1.0,
                0.92,
                3.6,
                1.04,
                4.8,
                1.06,
                24,
                0.050,
                0.015,
                0.003,
                0.10,
                0.12,
                7,
            ),
        ),
    ),
    LobConfig(
        name="Commercial Auto",
        base_monthly_exposure=850,
        annual_exposure_growth=0.014,
        annual_rate_trend=0.058,
        annual_severity_trend=0.060,
        coverages=(
            CoverageConfig(
                "Auto Liability",
                190.0,
                0.035,
                36_000,
                3.2,
                0.76,
                18.0,
                0.86,
                22.0,
                0.90,
                60,
                0.125,
                0.000,
                0.018,
                0.14,
                0.05,
                1,
            ),
            CoverageConfig(
                "Physical Damage",
                105.0,
                0.070,
                9_000,
                1.4,
                0.88,
                5.5,
                0.98,
                7.0,
                1.02,
                36,
                0.065,
                0.030,
                0.006,
                0.09,
                0.09,
                1,
            ),
        ),
    ),
    LobConfig(
        name="Homeowners",
        base_monthly_exposure=1_900,
        annual_exposure_growth=0.012,
        annual_rate_trend=0.062,
        annual_severity_trend=0.064,
        coverages=(
            CoverageConfig(
                "Dwelling Property",
                115.0,
                0.018,
                40_000,
                1.5,
                0.86,
                7.0,
                0.94,
                9.0,
                0.98,
                36,
                0.085,
                0.020,
                0.004,
                0.11,
                0.10,
                1,
            ),
            CoverageConfig(
                "Personal Property",
                24.0,
                0.025,
                6_000,
                1.1,
                0.90,
                4.5,
                1.00,
                6.0,
                1.02,
                30,
                0.060,
                0.012,
                0.003,
                0.12,
                0.08,
                1,
            ),
            CoverageConfig(
                "Premises Liability",
                14.0,
                0.004,
                23_000,
                3.0,
                0.76,
                16.0,
                0.86,
                20.0,
                0.90,
                48,
                0.140,
                0.000,
                0.010,
                0.18,
                0.03,
                1,
            ),
        ),
    ),
)


def month_number(yyyymm: int) -> int:
    year, month = divmod(yyyymm, 100)
    return year * 12 + month - 1


def as_yyyymm(value: int) -> int:
    year, zero_based_month = divmod(value, 12)
    return year * 100 + zero_based_month + 1


def iter_months(start: int, end: int):
    for value in range(month_number(start), month_number(end) + 1):
        yield as_yyyymm(value)


def add_months(yyyymm: int, offset: int) -> int:
    return as_yyyymm(month_number(yyyymm) + offset)


def months_between(start: int, end: int) -> int:
    return month_number(end) - month_number(start)


def rng_for(*parts: object) -> random.Random:
    key = "|".join(str(part) for part in (SEED, *parts))
    digest = hashlib.sha256(key.encode("utf-8")).digest()
    return random.Random(int.from_bytes(digest[:8], "big"))


def centered_lognormal(rng: random.Random, sigma: float) -> float:
    return math.exp(rng.gauss(-0.5 * sigma * sigma, sigma))


def poisson(rng: random.Random, mean: float) -> int:
    if mean <= 0:
        return 0
    if mean >= 30:
        return max(0, round(rng.gauss(mean, math.sqrt(mean))))

    threshold = math.exp(-mean)
    product = 1.0
    count = 0
    while product > threshold:
        count += 1
        product *= rng.random()
    return count - 1


def seasonal_factor(month: int, amplitude: float, peak_month: int) -> float:
    angle = 2.0 * math.pi * (month - peak_month) / 12.0
    return 1.0 + amplitude * math.cos(angle)


def development_cdf(
    age: int,
    scale: float,
    shape: float,
    terminal_age: int,
    speed_factor: float,
) -> float:
    if age < 0:
        return 0.0
    if age >= terminal_age:
        return 1.0
    adjusted_scale = max(0.2, scale * speed_factor)
    return min(1.0, 1.0 - math.exp(-((age + 1) / adjusted_scale) ** shape))


def money(cents: int) -> str:
    return f"{cents / 100:.2f}"


def exposure_for(
    lob: LobConfig,
    state: StateConfig,
    channel: ChannelConfig,
    accident_month: int,
) -> float:
    trend_years = months_between(START_ACCIDENT_MONTH, accident_month) / 12.0
    month = accident_month % 100
    rng = rng_for("exposure", lob.name, state.code, channel.code, accident_month)
    stable_fluctuation = centered_lognormal(rng, 0.025)
    seasonality = seasonal_factor(month, 0.025, 7)
    exposure = (
        lob.base_monthly_exposure
        * state.exposure_factor
        * channel.exposure_factor
        * (1.0 + lob.annual_exposure_growth) ** trend_years
        * seasonality
        * stable_fluctuation
    )
    return round(exposure, 2)


def generate_rows():
    accident_months = tuple(iter_months(START_ACCIDENT_MONTH, END_ACCIDENT_MONTH))

    for lob in LOBS:
        for state in STATES:
            for channel in CHANNELS:
                for coverage in lob.coverages:
                    for accident_month in accident_months:
                        trend_years = (
                            months_between(START_ACCIDENT_MONTH, accident_month) / 12.0
                        )
                        calendar_month = accident_month % 100
                        exposure = exposure_for(lob, state, channel, accident_month)
                        rng = rng_for(
                            "loss",
                            lob.name,
                            state.code,
                            channel.code,
                            coverage.name,
                            accident_month,
                        )

                        premium_rate = (
                            coverage.monthly_premium
                            * state.premium_factor
                            * channel.premium_factor
                            * (1.0 + lob.annual_rate_trend) ** trend_years
                        )
                        premium_cents = round(exposure * premium_rate * 100)

                        frequency = (
                            coverage.annual_frequency
                            * state.loss_factor**0.35
                            * channel.loss_factor**0.20
                            * seasonal_factor(
                                calendar_month,
                                coverage.seasonal_amplitude,
                                coverage.seasonal_peak_month,
                            )
                        )
                        ultimate_claims = poisson(rng, exposure * frequency / 12.0)

                        severity = (
                            coverage.average_severity
                            * state.loss_factor**0.65
                            * channel.loss_factor**0.80
                            * (1.0 + lob.annual_severity_trend) ** trend_years
                        )
                        aggregate_sigma = max(
                            0.055, 0.28 / math.sqrt(max(ultimate_claims, 1))
                        )
                        severity_noise = centered_lognormal(rng, aggregate_sigma)
                        ultimate_loss_cents = round(
                            ultimate_claims * severity * severity_noise * 100
                        )
                        expense_cents = round(
                            ultimate_loss_cents * coverage.expense_ratio
                        )
                        salvage_cents = round(
                            ultimate_loss_cents
                            * coverage.salvage_ratio
                            * centered_lognormal(rng, 0.08)
                        )
                        subrogation_cents = round(
                            ultimate_loss_cents
                            * coverage.subrogation_ratio
                            * centered_lognormal(rng, 0.08)
                        )
                        zero_payment_claims = min(
                            ultimate_claims,
                            round(ultimate_claims * coverage.zero_payment_ratio),
                        )
                        payment_claims = ultimate_claims - zero_payment_claims
                        speed_factor = centered_lognormal(rng, 0.075)

                        observed_age = months_between(accident_month, VALUATION_MONTH)
                        max_age = min(
                            observed_age,
                            coverage.development_months - 1,
                        )
                        terminal_age = coverage.development_months - 1

                        previous_paid = 0
                        previous_reported_loss = 0
                        previous_case = 0
                        previous_expense = 0
                        previous_salvage = 0
                        previous_subrogation = 0
                        previous_reported_claims = 0
                        previous_closed_with_payment = 0
                        previous_closed_without_payment = 0

                        for age in range(max_age + 1):
                            report_cdf = development_cdf(
                                age,
                                coverage.report_scale,
                                coverage.report_shape,
                                terminal_age,
                                speed_factor,
                            )
                            paid_cdf = min(
                                report_cdf,
                                development_cdf(
                                    age,
                                    coverage.paid_scale,
                                    coverage.paid_shape,
                                    terminal_age,
                                    speed_factor,
                                ),
                            )
                            expense_cdf = development_cdf(
                                age,
                                coverage.paid_scale * 0.70,
                                coverage.paid_shape,
                                terminal_age,
                                speed_factor,
                            )
                            recovery_cdf = development_cdf(
                                age,
                                coverage.paid_scale * 1.20,
                                coverage.paid_shape,
                                terminal_age,
                                speed_factor,
                            )

                            cumulative_reported_loss = round(
                                ultimate_loss_cents * report_cdf
                            )
                            cumulative_paid = min(
                                cumulative_reported_loss,
                                round(ultimate_loss_cents * paid_cdf),
                            )
                            cumulative_case = (
                                cumulative_reported_loss - cumulative_paid
                            )
                            cumulative_expense = round(expense_cents * expense_cdf)
                            cumulative_salvage = min(
                                cumulative_paid,
                                round(salvage_cents * recovery_cdf),
                            )
                            cumulative_subrogation = min(
                                cumulative_paid - cumulative_salvage,
                                round(subrogation_cents * recovery_cdf),
                            )

                            claim_report_cdf = development_cdf(
                                age,
                                coverage.report_scale * 0.75,
                                coverage.report_shape,
                                terminal_age,
                                speed_factor,
                            )
                            cumulative_reported_claims = round(
                                ultimate_claims * claim_report_cdf
                            )
                            close_no_pay_cdf = development_cdf(
                                age,
                                coverage.close_scale * 0.72,
                                coverage.close_shape,
                                terminal_age,
                                speed_factor,
                            )
                            close_with_pay_cdf = development_cdf(
                                age,
                                coverage.close_scale,
                                coverage.close_shape,
                                terminal_age,
                                speed_factor,
                            )
                            desired_closed_without_payment = round(
                                zero_payment_claims * close_no_pay_cdf
                            )
                            desired_closed_with_payment = round(
                                payment_claims * close_with_pay_cdf
                            )

                            available_to_close = max(
                                0,
                                cumulative_reported_claims
                                - previous_closed_without_payment
                                - previous_closed_with_payment,
                            )
                            close_without_payment = min(
                                max(
                                    0,
                                    desired_closed_without_payment
                                    - previous_closed_without_payment,
                                ),
                                available_to_close,
                            )
                            available_to_close -= close_without_payment
                            close_with_payment = min(
                                max(
                                    0,
                                    desired_closed_with_payment
                                    - previous_closed_with_payment,
                                ),
                                available_to_close,
                            )
                            cumulative_closed_without_payment = (
                                previous_closed_without_payment
                                + close_without_payment
                            )
                            cumulative_closed_with_payment = (
                                previous_closed_with_payment + close_with_payment
                            )

                            paid_increment = cumulative_paid - previous_paid
                            case_increment = cumulative_case - previous_case
                            expense_increment = (
                                cumulative_expense - previous_expense
                            )
                            salvage_increment = (
                                cumulative_salvage - previous_salvage
                            )
                            subrogation_increment = (
                                cumulative_subrogation - previous_subrogation
                            )
                            gross_reported_increment = paid_increment + case_increment
                            net_paid_increment = (
                                paid_increment
                                - salvage_increment
                                - subrogation_increment
                            )
                            net_reported_increment = (
                                gross_reported_increment
                                - salvage_increment
                                - subrogation_increment
                            )
                            reported_claim_increment = (
                                cumulative_reported_claims
                                - previous_reported_claims
                            )

                            yield (
                                lob.name,
                                state.code,
                                channel.code,
                                coverage.name,
                                accident_month,
                                add_months(accident_month, age),
                                money(paid_increment),
                                money(expense_increment),
                                money(salvage_increment),
                                money(subrogation_increment),
                                money(case_increment),
                                money(net_paid_increment),
                                money(gross_reported_increment),
                                money(net_reported_increment),
                                close_with_payment,
                                close_without_payment,
                                reported_claim_increment,
                                money(premium_cents if age == 0 else 0),
                                f"{exposure:.2f}" if age == 0 else "0.00",
                            )

                            previous_paid = cumulative_paid
                            previous_reported_loss = cumulative_reported_loss
                            previous_case = cumulative_case
                            previous_expense = cumulative_expense
                            previous_salvage = cumulative_salvage
                            previous_subrogation = cumulative_subrogation
                            previous_reported_claims = cumulative_reported_claims
                            previous_closed_with_payment = (
                                cumulative_closed_with_payment
                            )
                            previous_closed_without_payment = (
                                cumulative_closed_without_payment
                            )

                        if previous_reported_loss < previous_paid:
                            raise AssertionError("Reported loss cannot be below paid loss")


def write_demo_csv(output_path: Path) -> int:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = output_path.with_suffix(output_path.suffix + ".tmp")
    row_count = 0
    with temporary_path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream, lineterminator="\n")
        writer.writerow(HEADERS)
        for row in generate_rows():
            writer.writerow(row)
            row_count += 1
    temporary_path.replace(output_path)
    return row_count


def main() -> None:
    repository_root = Path(__file__).resolve().parents[1]
    default_output = (
        repository_root / "demo-data" / "monthly_detailed_insurance_demo.csv"
    )
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=default_output)
    args = parser.parse_args()

    output_path = args.output.resolve()
    row_count = write_demo_csv(output_path)
    print(f"Wrote {row_count:,} synthetic rows to {output_path}")


if __name__ == "__main__":
    main()
