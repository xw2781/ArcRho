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

from arcrho_api.dfm_contract import method_revisions, recalculate_dfm_method
from app_server.services import excel_link_service
from dependent_propagation_workspace_stub import IsolatedPropagationWorkspace


OLD_REFERENCE = "='C:\\Data\\[Book.xlsx]Sheet 1'!$A$1:$B$1"


def dfm_method_payload(inputs_first_cell: str) -> dict:
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
                    "inputs": [[inputs_first_cell, "1"]],
                    "display inputs": [[inputs_first_cell, "1"]],
                },
            },
            "results tab": {},
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
        timestamp="2026-01-01T00:00:00Z",
    )


class ExcelLinkReferenceRewriteTests(unittest.TestCase):
    def test_finds_quoted_inline_and_standalone_references(self) -> None:
        inline = excel_link_service.find_workbook_references(
            "1.5 * 'C:\\Data\\[Book.xlsx]Sheet 1'!$A$1 + 'D:\\Other\\[Second.xlsx]S2'!B2:C3"
        )
        self.assertEqual(
            [item["book_path"] for item in inline],
            ["C:\\Data\\Book.xlsx", "D:\\Other\\Second.xlsx"],
        )
        standalone = excel_link_service.find_workbook_references(
            "=C:\\Data\\[Book.xlsx]Sheet1!A1"
        )
        self.assertEqual(standalone[0]["book_path"], "C:\\Data\\Book.xlsx")
        self.assertEqual(excel_link_service.find_workbook_references("= \"Simple\" * 2"), [])

    def test_rewrites_only_matching_workbook_and_preserves_sheet_and_address(self) -> None:
        old_key = excel_link_service.workbook_key("c:\\data\\book.xlsx")
        text = "'C:\\Data\\[Book.xlsx]Sheet 1'!$A$1 + 'D:\\Other\\[Second.xlsx]S2'!B2"
        rewritten, changed = excel_link_service.rewrite_workbook_references(
            text, old_key, "E:\\Moved\\Book 2026.xlsx"
        )
        self.assertEqual(changed, 1)
        self.assertEqual(
            rewritten,
            "'E:\\Moved\\[Book 2026.xlsx]Sheet 1'!$A$1 + 'D:\\Other\\[Second.xlsx]S2'!B2",
        )

    def test_rewrites_standalone_unquoted_form_to_canonical_quoted_form(self) -> None:
        old_key = excel_link_service.workbook_key("C:\\Data\\Book.xlsx")
        rewritten, changed = excel_link_service.rewrite_workbook_references(
            "=C:\\Data\\[Book.xlsx]Sheet1!$A$1:$B$2", old_key, "E:\\Moved\\Book.xlsx"
        )
        self.assertEqual(changed, 1)
        self.assertEqual(rewritten, "='E:\\Moved\\[Book.xlsx]Sheet1'!$A$1:$B$2")

    def test_escapes_apostrophes_in_new_workbook_path(self) -> None:
        old_key = excel_link_service.workbook_key("C:\\Data\\Book.xlsx")
        rewritten, changed = excel_link_service.rewrite_workbook_references(
            "='C:\\Data\\[Book.xlsx]Sheet 1'!A1", old_key, "E:\\Ann's\\Book.xlsx"
        )
        self.assertEqual(changed, 1)
        self.assertEqual(rewritten, "='E:\\Ann''s\\[Book.xlsx]Sheet 1'!A1")
        round_trip = excel_link_service.find_workbook_references(rewritten)
        self.assertEqual(round_trip[0]["book_path"], "E:\\Ann's\\Book.xlsx")


class ExcelLinkFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(dir=REPO_ROOT)
        root = Path(self.temp.name)
        self.sidecars = root / "sidecars"
        self.methods = root / "methods"
        self.datasets = root / "datasets"
        self.books = root / "books"
        for folder in (self.sidecars, self.methods, self.datasets, self.books):
            folder.mkdir()
        self.old_book = self.books / "Book.xlsx"
        self.old_book.write_bytes(b"old")
        self.new_book = self.books / "Book 2026.xlsx"
        self.new_book.write_bytes(b"new")
        self.old_reference = (
            f"='{self.books}\\[Book.xlsx]Sheet 1'!$A$1:$B$1"
        )
        self.patchers = [
            IsolatedPropagationWorkspace(),
            mock.patch.object(
                excel_link_service.config,
                "get_project_dataset_sidecar_dir",
                return_value=str(self.sidecars),
            ),
            mock.patch.object(
                excel_link_service.config,
                "get_project_method_data_dir",
                return_value=str(self.methods),
            ),
        ]
        for patcher in self.patchers:
            patcher.start()

    def tearDown(self) -> None:
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.temp.cleanup()

    def write_json(self, path: Path, payload: dict) -> None:
        path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    def linked_sidecar(self, name: str = "Manual Paid") -> dict:
        return {
            "dataset_name": name,
            "dataset_type": name,
            "project_name": "Project",
            "reserving_class": "Class",
            "source_kind": "input",
            "data_format": "Triangle",
            "origin_length": 12,
            "development_length": 12,
            "csv_file": f"{name}@12@12@cum@dev.csv",
            "updated_at": "2026-01-05T00:00:00Z",
            "audit_log": [
                {"event_date": "2026-01-05T00:00:00Z", "action": "Insert", "change_info": "", "user": "user1"},
            ],
            "external_links": [
                {
                    "reference": self.old_reference,
                    "target_cells": [
                        {"row": 0, "column": 0, "source_cell": "A1"},
                        {"row": 0, "column": 1, "source_cell": "B1"},
                    ],
                },
            ],
        }

    def write_dfm_method(self, first_input: str) -> dict:
        payload = dfm_method_payload(first_input)
        self.write_json(self.methods / "DFM@Development.json", payload)
        return payload


