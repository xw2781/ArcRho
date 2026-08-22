"""Every sidecar producer emits the one shared core, with ``audit_log`` last."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from arcrho_api import bootstrap_contract, bornhuetter_ferguson_contract, cape_cod_contract, dfm_contract  # noqa: E402
from arcrho_api.engine_dataset_sidecar_contract import build_engine_dataset_sidecar  # noqa: E402
from arcrho_api.sidecar_core_contract import (  # noqa: E402
    METHOD_OUTPUT_SIDECAR_FIELDS,
    SIDECAR_CORE_FIELDS,
    SidecarContractError,
    validate_sidecar_core,
    with_audit_log_last,
)
import test_bootstrap_contract as bootstrap_tests  # noqa: E402
import test_bornhuetter_ferguson_contract as bf_tests  # noqa: E402
import test_cape_cod_contract as cc_tests  # noqa: E402
import test_dfm_contract as dfm_tests  # noqa: E402


_PRIOR = {
    "show_subtotal": False,
    "audit_log": [
        {"event_date": "2026-08-01T00:00:00Z", "action": "Insert", "change_info": "", "user": "Dana"},
        {"event_date": "2026-08-02T00:00:00Z", "action": "Auto Refresh", "change_info": "", "user": "Engine"},
        {"event_date": "2026-08-03T00:00:00Z", "action": "Auto Refresh", "change_info": "", "user": "Engine"},
    ],
}


def _dfm_sidecar() -> dict:
    method = dfm_contract.recalculate_dfm_method(
        dfm_tests.owned_payload(),
        input_snapshot=dfm_tests.input_snapshot(),
        ratio_basis_snapshot=dfm_tests.basis_snapshot(),
    )
    return dfm_contract.build_dfm_output_sidecar(
        method,
        project_name="Demo",
        reserving_class=r"Auto\PP",
        csv_file="Paid Selected@12.csv",
        existing=_PRIOR,
        user="tester",
        timestamp="2026-08-04T00:00:00Z",
    )


def _bf_sidecar() -> dict:
    return bornhuetter_ferguson_contract.build_bornhuetter_ferguson_output_sidecar(
        bf_tests.complete_method(),
        project_name="Demo",
        reserving_class=r"Auto\PP",
        csv_file="BF Ultimate@12.csv",
        existing=_PRIOR,
        user="tester",
        timestamp="2026-08-04T00:00:00Z",
    )


def _cc_sidecar() -> dict:
    return cape_cod_contract.build_cape_cod_output_sidecar(
        cc_tests.complete_method(),
        project_name="Demo",
        reserving_class=r"Auto\PP",
        csv_file="CC Ultimate@12.csv",
        existing=_PRIOR,
        user="tester",
        timestamp="2026-08-04T00:00:00Z",
    )


def _bootstrap_sidecar() -> dict:
    fixture = json.loads(bootstrap_tests.FIXTURE.read_text(encoding="utf-8"))
    case = fixture["methods"]["odp_single_scale"]
    reference = fixture["simulation_reference"]
    method = bootstrap_contract.recalculate_bootstrap_method(
        bootstrap_tests._seed_payload(case, reference),
        dfm_snapshot=bootstrap_tests._snapshot_from_fixture(case),
        target_snapshot=bootstrap_tests._target_snapshot(case, reference),
        timestamp="2026-08-05T00:00:00Z",
    )
    return bootstrap_contract.build_bootstrap_output_sidecar(
        method,
        project_name="Demo",
        reserving_class=r"Auto\PP",
        csv_file="F 72 A@12.csv",
        existing=_PRIOR,
        user="tester",
        timestamp="2026-08-05T00:00:00Z",
    )


def _engine_sidecar() -> dict:
    return build_engine_dataset_sidecar(
        project_name="Demo",
        reserving_class=r"Auto\PP",
        dataset_name="Paid Loss",
        dataset_type="Paid Loss",
        data_format="Triangle",
        csv_file="Paid Loss@12@12@cum@dev.csv",
        user="tester",
        created="2026-08-01T00:00:00Z",
        updated_at="2026-08-04T00:00:00Z",
        number_format="0,000",
        decimal_places=1,
        origin_length=12,
        development_length=12,
        audit_log=_PRIOR["audit_log"],
        audit_action="Update",
    )


PRODUCERS = {
    "dfm": _dfm_sidecar,
    "bornhuetter_ferguson": _bf_sidecar,
    "cape_cod": _cc_sidecar,
    "bootstrap": _bootstrap_sidecar,
    "engine": _engine_sidecar,
}


class CrossWriterSidecarCoreTests(unittest.TestCase):
    def test_every_producer_passes_the_shared_validator(self) -> None:
        for name, build in PRODUCERS.items():
            with self.subTest(producer=name):
                sidecar = build()
                self.assertEqual(validate_sidecar_core(sidecar), sidecar)
                self.assertEqual(list(sidecar)[-1], "audit_log")
                self.assertTrue(set(SIDECAR_CORE_FIELDS) <= set(sidecar))

    def test_method_outputs_add_only_the_method_fields_on_top(self) -> None:
        engine = _engine_sidecar()
        for name, build in PRODUCERS.items():
            if name == "engine":
                continue
            with self.subTest(producer=name):
                sidecar = build()
                for field in METHOD_OUTPUT_SIDECAR_FIELDS:
                    self.assertIn(field, sidecar)
                self.assertIs(sidecar["calculated"], True)
                self.assertEqual(sidecar["method_type"], sidecar["method_type"].strip())
        for field in METHOD_OUTPUT_SIDECAR_FIELDS:
            self.assertNotIn(field, engine)

    def test_every_producer_appends_under_the_one_audit_policy(self) -> None:
        # The prior log carries two consecutive automatic entries; each writer
        # keeps the history, collapses the run, and appends its own record.
        for name, build in PRODUCERS.items():
            with self.subTest(producer=name):
                log = build()["audit_log"]
                self.assertEqual([item["action"] for item in log], ["Insert", "Auto Refresh", "Update"])
                self.assertEqual(log[1]["event_date"], "2026-08-03T00:00:00Z")
                self.assertEqual(log[-1]["user"], "tester")

    def test_a_method_writer_without_an_audit_entry_still_normalizes_the_log(self) -> None:
        method = dfm_contract.recalculate_dfm_method(
            dfm_tests.owned_payload(),
            input_snapshot=dfm_tests.input_snapshot(),
            ratio_basis_snapshot=dfm_tests.basis_snapshot(),
        )
        sidecar = dfm_contract.build_dfm_output_sidecar(
            method,
            project_name="Demo",
            reserving_class=r"Auto\PP",
            csv_file="Paid Selected@12.csv",
            existing=_PRIOR,
            append_audit=False,
        )
        self.assertEqual([item["action"] for item in sidecar["audit_log"]], ["Insert", "Auto Refresh"])


class ValidatorTests(unittest.TestCase):
    def test_a_missing_core_field_is_named(self) -> None:
        sidecar = _engine_sidecar()
        sidecar.pop("csv_file")
        with self.assertRaises(SidecarContractError) as caught:
            validate_sidecar_core(sidecar)
        self.assertIn("csv_file", str(caught.exception))

    def test_the_audit_log_must_be_last(self) -> None:
        sidecar = _engine_sidecar()
        sidecar["extra"] = 1
        with self.assertRaises(SidecarContractError) as caught:
            validate_sidecar_core(sidecar)
        self.assertIn("last field", str(caught.exception))
        self.assertEqual(validate_sidecar_core(with_audit_log_last(sidecar)), with_audit_log_last(sidecar))

    def test_the_audit_log_must_already_follow_the_policy(self) -> None:
        sidecar = _engine_sidecar()
        sidecar["audit_log"] = [*sidecar["audit_log"], {"event_date": "", "action": "Update"}]
        with self.assertRaises(SidecarContractError):
            validate_sidecar_core(sidecar)

    def test_a_half_method_sidecar_is_refused(self) -> None:
        sidecar = dict(_engine_sidecar())
        sidecar = with_audit_log_last({**sidecar, "method_name": "M"})
        with self.assertRaises(SidecarContractError):
            validate_sidecar_core(sidecar)
        sidecar = with_audit_log_last({**sidecar, "publication_revision": "sha256:0000000000000000"})
        with self.assertRaises(SidecarContractError):
            validate_sidecar_core(sidecar)  # still not calculated
        sidecar = with_audit_log_last({**sidecar, "calculated": True})
        validate_sidecar_core(sidecar)

    def test_with_audit_log_last_moves_and_normalizes(self) -> None:
        payload = {"audit_log": [{"event_date": "d", "action": "insert", "user": "u"}], "a": 1}
        ordered = with_audit_log_last(payload)
        self.assertEqual(list(ordered), ["a", "audit_log"])
        self.assertEqual(ordered["audit_log"][0]["action"], "Insert")
        self.assertEqual(with_audit_log_last({"a": 1})["audit_log"], [])


if __name__ == "__main__":
    unittest.main()
