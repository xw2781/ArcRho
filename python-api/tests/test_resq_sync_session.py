"""Cover the canonical ArcRho/ResQ synchronization session.

These rules used to live inside the synchronization macro. They moved into
``resq_migration.sync_session`` when the ResQ session moved onto the Bridge, so
the same code now serves a queued Bridge worker and any direct caller. The
tests follow the rules rather than their old home.
"""
from __future__ import annotations

import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


_PYTHON_API_ROOT = Path(__file__).resolve().parents[1]
for _path in (_PYTHON_API_ROOT / "src", _PYTHON_API_ROOT / "migration"):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from resq_migration import sync_session


def _side(
    modified: str = "2026-08-12T10:00:00+00:00",
    *,
    timestamp: float | None = 100.0,
    source: str = "updated_at",
) -> dict:
    return {
        "modified": modified,
        "modified_timestamp": timestamp,
        "timestamp_source": source,
    }


def _plan_row(
    row_id: str,
    *,
    arcrho=None,
    resq=None,
    selected: bool = False,
    disabled: bool = True,
) -> dict:
    return {
        "id": row_id,
        "name": row_id,
        "kind": "Dataset",
        "arcrho": arcrho,
        "resq": resq,
        "status": "Test status",
        "action": "",
        "detail": "Test detail",
        "selected": selected,
        "disabled": disabled,
        "review": False,
    }


class SyncSessionPhaseTests(unittest.TestCase):
    def _runtime(self):
        migration = Mock()
        migration.CONNECTION_NAME = "ResQ Test"
        migration._apply_runtime_scope.return_value = {"previous": True}
        sync_contract = Mock()
        sync_contract.plan_signature.side_effect = lambda row: {
            "id": row.get("id"),
            "action": row.get("action"),
            "arcrho_timestamp": (row.get("arcrho") or {}).get("modified_timestamp"),
            "resq_timestamp": (row.get("resq") or {}).get("modified_timestamp"),
        }
        sync_contract.signatures_equal.side_effect = lambda left, right: left == right
        sync_contract.newer_side.side_effect = lambda arcrho, resq: (
            "resq" if (resq.get("modified_timestamp") or 0) > (arcrho.get("modified_timestamp") or 0) else "arcrho"
        )
        sync_contract.export_supported.side_effect = lambda arcrho, resq: bool(arcrho.get("can_export_to_resq"))
        return {"migration": migration, "sync_contract": sync_contract}, migration

    def _action_row(self, row_id: str, timestamp: float) -> dict:
        row = _plan_row(
            row_id,
            arcrho=_side(timestamp=timestamp),
            resq=_side(timestamp=timestamp - 1),
            selected=True,
            disabled=False,
        )
        row.update({"key": row_id, "action": "arcrho_to_resq"})
        return row

    def _reviewed(self, runtime, row: dict) -> dict:
        signature = runtime["sync_contract"].plan_signature(row)
        return {"id": row["id"], "name": row["name"], "signature": signature}

    def test_preview_never_opens_a_write_session_and_publishes_row_signatures(self):
        runtime, migration = self._runtime()
        row = self._action_row("paid-loss", 200)
        row["arcrho"].update({"dataset_type": "Paid Loss", "method_name": "Paid DFM", "can_export_to_resq": True})
        preview = {
            "plan": [row],
            "state": {"items": {}},
            "state_path": Path("state.json"),
            "direction": {"direction": "arcrho_to_resq", "arcrho_timestamp": 200.0, "resq_timestamp": 199.0},
        }

        with (
            patch.object(sync_session, "_plan_context", return_value=preview),
            patch.object(sync_session, "apply_sync_plan") as apply_plan,
        ):
            result = sync_session.preview_sync(
                runtime,
                "Demo",
                r"Auto\PP",
                server_root=Path.cwd(),
            )

        self.assertEqual(result["status"], "review_required")
        self.assertEqual(result["connection_name"], "ResQ Test")
        self.assertEqual(result["direction"]["action"], "arcrho_to_resq")
        self.assertEqual(result["direction"]["label"], "ArcRho -> ResQ")
        self.assertNotEqual(result["direction"]["arcrho_timestamp"], "Unknown")
        apply_plan.assert_not_called()
        self.assertEqual(
            result["preview"][0]["signature"],
            runtime["sync_contract"].plan_signature(row),
        )
        # The Export macro's timestamp check reads these per-row facts, and a
        # link that opens the item in ArcRho needs the type and method name.
        public = result["preview"][0]
        self.assertEqual(public["newer_side"], "arcrho")
        self.assertTrue(public["export_supported"])
        self.assertEqual((public["dataset_type"], public["method_name"]), ("Paid Loss", "Paid DFM"))
        migration._restore_runtime_scope.assert_called_once_with({"previous": True})

    def test_apply_with_no_accepted_row_performs_no_write_or_resq_connection(self):
        runtime, migration = self._runtime()

        with (
            patch.object(sync_session, "_plan_context") as plan_context,
            patch.object(sync_session, "_new_exporter") as new_exporter,
            patch.object(sync_session, "apply_sync_plan") as apply_plan,
        ):
            result = sync_session.apply_sync(
                runtime,
                "Demo",
                r"Auto\PP",
                server_root=Path.cwd(),
                reviewed_rows=[],
            )

        self.assertEqual(result["status"], "no_changes")
        plan_context.assert_not_called()
        new_exporter.assert_not_called()
        apply_plan.assert_not_called()
        migration._restore_runtime_scope.assert_called_once_with({"previous": True})

    def test_accepted_subset_routes_only_the_reviewed_row(self):
        runtime, _migration = self._runtime()
        paid = self._action_row("paid-loss", 200)
        case = self._action_row("case-loss", 300)
        observation = {
            "plan": [paid, case],
            "state": {"items": {}},
            "state_path": Path("state.json"),
        }
        exporter = Mock()

        with (
            patch.object(sync_session, "_plan_context", return_value=observation),
            patch.object(sync_session, "_new_exporter", return_value=exporter),
            patch.object(
                sync_session,
                "apply_sync_plan",
                return_value={"successes": 1, "failures": 0, "results": [], "successful_keys": ["paid-loss"]},
            ) as apply_plan,
        ):
            result = sync_session.apply_sync(
                runtime,
                "Demo",
                r"Auto\PP",
                server_root=Path.cwd(),
                reviewed_rows=[self._reviewed(runtime, paid)],
            )

        self.assertEqual(result["status"], "completed")
        selected = apply_plan.call_args.kwargs["selected_rows"]
        self.assertEqual([row["id"] for row in selected], ["paid-loss"])
        exporter.connect.assert_called_once_with()
        exporter.disconnect.assert_called_once_with()

    def test_timestamp_changed_since_the_review_aborts_before_apply(self):
        runtime, _migration = self._runtime()
        reviewed = self._action_row("paid-loss", 200)
        current = self._action_row("paid-loss", 201)
        exporter = Mock()

        with (
            patch.object(
                sync_session,
                "_plan_context",
                return_value={"plan": [current], "state": {"items": {}}, "state_path": Path("state.json")},
            ),
            patch.object(sync_session, "_new_exporter", return_value=exporter),
            patch.object(sync_session, "apply_sync_plan") as apply_plan,
        ):
            result = sync_session.apply_sync(
                runtime,
                "Demo",
                r"Auto\PP",
                server_root=Path.cwd(),
                reviewed_rows=[self._reviewed(runtime, reviewed)],
            )

        self.assertEqual(result["status"], "stale")
        self.assertEqual(result["stale_items"], ["paid-loss"])
        apply_plan.assert_not_called()
        exporter.disconnect.assert_called_once_with()

    def test_reviewed_row_without_a_signature_is_never_written(self):
        runtime, _migration = self._runtime()
        row = self._action_row("paid-loss", 200)
        exporter = Mock()

        with (
            patch.object(
                sync_session,
                "_plan_context",
                return_value={"plan": [row], "state": {"items": {}}, "state_path": Path("state.json")},
            ),
            patch.object(sync_session, "_new_exporter", return_value=exporter),
            patch.object(sync_session, "apply_sync_plan") as apply_plan,
        ):
            result = sync_session.apply_sync(
                runtime,
                "Demo",
                r"Auto\PP",
                server_root=Path.cwd(),
                reviewed_rows=[{"id": "paid-loss", "name": "paid-loss"}],
            )

        self.assertEqual(result["status"], "stale")
        apply_plan.assert_not_called()

    def test_a_session_requires_its_logical_scope(self):
        runtime, _migration = self._runtime()
        for kwargs in (
            {"project_name": "", "rc_path": r"Auto\PP", "server_root": Path.cwd()},
            {"project_name": "Demo", "rc_path": "", "server_root": Path.cwd()},
            {"project_name": "Demo", "rc_path": r"Auto\PP", "server_root": None},
        ):
            with self.subTest(**kwargs):
                with self.assertRaises(ValueError):
                    sync_session.preview_sync(
                        runtime,
                        kwargs["project_name"],
                        kwargs["rc_path"],
                        server_root=kwargs["server_root"],
                    )


