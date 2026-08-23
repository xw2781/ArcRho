from __future__ import annotations

import json
import os
import sys
import tempfile
import types
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch


_PYTHON_API = Path(__file__).resolve().parents[1]
_REPO_ROOT = _PYTHON_API.parent
sys.path.insert(0, str(_PYTHON_API / "src"))
sys.path.insert(0, str(_PYTHON_API / "migration"))
sys.path.insert(0, str(_REPO_ROOT / "frontend"))

from arcrho_api.dfm_contract import (  # noqa: E402
    DFM_JSON_FORMAT,
    build_dfm_output_sidecar,
    owned_projection,
    recalculate_dfm_method,
)
from arcrho_api.dfm import DfmMethod  # noqa: E402
from app_server.services import dfm_service as app_dfm_service  # noqa: E402
from resq_migration import dfm as migration_dfm  # noqa: E402
from resq_migration import extractors  # noqa: E402


_TMP_ROOT = Path(__file__).resolve().parent / "logs" / "tmp"


def _owned_payload() -> dict:
    return {
        "json_format": DFM_JSON_FORMAT,
        "details_tab": {
            "name": "Paid DFM",
            "output_type": "Paid Ultimate",
            "output_dataset": "Paid Selected",
            "output_category": "Loss",
            "input_triangle": "Paid Loss",
            "origin_length": 12,
            "development_length": 12,
            "decimal_places": 2,
        },
        "ratios_tab": {
            "ratio_triangle": {"excluded": [[1, 0], [0], []]},
            "average_formulas": {
                "label": ["Simple - all", "User Entry"],
                "custom_average_formula_settings": {
                    "average_type": ["custom", "user_entry"],
                    "base": ["simple", "simple"],
                    "periods": ["all", "all"],
                    "exclude": [0, 0],
                },
                "selected": [[1, 1, 1], [0, 0, 0]],
                "values": [[1, 1, 1], [1.2, 1.3, 1]],
                "inputs": [["", "", ""], ["=1.2", "='[Book.xlsx]S'!A1", ""]],
                "display_inputs": [["", "", ""], ["=[Premium][2025 Q4]", "", ""]],
            },
            "cell_notes": {
                "ratio_main_table": {"2020": {"(1) 12-24": "keep"}},
                "ratio_summary_table": {},
            },
        },
        "results_tab": {"ratio_basis_dataset": "Premium", "ultimate_ratio_decimal_places": 2},
        "method_metadata": {"last_modified": "owned", "data_refreshed": "old"},
    }


def _input(values=None) -> dict:
    values = values or [[100, 150, 180], [200, 300, None], [400, None, None]]
    return {
        "name": "Paid Loss",
        "origin_labels": ["2020", "2021", "2022"],
        "development_labels": ["12m", "24m", "36m"],
        "values": values,
        "mask": [[value is not None for value in row] for row in values],
        "data_format": "Triangle",
        "number_format": "#,##0",
        "decimal_places": 0,
    }


def _basis() -> dict:
    return {
        "name": "Premium",
        "origin_labels": ["2020", "2021", "2022"],
        "values": [1000, 2000, 3000],
        "data_format": "Vector",
        "number_format": "$#,##0",
        "decimal_places": 0,
    }