class ExcelLinkServiceTests(ExcelLinkFixture):
    def test_list_groups_workbooks_across_datasets_and_dfm_methods(self) -> None:
        self.write_json(self.sidecars / "Manual Paid.json", self.linked_sidecar())
        self.write_json(self.sidecars / "No Links.json", {"dataset_name": "No Links"})
        (self.sidecars / "Broken.json").write_text("{not json", encoding="utf-8")
        self.write_dfm_method(f"'{self.books}\\[Book.xlsx]Sheet 1'!$A$1 * 2")
        self.write_json(self.methods / "DFM@Old.json", {"json format": "arcrho-dfm-method-by-tab-v1"})

        listing = excel_link_service.list_reserving_class_excel_links("Project", "Class")

        self.assertTrue(listing["ok"])
        self.assertEqual(len(listing["workbooks"]), 1)
        workbook = listing["workbooks"][0]
        self.assertEqual(workbook["workbook_name"], "Book.xlsx")
        self.assertTrue(workbook["exists"])
        self.assertEqual(workbook["dataset_count"], 1)
        self.assertEqual(workbook["method_count"], 1)
        self.assertEqual(workbook["link_count"], 2)
        self.assertEqual(workbook["cell_count"], 3)
        self.assertEqual(
            [(item["kind"], item["name"]) for item in workbook["usages"]],
            [("dataset", "Manual Paid"), ("dfm", "Development")],
        )
        self.assertEqual(
            [item["file"] for item in listing["errors"]],
            ["Broken.json"],
        )

    def test_list_marks_missing_workbooks(self) -> None:
        sidecar = self.linked_sidecar()
        sidecar["external_links"][0]["reference"] = "='C:\\Gone\\[Missing.xlsx]S1'!A1:B1"
        self.write_json(self.sidecars / "Manual Paid.json", sidecar)

        listing = excel_link_service.list_reserving_class_excel_links("Project", "Class")

        self.assertEqual(listing["workbooks"][0]["workbook_name"], "Missing.xlsx")
        self.assertFalse(listing["workbooks"][0]["exists"])

    def test_retarget_rewrites_datasets_and_dfm_methods_without_touching_values(self) -> None:
        self.write_json(self.sidecars / "Manual Paid.json", self.linked_sidecar())
        untouched = {"dataset_name": "Other", "external_links": []}
        self.write_json(self.sidecars / "Other.json", untouched)
        untouched_bytes = (self.sidecars / "Other.json").read_bytes()
        method = self.write_dfm_method(f"'{self.books}\\[Book.xlsx]Sheet 1'!$A$1 * 2")
        output_csv = self.datasets / "Development Output@12.csv"
        output_csv.write_text("150\n300\n", encoding="utf-8")
        csv_bytes = output_csv.read_bytes()

        with mock.patch(
            "app_server.services.dataset_instance_index_service.rebuild_index"
        ) as rebuild:
            response = excel_link_service.retarget_reserving_class_workbook(
                "Project", "Class", str(self.old_book), str(self.new_book)
            )

        self.assertTrue(response["ok"])
        self.assertEqual(response["changed_file_count"], 2)
        self.assertEqual(response["changed_link_count"], 3)
        self.assertEqual(
            sorted((item["kind"], item["name"]) for item in response["results"]),
            [("dataset", "Manual Paid"), ("dfm", "Development")],
        )
        rebuild.assert_called_once_with("Project", "Class")

        sidecar = json.loads((self.sidecars / "Manual Paid.json").read_text(encoding="utf-8"))
        self.assertEqual(
            sidecar["external_links"][0]["reference"],
            f"='{self.books}\\[Book 2026.xlsx]Sheet 1'!$A$1:$B$1",
        )
        self.assertEqual(
            sidecar["external_links"][0]["target_cells"],
            [
                {"row": 0, "column": 0, "source_cell": "A1"},
                {"row": 0, "column": 1, "source_cell": "B1"},
            ],
        )
        self.assertEqual(sidecar["updated_at"], "2026-01-05T00:00:00Z")
        self.assertEqual(len(sidecar["audit_log"]), 1)
        self.assertEqual((self.sidecars / "Other.json").read_bytes(), untouched_bytes)

        saved_method = json.loads(
            (self.methods / "DFM@Development.json").read_text(encoding="utf-8")
        )
        formulas = saved_method["ratios tab"]["average formulas"]
        self.assertEqual(
            formulas["inputs"][0][0],
            f"'{self.books}\\[Book 2026.xlsx]Sheet 1'!$A$1 * 2",
        )
        self.assertEqual(formulas["display inputs"][0][0], formulas["inputs"][0][0])
        self.assertEqual(formulas["values"], method["ratios tab"]["average formulas"]["values"])
        before = method_revisions(method)
        after = method_revisions(saved_method)
        self.assertEqual(after["publication revision"], before["publication revision"])
        self.assertNotEqual(after["owned revision"], before["owned revision"])
        self.assertNotEqual(
            saved_method["method metadata"]["last modified"],
            method["method metadata"]["last modified"],
        )
        self.assertEqual(
            saved_method["method metadata"]["data refreshed"],
            method["method metadata"]["data refreshed"],
        )
        self.assertEqual(output_csv.read_bytes(), csv_bytes)

        # The refreshed inventory in the same response reflects the new workbook.
        self.assertEqual(response["workbooks"][0]["workbook_name"], "Book 2026.xlsx")

    def test_retarget_requires_an_existing_new_workbook(self) -> None:
        self.write_json(self.sidecars / "Manual Paid.json", self.linked_sidecar())
        with self.assertRaises(HTTPException) as ctx:
            excel_link_service.retarget_reserving_class_workbook(
                "Project", "Class", str(self.old_book), str(self.books / "Nope.xlsx")
            )
        self.assertEqual(ctx.exception.status_code, 400)

    def test_retarget_to_same_workbook_is_a_no_op(self) -> None:
        self.write_json(self.sidecars / "Manual Paid.json", self.linked_sidecar())
        before = (self.sidecars / "Manual Paid.json").read_bytes()
        response = excel_link_service.retarget_reserving_class_workbook(
            "Project", "Class", str(self.old_book), str(self.old_book).upper()
        )
        self.assertTrue(response["ok"])
        self.assertEqual(response["changed_file_count"], 0)
        self.assertIn("already the current link", response["message"])
        self.assertEqual((self.sidecars / "Manual Paid.json").read_bytes(), before)