class SyncSessionTransferPreviewTests(unittest.TestCase):
    """The whole-class review the Import and Export macros share."""

    def setUp(self):
        from resq_migration import sync as sync_contract
        from resq_migration import transfer_selection

        self.sync_contract = sync_contract
        self.transfer_selection = transfer_selection
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.root = Path(self.tempdir.name)

    def _runtime(self):
        migration = Mock()
        migration.CONNECTION_NAME = "ResQ Test"
        migration._apply_runtime_scope.return_value = {"previous": True}
        return {
            "migration": migration,
            "sync_contract": self.sync_contract,
            "transfer_selection": self.transfer_selection,
        }

    def _arcrho(self, name, **fields):
        item = {
            "name": name,
            "kind": "Dataset",
            "modified": "2026-08-28T10:00:00+00:00",
            "modified_timestamp": 100.0,
            "timestamp_source": "Dataset metadata",
            "can_export_to_resq": True,
            "export_block_reason": "",
        }
        item.update(fields)
        return item

    def _resq(self, name, **fields):
        item = {
            "name": name,
            "kind": "Dataset",
            "modified": "2026-08-28T11:00:00+00:00",
            "modified_timestamp": 200.0,
            "timestamp_source": "ResQ Modified",
            "can_import_to_arcrho": True,
            "import_block_reason": "",
            "can_receive_from_arcrho": True,
            "receive_block_reason": "",
        }
        item.update(fields)
        return item

    def _context(self, arcrho, resq):
        plan = self.sync_contract.build_sync_plan(arcrho, resq, {})
        return {
            "arcrho": arcrho,
            "resq": resq,
            "plan": plan,
            "direction": self.sync_contract.plan_direction(plan),
        }

    def _preview(self, direction, arcrho, resq):
        runtime = self._runtime()
        with patch.object(sync_session, "_plan_context", return_value=self._context(arcrho, resq)):
            return sync_session.preview_transfer(
                runtime, "Demo", r"Auto\PP", direction=direction, server_root=self.root
            )

    def test_an_item_only_one_side_holds_is_still_a_row(self):
        result = self._preview(
            "import",
            [self._arcrho("Paid Loss"), self._arcrho("ArcRho Only")],
            [self._resq("Paid Loss"), self._resq("ResQ Only")],
        )

        rows = {row["name"]: row for row in result["preview"]}
        self.assertEqual(set(rows), {"Paid Loss", "ArcRho Only", "ResQ Only"})
        self.assertEqual(rows["Paid Loss"]["presence"], "both")
        self.assertEqual(rows["ArcRho Only"]["presence"], "arcrho")
        self.assertEqual(rows["ResQ Only"]["presence"], "resq")

    def test_an_import_can_bring_a_resq_only_item_across_and_an_export_cannot(self):
        arcrho = [self._arcrho("ArcRho Only")]
        resq = [self._resq("ResQ Only")]

        importing = {row["name"]: row for row in self._preview("import", arcrho, resq)["preview"]}
        exporting = {row["name"]: row for row in self._preview("export", arcrho, resq)["preview"]}

        self.assertTrue(importing["ResQ Only"]["transfer_supported"])
        self.assertFalse(importing["ArcRho Only"]["transfer_supported"])
        self.assertFalse(exporting["ResQ Only"]["transfer_supported"])
        self.assertFalse(exporting["ArcRho Only"]["transfer_supported"])
        self.assertIn("no matching dataset", exporting["ArcRho Only"]["transfer_block_reason"])

    def test_a_berquist_sherman_method_is_exportable_because_the_export_saves_it(self):
        arcrho = [self._arcrho("BS Paid", kind="B&S Settlement Rate", can_export_to_resq=False,
                               export_block_reason="ArcRho-to-ResQ write-back is not supported for B&S Settlement Rate.")]
        resq = [self._resq("BS Paid", kind="B&S Settlement Rate", can_receive_from_arcrho=False,
                           receive_block_reason="ArcRho cannot write B&S Settlement Rate methods to ResQ.")]

        row = self._preview("export", arcrho, resq)["preview"][0]

        self.assertTrue(row["transfer_supported"])
        self.assertEqual(row["transfer_block_reason"], "")

    def test_an_ambiguous_name_is_still_named_and_left_untickable(self):
        result = self._preview(
            "export",
            [self._arcrho("Paid  Loss"), self._arcrho("Paid Loss")],
            [self._resq("Paid Loss")],
        )

        row = result["preview"][0]
        self.assertEqual(row["name"], "Paid Loss")
        self.assertEqual(row["presence"], "both")
        self.assertFalse(row["transfer_supported"])
        self.assertFalse(row["selected"])
        self.assertIn("same normalized name", row["detail"])

    def test_everything_is_ticked_until_a_selection_has_been_saved(self):
        result = self._preview(
            "export",
            [self._arcrho("Paid Loss"), self._arcrho("Reported Loss")],
            [self._resq("Paid Loss"), self._resq("Reported Loss")],
        )

        self.assertTrue(all(row["selected"] for row in result["preview"]))
        self.assertEqual(result["selection"]["names"], [])

    def test_the_saved_selection_decides_what_comes_back_ticked(self):
        self.transfer_selection.save_selection(
            self.root, "Demo", r"Auto\PP", "ResQ Test", "export", ["Paid Loss"], updated_by="ali"
        )

        result = self._preview(
            "export",
            [self._arcrho("Paid Loss"), self._arcrho("Reported Loss")],
            [self._resq("Paid Loss"), self._resq("Reported Loss")],
        )

        ticked = {row["name"]: row["selected"] for row in result["preview"]}
        self.assertEqual(ticked, {"Paid Loss": True, "Reported Loss": False})
        self.assertEqual(result["selection"]["names"], ["Paid Loss"])
        self.assertEqual(result["selection"]["updated_by"], "ali")

    def test_one_direction_selection_never_ticks_the_other(self):
        self.transfer_selection.save_selection(
            self.root, "Demo", r"Auto\PP", "ResQ Test", "import", ["Paid Loss"]
        )

        exporting = self._preview(
            "export",
            [self._arcrho("Paid Loss"), self._arcrho("Reported Loss")],
            [self._resq("Paid Loss"), self._resq("Reported Loss")],
        )

        self.assertEqual(exporting["selection"]["names"], [])
        self.assertTrue(all(row["selected"] for row in exporting["preview"]))

    def test_an_unsupported_row_is_never_ticked(self):
        self.transfer_selection.save_selection(
            self.root, "Demo", r"Auto\PP", "ResQ Test", "export", ["Paid Loss", "No Cache"]
        )

        result = self._preview(
            "export",
            [self._arcrho("Paid Loss"), self._arcrho("No Cache", can_export_to_resq=False,
                                                    export_block_reason="The ArcRho dataset CSV cache is missing.")],
            [self._resq("Paid Loss"), self._resq("No Cache")],
        )

        ticked = {row["name"]: row["selected"] for row in result["preview"]}
        self.assertEqual(ticked, {"Paid Loss": True, "No Cache": False})


class SyncSessionExportGuardTests(unittest.TestCase):
    def test_triangle_sync_fails_before_export_when_resq_cannot_clear_data(self):
        target = Mock()
        target.ClearData.side_effect = RuntimeError("COM failure")
        exporter = Mock()
        exporter.counts = {"errors": 0, "datasets_written": 0}
        exporter.skipped = {}
        exporter.error_details = []
        exporter._find_triangle.return_value = target
        row = {
            "name": "Paid Loss",
            "kind": "Dataset",
            "arcrho": {
                "payload": {"data_format": "Triangle"},
            },
        }

        with patch.object(sync_session, "_preflight_dataset_export", return_value=[[100.0]]):
            with self.assertRaisesRegex(RuntimeError, "could not clear the target triangle"):
                sync_session._export_one_to_resq(exporter, row)

        exporter.export_datasets.assert_not_called()

    def test_triangle_verification_rejects_nonblank_value_in_arcrho_blank_cell(self):
        target = Mock()
        target.OriginCount = 1
        target.ValuesByIndex.return_value = 25.0
        exporter = Mock()
        exporter._find_triangle.return_value = target
        exporter._triangle_row_width.return_value = 1
        row = {
            "name": "Paid Loss",
            "arcrho": {"payload": {"data_format": "Triangle"}},
        }

        with self.assertRaisesRegex(RuntimeError, "retained a value in ArcRho blank cell"):
            sync_session._verify_dataset_export(exporter, row, [[None]])