class ResqDfmV2Tests(unittest.TestCase):
    def setUp(self) -> None:
        _TMP_ROOT.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=str(_TMP_ROOT))
        self.rc_dir = Path(self.tmp.name)
        (self.rc_dir / "datasets").mkdir()
        (self.rc_dir / "sidecars").mkdir()
        (self.rc_dir / "methods").mkdir()
        extractors.configure_extractors(
            project_name="Demo",
            rs_json_format="arcrho-result-selection-v4",
            method_data_dir="methods",
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_migration_owned_rebase_preserves_all_owned_settings(self) -> None:
        local = recalculate_dfm_method(
            _owned_payload(), input_snapshot=_input(), ratio_basis_snapshot=_basis(), timestamp="old"
        )
        remote = recalculate_dfm_method(
            _owned_payload(),
            input_snapshot=_input([[100, 200, 260], [200, 400, None], [400, None, None]]),
            ratio_basis_snapshot=_basis(),
            timestamp="new",
        )
        rebased, preserved = migration_dfm._preserve_local_dfm_data(remote, local)

        self.assertEqual(owned_projection(rebased), owned_projection(local))
        self.assertIn("exclusions", preserved)
        self.assertEqual(
            rebased["ratios_tab"]["average_formulas"]["values"][1][1],
            local["ratios_tab"]["average_formulas"]["values"][1][1],
        )
        self.assertEqual(
            rebased["ratios_tab"]["average_formulas"]["display_inputs"],
            local["ratios_tab"]["average_formulas"]["display_inputs"],
        )
        self.assertNotEqual(
            rebased["data_tab"]["input_data_triangle_values"],
            local["data_tab"]["input_data_triangle_values"],
        )
        self.assertEqual(
            rebased["method_metadata"]["last_modified"],
            local["method_metadata"]["last_modified"],
        )

    def _publish_dfm_authority_fixture(
        self,
        *,
        preserve_local_owned_state: bool | None,
    ) -> tuple[dict, object]:
        remote = recalculate_dfm_method(
            _owned_payload(),
            input_snapshot=_input(),
            ratio_basis_snapshot=_basis(),
            timestamp="resq-modified",
        )
        remote["method_metadata"]["last_modified"] = "resq-modified"
        remote["method_metadata"]["data_refreshed"] = "resq-modified"
        local = deepcopy(remote)
        local["method_metadata"]["last_modified"] = "arcrho-modified"
        captured: list[dict] = []

        def capture_publication(_ultimate, method_payload, _rc_path, rc_dir):
            captured.append(deepcopy(method_payload))
            sidecar_path = rc_dir / "sidecars" / "Paid Selected.json"
            return (
                rc_dir / "datasets" / "Paid Selected@12.csv",
                {sidecar_path: b"{}"},
                sidecar_path,
            )

        dfm = types.SimpleNamespace(
            Name="Paid DFM",
            OutputVector=types.SimpleNamespace(
                Name="Paid Selected",
                DatasetType=types.SimpleNamespace(Name="Paid Ultimate"),
            ),
        )
        kwargs = {}
        if preserve_local_owned_state is not None:
            kwargs["preserve_local_owned_state"] = preserve_local_owned_state
        with (
            patch.object(migration_dfm, "export_dfm", return_value=deepcopy(remote)),
            patch.object(migration_dfm, "_safe_read_json", return_value=local),
            patch.object(
                migration_dfm,
                "export_dfm_ultimate_vector",
                return_value={"name": "Paid Selected", "dataset_type": "Paid Ultimate"},
            ),
            patch.object(migration_dfm, "_is_known_dataset_type", return_value=True),
            patch.object(
                migration_dfm,
                "build_dfm_ultimate_publication",
                side_effect=capture_publication,
            ),
            patch.object(migration_dfm, "publish_dfm_artifacts"),
            patch.object(
                migration_dfm,
                "_preserve_local_dfm_data",
                wraps=migration_dfm._preserve_local_dfm_data,
            ) as preserve,
        ):
            migration_dfm.export_dfm_output_dataset(
                dfm,
                r"Auto\PP",
                self.rc_dir,
                project_name="Demo",
                project_data_dir=self.rc_dir,
                method_data_dir="methods",
                debug_log=lambda *_args, **_kwargs: None,
                log=lambda *_args, **_kwargs: None,
                **kwargs,
            )
        self.assertEqual(len(captured), 1)
        return captured[0], preserve

    def test_dfm_publication_preserves_local_owned_state_by_default(self) -> None:
        published, preserve = self._publish_dfm_authority_fixture(
            preserve_local_owned_state=None,
        )

        preserve.assert_called_once()
        self.assertEqual(
            published["method_metadata"]["last_modified"],
            "arcrho-modified",
        )

    def test_dfm_publication_can_keep_resq_authoritative_timestamp(self) -> None:
        published, preserve = self._publish_dfm_authority_fixture(
            preserve_local_owned_state=False,
        )

        preserve.assert_not_called()
        self.assertEqual(
            published["method_metadata"]["last_modified"],
            "resq-modified",
        )
        self.assertEqual(
            published["method_metadata"]["data_refreshed"],
            "resq-modified",
        )

    def test_dfm_ratio_basis_reads_values_by_index_at_dfm_shape(self) -> None:
        class _Basis:
            Name = "Basis DFM"
            Modified = "producer timestamp"
            DatasetType = types.SimpleNamespace(Name="Premium")

            def __init__(self):
                self.requested_indices = []

            def ValuesByIndex(self, index):
                self.requested_indices.append(index)
                return [10, 20][index - 1]

        basis = _Basis()
        dfm = types.SimpleNamespace(SummaryRatioBasis=basis, OriginCount=2)
        snapshot = migration_dfm._ratio_basis_snapshot(
            dfm,
            "Basis DFM",
            ["2020", "2021"],
            r"Auto\PP",
        )
        self.assertEqual(basis.requested_indices, [1, 2])
        self.assertEqual(snapshot["values"], [10, 20])
        self.assertEqual(snapshot["origin_labels"], ["2020", "2021"])
        self.assertEqual(snapshot["revision"], "producer timestamp")

    def test_dfm_output_status_comes_from_output_vector(self) -> None:
        output_vector = types.SimpleNamespace(
            Name="Paid Selected",
            DatasetType=types.SimpleNamespace(
                Name="Paid Ultimate",
                DataFormat=1,
                Category=types.SimpleNamespace(Name="Loss"),
            ),
            MethodType=1,
            Status=2,
            User="tester",
            Created="2026-01-01T00:00:00",
            Modified="2026-01-02T00:00:00",
        )

        class Dfm:
            Name = "Paid DFM"
            Notes = ""
            OutputVector = output_vector

            def Ultimates(self, index):
                return [100, 200][index - 1]

        payload = extractors.export_dfm_ultimate_vector(
            Dfm(), ["2025", "2026"], 12, 12
        )

        self.assertEqual(payload["status"], 2)

    def test_migrated_benchmark_setting_stays_frozen(self) -> None:
        self.assertEqual(migration_dfm._infer_avg_settings("Benchmark")["base"], "benchmark")
        payload = _owned_payload()
        formulas = payload["ratios_tab"]["average_formulas"]
        formulas["label"].insert(1, "Benchmark")
        settings = formulas["custom_average_formula_settings"]
        settings["average_type"].insert(1, "custom")
        settings["base"].insert(1, "benchmark")
        settings["periods"].insert(1, "all")
        settings["exclude"].insert(1, 0)
        formulas["selected"].insert(1, [0, 0, 0])
        formulas["values"].insert(1, [1.8, 1.7, 1.0])
        formulas["inputs"].insert(1, ["", "", ""])
        method = recalculate_dfm_method(
            payload, input_snapshot=_input(), ratio_basis_snapshot=_basis()
        )
        row = method["ratios_tab"]["average_formulas"]["label"].index("Benchmark")
        self.assertEqual(method["ratios_tab"]["average_formulas"]["values"][row], [1.8, 1.7, 1.0])

    def test_migration_sidecar_exactly_matches_canonical_projection(self) -> None:
        owned = _owned_payload()
        owned["ratios_tab"]["average_formulas"]["inputs"][1][0] = \
            '=[Accounting Cutoff][-1]'
        method = recalculate_dfm_method(
            owned, input_snapshot=_input(), ratio_basis_snapshot=_basis(), timestamp="method-time"
        )
        existing = {
            "notes": "Method Notes",
            "audit_log": [{"event_date": "old", "action": "Insert", "change_info": "", "user": "a"}],
            "dependents": [{"dataset_name": "RS Ultimate"}],
            "created": "old",
            "number_format": "$#,##0",
            "publication_revision": "old-revision",
        }
        sidecar_path = self.rc_dir / "sidecars" / "Paid Selected.json"
        sidecar_path.write_text(json.dumps(existing), encoding="utf-8")
        ultimate = {
            "name": "Paid Selected",
            "origin_length": 12,
            "modified": "published",
            "user": "tester",
            "notes": "ResQ note must not replace Method Notes",
        }
        _primary, files, actual_path = extractors.build_dfm_ultimate_publication(
            ultimate, method, r"Auto\PP", self.rc_dir
        )
        actual = json.loads(files[actual_path].decode("utf-8"))
        expected = build_dfm_output_sidecar(
            method,
            project_name="Demo",
            reserving_class=r"Auto\PP",
            csv_file="Paid Selected@12.csv",
            existing=existing,
            notes=None,
            timestamp="published",
            user="tester",
            output_changed=True,
            append_audit=True,
        )
        self.assertEqual(actual, expected)
        self.assertEqual(
            actual["precedents"],
            [
                {"dataset_name": "Paid Loss"},
                {"dataset_name": "Premium"},
                {"dataset_name": "Accounting Cutoff"},
            ],
        )

    def test_full_method_payload_parity_across_app_public_and_migration_adapters(self) -> None:
        class _Project:
            name = "Demo"
            read_only = False

            def __init__(self, root: Path) -> None:
                self.root = root

            def reserving_class_data_dir(self, _path: str) -> Path:
                return self.root

            def dfm_path(self, _path: str, _name: str) -> Path:
                return self.root / "methods" / "DFM@Paid DFM.json"

        project = _Project(self.rc_dir)
        rc = types.SimpleNamespace(project=project, path=r"Auto\PP")
        base_payload = _owned_payload()
        base_payload["results_tab"]["ratio_basis_dataset"] = ""
        app_input = {**_input(), "revision": "app timestamp", "csv_path": r"Z:\alias\paid.csv"}
        public_input = {**_input(), "revision": "public timestamp", "csv_path": r"Y:\alias\paid.csv"}
        migration_input = {**_input(), "revision": "resq timestamp", "csv_path": r"X:\alias\paid.csv"}
        app_basis = {**_basis(), "revision": "app basis", "csv_path": r"Z:\alias\premium.csv"}
        public_basis = {**_basis(), "revision": "public basis", "csv_path": r"Y:\alias\premium.csv"}
        migration_basis = {**_basis(), "revision": "resq basis", "csv_path": r"X:\alias\premium.csv"}

        with patch("arcrho_api.dfm_contract._timestamp", return_value="same"):
            app_payload = app_dfm_service._contract_call(
                app_dfm_service.recalculate_dfm_method,
                deepcopy(base_payload),
                input_snapshot=app_input,
                ratio_basis_snapshot=app_basis,
                timestamp="same",
            )
            public = DfmMethod(
                rc,
                "Paid DFM",
                deepcopy(base_payload),
                project.dfm_path(rc.path, "Paid DFM"),
            )
            public.set_input_snapshot(public_input)
            public.set_ratio_basis_snapshot(public_basis)
            public_payload = public.to_dict()
            migration_payload = migration_dfm.recalculate_dfm_method(
                deepcopy(base_payload),
                input_snapshot=migration_input,
                ratio_basis_snapshot=migration_basis,
                timestamp="same",
            )

        self.assertEqual(app_payload, public_payload)
        self.assertEqual(public_payload, migration_payload)
        self.assertNotIn("csv_path", json.dumps(public_payload))

    def test_transaction_rolls_back_and_never_replaces_sidecar_before_method(self) -> None:
        method_path = self.rc_dir / "methods" / "DFM@Paid DFM.json"
        csv_path = self.rc_dir / "datasets" / "Paid Selected@12.csv"
        sidecar_path = self.rc_dir / "sidecars" / "Paid Selected.json"
        method_path.write_bytes(b"old method")
        csv_path.write_bytes(b"old csv")
        sidecar_path.write_bytes(b"old sidecar")
        files = {method_path: b"new method", csv_path: b"new csv", sidecar_path: b"new sidecar"}
        real_replace = os.replace
        replaced_targets: list[Path] = []

        def record_replace(source, target):
            replaced_targets.append(Path(target))
            return real_replace(source, target)

        with patch("resq_migration.extractors.os.replace", side_effect=record_replace):
            extractors.publish_dfm_artifacts(files, sidecar_path=sidecar_path)
        self.assertEqual(replaced_targets[-1], sidecar_path)

        failed = False

        def fail_sidecar_once(source, target):
            nonlocal failed
            if Path(target) == sidecar_path and not failed:
                failed = True
                raise OSError("sidecar failed")
            return real_replace(source, target)

        rollback_files = {method_path: b"third method", csv_path: b"third csv", sidecar_path: b"third sidecar"}
        with patch("resq_migration.extractors.os.replace", side_effect=fail_sidecar_once):
            with self.assertRaisesRegex(RuntimeError, "Failed to publish"):
                extractors.publish_dfm_artifacts(rollback_files, sidecar_path=sidecar_path)
        self.assertEqual(method_path.read_bytes(), b"new method")
        self.assertEqual(csv_path.read_bytes(), b"new csv")
        self.assertEqual(sidecar_path.read_bytes(), b"new sidecar")


if __name__ == "__main__":
    unittest.main()