class ExcelLinkRefreshValuesTests(ExcelLinkFixture):
    """Retarget with refresh_values commits refreshed values through the saves."""

    def refresh_mocks(self, cell_values: dict, *, dataset_values=None):
        def read_cells_batch(items):
            results = []
            for item in items:
                key = (item["sheet"], item["cell"].replace("$", "").upper())
                if key in cell_values:
                    value = cell_values[key]
                    results.append({"ok": True, "value": value})
                else:
                    results.append({"ok": False, "error": f"Cell {item['cell']} not found."})
            return {"ok": True, "results": results}

        return (
            mock.patch.object(
                excel_link_service.excel_service, "excel_read_cells_batch",
                side_effect=read_cells_batch,
            ),
            mock.patch.object(
                excel_link_service.dependent_propagation_service,
                "require_reserving_class_writable",
            ),
            mock.patch(
                "app_server.services.dataset_service.load_cached_dataset_values",
                return_value={"values": dataset_values if dataset_values is not None else [[100, 150], [200, None]]},
            ),
            mock.patch(
                "app_server.services.dataset_service.save_dataset_sidecar",
                return_value={"ok": True, "calculated_updates": {"ok": True, "status": "queued"}, "propagation_ok": True},
            ),
            mock.patch(
                "app_server.services.dfm_service.save_dfm_method",
                return_value={"ok": True, "propagation": {"ok": True, "status": "queued"}, "propagation_ok": True},
            ),
            mock.patch("app_server.services.dataset_instance_index_service.rebuild_index"),
        )

    def run_retarget(self, cell_values: dict, *, dataset_values=None):
        patches = self.refresh_mocks(cell_values, dataset_values=dataset_values)
        with patches[0] as read_batch, patches[1] as engine, patches[2], \
                patches[3] as dataset_save, patches[4] as dfm_save, patches[5] as rebuild:
            response = excel_link_service.retarget_reserving_class_workbook(
                "Project", "Class", str(self.old_book), str(self.new_book),
                refresh_values=True,
            )
        return response, read_batch, engine, dataset_save, dfm_save, rebuild

    def test_refresh_applies_dataset_values_through_the_canonical_save(self) -> None:
        self.write_json(self.sidecars / "Manual Paid.json", self.linked_sidecar())
        response, read_batch, engine, dataset_save, _dfm_save, rebuild = self.run_retarget(
            {("Sheet 1", "A1"): 111.5, ("Sheet 1", "B1"): None},
        )

        self.assertTrue(response["ok"])
        self.assertTrue(response["refresh_requested"])
        self.assertEqual(response["refreshed_cell_count"], 2)
        self.assertEqual(response["failed_refresh_count"], 0)
        self.assertEqual(response["value_changed_file_count"], 1)
        self.assertTrue(response["propagation_ok"])
        engine.assert_called_once_with("Project", "Class")
        read_batch.assert_called_once()
        for item in read_batch.call_args[0][0]:
            self.assertEqual(item["book_path"], str(self.new_book))
        dataset_save.assert_called_once()
        kwargs = dataset_save.call_args.kwargs
        self.assertEqual(kwargs["values"][0][0], 111.5)
        self.assertIsNone(kwargs["values"][0][1])
        self.assertEqual(kwargs["values"][1], [200, None])
        self.assertIn("Book 2026.xlsx", kwargs["external_links"][0]["reference"])
        self.assertEqual(kwargs["origin_length"], 12)
        rebuild.assert_not_called()

    def test_refresh_save_preserves_zero_decimal_places(self) -> None:
        sidecar = self.linked_sidecar()
        sidecar["decimal_places"] = 0
        self.write_json(self.sidecars / "Manual Paid.json", sidecar)
        _response, _read, _engine, dataset_save, _dfm_save, _rebuild = self.run_retarget(
            {("Sheet 1", "A1"): 111.5, ("Sheet 1", "B1"): 152},
        )
        self.assertEqual(dataset_save.call_args.kwargs["decimal_places"], 0)

    def test_refresh_is_per_link_atomic_and_still_retargets_failed_links(self) -> None:
        sidecar = self.linked_sidecar()
        sidecar["external_links"].append({
            "reference": f"='{self.books}\\[Book.xlsx]Sheet 1'!$C$3",
            "target_cells": [{"row": 1, "column": 0, "source_cell": "C3"}],
        })
        self.write_json(self.sidecars / "Manual Paid.json", sidecar)
        response, _read, _engine, dataset_save, _dfm_save, _rebuild = self.run_retarget(
            {("Sheet 1", "A1"): 111.5, ("Sheet 1", "B1"): 152},
        )

        result = response["results"][0]
        self.assertTrue(result["ok"])
        self.assertEqual(result["changed_link_count"], 2)
        self.assertEqual(result["refreshed_cell_count"], 2)
        self.assertEqual(result["failed_refresh_count"], 1)
        self.assertIn("C3", result["refresh_errors"][0])
        kwargs = dataset_save.call_args.kwargs
        self.assertEqual(kwargs["values"][0], [111.5, 152])
        self.assertEqual(kwargs["values"][1], [200, None])
        self.assertIn("Book 2026.xlsx", kwargs["external_links"][1]["reference"])

    def test_refresh_with_unchanged_values_keeps_the_metadata_only_write(self) -> None:
        self.write_json(self.sidecars / "Manual Paid.json", self.linked_sidecar())
        response, _read, _engine, dataset_save, _dfm_save, rebuild = self.run_retarget(
            {("Sheet 1", "A1"): 100, ("Sheet 1", "B1"): 150},
        )

        result = response["results"][0]
        self.assertFalse(result["value_changed"])
        dataset_save.assert_not_called()
        rebuild.assert_called_once()
        sidecar = json.loads((self.sidecars / "Manual Paid.json").read_text(encoding="utf-8"))
        self.assertIn("Book 2026.xlsx", sidecar["external_links"][0]["reference"])
        self.assertEqual(len(sidecar["audit_log"]), 1)

    def test_refresh_evaluates_dfm_inline_formulas_and_saves_the_method(self) -> None:
        self.write_dfm_method(f"'{self.books}\\[Book.xlsx]Sheet 1'!$A$1 * 2")
        response, _read, _engine, _dataset_save, dfm_save, _rebuild = self.run_retarget(
            {("Sheet 1", "A1"): 2},
        )

        result = response["results"][0]
        self.assertEqual(result["kind"], "dfm")
        self.assertTrue(result["value_changed"])
        self.assertEqual(result["refreshed_cell_count"], 1)
        dfm_save.assert_called_once()
        merged = dfm_save.call_args.args[2]
        formulas = merged["ratios tab"]["average formulas"]
        self.assertEqual(formulas["values"][0][0], 4)
        self.assertIn("Book 2026.xlsx", formulas["inputs"][0][0])
        self.assertEqual(
            dfm_save.call_args.kwargs["expected_owned_revision"],
            method_revisions(dfm_method_payload(f"'{self.books}\\[Book.xlsx]Sheet 1'!$A$1 * 2"))["owned revision"],
        )

    def test_refresh_rejects_nonpositive_dfm_results_and_keeps_stored_values(self) -> None:
        self.write_dfm_method(f"'{self.books}\\[Book.xlsx]Sheet 1'!$A$1 * 2")
        response, _read, _engine, _dataset_save, dfm_save, _rebuild = self.run_retarget(
            {("Sheet 1", "A1"): -3},
        )

        result = response["results"][0]
        self.assertFalse(result["value_changed"])
        self.assertEqual(result["failed_refresh_count"], 1)
        self.assertIn("greater than 0", result["refresh_errors"][0])
        merged = dfm_save.call_args.args[2]
        self.assertEqual(merged["ratios tab"]["average formulas"]["values"][0][0], 1.5)
        self.assertIn("Book 2026.xlsx", merged["ratios tab"]["average formulas"]["inputs"][0][0])

    def test_refresh_spills_dfm_ranges_into_literal_non_anchor_cells(self) -> None:
        self.write_dfm_method(f"='{self.books}\\[Book.xlsx]Sheet 1'!$A$1:$B$1")
        response, _read, _engine, _dataset_save, dfm_save, _rebuild = self.run_retarget(
            {("Sheet 1", "A1"): 1.1, ("Sheet 1", "B1"): 1.2},
        )

        result = response["results"][0]
        self.assertTrue(result["value_changed"])
        self.assertEqual(result["refreshed_cell_count"], 2)
        merged = dfm_save.call_args.args[2]
        formulas = merged["ratios tab"]["average formulas"]
        self.assertEqual(formulas["values"][0], [1.1, 1.2])
        self.assertIn("Book 2026.xlsx", formulas["inputs"][0][0])
        self.assertEqual(formulas["inputs"][0][1], "1.2")
        self.assertEqual(formulas["display inputs"][0][1], "1.2")

    def test_refresh_requires_a_live_engine_before_any_write(self) -> None:
        self.write_json(self.sidecars / "Manual Paid.json", self.linked_sidecar())
        before = (self.sidecars / "Manual Paid.json").read_bytes()
        with mock.patch.object(
            excel_link_service.dependent_propagation_service,
            "require_reserving_class_writable",
            side_effect=HTTPException(503, "No ArcRho Engine instance is available."),
        ):
            with self.assertRaises(HTTPException) as ctx:
                excel_link_service.retarget_reserving_class_workbook(
                    "Project", "Class", str(self.old_book), str(self.new_book),
                    refresh_values=True,
                )
        self.assertEqual(ctx.exception.status_code, 503)
        self.assertEqual((self.sidecars / "Manual Paid.json").read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