class SyncSessionReviewCellTests(unittest.TestCase):
    def test_review_timestamps_are_shown_in_local_time(self):
        from arcrho_api.timestamps import format_display_timestamp

        persisted = "2026-08-13T18:49:34.302Z"
        shown = format_display_timestamp(persisted)
        self.assertNotEqual(shown, persisted)

        self.assertEqual(
            sync_session._timestamp_cell({"modified": persisted, "modified_timestamp": 1.0, "timestamp_source": "ResQ Modified"}),
            shown,
        )
        self.assertEqual(
            sync_session._timestamp_cell({"modified": persisted, "modified_timestamp": 1.0, "timestamp_source": "File modified"}),
            f"{shown} (File modified)",
        )
        self.assertEqual(
            sync_session._timestamp_cell({"modified": persisted, "modified_timestamp": None, "timestamp_source": "ResQ Created"}),
            f"Unknown Modified; Created {shown}",
        )
        self.assertEqual(sync_session._timestamp_cell({"modified": "", "modified_timestamp": None}), "Unknown")


class SyncSessionInventoryTests(unittest.TestCase):
    def test_berquist_sherman_inventory_uses_validated_method_name(self):
        output = types.SimpleNamespace(
            Name="Adjusted Paid",
            MethodType=8,
            Modified="2026-08-12T10:00:00",
            Created="2026-08-11T10:00:00",
            DatasetType=types.SimpleNamespace(Name="Adjusted Paid"),
            Calculated=True,
        )
        method = types.SimpleNamespace(
            Name="Settlement  Configuration ",
            OutputTriangle=output,
        )

        class Collection:
            def __init__(self, items):
                self.items = list(items)
                self.Count = len(self.items)

            def __iter__(self):
                return iter(self.items)

            def Item(self, value):
                if isinstance(value, int):
                    return self.items[value - 1]
                for item in self.items:
                    if str(getattr(item, "Name", "")).casefold() == str(value).casefold():
                        return item
                raise KeyError(value)

        empty = Collection([])

        class ReservingClass:
            def Triangles(self):
                return Collection([output])

            def Vectors(self):
                return empty

            def DFMMethods(self):
                return empty

            def BFMethods(self):
                return empty

            def CapeCodMethods(self):
                return empty

            def ResultSelections(self):
                return empty

            def BerquistShermanSRs(self):
                return Collection([method])

            def GetBerquistShermanSR(self, name):
                # This deliberately resolves method names, not output names.
                return self.BerquistShermanSRs().Item(name)

        migration = types.SimpleNamespace(
            _safe_attr=lambda source, name, default=None: getattr(source, name, default),
            _iso_or_text=lambda value: str(value or ""),
            _is_known_dataset_type=lambda _name: True,
            _is_unreviewed_dataset=lambda _name, _type: False,
            _find_berquist_sherman_for_triangle=(
                __import__(
                    "resq_migration.extractors",
                    fromlist=["_find_berquist_sherman_for_triangle"],
                )._find_berquist_sherman_for_triangle
            ),
        )
        runtime = {
            "migration": migration,
            "exporter_module": types.SimpleNamespace(
                _clean_label=lambda value: " ".join(str(value or "").split())
            ),
            "sync_contract": types.SimpleNamespace(
                logical_key=lambda value: str(value or "").strip().casefold()
            ),
            "parse_timestamp": sync_session._parsed_timestamp,
        }
        exporter = types.SimpleNamespace(reserving_class=ReservingClass())

        inventory = sync_session.collect_resq_inventory(runtime, exporter)

        self.assertEqual(len(inventory), 1)
        self.assertEqual(inventory[0]["name"], "Adjusted Paid")
        self.assertEqual(inventory[0]["resq_method_name"], "Settlement Configuration")
        self.assertIs(inventory[0]["resq_method"], method)
        self.assertTrue(inventory[0]["can_import_to_arcrho"])
        target = sync_session._resq_import_target({
            "kind": sync_session.KIND_BS_SR,
            "name": inventory[0]["name"],
            "resq": inventory[0],
        })
        self.assertEqual(target["method_names"], ["Settlement Configuration"])


class SyncSessionWriteRecheckTests(unittest.TestCase):
    """The write phase rechecks the plan rows it selected, not review-table echoes.

    Every apply since the session moved onto the Bridge returned ``stale`` for
    every accepted row: the write phase handed its own plan rows to the stale
    check, and those rows never carry the separate ``signature`` field a
    review-table echo does. A plan row is its own observation.
    """

    def _runtime_and_plan(self):
        from resq_migration import sync as sync_contract

        arcrho = [{
            "name": "C 22 - CWOP DFM w/ Selected LDFs",
            "kind": sync_session.KIND_DFM,
            "data_format": "Vector",
            "method_name": "C 22 - CWOP DFM w/ Selected LDFs",
            "dataset_type": "C 22 - CWOP DFM w/ Selected LDFs",
            "modified": "2026-08-25T20:00:56.141Z",
            "modified_timestamp": 1787688056.141,
            "can_export_to_resq": True,
            "export_block_reason": "",
        }]
        resq = [{
            "name": "C 22 - CWOP DFM w/ Selected LDFs",
            "kind": sync_session.KIND_DFM,
            "data_format": "Vector",
            "method_name": "C 22 - CWOP DFM w/ Selected LDFs",
            "dataset_type": "C 22 - CWOP DFM w/ Selected LDFs",
            "modified": "2026-08-19T13:37:49.471Z",
            "modified_timestamp": 1787146669.471,
            "can_import_to_arcrho": True,
            "can_receive_from_arcrho": True,
        }]
        plan = sync_contract.build_sync_plan(arcrho, resq, {"items": {}})
        return {"sync_contract": sync_contract}, plan, arcrho, resq

    def test_an_unchanged_plan_row_is_not_stale_against_a_fresh_plan(self):
        from resq_migration import sync as sync_contract

        runtime, plan, arcrho, resq = self._runtime_and_plan()
        self.assertEqual(plan[0]["action"], "arcrho_to_resq")
        self.assertNotIn("signature", plan[0])

        selected = sync_session._selected_rows(plan, [plan[0]["id"]])
        fresh_plan = sync_contract.build_sync_plan(arcrho, resq, {"items": {}})

        self.assertEqual(sync_session._stale_selected_rows(runtime, selected, fresh_plan), [])

    def test_a_plan_row_whose_source_moved_is_still_stale(self):
        from resq_migration import sync as sync_contract

        runtime, plan, arcrho, resq = self._runtime_and_plan()
        selected = sync_session._selected_rows(plan, [plan[0]["id"]])
        moved = [dict(arcrho[0], modified_timestamp=1787688056.141 + 60)]
        fresh_plan = sync_contract.build_sync_plan(moved, resq, {"items": {}})

        self.assertEqual(
            sync_session._stale_selected_rows(runtime, selected, fresh_plan),
            ["C 22 - CWOP DFM w/ Selected LDFs"],
        )

    def test_a_row_without_any_observation_is_still_stale(self):
        runtime, plan, _arcrho, _resq = self._runtime_and_plan()

        self.assertEqual(
            sync_session._stale_selected_rows(runtime, [{"id": plan[0]["id"], "name": "Echo"}], plan),
            ["Echo"],
        )

    def test_a_target_side_restamped_by_the_batch_does_not_block_the_write(self):
        """Saving the DFMs made ResQ recalculate the Result Selection after them.

        C 91 read C 61 and C 62, which ResQ derives from the C 22 and C 32 DFM
        outputs, so the two DFM writes moved C 91's ResQ timestamp before its
        own turn and the row was refused with "Timestamp changed" every run.
        """
        from resq_migration import sync as sync_contract

        runtime, plan, arcrho, resq = self._runtime_and_plan()
        selected = sync_session._selected_rows(plan, [plan[0]["id"]])
        restamped = [dict(resq[0], modified_timestamp=1787688056.141 + 60)]
        fresh_plan = sync_contract.build_sync_plan(arcrho, restamped, {"items": {}})
        current = sync_session._plan_by_id(fresh_plan)[plan[0]["id"]]
        self.assertNotEqual(current["action"], plan[0]["action"])

        self.assertFalse(sync_session._row_moved_before_write(runtime, selected[0], current))

    def test_a_source_side_that_moved_still_blocks_the_write(self):
        from resq_migration import sync as sync_contract

        runtime, plan, arcrho, resq = self._runtime_and_plan()
        selected = sync_session._selected_rows(plan, [plan[0]["id"]])
        moved = [dict(arcrho[0], modified_timestamp=1787688056.141 + 60)]
        fresh_plan = sync_contract.build_sync_plan(moved, resq, {"items": {}})
        current = sync_session._plan_by_id(fresh_plan)[plan[0]["id"]]

        self.assertTrue(sync_session._row_moved_before_write(runtime, selected[0], current))
        self.assertTrue(sync_session._row_moved_before_write(runtime, selected[0], None))


