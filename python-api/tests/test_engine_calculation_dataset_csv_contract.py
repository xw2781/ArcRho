"""The ``dataset_csv`` operation: what the contract accepts and what it refuses.

A worksheet formula cannot open the CSV the dataset route resolves, so it asks
for the figures instead. This pins the one operation that answers with them --
which Engine functions may run it, which options it takes, and the keys no
client may name however it asks.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path


_TESTS_DIR = Path(__file__).resolve().parent
_SRC_ROOT = _TESTS_DIR.parent / "src"
if str(_SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(_SRC_ROOT))

import arcrho_engine_calculation_contract as engine_calculation_contract  # noqa: E402
from arcrho_engine_calculation_contract import (  # noqa: E402
    ENGINE_CALCULATION_CSV_FIELD,
    HTTP_ENGINE_CALCULATION_OPERATIONS,
    OPERATION_DATASET_CSV,
    OUTPUT_VARIANT_TEMPORARY_VIEW,
    SERVER_OWNED_REQUEST_KEYS,
    EngineCalculationContractError,
    build_engine_calculation_request,
)


TRI_PAIRS = [
    ["Function", "ArcRhoTri"],
    ["Path", "PA\\All States\\COL"],
    ["DatasetName", "Paid"],
    ["InstanceName", "Paid"],
    ["Cumulative", "True"],
    ["Transposed", "False"],
    ["Calendar", "False"],
    ["ProjectName", "Demo Project"],
    ["OriginLength", "12"],
    ["DevelopmentLength", "12"],
]
VEC_PAIRS = [["Function", "ArcRhoVec"]] + TRI_PAIRS[1:]
HEADER_PAIRS = [
    ["Function", "ArcRhoHeaders"],
    ["periodType", "0"],
    ["Transposed", "False"],
    ["Calendar", "False"],
    ["PeriodLength", "12"],
    ["ProjectName", "Demo Project"],
    ["StoredPeriodLength", "-1"],
]
PROJECT_SETTINGS_PAIRS = [
    ["Function", "ArcRhoProjectSettings"],
    ["ProjectName", "Demo Project"],
]


def _request(pairs=None, **overrides) -> dict:
    fields = {
        "request_id": "calc-1",
        "pairs": TRI_PAIRS if pairs is None else pairs,
        "timeout_sec": 15.0,
        "user_name": "alice",
        "user_display_name": "Alice Example",
        "operation": OPERATION_DATASET_CSV,
    }
    fields.update(overrides)
    return build_engine_calculation_request(**fields)


class DatasetCsvOperationTests(unittest.TestCase):
    def test_both_dataset_functions_accept_the_operation(self) -> None:
        for pairs in (TRI_PAIRS, VEC_PAIRS):
            request = _request(pairs)
            self.assertEqual(request["Operation"], OPERATION_DATASET_CSV)
            self.assertEqual(request["Options"], {})

    def test_the_project_level_functions_accept_the_operation(self) -> None:
        """The headings and project-settings formulas answer the same way."""

        for pairs in (HEADER_PAIRS, PROJECT_SETTINGS_PAIRS):
            request = _request(pairs)
            self.assertEqual(request["Operation"], OPERATION_DATASET_CSV)
            self.assertEqual(request["Options"], {})

    def test_the_project_level_functions_refuse_an_unlisted_key(self) -> None:
        for pairs in (HEADER_PAIRS, PROJECT_SETTINGS_PAIRS):
            with self.assertRaises(EngineCalculationContractError):
                _request(pairs + [["Path", "PA\\All States\\COL"]])
        # The project-settings request names the project and nothing else.
        with self.assertRaises(EngineCalculationContractError):
            _request(PROJECT_SETTINGS_PAIRS + [["PeriodLength", "12"]])

    def test_the_project_level_functions_take_no_output_variant(self) -> None:
        for pairs in (HEADER_PAIRS, PROJECT_SETTINGS_PAIRS):
            with self.assertRaises(EngineCalculationContractError):
                _request(pairs, output_variant=OUTPUT_VARIANT_TEMPORARY_VIEW)

    def test_the_operation_is_advertised(self) -> None:
        self.assertIn(OPERATION_DATASET_CSV, HTTP_ENGINE_CALCULATION_OPERATIONS)

    def test_the_run_options_are_accepted(self) -> None:
        request = _request(
            options={"local_only": False, "allow_derived": True}
        )
        self.assertEqual(
            request["Options"],
            {"local_only": False, "allow_derived": True},
        )

    def test_an_unlisted_option_is_refused(self) -> None:
        for options in (
            {"force_refresh": True},
            {"write_sidecar": False},
            {"temporary_session_id": "abc"},
            {"allow_runtime_cache_provenance": True},
            {"csv_text": True},
        ):
            with self.assertRaises(EngineCalculationContractError):
                _request(options=options)

    def test_an_option_of_the_wrong_type_is_refused(self) -> None:
        with self.assertRaises(EngineCalculationContractError):
            _request(options={"allow_derived": "yes"})

    def test_no_output_variant_travels_with_the_operation(self) -> None:
        with self.assertRaises(EngineCalculationContractError):
            _request(output_variant=OUTPUT_VARIANT_TEMPORARY_VIEW)

    def test_a_server_owned_key_is_still_refused(self) -> None:
        for name in sorted(SERVER_OWNED_REQUEST_KEYS):
            with self.assertRaises(EngineCalculationContractError):
                _request(TRI_PAIRS + [[name, "anything"]])

    def test_the_retired_dataset_view_key_is_refused(self) -> None:
        """``DatasetView`` asked an Engine to write a coarser view as a file.

        Nothing produces or answers it any more -- the figures travel in the
        answer instead -- so the contract no longer names it and a request
        carrying it is refused as the unknown key it now is.
        """

        self.assertFalse(
            hasattr(engine_calculation_contract, "DATASET_VIEW_REQUEST_KEY"),
            "the retired dataset view key is still named by the contract",
        )
        with self.assertRaises(EngineCalculationContractError):
            _request(TRI_PAIRS + [["DatasetView", "True"]])

    def test_the_answer_field_is_named_once(self) -> None:
        self.assertEqual(ENGINE_CALCULATION_CSV_FIELD, "csv_text")


if __name__ == "__main__":
    unittest.main()
