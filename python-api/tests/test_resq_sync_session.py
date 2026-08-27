"""Cover the canonical ArcRho/ResQ synchronization session.

These rules used to live inside the synchronization macro. They moved into
``resq_migration.sync_session`` when the ResQ session moved onto the Bridge, so
the same code now serves a queued Bridge worker and any direct caller. The
tests follow the rules rather than their old home.
"""
from __future__ import annotations

import sys
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
        "conflict": False,
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
        preview = {"plan": [row], "state": {"items": {}}, "state_path": Path("state.json")}

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
        apply_plan.assert_not_called()
        self.assertEqual(
            result["preview"][0]["signature"],
            runtime["sync_contract"].plan_signature(row),
        )
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
            _is_engine_generated_instance=lambda _payload: False,
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
        self.assertTrue(current.get("conflict") or current["action"] != plan[0]["action"])

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
        self.assertEqual(sync_session.SYNC_SESSION_API_VERSION, 2)

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
            Vectors=lambda: empty,
            DFMMethods=lambda: empty,
            BFMethods=lambda: empty,
            CapeCodMethods=lambda: empty,
            ResultSelections=lambda: empty,
        )
        migration = types.SimpleNamespace(
            _safe_attr=lambda source, name, default=None: getattr(source, name, default),
            _iso_or_text=lambda value: str(value or ""),
            _is_known_dataset_type=lambda _name: True,
            _is_engine_generated_instance=lambda payload: payload["name"] == "Reported Loss",
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

        self.assertEqual([item["name"] for item in inventory], ["Paid Loss"])
        self.assertTrue(inventory[0]["can_receive_from_arcrho"])


if __name__ == "__main__":
    unittest.main()