class SyncSessionRuntimeTests(unittest.TestCase):
    def test_build_runtime_binds_one_coherent_migration_root(self):
        migration = types.SimpleNamespace(__file__=str(_PYTHON_API_ROOT / "migration" / "resq_data_migration.py"))
        exporter_module = types.SimpleNamespace(__file__="exporter.py")

        runtime = sync_session.build_runtime(migration, exporter_module)

        migration_root = (_PYTHON_API_ROOT / "migration").resolve()
        self.assertIs(runtime["migration"], migration)
        self.assertIs(runtime["exporter_module"], exporter_module)
        self.assertTrue(
            Path(runtime["sync_contract"].__file__).resolve().is_relative_to(migration_root)
        )
        self.assertTrue(callable(runtime["parse_timestamp"]))
        self.assertTrue(callable(runtime["method_entry"]))

    def test_the_session_declares_the_api_version_the_bridge_pins(self):
        self.assertEqual(sync_session.SYNC_SESSION_API_VERSION, 4)

    def test_the_exporter_connects_with_the_account_the_host_supplied(self):
        migration = types.SimpleNamespace(
            __file__=str(_PYTHON_API_ROOT / "migration" / "resq_data_migration.py"),
            CONNECTION_NAME="ResQ Default",
            USER_NAME="",
            PASSWORD="",
        )
        exporter_module = types.SimpleNamespace(__file__="exporter.py", ResQReservingClassExporter=Mock())
        account = {"connection_name": "ResQ Prod", "user_name": "svc", "password": "secret"}
        runtime = sync_session.build_runtime(migration, exporter_module, resq_credentials=account)

        sync_session._new_exporter(runtime, "Demo", r"Auto\PP", Path("server"))

        kwargs = exporter_module.ResQReservingClassExporter.call_args.kwargs
        self.assertEqual(
            (kwargs["connection_name"], kwargs["resq_user_name"], kwargs["resq_password"]),
            ("ResQ Prod", "svc", "secret"),
        )

    def test_a_host_without_an_account_leaves_the_migration_defaults_in_charge(self):
        migration = types.SimpleNamespace(
            __file__=str(_PYTHON_API_ROOT / "migration" / "resq_data_migration.py"),
            CONNECTION_NAME="ResQ Default",
            USER_NAME="",
            PASSWORD="",
        )
        exporter_module = types.SimpleNamespace(__file__="exporter.py", ResQReservingClassExporter=Mock())
        runtime = sync_session.build_runtime(migration, exporter_module)

        sync_session._new_exporter(runtime, "Demo", r"Auto\PP", Path("server"))

        kwargs = exporter_module.ResQReservingClassExporter.call_args.kwargs
        self.assertEqual(
            (kwargs["connection_name"], kwargs["resq_user_name"], kwargs["resq_password"]),
            ("ResQ Default", "", ""),
        )


def _write_row(row_id: str, *, kind: str = "Dataset", payload: dict | None = None) -> dict:
    return {
        "id": row_id,
        "key": row_id.casefold(),
        "name": row_id,
        "kind": kind,
        "arcrho": {"payload": dict(payload or {})},
        "resq": None,
        "action": "arcrho_to_resq",
        "selected": True,
        "disabled": False,
    }


class SyncSessionWriteOrderTests(unittest.TestCase):
    """The write phase follows ArcRho's dependency graph, not the review order."""

    def _contract(self):
        from resq_migration import sync as sync_contract

        return sync_contract

    def test_rows_follow_the_arcrho_dependency_graph_within_one_direction(self):
        # The plan lists rows alphabetically; every dependency here sorts after
        # at least one row that reads it.
        rows = [
            _write_row(
                "BF Ultimate",
                kind="Bornhuetter Ferguson",
                payload={"method_tab": {
                    "latest_dataset": "Paid Loss",
                    "dfm_dataset": "Paid LDF",
                    "prior_datasets": [{"name": "Prior Ult"}],
                }},
            ),
            _write_row("Paid LDF", kind="DFM", payload={"details_tab": {"input_triangle": "Paid Loss"}}),
            _write_row("Paid Loss"),
            _write_row("Prior Ult"),
            _write_row(
                "Selected Ult",
                kind="Result Selection",
                payload={"method_tab": {"loaded_datasets": [{"name": "BF Ultimate"}, {"name": "Prior Ult"}]}},
            ),
        ]

        ordered = sync_session._dependency_ordered_rows(self._contract(), rows)

        self.assertEqual(
            [row["id"] for row in ordered],
            ["Paid Loss", "Prior Ult", "Paid LDF", "BF Ultimate", "Selected Ult"],
        )

    def test_unlinked_rows_keep_datasets_first_and_then_the_review_order(self):
        rows = [
            _write_row("Zeta", kind="DFM", payload={"details_tab": {"input_triangle": "Elsewhere"}}),
            _write_row("Beta"),
            _write_row("Alpha"),
        ]

        ordered = sync_session._dependency_ordered_rows(self._contract(), rows)

        self.assertEqual([row["id"] for row in ordered], ["Beta", "Alpha", "Zeta"])

    def test_a_dependency_cycle_keeps_every_row_instead_of_failing(self):
        rows = [
            _write_row("Alpha", payload={"precedents": [{"dataset_name": "Beta"}]}),
            _write_row("Beta", payload={"precedents": [{"dataset_name": "Alpha"}]}),
        ]

        ordered = sync_session._dependency_ordered_rows(self._contract(), rows)

        self.assertEqual(sorted(row["id"] for row in ordered), ["Alpha", "Beta"])

    def test_method_preflight_accepts_a_link_created_earlier_in_the_batch(self):
        exporter = Mock()
        exporter._find_triangle.return_value = None
        exporter._find_in.return_value = None
        row = _write_row("Paid LDF", kind="DFM", payload={"details_tab": {"input_triangle": "Paid Loss"}})

        with self.assertRaisesRegex(RuntimeError, "not present in ResQ: Paid Loss"):
            sync_session._preflight_method_export(exporter, row)

        sync_session._preflight_method_export(exporter, row, satisfied=lambda name: name == "Paid Loss")


class SyncSessionRippleTests(unittest.TestCase):
    """A write re-stamps everything downstream of it, on both sides."""

    def test_downstream_rows_are_reached_through_calculated_datasets(self):
        from resq_migration import sync as sync_contract

        runtime = {
            "sync_contract": sync_contract,
            "migration": types.SimpleNamespace(
                DATASET_SIDECAR_DIR="sidecars",
                _normalize_cached_dataset_name=lambda stem: stem,
            ),
        }
        rows = [
            _write_row("C 22", kind=sync_session.KIND_DFM, payload={"details_tab": {"input_triangle": "Paid"}}),
            _write_row("C 91", kind=sync_session.KIND_RS, payload={"method_tab": {"loaded_datasets": [{"name": "C 61"}]}}),
            _write_row("C 92", kind=sync_session.KIND_RS, payload={"method_tab": {"loaded_datasets": [{"name": "C 91"}]}}),
            _write_row("C 12", kind=sync_session.KIND_DFM, payload={"details_tab": {"input_triangle": "Paid"}}),
        ]
        with tempfile.TemporaryDirectory() as temp:
            rc_dir = Path(temp)
            (rc_dir / "sidecars").mkdir()
            # C 61 is calculated from C 22 and never reaches the review, yet it
            # is the link through which a written DFM re-stamps C 91 and C 92.
            (rc_dir / "sidecars" / "C 61.json").write_text(
                json.dumps({
                    "dataset_name": "C 61",
                    "calculated": True,
                    "precedents": [{"dataset_name": "C 22"}],
                    "dependents": [{"dataset_name": "C 91"}],
                }),
                encoding="utf-8",
            )

            edges = sync_session._reserving_class_edges(runtime, rc_dir, rows)

        self.assertEqual(sync_session._downstream_keys(edges, rows, {"c 22"}), {"c 91", "c 92"})
        self.assertEqual(sync_session._downstream_keys(edges, rows, {"c 12"}), set())

    def test_write_order_looks_through_calculated_datasets(self):
        from resq_migration import sync as sync_contract

        runtime = {
            "sync_contract": sync_contract,
            "migration": types.SimpleNamespace(
                DATASET_SIDECAR_DIR="sidecars",
                _normalize_cached_dataset_name=lambda stem: stem,
            ),
        }
        # The fake project's COL class: the B&S adjustment reads C 92, which
        # loads C 91, which loads the calculated C 62 -- and C 62 is derived
        # from the C 52 DFM. Visiting the adjustment early must not drag C 91
        # in front of C 52, or ResQ marks C 91 "Needs Review" the moment C 52
        # is saved after it.
        rows = [
            _write_row("Gross Loss--Paid - B&S", kind=sync_session.KIND_BS_SR, payload={"precedents": [{"dataset_name": "C 92"}]}),
            _write_row("C 52", kind=sync_session.KIND_DFM, payload={"details_tab": {"input_triangle": "CWOP %"}}),
            _write_row("C 91", kind=sync_session.KIND_RS, payload={"method_tab": {"loaded_datasets": [{"name": "C 62"}]}}),
            _write_row("C 92", kind=sync_session.KIND_RS, payload={"method_tab": {"loaded_datasets": [{"name": "C 91"}]}}),
        ]
        with tempfile.TemporaryDirectory() as temp:
            rc_dir = Path(temp)
            (rc_dir / "sidecars").mkdir()
            (rc_dir / "sidecars" / "C 62.json").write_text(
                json.dumps({
                    "dataset_name": "C 62",
                    "calculated": True,
                    "precedents": [{"dataset_name": "C 52"}],
                }),
                encoding="utf-8",
            )
            edges = sync_session._reserving_class_edges(runtime, rc_dir, rows)

        ordered = sync_session._dependency_ordered_rows(sync_contract, rows, edges)

        self.assertEqual([row["id"] for row in ordered], ["C 52", "C 91", "C 92", "Gross Loss--Paid - B&S"])


