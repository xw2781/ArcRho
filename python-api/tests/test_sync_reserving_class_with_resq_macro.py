from __future__ import annotations

import importlib.util
import os
import shutil
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


_MACRO_PATH = (
    Path(__file__).resolve().parents[1]
    / "macros"
    / "sync_reserving_class_with_resq.py"
)
_PUBLISHER_PATH = _MACRO_PATH.parent / "publish_macro_library.py"
_TMP_ROOT = Path(__file__).resolve().parent / "logs" / "tmp"


def _load_module_from_path(path: Path, module_name: str):
    spec = importlib.util.spec_from_file_location(
        module_name,
        path,
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load Python module: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_macro_module():
    return _load_module_from_path(
        _MACRO_PATH,
        "sync_reserving_class_with_resq_macro_under_test",
    )


def _load_publisher_module():
    spec = importlib.util.spec_from_file_location(
        "publish_macro_library_for_sync_loader_test",
        _PUBLISHER_PATH,
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load the macro-library publisher.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


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


class _ReviewUI:
    def __init__(self):
        self.calls = []
        self._statuses = [
            {"result": {"status": "pending"}},
            {
                "result": {
                    "status": "completed",
                    "accepted": True,
                    "selectedRowIds": ["paid-loss", "ultimate-loss"],
                }
            },
        ]

    def send_command(self, command, *, args, timeout_sec):
        self.calls.append((command, args, timeout_sec))
        if command == "ui.reviewTableOpen":
            return {"result": {"dialogId": "review-1"}}
        if command == "ui.reviewTableStatus":
            return self._statuses.pop(0)
        if command == "ui.reviewTableClose":
            return {"result": {"status": "closed"}}
        raise AssertionError(f"Unexpected command: {command}")


class SyncReservingClassWithResqMacroTests(unittest.TestCase):
    def setUp(self):
        self.module = _load_macro_module()

    def test_review_table_has_both_timestamp_columns_and_cells_for_every_row(self):
        plan = [
            _plan_row(
                "both-present",
                arcrho=_side("2026-08-12T10:00:00+00:00", timestamp=100),
                resq=_side("2026-08-12T11:00:00", timestamp=200, source="ResQ Modified"),
            ),
            _plan_row(
                "missing-resq",
                arcrho=_side("2026-08-12T12:00:00+00:00", timestamp=300),
                resq=None,
            ),
            _plan_row(
                "unknown",
                arcrho=_side("", timestamp=None, source=""),
                resq=_side("", timestamp=None, source="ResQ Modified"),
            ),
            _plan_row(
                "created-only",
                arcrho=None,
                resq=_side(
                    "2026-08-12T09:30:00",
                    timestamp=None,
                    source="ResQ Created (Modified unavailable)",
                ),
            ),
        ]

        payload = self.module.review_table_payload(
            plan,
            "Demo",
            r"Auto\PP",
            "ResQ Demo",
        )

        columns = {column["key"]: column["label"] for column in payload["columns"]}
        self.assertEqual(columns["arcrho_timestamp"], "ArcRho Timestamp")
        self.assertEqual(columns["resq_timestamp"], "ResQ Timestamp")
        self.assertIn("Both timestamp columns are shown for every row", payload["summary"])
        for row in payload["rows"]:
            with self.subTest(row=row["id"]):
                self.assertIn("arcrho_timestamp", row["cells"])
                self.assertIn("resq_timestamp", row["cells"])

        by_id = {row["id"]: row["cells"] for row in payload["rows"]}
        self.assertEqual(
            by_id["both-present"]["arcrho_timestamp"],
            "2026-08-12T10:00:00+00:00",
        )
        self.assertEqual(
            by_id["both-present"]["resq_timestamp"],
            "2026-08-12T11:00:00",
        )
        self.assertEqual(by_id["missing-resq"]["resq_timestamp"], "Not present")
        self.assertEqual(by_id["unknown"]["arcrho_timestamp"], "Unknown")
        self.assertEqual(by_id["unknown"]["resq_timestamp"], "Unknown")
        self.assertEqual(by_id["created-only"]["arcrho_timestamp"], "Not present")
        self.assertEqual(
            by_id["created-only"]["resq_timestamp"],
            "Unknown Modified; Created 2026-08-12T09:30:00",
        )

    def test_async_review_polls_status_key_and_always_closes_dialog(self):
        ui = _ReviewUI()
        plan = [
            _plan_row("paid-loss", selected=True, disabled=False),
            _plan_row("ultimate-loss", selected=True, disabled=False),
        ]

        with patch.object(self.module.time, "sleep") as sleep:
            selected = self.module.review_sync_plan(
                ui,
                plan,
                "Demo",
                r"Auto\PP",
                "ResQ Demo",
            )

        self.assertEqual(selected, ["paid-loss", "ultimate-loss"])
        self.assertEqual(
            [command for command, _args, _timeout in ui.calls],
            [
                "ui.reviewTableOpen",
                "ui.reviewTableStatus",
                "ui.reviewTableStatus",
                "ui.reviewTableClose",
            ],
        )
        self.assertEqual(ui.calls[-1][1], {"dialogId": "review-1"})
        sleep.assert_called_once_with(self.module.REVIEW_POLL_SECONDS)

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
        row.update({
            "key": row_id,
            "action": "arcrho_to_resq",
        })
        return row

    def test_cancel_after_review_performs_no_write_or_resq_connection(self):
        runtime, migration = self._runtime()
        preview = {
            "plan": [self._action_row("paid-loss", 200)],
            "state": {"items": {}},
            "state_path": Path("state.json"),
        }

        with (
            patch.object(self.module, "_plan_context", return_value=preview),
            patch.object(self.module, "_new_exporter") as new_exporter,
            patch.object(self.module, "apply_sync_plan") as apply_plan,
        ):
            result = self.module.sync_reserving_class_with_resq(
                "Demo",
                r"Auto\PP",
                server_root=Path.cwd(),
                selection_callback=lambda _plan: None,
                runtime=runtime,
            )

        self.assertEqual(result["status"], "cancelled")
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
            patch.object(self.module, "_plan_context", return_value=observation),
            patch.object(self.module, "_new_exporter", return_value=exporter),
            patch.object(
                self.module,
                "apply_sync_plan",
                return_value={"successes": 1, "failures": 0, "results": [], "successful_keys": ["paid-loss"]},
            ) as apply_plan,
        ):
            result = self.module.sync_reserving_class_with_resq(
                "Demo",
                r"Auto\PP",
                server_root=Path.cwd(),
                selected_row_ids=["paid-loss"],
                runtime=runtime,
            )

        self.assertEqual(result["status"], "completed")
        selected = apply_plan.call_args.kwargs["selected_rows"]
        self.assertEqual([row["id"] for row in selected], ["paid-loss"])
        exporter.connect.assert_called_once_with()
        exporter.disconnect.assert_called_once_with()

    def test_changed_timestamp_after_review_aborts_before_apply(self):
        runtime, _migration = self._runtime()
        preview = self._action_row("paid-loss", 200)
        current = self._action_row("paid-loss", 201)
        observations = [
            {"plan": [preview], "state": {"items": {}}, "state_path": Path("state.json")},
            {"plan": [current], "state": {"items": {}}, "state_path": Path("state.json")},
        ]
        exporter = Mock()

        with (
            patch.object(self.module, "_plan_context", side_effect=observations),
            patch.object(self.module, "_new_exporter", return_value=exporter),
            patch.object(self.module, "apply_sync_plan") as apply_plan,
        ):
            result = self.module.sync_reserving_class_with_resq(
                "Demo",
                r"Auto\PP",
                server_root=Path.cwd(),
                selected_row_ids=["paid-loss"],
                runtime=runtime,
            )

        self.assertEqual(result["status"], "stale")
        self.assertEqual(result["stale_items"], ["paid-loss"])
        apply_plan.assert_not_called()

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
                "payload": {"data_format_code": 0, "data_format": "Triangle"},
            },
        }

        with patch.object(self.module, "_preflight_dataset_export", return_value=[[100.0]]):
            with self.assertRaisesRegex(RuntimeError, "could not clear the target triangle"):
                self.module._export_one_to_resq(exporter, row)

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
            "arcrho": {"payload": {"data_format_code": 0}},
        }

        with self.assertRaisesRegex(RuntimeError, "retained a value in ArcRho blank cell"):
            self.module._verify_dataset_export(exporter, row, [[None]])

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
            "parse_timestamp": self.module._parsed_timestamp,
        }
        exporter = types.SimpleNamespace(reserving_class=ReservingClass())

        inventory = self.module.collect_resq_inventory(runtime, exporter)

        self.assertEqual(len(inventory), 1)
        self.assertEqual(inventory[0]["name"], "Adjusted Paid")
        self.assertEqual(
            inventory[0]["resq_method_name"],
            "Settlement Configuration",
        )
        self.assertIs(inventory[0]["resq_method"], method)
        self.assertTrue(inventory[0]["can_import_to_arcrho"])
        target = self.module._resq_import_target({
            "kind": self.module.KIND_BS_SR,
            "name": inventory[0]["name"],
            "resq": inventory[0],
        })
        self.assertEqual(target["method_names"], ["Settlement Configuration"])

    def test_runtime_loader_uses_one_coherent_migration_root(self):
        runtime = self.module._load_runtime_modules()
        migration_root = Path(runtime["migration"].__file__).resolve().parent

        self.assertTrue(Path(runtime["sync_contract"].__file__).resolve().is_relative_to(migration_root))
        for name, loaded in sys.modules.items():
            if not name.startswith("resq_migration."):
                continue
            loaded_path = str(getattr(loaded, "__file__", "") or "")
            self.assertTrue(loaded_path, name)
            self.assertTrue(Path(loaded_path).resolve().is_relative_to(migration_root), name)

    def test_runtime_loader_uses_published_client_release_and_rejects_tampering(self):
        publisher = _load_publisher_module()
        _TMP_ROOT.mkdir(parents=True, exist_ok=True)
        original_path = list(sys.path)
        original_modules = {
            name: module
            for name, module in sys.modules.items()
            if name == "resq_migration" or name.startswith("resq_migration.")
        }
        try:
            with tempfile.TemporaryDirectory(dir=_TMP_ROOT) as temp_name:
                temp_root = Path(temp_name)
                library = temp_root / "shared" / "macros"
                library.mkdir(parents=True)
                publisher.publish_migration_support(library, False)

                installed_macro = library / _MACRO_PATH.name
                shutil.copy2(_MACRO_PATH, installed_macro)
                installed = _load_module_from_path(
                    installed_macro,
                    "installed_sync_reserving_class_with_resq_macro_under_test",
                )
                with patch.dict(
                    os.environ,
                    {"ARCRHO_MACRO_LIBRARY_DIR": str(library)},
                ), patch("arcrho_api.get_server_root", side_effect=RuntimeError("test")):
                    runtime = installed._load_runtime_modules()
                    releases_root = (library.parent / "python-api" / "releases").resolve()
                    for key in ("migration", "exporter_module", "sync_contract"):
                        origin = Path(runtime[key].__file__).resolve()
                        self.assertTrue(origin.is_relative_to(releases_root), (key, origin))

                    sync_path = Path(runtime["sync_contract"].__file__).resolve()
                    sync_path.write_bytes(sync_path.read_bytes() + b"\n# tampered\n")
                    with self.assertRaisesRegex(FileNotFoundError, "support file hash does not match"):
                        installed._load_runtime_modules()
        finally:
            sys.path[:] = original_path
            for name in list(sys.modules):
                if name == "resq_migration" or name.startswith("resq_migration."):
                    sys.modules.pop(name, None)
            sys.modules.update(original_modules)


if __name__ == "__main__":
    unittest.main()
