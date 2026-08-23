from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from arcrho_api.dfm import DfmMethod  # noqa: E402
from arcrho_api.dfm_propagation import refresh_dfm_dependents_for_sources  # noqa: E402
from arcrho_api.exceptions import DfmDataError  # noqa: E402
from arcrho_api.paths import dfm_filename, sanitize_file_name_part  # noqa: E402
from arcrho_api.reserving_class import ReservingClass as ApiReservingClass  # noqa: E402


_TMP_ROOT = Path(__file__).resolve().parent / "logs" / "tmp"


class _Client:
    """Server-root anchor for the reserving-class propagation lease."""

    def __init__(self, root: Path) -> None:
        self.server_root = root


class _Project:
    def __init__(self, root: Path) -> None:
        self.name = "Demo"
        self.read_only = False
        self.path = root
        self.client = _Client(root)
        self.data_dir = root / "data"
        self.rc_data = self.data_dir / "Auto_%5C_PP"
        for folder in ("datasets", "methods", "sidecars"):
            (self.rc_data / folder).mkdir(parents=True, exist_ok=True)
        self.rebuilds = 0

    def reserving_class_data_dir(self, _reserving_class: str) -> Path:
        return self.rc_data

    def dfm_path(self, _reserving_class: str, name: str) -> Path:
        return self.rc_data / "methods" / dfm_filename(name)

    def rebuild_reserving_class_index(self, _reserving_class: str) -> list:
        self.rebuilds += 1
        return []


class _ReservingClass:
    def __init__(self, project: _Project) -> None:
        self.project = project
        self.path = r"Auto\PP"


def _input_snapshot(values: list[list[float | None]] | None = None) -> dict:
    values = values or [[100, 150, 180], [200, 300, None], [400, None, None]]
    return {
        "name": "Paid Loss",
        "origin_labels": ["2020", "2021", "2022"],
        "development_labels": ["12m", "24m", "36m"],
        "values": values,
        "mask": [[item is not None for item in row] for row in values],
        "data_format": "Triangle",
        "number_format": "#,##0",
        "decimal_places": 0,
    }


def _basis_snapshot(name: str = "Premium") -> dict:
    return {
        "name": name,
        "origin_labels": ["2020", "2021", "2022"],
        "values": [1000, 2000, 3000],
        "data_format": "Vector",
        "number_format": "$#,##0",
        "decimal_places": 0,
    }


class DfmV2PublicationTests(unittest.TestCase):
    def setUp(self) -> None:
        _TMP_ROOT.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=str(_TMP_ROOT))
        self.project = _Project(Path(self.tmp.name))
        self.rc = _ReservingClass(self.project)
        self.sidecars = self.project.rc_data / "sidecars"
        for name in ("Paid Loss", "Premium", "Premium 2"):
            self._write_sidecar(name, {"dataset_name": name, "dependents": [{"dataset_name": "Keep"}]})

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _sidecar_path(self, name: str) -> Path:
        return self.sidecars / f"{sanitize_file_name_part(name, 'Dataset')}.json"

    def _write_sidecar(self, name: str, payload: dict) -> None:
        self._sidecar_path(name).write_text(json.dumps(payload), encoding="utf-8")

    def _new_method(self, name: str = "Paid DFM") -> DfmMethod:
        method = DfmMethod.new(
            self.rc,
            name,
            output_vector="Paid Ultimate",
            input_triangle="Paid Loss",
            origin_length=12,
            development_length=12,
        )
        method.set_input_snapshot(_input_snapshot())
        method.set_ratio_basis_snapshot(_basis_snapshot())
        return method

    def test_save_registers_both_precedents_and_removes_old_basis_edge(self) -> None:
        method = self._new_method()
        method.save()

        for name in ("Paid Loss", "Premium"):
            sidecar = json.loads(self._sidecar_path(name).read_text(encoding="utf-8"))
            self.assertEqual(
                sidecar["dependents"],
                [{"dataset_name": "Keep"}, {"dataset_name": "Paid DFM"}],
            )
        method.set_summary_ratio_basis("Premium 2")
        method.set_ratio_basis_snapshot(_basis_snapshot("Premium 2"))
        method.save()

        old_basis = json.loads(self._sidecar_path("Premium").read_text(encoding="utf-8"))
        new_basis = json.loads(self._sidecar_path("Premium 2").read_text(encoding="utf-8"))
        self.assertEqual(old_basis["dependents"], [{"dataset_name": "Keep"}])
        self.assertEqual(
            new_basis["dependents"],
            [{"dataset_name": "Keep"}, {"dataset_name": "Paid DFM"}],
        )

    def test_save_as_rejects_an_output_sidecar_owned_by_another_method(self) -> None:
        method = self._new_method("New DFM")
        method.details["output_dataset"] = "Shared Ultimate"
        conflict_path = self._sidecar_path("Shared Ultimate")
        conflict = {"dataset_name": "Shared Ultimate", "method_name": "Other DFM", "notes": "keep"}
        self._write_sidecar("Shared Ultimate", conflict)

        with self.assertRaisesRegex(DfmDataError, "already owned"):
            method.save()

        self.assertEqual(json.loads(conflict_path.read_text(encoding="utf-8")), conflict)
        self.assertFalse(method.file_path.exists())

    def test_failed_sidecar_last_replace_rolls_back_graph_method_and_csv(self) -> None:
        method = self._new_method("Rollback DFM")
        output_sidecar = self._sidecar_path("Rollback DFM")
        input_before = self._sidecar_path("Paid Loss").read_bytes()
        basis_before = self._sidecar_path("Premium").read_bytes()
        real_replace = __import__("os").replace
        failed = False

        def fail_output_once(source, target):
            nonlocal failed
            if Path(target) == output_sidecar and not failed:
                failed = True
                raise OSError("simulated sidecar failure")
            return real_replace(source, target)

        with patch("arcrho_api.dfm.os.replace", side_effect=fail_output_once):
            with self.assertRaisesRegex(DfmDataError, "Failed to publish"):
                method.save()

        self.assertEqual(self._sidecar_path("Paid Loss").read_bytes(), input_before)
        self.assertEqual(self._sidecar_path("Premium").read_bytes(), basis_before)
        self.assertFalse(method.file_path.exists())
        self.assertFalse(output_sidecar.exists())
        self.assertFalse((self.project.rc_data / "datasets" / "Rollback DFM@12.csv").exists())