class SyncSessionResQNameMappingTests(unittest.TestCase):
    """ResQ names with stray double spaces map one-to-one onto ArcRho's clean names.

    ResQ holds "C 81 -  Prior Qtr Indicated" while ArcRho keeps the normalized
    "C 81 - Prior Qtr Indicated". The review paired them, but the Result
    Selection preflight compared raw names and refused C 92 on every run as
    having ResQ sources ArcRho could not remove.
    """

    def test_the_name_key_is_the_contract_pairing_key(self):
        from resq_migration import sync as sync_contract

        for raw in (
            "C 81 -  Prior Qtr Indicated",
            "  C 81 - Prior   Qtr Indicated ",
            "c 81 - prior qtr indicated",
        ):
            self.assertEqual(sync_session._name_key(raw), sync_contract.logical_key(raw))
            self.assertEqual(sync_session._name_key(raw), "c 81 - prior qtr indicated")

    def _result_selection_exporter(self, resq_sources):
        datasets = [Mock(Name=name) for name in resq_sources]
        target = Mock()
        target.DatasetCount = len(datasets)
        target.OriginCount = 40
        target.Dataset.side_effect = lambda index: datasets[index - 1]
        exporter = Mock()
        exporter._find_dataset.return_value = Mock()
        exporter._find_method_by_output.return_value = target
        return exporter

    def _result_selection_row(self, sources):
        return _write_row(
            "C 92 - Current Qtr Selected",
            kind=sync_session.KIND_RS,
            payload={"method_tab": {"loaded_datasets": [{"name": name, "weights": []} for name in sources]}},
        )

    def test_result_selection_sources_differing_only_by_spacing_pass_preflight(self):
        exporter = self._result_selection_exporter([
            "C 81 -  Prior Qtr Indicated",
            "C 82 -  Prior Qtr Selected",
            "C 91 -  Current Qtr Indicated",
        ])
        row = self._result_selection_row([
            "C 81 - Prior Qtr Indicated",
            "C 82 - Prior Qtr Selected",
            "C 91 - Current Qtr Indicated",
        ])

        sync_session._preflight_method_export(exporter, row)

    def test_a_source_only_resq_holds_is_reported_in_resq_spelling(self):
        exporter = self._result_selection_exporter([
            "C 81 -  Prior Qtr Indicated",
            "C 83 -  Prior Qtr Other",
        ])
        row = self._result_selection_row(["C 81 - Prior Qtr Indicated"])

        with self.assertRaisesRegex(RuntimeError, r"cannot remove: C 83 -  Prior Qtr Other$"):
            sync_session._preflight_method_export(exporter, row)


class _ResQCollection:
    def __init__(self, items):
        self.items = list(items)
        self.Count = len(self.items)

    def Item(self, value):
        if isinstance(value, int):
            return self.items[value - 1]
        for item in self.items:
            if str(getattr(item, "Name", "")).casefold() == str(value).casefold():
                return item
        raise KeyError(value)


class SyncSessionCalculatedDatasetTests(unittest.TestCase):
    """Calculated and engine datasets never reach the review: both sides rebuild them."""

    def _sync_contract(self):
        from resq_migration import sync as sync_contract

        return sync_contract

    def test_arcrho_inventory_leaves_out_calculated_and_engine_sidecars(self):
        import json
        import tempfile

        with tempfile.TemporaryDirectory() as temp:
            rc_dir = Path(temp)
            sidecars = rc_dir / "sidecars"
            cache = rc_dir / "cache"
            sidecars.mkdir()
            cache.mkdir()
            plain = {
                "dataset_name": "Paid Loss",
                "method_type": "None",
                "data_format": "Triangle",
                "calculated": False,
                "csv_file": "Paid Loss.csv",
                "last_modified": "2026-08-27T09:18:22",
            }
            calculated = dict(
                plain,
                dataset_name="Reported CDF",
                calculated=True,
                formula='"Reported" / "CWOP"',
                csv_file="Reported CDF.csv",
            )
            engine = dict(
                plain,
                dataset_name="Reported Loss",
                source_kind="engine",
                csv_file="Reported Loss.csv",
            )
            (sidecars / "Paid Loss.json").write_text(json.dumps(plain), encoding="utf-8")
            (sidecars / "Reported CDF.json").write_text(json.dumps(calculated), encoding="utf-8")
            (sidecars / "Reported Loss.json").write_text(json.dumps(engine), encoding="utf-8")
            (cache / "Paid Loss.csv").write_text("1\n", encoding="utf-8")
            (cache / "Reported CDF.csv").write_text("1\n", encoding="utf-8")
            (cache / "Reported Loss.csv").write_text("1\n", encoding="utf-8")
            migration = types.SimpleNamespace(
                DATASET_SIDECAR_DIR="sidecars",
                METHOD_DATA_DIR="methods",
                DATASET_CACHE_DIR="cache",
                _normalize_cached_dataset_name=lambda value: str(value),
                _cached_dataset_names_from_file=lambda name: [Path(name).stem],
            )
            runtime = {
                "migration": migration,
                "parse_timestamp": sync_session._parsed_timestamp,
                "method_entry": lambda payload, filename: None,
                "sync_contract": self._sync_contract(),
            }

            inventory = sync_session.collect_arcrho_inventory(runtime, rc_dir)

        # Neither left-out dataset's CSV cache may resurface it as a sidecar-less row.
        self.assertEqual([item["name"] for item in inventory], ["Paid Loss"])
        self.assertTrue(inventory[0]["can_export_to_resq"])

    def test_resq_inventory_leaves_out_calculated_and_generated_datasets(self):
        """ArcRho's dataset-types library decides what is calculated, not ResQ.

        ``Reported CDF`` is calculated in both libraries and ``Reported Loss``
        is engine-generated, so the one unreviewed-dataset rule keeps both out.
        ``Prior Qtr Indicated`` is derived in ResQ from a formula ArcRho does
        not have, while ArcRho's library lists it as a plain input: it is an
        editable input on the ArcRho side, so it stays in the review and can be
        imported, but ArcRho values cannot be pushed into a dataset ResQ
        recomputes.
        """
        def dataset(name: str, calculated: bool):
            return types.SimpleNamespace(
                Name=name,
                MethodType=0,
                Modified="2026-08-27T09:19:05",
                Created="2026-08-11T10:00:00",
                DatasetType=types.SimpleNamespace(Name=name),
                Calculated=calculated,
            )

        empty = _ResQCollection([])
        reserving_class = types.SimpleNamespace(
            Triangles=lambda: _ResQCollection([
                dataset("Paid Loss", False),
                dataset("Reported CDF", True),
                dataset("Reported Loss", False),
            ]),
            Vectors=lambda: _ResQCollection([
                dataset("Prior Qtr Indicated", True),
            ]),
            DFMMethods=lambda: empty,
            BFMethods=lambda: empty,
            CapeCodMethods=lambda: empty,
            ResultSelections=lambda: empty,
        )
        migration = types.SimpleNamespace(
            _safe_attr=lambda source, name, default=None: getattr(source, name, default),
            _iso_or_text=lambda value: str(value or ""),
            _is_known_dataset_type=lambda _name: True,
            _is_unreviewed_dataset=lambda name, _type: name in {"Reported CDF", "Reported Loss"},
        )
        runtime = {
            "migration": migration,
            "exporter_module": types.SimpleNamespace(
                _clean_label=lambda value: " ".join(str(value or "").split())
            ),
            "sync_contract": self._sync_contract(),
            "parse_timestamp": sync_session._parsed_timestamp,
        }
        exporter = types.SimpleNamespace(reserving_class=reserving_class)

        inventory = sync_session.collect_resq_inventory(runtime, exporter)

        self.assertEqual([item["name"] for item in inventory], ["Paid Loss", "Prior Qtr Indicated"])
        self.assertTrue(inventory[0]["can_receive_from_arcrho"])
        prior_qtr = inventory[1]
        self.assertTrue(prior_qtr["can_import_to_arcrho"])
        self.assertFalse(prior_qtr["can_receive_from_arcrho"])
        self.assertIn("ResQ computes this dataset", prior_qtr["receive_block_reason"])
        self.assertTrue(prior_qtr["calculated"])


