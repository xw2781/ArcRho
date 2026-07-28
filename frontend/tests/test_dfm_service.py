from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi import HTTPException


REPO_ROOT = Path(__file__).resolve().parents[2]
FRONTEND_ROOT = REPO_ROOT / "frontend"
PYTHON_API_SRC = REPO_ROOT / "python-api" / "src"
for path in (FRONTEND_ROOT, PYTHON_API_SRC):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from arcrho_api.dfm_contract import dfm_output_variants, method_revisions, recalculate_dfm_method
from app_server.services import calculated_dataset_service, dataset_sidecar_status_service, dfm_service


class DfmServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(dir=REPO_ROOT)
        root = Path(self.temp.name)
        self.methods = root / "methods"
        self.datasets = root / "datasets"
        self.sidecars = root / "sidecars"
        for folder in (self.methods, self.datasets, self.sidecars):
            folder.mkdir()
        self.patchers = [
            mock.patch.object(dfm_service.config, "get_project_method_data_dir", return_value=str(self.methods)),
            mock.patch.object(dfm_service.config, "get_project_dataset_cache_dir", return_value=str(self.datasets)),
            mock.patch.object(
                dataset_sidecar_status_service,
                "sidecar_path",
                side_effect=lambda _p, _r, name: str(self.sidecars / f"{name}.json"),
            ),
        ]
        for patcher in self.patchers:
            patcher.start()

    def tearDown(self) -> None:
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.temp.cleanup()

    @staticmethod
    def method_payload() -> dict:
        return recalculate_dfm_method(
            {
                "details tab": {
                    "name": "Development",
                    "output type": "Selected Ultimate",
                    "output dataset": "Development Output",
                    "input triangle": "Paid",
                    "origin length": 12,
                    "development length": 12,
                },
                "ratios tab": {
                    "average formulas": {
                        "label": ["User Entry"],
                        "custom average formula settings": {"averageType": ["user_entry"]},
                        "selected": [[1, 1]],
                        "values": [[1.5, 1]],
                        "inputs": [["1.5", "1"]],
                    },
                    "cell notes": {"ratio main table": {"2024": {"(1) 12-24": "keep"}}},
                },
                "results tab": {"ratio basis dataset": "Premium"},
            },
            input_snapshot={
                "name": "Paid",
                "data_format": "Triangle",
                "origin_labels": ["2024", "2025"],
                "development_labels": ["12", "24"],
                "values": [[100, 150], [200, None]],
                "mask": [[True, True], [True, False]],
                "number_format": "#,##0",
                "decimal_places": 0,
                "revision": "paid-r1",
            },
            ratio_basis_snapshot={
                "name": "Premium",
                "data_format": "Vector",
                "origin_labels": ["2024", "2025"],
                "values": [1000, 1100],
                "number_format": "#,##0",
                "decimal_places": 0,
                "revision": "premium-r1",
            },
            timestamp="2026-01-01T00:00:00Z",
        )

    def write_json(self, path: Path, payload: dict) -> None:
        path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    def output_sidecar(self, method: dict, *, status: int = 0) -> dict:
        revisions = method_revisions(method)
        return {
            "dataset_name": "Development Output",
            "dataset_type": "Selected Ultimate",
            "project_name": "Project",
            "reserving_class": "Class",
            "source_kind": "dfm",
            "method_type": "DFM",
            "method_name": "Development",
            "data_format": "Vector",
            "period_length": 12,
            "csv_file": "Development Output@12.csv",
            "origin_labels": ["2024", "2025"],
            "Precedents": [{"dataset_type_name": "Paid"}, {"dataset_type_name": "Premium"}],
            "Dependents": [],
            "status": status,
            "notes": "method note",
            "audit_log": [],
            "publication_revision": revisions["publication revision"],
            "updated_at": "2026-01-01T00:00:00Z",
        }

    def write_method_pair(self, method: dict | None = None, *, status: int = 0) -> dict:
        payload = method or self.method_payload()
        self.write_json(self.methods / "DFM@Development.json", payload)
        self.write_json(self.sidecars / "Development Output.json", self.output_sidecar(payload, status=status))
        (self.datasets / "Development Output@12.csv").write_text("150\n300\n", encoding="utf-8")
        return payload

    def write_source(
        self,
        name: str,
        csv_text: str,
        *,
        data_format: str,
        dependents: list[str] | None = None,
        method_type: str = "None",
        status: int = 0,
    ) -> None:
        csv_file = f"{name}@12.csv"
        (self.datasets / csv_file).write_text(csv_text, encoding="utf-8")
        self.write_json(self.sidecars / f"{name}.json", {
            "dataset_name": name,
            "dataset_type": name,
            "project_name": "Project",
            "reserving_class": "Class",
            "source_kind": "dfm" if method_type == "DFM" else "input",
            "method_type": method_type,
            "data_format": data_format,
            "origin_length": 12,
            "development_length": 12,
            "period_length": 12 if data_format == "Vector" else None,
            "origin_labels": ["2024", "2025"],
            "csv_file": csv_file,
            "number_format": "#,##0",
            "decimal_places": 0,
            "status": status,
            "Precedents": [],
            "Dependents": [
                {"dataset_type_name": item} for item in (dependents or [])
            ],
        })

    def test_v2_load_reads_only_method_and_own_sidecar(self) -> None:
        self.write_method_pair()
        original = dfm_service._read_json
        reads: list[str] = []

        def recording(path: str) -> dict:
            reads.append(str(Path(path)))
            return original(path)

        with mock.patch.object(dfm_service, "_read_json", side_effect=recording):
            result = dfm_service.load_dfm_method(
                "Project",
                "Class",
                "Development",
                output_dataset="Development Output",
            )

        self.assertTrue(result["ok"])
        self.assertCountEqual(reads, [
            str(self.methods / "DFM@Development.json"),
            str(self.sidecars / "Development Output.json"),
        ])

    def test_legacy_upgrade_preserves_distinct_supplied_output_identity(self) -> None:
        legacy = self.method_payload()
        legacy["json format"] = "arcrho-dfm-method-by-tab-v1"
        legacy["details tab"].pop("output dataset", None)
        for key in (
            "input data triangle values",
            "input data triangle mask",
            "source revision",
        ):
            legacy["data tab"].pop(key, None)
        for key in (
            "ratio basis origin labels",
            "ratio basis values",
            "ratio basis source revision",
            "ultimate vector",
        ):
            legacy["results tab"].pop(key, None)
        self.write_json(self.methods / "DFM@Development.json", legacy)
        sidecar = self.output_sidecar(self.method_payload(), status=2)
        sidecar.pop("publication_revision", None)
        self.write_json(self.sidecars / "Development Output.json", sidecar)
        self.write_source("Paid", "100,150\n200,\n", data_format="Triangle")
        self.write_source("Premium", "1000\n1100\n", data_format="Vector")

        result = dfm_service.load_dfm_method(
            "Project",
            "Class",
            "Development",
            output_dataset="Development Output",
        )

        self.assertTrue(result["upgraded"])
        self.assertEqual(result["method"]["details tab"]["output dataset"], "Development Output")
        self.assertFalse((self.sidecars / "Development.json").exists())
        saved_sidecar = json.loads((self.sidecars / "Development Output.json").read_text(encoding="utf-8"))
        self.assertEqual(saved_sidecar["method_name"], "Development")
        self.assertEqual(
            saved_sidecar["publication_revision"],
            method_revisions(result["method"])["publication revision"],
        )

    def test_legacy_upgrade_without_declared_or_supplied_output_is_rejected_without_mutation(self) -> None:
        legacy = self.method_payload()
        legacy["json format"] = "arcrho-dfm-method-by-tab-v1"
        legacy["details tab"].pop("output dataset", None)
        method_path = self.methods / "DFM@Development.json"
        self.write_json(method_path, legacy)
        before = method_path.read_bytes()

        with self.assertRaises(HTTPException) as raised:
            dfm_service.load_dfm_method("Project", "Class", "Development")

        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(method_path.read_bytes(), before)

    def test_existing_save_rebases_owned_patch_without_precedent_reads(self) -> None:
        method = self.write_method_pair(status=2)
        method["ratios tab"]["cell notes"]["ratio main table"]["2024"]["(1) 12-24"] = "updated"
        owned_revision = method_revisions(self.method_payload())["owned revision"]
        with (
            mock.patch.object(dfm_service, "_load_source_snapshot", side_effect=AssertionError("source read")),
            mock.patch(
                "app_server.services.calculated_dataset_service.recalculate_dependents",
                return_value={"ok": True, "updated": []},
            ) as cascade,
        ):
            result = dfm_service.save_dfm_method(
                "Project",
                "Class",
                method,
                expected_owned_revision=owned_revision,
            )

        self.assertTrue(result["ok"])
        cascade.assert_called_once_with(
            "Project",
            "Class",
            "Development Output",
            "Selected Ultimate",
            include_dfm=True,
            rebuild_index=True,
        )
        self.assertTrue(result["propagation_ok"])
        saved = json.loads((self.methods / "DFM@Development.json").read_text(encoding="utf-8"))
        self.assertEqual(
            saved["ratios tab"]["cell notes"]["ratio main table"]["2024"]["(1) 12-24"],
            "updated",
        )

    def test_explicit_save_warns_and_still_saves_with_unreviewed_precedent(self) -> None:
        method = self.write_method_pair(status=2)
        self.write_source(
            "Paid",
            "100,150\n200,\n",
            data_format="Triangle",
            method_type="DFM",
            status=2,
        )
        self.write_source("Premium", "1000\n1100\n", data_format="Vector")

        with mock.patch(
            "app_server.services.calculated_dataset_service.recalculate_dependents",
            return_value={"ok": True, "updated": []},
        ):
            result = dfm_service.save_dfm_method(
                "Project",
                "Class",
                method,
                expected_owned_revision=method_revisions(method)["owned revision"],
            )

        self.assertTrue(result["ok"])
        self.assertEqual(result["sidecar"]["status"], 0)
        self.assertEqual(result["unreviewed_precedents"], ["Paid"])
        self.assertEqual(result["unreviewed_precedent_count"], 1)

    def test_existing_save_rejects_owned_revision_conflict_without_mutation(self) -> None:
        method = self.write_method_pair()
        method_path = self.methods / "DFM@Development.json"
        sidecar_path = self.sidecars / "Development Output.json"
        output_path = self.datasets / "Development Output@12.csv"
        before = {
            path: path.read_bytes()
            for path in (method_path, sidecar_path, output_path)
        }
        method["ratios tab"]["cell notes"]["ratio main table"]["2024"]["(1) 12-24"] = "conflict"

        with self.assertRaises(HTTPException) as raised:
            dfm_service.save_dfm_method(
                "Project",
                "Class",
                method,
                expected_owned_revision="stale-owned-revision",
            )

        self.assertEqual(raised.exception.status_code, 409)
        self.assertIn("owned settings changed", str(raised.exception.detail))
        for path, contents in before.items():
            self.assertEqual(path.read_bytes(), contents)

    def test_triangle_ratio_basis_uses_latest_available_value_per_origin(self) -> None:
        self.write_source("Premium", "100,150\n200,\n", data_format="Triangle")

        snapshot = dfm_service._load_source_snapshot(
            "Project", "Class", "Premium", vector=True
        )

        self.assertEqual(snapshot["data_format"], "Triangle")
        self.assertEqual(snapshot["origin_labels"], ["2024", "2025"])
        self.assertEqual(snapshot["values"], [150, 200])

    def test_input_refresh_uses_saved_method_axes_when_sidecar_labels_are_absent(self) -> None:
        method = self.write_method_pair()
        self.write_source(
            "Paid",
            "100,175\n200,\n",
            data_format="Triangle",
            dependents=["Development Output"],
        )
        source_path = self.sidecars / "Paid.json"
        source = json.loads(source_path.read_text(encoding="utf-8"))
        source.pop("origin_labels")
        self.write_json(source_path, source)

        result = dfm_service.refresh_dependents("Project", "Class", ["Paid"])

        self.assertTrue(result["ok"], result)
        saved = json.loads((self.methods / "DFM@Development.json").read_text(encoding="utf-8"))
        self.assertEqual(saved["data tab"]["origin labels"], method["data tab"]["origin labels"])
        self.assertEqual(
            saved["data tab"]["development labels"],
            method["data tab"]["development labels"],
        )
        self.assertEqual(saved["data tab"]["input data triangle values"], [[100, 175], [200, None]])

    def test_basis_refresh_ignores_numeric_sidecar_labels_and_review_status(self) -> None:
        method = self.write_method_pair()
        self.write_source(
            "Premium",
            "2000\n2200\n",
            data_format="Vector",
            dependents=["Development Output"],
            method_type="DFM",
            status=2,
        )
        source_path = self.sidecars / "Premium.json"
        source = json.loads(source_path.read_text(encoding="utf-8"))
        source["origin_labels"] = ["1", "2"]
        self.write_json(source_path, source)

        result = dfm_service.refresh_dependents("Project", "Class", ["Premium"])

        self.assertTrue(result["ok"], result)
        saved = json.loads((self.methods / "DFM@Development.json").read_text(encoding="utf-8"))
        self.assertEqual(
            saved["results tab"]["ratio basis origin labels"],
            method["data tab"]["origin labels"],
        )
        self.assertEqual(saved["results tab"]["ratio basis values"], [2000, 2200])

    def test_snapshot_cache_is_scoped_by_saved_method_axes(self) -> None:
        method = self.method_payload()
        self.write_source("Paid", "100,150\n200,\n", data_format="Triangle")
        source_path = self.sidecars / "Paid.json"
        source = json.loads(source_path.read_text(encoding="utf-8"))
        source.pop("origin_labels")
        self.write_json(source_path, source)
        snapshot_cache = {}

        first, _ = dfm_service._source_snapshots(
            "Project",
            "Class",
            method,
            load_input=True,
            load_basis=False,
            snapshot_cache=snapshot_cache,
        )
        second_method = json.loads(json.dumps(method))
        second_method["data tab"]["origin labels"] = ["2022", "2023"]
        second, _ = dfm_service._source_snapshots(
            "Project",
            "Class",
            second_method,
            load_input=True,
            load_basis=False,
            snapshot_cache=snapshot_cache,
        )

        self.assertEqual(first["origin_labels"], ["2024", "2025"])
        self.assertEqual(second["origin_labels"], ["2022", "2023"])
        self.assertEqual(len(snapshot_cache), 2)

    def test_missing_sidecar_labels_do_not_hide_row_or_period_mismatches(self) -> None:
        self.write_method_pair()
        method_path = self.methods / "DFM@Development.json"
        output_path = self.datasets / "Development Output@12.csv"
        before_method = method_path.read_bytes()
        before_output = output_path.read_bytes()
        self.write_source(
            "Paid",
            "100,150\n200,\n300,\n",
            data_format="Triangle",
            dependents=["Development Output"],
        )
        source_path = self.sidecars / "Paid.json"
        source = json.loads(source_path.read_text(encoding="utf-8"))
        source.pop("origin_labels")
        self.write_json(source_path, source)

        row_result = dfm_service.refresh_dependents("Project", "Class", ["Paid"])

        self.assertFalse(row_result["ok"])
        self.assertIn("has 3 rows; expected 2", row_result["errors"][0]["reason"])
        self.assertEqual(method_path.read_bytes(), before_method)
        self.assertEqual(output_path.read_bytes(), before_output)

        (self.datasets / "Paid@12.csv").write_text("100,150\n200,\n", encoding="utf-8")
        source["origin_length"] = 3
        self.write_json(source_path, source)

        period_result = dfm_service.refresh_dependents("Project", "Class", ["Paid"])

        self.assertFalse(period_result["ok"])
        self.assertIn("incompatible origin period length", period_result["errors"][0]["reason"])
        self.assertEqual(method_path.read_bytes(), before_method)
        self.assertEqual(output_path.read_bytes(), before_output)

    def test_output_csv_variants_are_projected_by_the_canonical_contract(self) -> None:
        method = self.write_method_pair()
        method["details tab"]["origin length"] = 3
        method["data tab"]["origin labels"] = ["2024 Q1", "2024 Q2", "2024 Q3", "2024 Q4"]
        method["results tab"]["ultimate vector"] = [10, 20, 30, 40]

        files = dfm_service._output_files("Project", "Class", method)
        actual = {
            int(Path(path).stem.rsplit("@", 1)[1]): [
                float(value) for value in text.splitlines() if value
            ]
            for path, text in files.items()
        }
        expected = {
            period: [float(value) for value in values if value is not None]
            for period, values in dfm_output_variants(method).items()
        }

        self.assertEqual(actual, expected)

    def test_precedent_sidecar_label_change_does_not_replace_saved_method_axis(self) -> None:
        method = self.write_method_pair()
        self.write_source(
            "Paid",
            "100,150\n200,\n",
            data_format="Triangle",
            dependents=["Development Output"],
        )
        self.write_source("Premium", "1000\n1100\n", data_format="Vector")
        for name in ("Paid", "Premium"):
            path = self.sidecars / f"{name}.json"
            sidecar = json.loads(path.read_text(encoding="utf-8"))
            sidecar["origin_labels"] = ["2023", "2025"]
            self.write_json(path, sidecar)

        result = dfm_service.refresh_dependents("Project", "Class", ["Paid"])

        self.assertTrue(result["ok"], result)
        self.assertEqual(
            result["updated"],
            [{
                "dataset_name": "Development Output",
                "dataset_type": "Selected Ultimate",
                "output_changed": False,
            }],
        )
        saved = json.loads((self.methods / "DFM@Development.json").read_text(encoding="utf-8"))
        self.assertEqual(saved["results tab"]["ultimate vector"], method["results tab"]["ultimate vector"])
        self.assertEqual(saved["data tab"]["origin labels"], method["data tab"]["origin labels"])
        sidecar = json.loads((self.sidecars / "Development Output.json").read_text(encoding="utf-8"))
        self.assertEqual(sidecar["audit_log"], [])

    def test_basis_only_refresh_updates_method_without_rewriting_ultimate_csv(self) -> None:
        method = self.write_method_pair(status=0)
        sidecar_path = self.sidecars / "Development Output.json"
        sidecar = json.loads(sidecar_path.read_text(encoding="utf-8"))
        sidecar["Dependents"] = [{"dataset_type_name": "Unrelated Downstream DFM"}]
        self.write_json(sidecar_path, sidecar)
        self.write_source("Paid", "100,150\n200,\n", data_format="Triangle")
        self.write_source(
            "Premium",
            "2000\n2200\n",
            data_format="Vector",
            dependents=["Development Output"],
        )
        output_path = self.datasets / "Development Output@12.csv"
        before_output = output_path.read_bytes()

        result = dfm_service.refresh_dependents("Project", "Class", ["Premium"])

        self.assertTrue(result["ok"], result)
        self.assertEqual(output_path.read_bytes(), before_output)
        saved = json.loads((self.methods / "DFM@Development.json").read_text(encoding="utf-8"))
        self.assertEqual(saved["results tab"]["ratio basis values"], [2000, 2200])
        self.assertEqual(saved["results tab"]["ultimate vector"], method["results tab"]["ultimate vector"])
        self.assertEqual(
            saved["ratios tab"]["cell notes"]["ratio main table"]["2024"]["(1) 12-24"],
            "keep",
        )
        sidecar = json.loads((self.sidecars / "Development Output.json").read_text(encoding="utf-8"))
        self.assertEqual(sidecar["status"], 2)
        self.assertEqual(
            result["review_status_updates"],
            [{"dataset_name": "Development Output", "status": 2}],
        )
        self.assertEqual(result["errors"], [])
        self.assertEqual(
            result["updated"],
            [{
                "dataset_name": "Development Output",
                "dataset_type": "Selected Ultimate",
                "output_changed": False,
            }],
        )

    def test_input_refresh_with_unchanged_origins_does_not_read_ratio_basis(self) -> None:
        self.write_method_pair()
        self.write_source(
            "Paid",
            "100,175\n200,\n",
            data_format="Triangle",
            dependents=["Development Output"],
        )

        original_load = dfm_service._load_source_snapshot
        source_reads: list[tuple[str, bool]] = []

        def record_source(*args, **kwargs):
            source_reads.append((str(args[2]), bool(kwargs.get("vector"))))
            return original_load(*args, **kwargs)

        with mock.patch.object(dfm_service, "_load_source_snapshot", side_effect=record_source):
            result = dfm_service.refresh_dependents("Project", "Class", ["Paid"])

        self.assertTrue(result["ok"], result)
        self.assertEqual(source_reads, [("Paid", False)])
        self.assertFalse((self.sidecars / "Premium.json").exists())

    def test_explicit_refresh_keeps_review_alert_until_save(self) -> None:
        self.write_method_pair(status=2)
        self.write_source("Paid", "100,150\n200,\n", data_format="Triangle")
        self.write_source("Premium", "1000\n1100\n", data_format="Vector")
        with mock.patch(
            "app_server.services.calculated_dataset_service.recalculate_dependents",
            return_value={"ok": True, "updated": []},
        ) as cascade:
            result = dfm_service.refresh_dfm_method(
                "Project",
                "Class",
                "Development",
                output_dataset="Development Output",
            )

        self.assertFalse(result["output_changed"])
        self.assertFalse(result["status_refreshed"])
        cascade.assert_not_called()
        sidecar = json.loads(
            (self.sidecars / "Development Output.json").read_text(encoding="utf-8")
        )
        self.assertEqual(
            sidecar["status"],
            dataset_sidecar_status_service.STATUS_REVIEW_NEEDED,
        )

    def test_incompatible_input_refresh_preserves_last_valid_artifacts_and_marks_review(self) -> None:
        self.write_method_pair()
        self.write_source(
            "Paid",
            "100,150,175\n200,,\n",
            data_format="Triangle",
            dependents=["Development Output"],
        )
        method_path = self.methods / "DFM@Development.json"
        output_path = self.datasets / "Development Output@12.csv"
        before_method = method_path.read_bytes()
        before_output = output_path.read_bytes()

        result = dfm_service.refresh_dependents("Project", "Class", ["Paid"])

        self.assertFalse(result["ok"])
        self.assertEqual(method_path.read_bytes(), before_method)
        self.assertEqual(output_path.read_bytes(), before_output)
        sidecar = json.loads((self.sidecars / "Development Output.json").read_text(encoding="utf-8"))
        self.assertEqual(sidecar["status"], dataset_sidecar_status_service.STATUS_REVIEW_NEEDED)

    def test_dfm_output_refreshes_downstream_dfm_ratio_basis_in_same_wave(self) -> None:
        first = self.write_method_pair(status=2)
        first_sidecar_path = self.sidecars / "Development Output.json"
        first_sidecar = json.loads(first_sidecar_path.read_text(encoding="utf-8"))
        first_sidecar["Dependents"] = [{"dataset_type_name": "Second Output"}]
        self.write_json(first_sidecar_path, first_sidecar)
        self.write_source(
            "Paid",
            "100,180\n200,\n",
            data_format="Triangle",
            dependents=["Development Output"],
        )
        self.write_source("Premium", "1000\n1100\n", data_format="Vector")
        self.write_source("Incurred", "80,120\n160,\n", data_format="Triangle")
        second = recalculate_dfm_method(
            {
                "details tab": {
                    "name": "Second",
                    "output type": "Second Ultimate",
                    "output dataset": "Second Output",
                    "input triangle": "Incurred",
                    "origin length": 12,
                    "development length": 12,
                },
                "ratios tab": {
                    "average formulas": {
                        "label": ["User Entry"],
                        "custom average formula settings": {"averageType": ["user_entry"]},
                        "selected": [[1, 1]],
                        "values": [[1.5, 1]],
                        "inputs": [["1.5", "1"]],
                    },
                },
                "results tab": {"ratio basis dataset": "Development Output"},
            },
            input_snapshot={
                "name": "Incurred",
                "data_format": "Triangle",
                "origin_labels": ["2024", "2025"],
                "development_labels": ["12", "24"],
                "values": [[80, 120], [160, None]],
                "mask": [[True, True], [True, False]],
                "revision": "incurred-r1",
            },
            ratio_basis_snapshot={
                "name": "Development Output",
                "data_format": "Vector",
                "origin_labels": ["2024", "2025"],
                "values": first["results tab"]["ultimate vector"],
                "revision": "first-r1",
            },
            timestamp="2026-01-01T00:00:00Z",
        )
        self.write_json(self.methods / "DFM@Second.json", second)
        second_sidecar = {
            **self.output_sidecar(second, status=2),
            "dataset_name": "Second Output",
            "dataset_type": "Second Ultimate",
            "method_name": "Second",
            "csv_file": "Second Output@12.csv",
            "Precedents": [
                {"dataset_type_name": "Incurred"},
                {"dataset_type_name": "Development Output"},
            ],
            "publication_revision": method_revisions(second)["publication revision"],
        }
        self.write_json(self.sidecars / "Second Output.json", second_sidecar)
        (self.datasets / "Second Output@12.csv").write_text("120\n240\n", encoding="utf-8")

        result = dfm_service.refresh_dependents("Project", "Class", ["Paid"])

        self.assertTrue(result["ok"], result)
        by_name = {item["dataset_name"]: item for item in result["updated"]}
        self.assertTrue(by_name["Development Output"]["output_changed"])
        self.assertFalse(by_name["Second Output"]["output_changed"])
        first_saved = json.loads((self.methods / "DFM@Development.json").read_text(encoding="utf-8"))
        second_saved = json.loads((self.methods / "DFM@Second.json").read_text(encoding="utf-8"))
        self.assertEqual(
            second_saved["results tab"]["ratio basis values"],
            first_saved["results tab"]["ultimate vector"],
        )

    def test_calculated_cascade_refreshes_dfm_before_calculated_and_rs(self) -> None:
        events: list[str] = []
        dfm_result = {
            "ok": True,
            "updated": [{
                "dataset_name": "Development Output",
                "dataset_type": "Selected Ultimate",
                "output_changed": True,
            }],
            "errors": [],
        }
        rows = [{
            "name": "Calculated Ultimate",
            "calculated": True,
            "generated": False,
            "formula": "[Selected Ultimate]",
        }]
        with (
            mock.patch.object(
                dfm_service,
                "refresh_dependents",
                side_effect=lambda *_args, **_kwargs: events.append("dfm") or dfm_result,
            ),
            mock.patch.object(calculated_dataset_service, "_dataset_type_rows", return_value=rows),
            mock.patch.object(
                calculated_dataset_service,
                "_existing_downstream_keys",
                side_effect=lambda _p, _r, roots, _rows: (
                    self.assertIn("Development Output", roots),
                    self.assertIn("Selected Ultimate", roots),
                    ["calculated ultimate"],
                )[-1],
            ),
            mock.patch.object(
                calculated_dataset_service,
                "recalculate_dataset",
                side_effect=lambda *_args, **_kwargs: events.append("calculated") or {
                    "ok": True,
                    "dataset_type_name": "Calculated Ultimate",
                },
            ),
            mock.patch(
                "app_server.services.result_selection_service.refresh_dependents",
                side_effect=lambda *_args, **_kwargs: events.append("rs") or {
                    "ok": True,
                    "updated": [],
                },
            ) as refresh_rs,
            mock.patch.object(calculated_dataset_service.dataset_instance_index_service, "rebuild_index"),
        ):
            result = calculated_dataset_service.recalculate_dependents(
                "Project", "Class", "Paid", "Paid"
            )

        self.assertTrue(result["ok"], result)
        self.assertEqual(events, ["dfm", "calculated", "dfm", "rs"])
        rs_roots = refresh_rs.call_args.args[2]
        self.assertIn("Development Output", rs_roots)
        self.assertIn("Selected Ultimate", rs_roots)

    def test_failed_dfm_root_blocks_only_its_calculated_and_rs_descendants(self) -> None:
        dfm_result = {
            "ok": False,
            "updated": [],
            "errors": [{
                "dataset_name": "Development Output",
                "dataset_type": "Selected Ultimate",
                "reason": "geometry mismatch",
            }],
        }
        rows = [{
            "name": "Calculated Ultimate",
            "calculated": True,
            "generated": False,
            "formula": "[Selected Ultimate]",
        }]
        with (
            mock.patch.object(dfm_service, "refresh_dependents", return_value=dfm_result),
            mock.patch.object(calculated_dataset_service, "_dataset_type_rows", return_value=rows),
            mock.patch.object(
                calculated_dataset_service,
                "_existing_downstream_keys",
                return_value=["calculated ultimate"],
            ),
            mock.patch.object(
                calculated_dataset_service,
                "_formula_components",
                return_value=["Selected Ultimate"],
            ),
            mock.patch.object(calculated_dataset_service, "recalculate_dataset") as recalculate,
            mock.patch(
                "app_server.services.result_selection_service.refresh_dependents",
                return_value={"ok": False, "updated": [], "errors": []},
            ) as refresh_rs,
            mock.patch.object(
                dataset_sidecar_status_service,
                "refresh_method_statuses_for_dependents",
                return_value=[],
            ),
            mock.patch.object(calculated_dataset_service.dataset_instance_index_service, "rebuild_index"),
        ):
            result = calculated_dataset_service.recalculate_dependents(
                "Project", "Class", "Paid", "Paid"
            )

        recalculate.assert_not_called()
        self.assertFalse(result["ok"])
        self.assertEqual(result["skipped"][0]["reason"], "upstream_calculation_failed")
        blocked = refresh_rs.call_args.kwargs["blocked_precedent_names"]
        self.assertIn("Development Output", blocked)
        self.assertIn("Selected Ultimate", blocked)

    def test_calculated_output_refreshes_dfm_before_later_calculated_descendant(self) -> None:
        events: list[str] = []
        dfm_results = iter([
            {"ok": True, "updated": [], "errors": []},
            {
                "ok": True,
                "updated": [{
                    "dataset_name": "Method B Output",
                    "dataset_type": "Method B Ultimate",
                    "output_changed": True,
                }],
                "errors": [],
            },
            {"ok": True, "updated": [], "errors": []},
        ])
        rows = [
            {"name": "Calculated C", "calculated": True, "generated": False, "formula": "[Paid]"},
            {
                "name": "Calculated D",
                "calculated": True,
                "generated": False,
                "formula": "[Method B Ultimate]",
            },
        ]

        def refresh_dfm(*_args, **_kwargs):
            events.append("dfm")
            return next(dfm_results)

        def downstream(_project, _reserving, roots, _rows):
            normalized = {str(item).casefold() for item in roots}
            return ["calculated d"] if "method b ultimate" in normalized else ["calculated c"]

        def recalculate(_project, _reserving, name, **_kwargs):
            events.append(name)
            return {"ok": True, "dataset_type_name": name}

        with (
            mock.patch.object(dfm_service, "refresh_dependents", side_effect=refresh_dfm),
            mock.patch.object(calculated_dataset_service, "_dataset_type_rows", return_value=rows),
            mock.patch.object(calculated_dataset_service, "_existing_downstream_keys", side_effect=downstream),
            mock.patch.object(calculated_dataset_service, "recalculate_dataset", side_effect=recalculate),
            mock.patch(
                "app_server.services.result_selection_service.refresh_dependents",
                side_effect=lambda *_args, **_kwargs: events.append("rs") or {"ok": True, "updated": []},
            ) as refresh_rs,
            mock.patch.object(calculated_dataset_service.dataset_instance_index_service, "rebuild_index"),
        ):
            result = calculated_dataset_service.recalculate_dependents(
                "Project", "Class", "Paid", "Paid"
            )

        self.assertTrue(result["ok"], result)
        self.assertEqual(
            events,
            ["dfm", "Calculated C", "dfm", "Calculated D", "dfm", "rs"],
        )
        self.assertIn("Method B Output", refresh_rs.call_args.args[2])
        self.assertIn("Method B Ultimate", refresh_rs.call_args.args[2])

    def test_staged_publish_rolls_back_and_replaces_sidecar_last(self) -> None:
        method_path = self.methods / "method.json"
        csv_path = self.datasets / "output.csv"
        sidecar_path = self.sidecars / "output.json"
        for path, text in (
            (method_path, "old-method\n"),
            (csv_path, "old-csv\n"),
            (sidecar_path, "old-sidecar\n"),
        ):
            path.write_text(text, encoding="utf-8")
        original = {path: path.read_bytes() for path in (method_path, csv_path, sidecar_path)}
        real_replace = dfm_service.os.replace
        targets: list[str] = []

        def replace(source: str, target: str) -> None:
            targets.append(target)
            if target == str(sidecar_path) and source.endswith(".tmp"):
                raise OSError("sidecar publish failed")
            real_replace(source, target)

        with mock.patch.object(dfm_service.os, "replace", side_effect=replace):
            with self.assertRaises(OSError):
                dfm_service._commit_text_files(
                    {
                        str(method_path): "new-method\n",
                        str(csv_path): "new-csv\n",
                        str(sidecar_path): "new-sidecar\n",
                    },
                    last_paths=[str(sidecar_path)],
                )

        self.assertEqual(
            {path: path.read_bytes() for path in original},
            original,
        )
        first_sidecar_target = targets.index(str(sidecar_path))
        self.assertGreater(first_sidecar_target, targets.index(str(method_path)))
        self.assertGreater(first_sidecar_target, targets.index(str(csv_path)))

    def test_staged_publish_skips_unchanged_files(self) -> None:
        path = self.methods / "unchanged.json"
        path.write_bytes(b"same\n")
        with mock.patch.object(dfm_service.os, "replace") as replace:
            changed = dfm_service._commit_text_files({str(path): "same\n"})
        self.assertEqual(changed, [])
        replace.assert_not_called()


if __name__ == "__main__":
    unittest.main()
