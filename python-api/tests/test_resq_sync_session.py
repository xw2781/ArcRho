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
        self.assertEqual(sync_session.SYNC_SESSION_API_VERSION, 1)


if __name__ == "__main__":
    unittest.main()