class SyncSessionMethodNotesTests(unittest.TestCase):
    """DFM Method Notes live in the output sidecar and ride along on an ArcRho-to-ResQ write."""

    def test_arcrho_inventory_attaches_output_sidecar_notes_to_the_method_row(self):
        from resq_migration import sync as sync_contract

        with tempfile.TemporaryDirectory() as temp:
            rc_dir = Path(temp)
            for folder in ("sidecars", "methods", "cache"):
                (rc_dir / folder).mkdir()
            for method_name, output_name in (("Paid DFM", "Paid CDF"), ("Orphan DFM", "Orphan CDF")):
                method = {"details_tab": {"name": method_name, "output_dataset": output_name}}
                (rc_dir / "methods" / f"DFM@{method_name}.json").write_text(json.dumps(method), encoding="utf-8")
            sidecar = {
                "dataset_name": "Paid CDF",
                "method_type": "DFM",
                "data_format": "Origin Vector",
                "notes": "Excluded 2020.\nSelected 3-year.",
                "precedents": [{"dataset_name": "Paid Loss"}],
                "last_modified": "2026-08-27T09:18:22",
            }
            (rc_dir / "sidecars" / "Paid CDF.json").write_text(json.dumps(sidecar), encoding="utf-8")
            plain = {
                "dataset_name": "Paid Loss",
                "method_type": "None",
                "data_format": "Triangle",
                "csv_file": "Paid Loss.csv",
                "notes": "Loaded from claims.",
                "last_modified": "2026-08-27T09:18:22",
            }
            (rc_dir / "sidecars" / "Paid Loss.json").write_text(json.dumps(plain), encoding="utf-8")
            (rc_dir / "cache" / "Paid Loss.csv").write_text("1\n", encoding="utf-8")
            migration = types.SimpleNamespace(
                DATASET_SIDECAR_DIR="sidecars",
                METHOD_DATA_DIR="methods",
                DATASET_CACHE_DIR="cache",
                _normalize_cached_dataset_name=lambda value: str(value),
                _cached_dataset_names_from_file=lambda name: [Path(name).stem],
            )
            runtime = {
                "migration": migration,
                "parse_timestamp": sync_session._parsed_timestamp,
                "method_entry": lambda payload, filename: {
                    "dataset_name": payload["details_tab"]["output_dataset"],
                    "method_name": payload["details_tab"]["name"],
                    "method_type": "DFM",
                },
                "sync_contract": sync_contract,
            }

            inventory = sync_session.collect_arcrho_inventory(runtime, rc_dir)

        by_name = {item["name"]: item for item in inventory}
        # The output sidecar folds into its method row instead of listing twice.
        self.assertEqual(sorted(by_name), ["Orphan CDF", "Paid CDF", "Paid Loss"])
        self.assertEqual(by_name["Paid CDF"]["notes"], "Excluded 2020.\nSelected 3-year.")
        # The output sidecar's graph edges ride along too, for the write order.
        self.assertEqual(by_name["Paid CDF"]["precedents"], ["Paid Loss"])
        self.assertNotIn("notes", by_name["Orphan CDF"])
        self.assertNotIn("precedents", by_name["Orphan CDF"])
        # A plain dataset's sidecar is its own notes owner.
        self.assertEqual(by_name["Paid Loss"]["notes"], "Loaded from claims.")

    def _dfm_row(self, **item):
        return {
            "name": "Paid CDF",
            "kind": sync_session.KIND_DFM,
            "arcrho": {"method_name": "Paid DFM", "payload": {"details_tab": {"name": "Paid DFM"}}, **item},
        }

    def _writer(self):
        exporter = Mock()
        exporter.counts = {"errors": 0, "dfms_written": 0}
        exporter.skipped = {}
        exporter.error_details = []
        exporter.export_dfms.side_effect = lambda entries: exporter.counts.__setitem__("dfms_written", len(entries))
        return exporter

    def test_export_hands_the_sidecar_notes_to_the_dfm_writer(self):
        exporter = self._writer()

        with patch.object(sync_session, "_preflight_method_export"), patch.object(sync_session, "_verify_method_export"):
            ok, _message = sync_session._export_one_to_resq(exporter, self._dfm_row(notes="Excluded 2020."))

        self.assertTrue(ok)
        exporter.export_dfms.assert_called_once_with(
            [{"name": "Paid DFM", "payload": {"details_tab": {"name": "Paid DFM"}}, "notes": "Excluded 2020."}]
        )

    def test_export_leaves_notes_out_when_the_sidecar_was_unavailable(self):
        exporter = self._writer()

        with patch.object(sync_session, "_preflight_method_export"), patch.object(sync_session, "_verify_method_export"):
            sync_session._export_one_to_resq(exporter, self._dfm_row())

        self.assertNotIn("notes", exporter.export_dfms.call_args.args[0][0])

    def test_verification_reads_the_notes_back(self):
        target = Mock()
        target.Notes = "Old note"
        exporter = Mock()
        exporter._find_in.return_value = target
        exporter._dfm_development_column_count.return_value = 0
        exporter._average_formula_display_indexes.return_value = {}
        exporter._user_entry_payload_row_index.return_value = None
        exporter._resq_notes_text.side_effect = lambda notes: str(notes).replace("\n", "\r\n")
        row = self._dfm_row(notes="Excluded 2020.\nSelected 3-year.")

        with patch.object(sync_session, "_preflight_method_export"):
            with self.assertRaisesRegex(RuntimeError, "DFM notes verification failed"):
                sync_session._verify_method_export(exporter, row)
            target.Notes = "Excluded 2020.\r\nSelected 3-year."
            sync_session._verify_method_export(exporter, row)

    def test_dataset_verification_reads_the_notes_back(self):
        target = Mock()
        target.Count = 1
        target.ValuesByIndex.return_value = 1.0
        target.Notes = "Old note"
        exporter = Mock()
        exporter._find_vector.return_value = target
        exporter._resq_notes_text.side_effect = lambda notes: str(notes)
        row = {
            "name": "Paid Loss",
            "kind": "Dataset",
            "arcrho": {"payload": {"data_format": "Vector"}, "notes": "Reviewed."},
        }

        with self.assertRaisesRegex(RuntimeError, "vector notes verification failed"):
            sync_session._verify_dataset_export(exporter, row, [[1.0]])
        target.Notes = "Reviewed."
        sync_session._verify_dataset_export(exporter, row, [[1.0]])


def _export_item(name: str, *, kind: str = "Dataset", payload: dict | None = None, **fields) -> dict:
    item = {"name": name, "kind": kind, "payload": dict(payload or {}), "export_block_reason": ""}
    item.update(fields)
    return item


def _push_exporter():
    """An exporter whose writers only move the counters the session reads."""

    exporter = Mock()
    exporter.counts = {
        "errors": 0,
        "datasets_written": 0,
        "dfms_written": 0,
        "result_selections_written": 0,
        "methods_saved": 0,
    }
    exporter.skipped = {}
    exporter.skip_details = []
    exporter.error_details = []

    def bump(field):
        def writer(*_args, **_kwargs):
            exporter.counts[field] += 1
        return writer

    exporter.export_datasets.side_effect = bump("datasets_written")
    exporter.export_dfms.side_effect = bump("dfms_written")
    exporter.export_result_selections.side_effect = bump("result_selections_written")
    exporter.save_method.side_effect = bump("methods_saved")
    return exporter