class DfmV2PropagationTests(unittest.TestCase):
    def setUp(self) -> None:
        _TMP_ROOT.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=str(_TMP_ROOT))
        self.project = _Project(Path(self.tmp.name))
        self.rc = ApiReservingClass(self.project, r"Auto\PP")
        self.datasets = self.project.rc_data / "datasets"
        self.sidecars = self.project.rc_data / "sidecars"
        self.input_path = self.datasets / "Paid Loss@12@12@cum@dev.csv"
        self.input_path.write_text("100,150,180\n200,300,\n400,,\n", encoding="utf-8")
        self.basis_path = self.datasets / "Premium@12.csv"
        self.basis_path.write_text("1000\n2000\n3000\n", encoding="utf-8")
        common_labels = ["2020", "2021", "2022"]
        (self.sidecars / "Paid Loss.json").write_text(json.dumps({
            "dataset_name": "Paid Loss",
            "data_format": "Triangle",
            "csv_file": self.input_path.name,
            "origin_labels": common_labels,
            "development_labels": ["12m", "24m", "36m"],
            "number_format": "#,##0",
            "decimal_places": 0,
            "dependents": [],
        }), encoding="utf-8")
        (self.sidecars / "Premium.json").write_text(json.dumps({
            "dataset_name": "Premium",
            "data_format": "Vector",
            "csv_file": self.basis_path.name,
            "origin_labels": common_labels,
            "number_format": "$#,##0",
            "decimal_places": 0,
            "dependents": [],
        }), encoding="utf-8")
        method = self.rc.new_dfm(
            "Paid DFM",
            output_vector="Paid Ultimate",
            input_triangle="Paid Loss",
            origin_length=12,
            development_length=12,
        )
        method.set_input_snapshot(_input_snapshot())
        method.set_ratio_basis_snapshot(_basis_snapshot())
        method.ratios_tab["cell_notes"] = {
            "ratio_main_table": {"2020": {"(1) 12-24": "preserve"}},
            "ratio_summary_table": {},
        }
        method.save()
        self.method_path = method.file_path
        self.output_sidecar = self.sidecars / "Paid DFM.json"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _refresh_with_rows(self, text: str):
        def write_request(_name, data_path, **_kwargs):
            data_path.write_text(text, encoding="utf-8")
            return self.project.path / "request.json"

        with patch.object(self.rc, "_write_triangle_request", side_effect=write_request):
            return self.rc.add_triangle(
                "Paid Loss",
                origin_length=12,
                development_length=12,
                force_refresh=True,
                timeout_sec=0.1,
            )

    def test_add_triangle_refreshes_dfm_and_returns_nonblocking_propagation_result(self) -> None:
        before = json.loads(self.method_path.read_text(encoding="utf-8"))
        result = self._refresh_with_rows("100,200,260\n200,400,\n400,,\n")
        after = json.loads(self.method_path.read_text(encoding="utf-8"))

        self.assertEqual(result.refreshed_dfm_outputs, ("Paid DFM",))
        self.assertEqual(result.propagation_warnings, ())
        self.assertNotEqual(
            after["method_metadata"]["derived_revision"],
            before["method_metadata"]["derived_revision"],
        )
        self.assertEqual(
            after["ratios_tab"]["cell_notes"],
            before["ratios_tab"]["cell_notes"],
        )
        sidecar = json.loads(self.output_sidecar.read_text(encoding="utf-8"))
        self.assertEqual(sidecar["status"], 0)
        self.assertEqual(sidecar["audit_log"][-1]["action"], "Auto Refresh")

    def test_same_origin_input_refresh_uses_embedded_basis_when_basis_is_unavailable(self) -> None:
        (self.sidecars / "Premium.json").unlink()
        result = self._refresh_with_rows("100,200,260\n200,400,\n400,,\n")

        self.assertEqual(result.refreshed_dfm_outputs, ("Paid DFM",))
        self.assertEqual(result.propagation_warnings, ())
        refreshed = json.loads(self.method_path.read_text(encoding="utf-8"))
        self.assertEqual(refreshed["results_tab"]["ratio_basis_values"], [1000, 2000, 3000])

    def test_batched_input_and_basis_refresh_applies_both_latest_snapshots(self) -> None:
        self.input_path.write_text("100,200,260\n200,400,\n400,,\n", encoding="utf-8")
        self.basis_path.write_text("1100\n2200\n3300\n", encoding="utf-8")

        result = refresh_dfm_dependents_for_sources(
            self.rc,
            ("Paid Loss", "Premium"),
        )

        self.assertEqual(result.refreshed_outputs, ("Paid DFM",))
        self.assertEqual(result.warnings, ())
        refreshed = json.loads(self.method_path.read_text(encoding="utf-8"))
        # The file holds the persisted projection -- trailing nulls trimmed and
        # no mask -- exactly as the app server writes it.
        self.assertEqual(
            refreshed["data_tab"]["input_data_triangle_values"],
            [[100, 200, 260], [200, 400], [400]],
        )
        self.assertNotIn("input_data_triangle_mask", refreshed["data_tab"])
        self.assertEqual(
            refreshed["results_tab"]["ratio_basis_values"],
            [1100, 2200, 3300],
        )

    def test_failed_branch_keeps_publication_and_marks_dfm_descendants_review_needed(self) -> None:
        parent_sidecar = json.loads(self.output_sidecar.read_text(encoding="utf-8"))
        parent_sidecar["dependents"] = [{"dataset_name": "Blocked Child"}]
        self.output_sidecar.write_text(json.dumps(parent_sidecar), encoding="utf-8")
        blocked_child = self.sidecars / "Blocked Child.json"
        blocked_child.write_text(json.dumps({
            "dataset_name": "Blocked Child",
            "method_name": "Blocked Child DFM",
            "method_type": "DFM",
            "source_kind": "dfm",
            "status": 0,
            "dependents": [],
        }), encoding="utf-8")
        method_before = self.method_path.read_bytes()
        output_before = (self.datasets / "Paid DFM@12.csv").read_bytes()
        result = self._refresh_with_rows("100,200,260\n200,400,\n")

        self.assertTrue(result.propagation_warnings)
        self.assertEqual(self.method_path.read_bytes(), method_before)
        self.assertEqual((self.datasets / "Paid DFM@12.csv").read_bytes(), output_before)
        sidecar = json.loads(self.output_sidecar.read_text(encoding="utf-8"))
        self.assertEqual(sidecar["status"], 2)
        self.assertEqual(json.loads(blocked_child.read_text(encoding="utf-8"))["status"], 2)
        self.assertTrue(self.input_path.is_file())

    def test_changed_dfm_save_refreshes_transitive_dfm_basis_without_recursing(self) -> None:
        reported_csv = self.datasets / "Reported Loss@12@12@cum@dev.csv"
        reported_csv.write_text("50,75,90\n100,150,\n200,,\n", encoding="utf-8")
        (self.sidecars / "Reported Loss.json").write_text(json.dumps({
            "dataset_name": "Reported Loss",
            "data_format": "Triangle",
            "csv_file": reported_csv.name,
            "origin_labels": ["2020", "2021", "2022"],
            "development_labels": ["12m", "24m", "36m"],
            "number_format": "#,##0",
            "decimal_places": 0,
            "dependents": [],
        }), encoding="utf-8")
        upstream = self.rc.dfm("Paid DFM")
        downstream = self.rc.new_dfm(
            "Downstream DFM",
            output_vector="Downstream Ultimate",
            input_triangle="Reported Loss",
            origin_length=12,
            development_length=12,
        )
        downstream.set_input_snapshot({**_input_snapshot(), "name": "Reported Loss"})
        downstream.set_ratio_basis_snapshot({
            "name": "Paid DFM",
            "origin_labels": ["2020", "2021", "2022"],
            "values": upstream.results_tab["ultimate_vector"],
            "data_format": "Vector",
            "number_format": "#,##0",
            "decimal_places": 2,
        })
        downstream.save()

        upstream.set_user_ratio(3.0, 1, formula="3.0")
        upstream.save()

        self.assertEqual(upstream.propagation_warnings, ())
        self.assertEqual(upstream.refreshed_dfm_outputs, ("Downstream DFM",))
        refreshed = self.rc.dfm("Downstream DFM")
        self.assertEqual(
            refreshed.results_tab["ratio_basis_values"],
            upstream.results_tab["ultimate_vector"],
        )
        upstream.set_summary_ratio_basis("Downstream DFM")
        upstream.set_ratio_basis_snapshot({
            "name": "Downstream DFM",
            "origin_labels": ["2020", "2021", "2022"],
            "values": refreshed.results_tab["ultimate_vector"],
            "data_format": "Vector",
            "number_format": "#,##0",
            "decimal_places": 2,
        })
        with self.assertRaisesRegex(DfmDataError, "dependency cycle"):
            upstream.save()


if __name__ == "__main__":
    unittest.main()