class SyncSessionExportTests(unittest.TestCase):
    """The export phase pushes the whole class one way, in ArcRho's dependency order."""

    def _runtime(self, migration=None):
        from resq_migration import sync as sync_contract
        from resq_migration import transfer_selection

        return {
            "migration": migration or Mock(),
            "sync_contract": sync_contract,
            "transfer_selection": transfer_selection,
        }

    def test_export_rows_leave_bootstrap_out_and_key_rows_by_logical_name(self):
        rows = sync_session._export_rows(self._runtime(), [
            _export_item("Paid  Loss"),
            _export_item("Boot", kind=sync_session.KIND_BOOTSTRAP),
            _export_item("BF Ult", kind=sync_session.KIND_BF),
        ])

        self.assertEqual([row["name"] for row in rows], ["Paid  Loss", "BF Ult"])
        self.assertEqual(rows[0]["key"], "paid loss")
        self.assertEqual(rows[0]["id"], rows[0]["key"])
        self.assertIs(rows[1]["arcrho"]["kind"], sync_session.KIND_BF)

    def test_a_save_only_method_is_saved_by_its_resq_code(self):
        exporter = _push_exporter()
        for kind, code in ((sync_session.KIND_BF, 2), (sync_session.KIND_CC, 3), (sync_session.KIND_BS_SR, 8), (sync_session.KIND_BS_CRA, 9)):
            with self.subTest(kind=kind):
                exporter.save_method.reset_mock()
                row = {"kind": kind, "name": f"{kind} method", "arcrho": _export_item(f"{kind} method", kind=kind)}

                outcome, message = sync_session._push_row_to_resq(exporter, row)

                self.assertEqual((outcome, message), ("saved", "Written to ResQ."))
                exporter.save_method.assert_called_once_with(code, f"{kind} method")
        exporter.export_bfs.assert_not_called()
        exporter.export_ccs.assert_not_called()

    def test_a_dataset_and_a_dfm_go_through_the_writers_with_their_notes(self):
        exporter = _push_exporter()
        dataset = {"kind": "Dataset", "name": "Paid Loss", "arcrho": _export_item("Paid Loss", payload={"csv_file": "Paid Loss.csv"})}
        dfm = {
            "kind": sync_session.KIND_DFM,
            "name": "Paid CDF",
            "arcrho": _export_item("Paid CDF", kind=sync_session.KIND_DFM, payload={"details_tab": {"name": "Paid DFM"}}, method_name="Paid DFM", notes="Excluded 2020."),
        }

        self.assertEqual(sync_session._push_row_to_resq(exporter, dataset), ("exported", "Written to ResQ."))
        self.assertEqual(sync_session._push_row_to_resq(exporter, dfm), ("exported", "Written to ResQ."))

        exporter.export_datasets.assert_called_once_with([{"csv_file": "Paid Loss.csv"}])
        exporter.export_dfms.assert_called_once_with(
            [{"name": "Paid DFM", "payload": {"details_tab": {"name": "Paid DFM"}}, "notes": "Excluded 2020."}]
        )

    def test_a_blocked_item_is_skipped_with_the_inventory_reason(self):
        exporter = _push_exporter()
        row = {
            "kind": "Dataset",
            "name": "Paid Loss",
            "arcrho": _export_item("Paid Loss", export_block_reason="The ArcRho dataset CSV cache is missing."),
        }

        outcome, message = sync_session._push_row_to_resq(exporter, row)

        self.assertEqual((outcome, message), ("skipped", "The ArcRho dataset CSV cache is missing."))
        exporter.export_datasets.assert_not_called()

    def test_an_exporter_skip_or_error_is_reported_with_its_message(self):
        exporter = _push_exporter()

        def skip(_sidecars):
            exporter.skipped["calculated_in_resq"] = 1
            exporter.skip_details.append({"message": "ResQ dataset is calculated; ResQ recomputes its values"})

        exporter.export_datasets.side_effect = skip
        row = {"kind": "Dataset", "name": "Paid Loss", "arcrho": _export_item("Paid Loss")}
        self.assertEqual(
            sync_session._push_row_to_resq(exporter, row),
            ("skipped", "ResQ dataset is calculated; ResQ recomputes its values"),
        )

        def fail(_code, _name):
            exporter.counts["errors"] += 1
            exporter.error_details.append({"message": "locked by the template"})

        exporter.save_method.side_effect = fail
        bf = {"kind": sync_session.KIND_BF, "name": "BF Ult", "arcrho": _export_item("BF Ult", kind=sync_session.KIND_BF)}
        self.assertEqual(sync_session._push_row_to_resq(exporter, bf), ("failed", "locked by the template"))

    def test_method_rows_order_by_their_output_sidecar_precedents(self):
        from resq_migration import sync as sync_contract

        def row(name, kind, *, precedents=(), payload=None):
            return {
                "id": name,
                "key": sync_contract.logical_key(name),
                "name": name,
                "kind": kind,
                "arcrho": {"payload": dict(payload or {}), "precedents": list(precedents)},
            }

        # A Result Selection feeds a Berquist Sherman adjustment whose output
        # triangle a DFM reads: only the sidecar edges can put them in order.
        rows = [
            row("D 18 - BS Paid DFM", sync_session.KIND_DFM, payload={"details_tab": {"input_triangle": "Gross Loss--Paid - B&S"}}),
            row("Gross Loss--Paid - B&S", sync_session.KIND_BS_SR, precedents=["Gross Loss--Paid", "C 92 - Selected"]),
            row("C 92 - Selected", sync_session.KIND_RS, payload={"method_tab": {"loaded_datasets": [{"name": "Claim Counts"}]}}),
            row("Gross Loss--Paid", "Dataset"),
            row("Claim Counts", "Dataset"),
        ]

        ordered = sync_session._dependency_ordered_rows(sync_contract, rows)

        self.assertEqual(
            [item["id"] for item in ordered],
            ["Gross Loss--Paid", "Claim Counts", "C 92 - Selected", "Gross Loss--Paid - B&S", "D 18 - BS Paid DFM"],
        )

    def test_export_reserving_class_writes_in_dependency_order_and_reports_every_item(self):
        import tempfile

        exporter = _push_exporter()
        inventory = [
            _export_item("Selected Ult", kind=sync_session.KIND_RS, payload={"method_tab": {"loaded_datasets": [{"name": "BF Ult"}]}}),
            _export_item("BF Ult", kind=sync_session.KIND_BF, precedents=["Paid LDF", "Paid Loss"]),
            _export_item("Boot", kind=sync_session.KIND_BOOTSTRAP),
            _export_item("Paid LDF", kind=sync_session.KIND_DFM, precedents=["Paid Loss"], method_name="Paid DFM"),
            _export_item("Paid Loss", payload={"csv_file": "Paid Loss.csv"}),
        ]
        events = []
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "data" / "RC").mkdir(parents=True)
            migration = Mock()
            migration.PROJECT_DATA_DIR = root / "data"
            migration.DATASET_SIDECAR_DIR = "sidecars"
            migration._encode_rc_folder.return_value = "RC"
            migration._apply_runtime_scope.return_value = {"previous": True}
            migration.CONNECTION_NAME = "ResQ Test"
            migration.USER_NAME = ""
            migration.PASSWORD = ""
            runtime = self._runtime(migration)
            with (
                patch.object(sync_session, "collect_arcrho_inventory", return_value=inventory) as collect,
                patch.object(sync_session, "_new_exporter", return_value=exporter),
            ):
                result = sync_session.export_reserving_class(
                    runtime, "Demo", r"Auto\PP", server_root=root, progress_callback=events.append
                )

        collect.assert_called_once_with(runtime, root / "data" / "RC")
        exporter.connect.assert_called_once_with()
        exporter.disconnect.assert_called_once_with()
        migration._restore_runtime_scope.assert_called_once_with({"previous": True})
        self.assertEqual(result["status"], "completed")
        self.assertEqual((result["project_name"], result["rc_path"], result["connection_name"]), ("Demo", r"Auto\PP", "ResQ Test"))
        self.assertEqual(
            [(item["name"], item["outcome"]) for item in result["results"]],
            [("Paid Loss", "exported"), ("Paid LDF", "exported"), ("BF Ult", "saved"), ("Selected Ult", "exported")],
        )
        exporter.save_method.assert_called_once_with(2, "BF Ult")
        writes = [event for event in events if event.get("event") == "write"]
        self.assertEqual([(event["completed"], event["total"], event["status"]) for event in writes], [(1, 4, "success"), (2, 4, "success"), (3, 4, "success"), (4, 4, "success")])
        self.assertEqual(writes[0]["message"], "Paid Loss: Written to ResQ.")

    def test_a_selection_narrows_what_is_written_and_becomes_the_next_default(self):
        import tempfile

        from resq_migration import transfer_selection

        exporter = _push_exporter()
        inventory = [
            _export_item("Paid Loss", payload={"csv_file": "Paid Loss.csv"}),
            _export_item("Reported Loss", payload={"csv_file": "Reported Loss.csv"}),
            _export_item("Paid LDF", kind=sync_session.KIND_DFM, precedents=["Paid Loss"], method_name="Paid DFM"),
        ]
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            migration = self._export_scope(root)
            runtime = self._runtime(migration)
            with (
                patch.object(sync_session, "collect_arcrho_inventory", return_value=inventory),
                patch.object(sync_session, "_new_exporter", return_value=exporter),
            ):
                result = sync_session.export_reserving_class(
                    runtime,
                    "Demo",
                    r"Auto\PP",
                    server_root=root,
                    selected_names=["Paid Loss", "Paid LDF"],
                    requested_by="ali",
                )

            # Only the ticked rows are written, still in dependency order.
            self.assertEqual(
                [item["name"] for item in result["results"]], ["Paid Loss", "Paid LDF"]
            )
            self.assertEqual(result["selection"]["saved"], 2)
            self.assertEqual(result["selection"]["error"], "")
            saved = transfer_selection.read_selection(
                transfer_selection.selection_path(root, "Demo", r"Auto\PP", "ResQ Test"),
                "Demo",
                r"Auto\PP",
                "ResQ Test",
            )
            self.assertEqual(
                transfer_selection.selected_names(saved, "export"), ["Paid LDF", "Paid Loss"]
            )
            self.assertEqual(saved["selections"]["export"]["updated_by"], "ali")
            self.assertEqual(transfer_selection.selected_names(saved, "import"), [])

    def test_an_export_without_a_selection_saves_none_and_writes_everything(self):
        import tempfile

        from resq_migration import transfer_selection

        exporter = _push_exporter()
        inventory = [_export_item("Paid Loss", payload={"csv_file": "Paid Loss.csv"})]
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            runtime = self._runtime(self._export_scope(root))
            with (
                patch.object(sync_session, "collect_arcrho_inventory", return_value=inventory),
                patch.object(sync_session, "_new_exporter", return_value=exporter),
            ):
                result = sync_session.export_reserving_class(
                    runtime, "Demo", r"Auto\PP", server_root=root
                )

            self.assertEqual([item["name"] for item in result["results"]], ["Paid Loss"])
            self.assertEqual(result["selection"], {"saved": 0, "path": "", "error": ""})
            self.assertFalse(
                transfer_selection.selection_path(root, "Demo", r"Auto\PP", "ResQ Test").exists()
            )

    def _export_scope(self, root: Path):
        """A migration bound to one temporary reserving class the export can read."""

        (root / "data" / "RC").mkdir(parents=True, exist_ok=True)
        migration = Mock()
        migration.PROJECT_DATA_DIR = root / "data"
        migration.DATASET_SIDECAR_DIR = "sidecars"
        migration._encode_rc_folder.return_value = "RC"
        migration._apply_runtime_scope.return_value = {"previous": True}
        migration.CONNECTION_NAME = "ResQ Test"
        migration.USER_NAME = ""
        migration.PASSWORD = ""
        return migration

    def test_the_export_saves_the_timestamp_pair_of_everything_it_wrote(self):
        """The pair the next review measures against, and what it then reports.

        The export stamps ResQ, so afterwards ResQ always carries the newer
        time. Only the saved pair can tell that apart from someone editing the
        item in ResQ, which is what the second half of this test checks.
        """

        import tempfile

        from resq_migration import sync as sync_contract

        def side(name, timestamp):
            return {
                "name": name,
                "kind": "Dataset",
                "data_format": "Triangle",
                "dataset_type": "Paid Loss",
                "method_name": "",
                "modified_timestamp": timestamp,
                "can_export_to_resq": True,
                "can_import_to_arcrho": True,
                "can_receive_from_arcrho": True,
            }

        arcrho = [dict(side("Paid Loss", 100.0), payload={"csv_file": "Paid Loss.csv"})]
        before_resq = [side("Paid Loss", 90.0)]
        after_resq = [side("Paid Loss", 500.0)]
        exporter = _push_exporter()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            migration = self._export_scope(root)
            runtime = self._runtime(migration)
            with (
                patch.object(sync_session, "collect_arcrho_inventory", return_value=arcrho),
                patch.object(
                    sync_session, "collect_resq_inventory", side_effect=[before_resq, after_resq]
                ),
                patch.object(sync_session, "_new_exporter", return_value=exporter),
            ):
                result = sync_session.export_reserving_class(
                    runtime, "Demo", r"Auto\PP", server_root=root
                )

            state_path = sync_contract.sync_state_path(root, "Demo", r"Auto\PP", "ResQ Test")
            saved = json.loads(state_path.read_text(encoding="utf-8"))
            reported_path = Path(result["baseline"]["path"]).resolve()

        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["baseline"]["recorded"], 1)
        self.assertEqual(result["baseline"]["error"], "")
        self.assertEqual(reported_path, state_path.resolve())
        entry = saved["items"]["paid loss"]
        self.assertEqual((entry["arcrho_timestamp"], entry["resq_timestamp"]), (100.0, 500.0))

        settled = sync_contract.build_sync_plan(arcrho, after_resq, saved)[0]
        review = sync_contract.export_review(
            settled["arcrho"], settled["resq"], settled["state_signature"]
        )
        self.assertEqual(review["changed"], sync_contract.CHANGED_NEITHER)
        self.assertFalse(review["overwrites_edit"])

        edited_in_resq = sync_contract.build_sync_plan(arcrho, [side("Paid Loss", 900.0)], saved)[0]
        after_edit = sync_contract.export_review(
            edited_in_resq["arcrho"], edited_in_resq["resq"], edited_in_resq["state_signature"]
        )
        self.assertEqual(after_edit["changed"], sync_contract.CHANGED_RESQ)
        self.assertTrue(after_edit["overwrites_edit"])

    def test_an_item_the_export_could_not_write_keeps_its_old_baseline(self):
        import tempfile

        from resq_migration import sync as sync_contract

        exporter = _push_exporter()
        exporter.export_datasets.side_effect = RuntimeError("COM went away")
        arcrho = [{
            "name": "Paid Loss",
            "kind": "Dataset",
            "modified_timestamp": 100.0,
            "can_export_to_resq": True,
            "can_receive_from_arcrho": True,
            "payload": {"csv_file": "Paid Loss.csv"},
        }]
        resq = [{"name": "Paid Loss", "kind": "Dataset", "modified_timestamp": 500.0}]
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            migration = self._export_scope(root)
            with (
                patch.object(sync_session, "collect_arcrho_inventory", return_value=arcrho),
                patch.object(sync_session, "collect_resq_inventory", return_value=resq),
                patch.object(sync_session, "_new_exporter", return_value=exporter),
            ):
                result = sync_session.export_reserving_class(
                    self._runtime(migration), "Demo", r"Auto\PP", server_root=root
                )

            state_path = sync_contract.sync_state_path(root, "Demo", r"Auto\PP", "ResQ Test")
            saved = json.loads(state_path.read_text(encoding="utf-8"))

        self.assertEqual(result["status"], "completed_with_errors")
        self.assertEqual(result["baseline"]["recorded"], 0)
        self.assertEqual(saved["items"], {})

    def test_a_baseline_that_cannot_be_read_is_reported_and_never_stops_the_export(self):
        import tempfile

        exporter = _push_exporter()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            migration = self._export_scope(root)
            with (
                patch.object(sync_session, "collect_arcrho_inventory", return_value=[_export_item("Paid Loss")]),
                patch.object(
                    sync_session, "collect_resq_inventory", side_effect=RuntimeError("ResQ went away")
                ),
                patch.object(sync_session, "_new_exporter", return_value=exporter),
            ):
                result = sync_session.export_reserving_class(
                    self._runtime(migration), "Demo", r"Auto\PP", server_root=root
                )

        self.assertEqual(result["status"], "completed")
        self.assertEqual([item["outcome"] for item in result["results"]], ["exported"])
        self.assertIn("ResQ went away", result["baseline"]["error"])
        self.assertEqual(result["baseline"]["recorded"], 0)

    def test_a_failed_item_marks_the_export_completed_with_errors_and_keeps_going(self):
        import tempfile

        exporter = _push_exporter()
        exporter.export_datasets.side_effect = RuntimeError("COM went away")
        inventory = [_export_item("Paid Loss"), _export_item("BF Ult", kind=sync_session.KIND_BF)]
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "data" / "RC").mkdir(parents=True)
            migration = Mock()
            migration.PROJECT_DATA_DIR = root / "data"
            migration.DATASET_SIDECAR_DIR = "sidecars"
            migration._encode_rc_folder.return_value = "RC"
            migration.CONNECTION_NAME = "ResQ Test"
            migration.USER_NAME = ""
            migration.PASSWORD = ""
            with (
                patch.object(sync_session, "collect_arcrho_inventory", return_value=inventory),
                patch.object(sync_session, "_new_exporter", return_value=exporter),
            ):
                result = sync_session.export_reserving_class(self._runtime(migration), "Demo", r"Auto\PP", server_root=root)

        self.assertEqual(result["status"], "completed_with_errors")
        self.assertEqual(
            [(item["name"], item["outcome"], item["message"]) for item in result["results"]],
            [("Paid Loss", "failed", "COM went away"), ("BF Ult", "saved", "Written to ResQ.")],
        )


if __name__ == "__main__":
    unittest.main()
