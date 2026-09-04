from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch


_REPO_ROOT = Path(__file__).resolve().parents[2]
# Every test temp directory lives under one gitignored folder at the
# repository root, so a suite that dies before teardown cannot scatter
# tmp folders beside the code.
TEST_TEMP_ROOT = _REPO_ROOT / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
_MACROS_DIR = Path(__file__).resolve().parents[1] / "macros"
_SRC_DIR = Path(__file__).resolve().parents[1] / "src"
for path in (_SRC_DIR, _MACROS_DIR):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

_MACRO_PATH = _MACROS_DIR / "import_resq_reserving_classes.py"


def load_macro_module():
    spec = importlib.util.spec_from_file_location(
        "import_resq_reserving_classes_macro_under_test",
        _MACRO_PATH,
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load the batch ResQ import macro.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _Progress:
    def __init__(self):
        self.total = 0
        self.completed = 0
        self.updates = []
        self.closed = False

    def update(self, **kwargs):
        self.updates.append(kwargs)
        self.total = int(kwargs.get("total", self.total) or 0)
        self.completed = int(kwargs.get("completed", self.completed) or 0)

    def close(self, **_kwargs):
        self.closed = True


class _UI:
    """Fake ArcRhoUI: context, review table commands, progress, messages."""

    def __init__(self, *, selected_ids, button_script=None, overwrite=False):
        self.messages = []
        self.commands = []
        self.reload_calls = []
        self.selected_ids = selected_ids
        self.overwrite = overwrite
        self.review_payload = None
        # Buttons returned by successive message boxes; empty answers mean the
        # non-destructive merge default, which keeps the older tests unchanged.
        self.button_script = list(button_script or [])
        self.project_instance = types.SimpleNamespace(
            context=lambda **_kwargs: {"projectName": "Demo"},
            reload_dataset_table=self._reload_dataset_table,
        )

    def _reload_dataset_table(self, **kwargs):
        self.reload_calls.append(kwargs)
        return {"refreshed": True}

    def message_box(self, message, **kwargs):
        self.messages.append((message, kwargs))
        if kwargs.get("buttons") and self.button_script:
            return {"ok": True, "button": self.button_script.pop(0)}
        return {"ok": True}

    def progress_bar(self, **_kwargs):
        self.progress = _Progress()
        return self.progress

    def send_command(self, command, *, args=None, **_kwargs):
        self.commands.append((command, args))
        if command == "ui.reviewTableOpen":
            self.review_payload = args
            return {"result": {"dialogId": "dlg-1"}}
        if command == "ui.reviewTableStatus":
            if self.selected_ids is None:
                return {"result": {"status": "completed", "accepted": False}}
            return {"result": {
                "status": "completed",
                "accepted": True,
                "selectedRowIds": list(self.selected_ids),
                "optionStates": {"overwrite": bool(self.overwrite)},
            }}
        if command == "ui.reviewTableClose":
            return {"result": {"closed": True}}
        raise AssertionError(f"Unexpected command: {command}")


class FixedReservingClassesTests(unittest.TestCase):
    """The class list is built into the macro; the project only marks existence."""

    def setUp(self):
        self.module = load_macro_module()

    def test_the_built_in_list_is_the_canonical_default_selection(self):
        self.assertEqual(len(self.module.RC_PATHS), 17)
        self.assertEqual(self.module.RC_PATHS[0], "PRNJ - PA\\PA\\NY\\Direct Group\\BI Total")
        self.assertEqual(self.module.RC_PATHS[-1], "PRNJ - PA\\PA\\MA\\Direct Group\\MP+PIP")
        self.assertEqual(len(set(path.casefold() for path in self.module.RC_PATHS)), 17)

    def test_listed_classes_are_marked_existing_or_new_and_others_are_ignored(self):
        import tempfile

        with tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT) as root:
            data = Path(root) / "projects" / "Demo" / "data"
            indexed = data / "HPPREF_%5C_HO+DF_%5C_NJ_%5C_Legacy_%5C_HOL"
            indexed.mkdir(parents=True)
            (indexed / "index.json").write_text(
                json.dumps({
                    # The index owns the spelling; casing differences still match.
                    "reserving_class": "hppref\\HO+DF\\NJ\\Legacy\\HOL",
                    "files": [{"name": "Paid"}, {"name": "Premium"}],
                }),
                encoding="utf-8",
            )
            # A listed class whose folder has no index is still "existing".
            (data / "HPPREF_%5C_HO+DF_%5C_NJ_%5C_Legacy_%5C_HOPxCAT").mkdir()
            # Folders outside the list never reach the table.
            (data / "Auto_%5C_NJ").mkdir()
            (data / ".arcrho-cache").mkdir()

            classes = self.module.fixed_reserving_classes(root, "Demo")

        self.assertEqual([item["path"] for item in classes], list(self.module.RC_PATHS))
        by_path = {item["path"]: item for item in classes}
        self.assertEqual(
            by_path["HPPREF\\HO+DF\\NJ\\Legacy\\HOL"],
            {"path": "HPPREF\\HO+DF\\NJ\\Legacy\\HOL", "dataset_count": 2, "exists": True},
        )
        self.assertEqual(
            by_path["HPPREF\\HO+DF\\NJ\\Legacy\\HOPxCAT"],
            {"path": "HPPREF\\HO+DF\\NJ\\Legacy\\HOPxCAT", "dataset_count": None, "exists": True},
        )
        new_paths = [item["path"] for item in classes if not item["exists"]]
        self.assertEqual(len(new_paths), 15)
        self.assertNotIn("Auto\\NJ", by_path)

    def test_a_project_with_no_data_folder_offers_every_class_as_new(self):
        classes = self.module.fixed_reserving_classes("Q:\\absent", "Demo")
        self.assertEqual([item["path"] for item in classes], list(self.module.RC_PATHS))
        self.assertFalse(any(item["exists"] for item in classes))

    def test_the_review_table_marks_new_classes_and_preselects_everything(self):
        payload = self.module.review_table_payload(
            [
                {"path": "Auto\\NJ", "dataset_count": 3, "exists": True},
                {"path": "Auto\\PA", "dataset_count": None, "exists": False},
            ],
            "Demo",
            1,
        )
        rows = payload["rows"]
        self.assertTrue(all(row["selected"] for row in rows))
        self.assertEqual(rows[0]["cells"]["datasets"], "3")
        self.assertEqual(rows[1]["cells"]["datasets"], "New")
        self.assertIn("1 not in this project yet", payload["summary"])


class BatchImportMacroTests(unittest.TestCase):
    """End-to-end run_macro flow against the real sibling queue adapter."""

    def setUp(self):
        import tempfile

        self.module = load_macro_module()
        self.single = self.module._load_single_import_macro()
        # The flow tests drive the macro with a short fixed list; the real
        # built-in list is covered by FixedReservingClassesTests.
        self.module.RC_PATHS = ["Auto\\NJ", "Auto\\PA"]
        self.tempdir = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        self.addCleanup(self.tempdir.cleanup)
        self.server_root = Path(self.tempdir.name)
        self._write_worker()
        self._write_classes("Auto\\NJ", "Auto\\PA")

    def _write_worker(self):
        path = self.server_root / self.single.BRIDGE_WORKER_DIR / "worker.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps({"Role": "bridge_worker", "ResQGuiRunning": True}),
            encoding="utf-8",
        )

    def _write_classes(self, *rc_paths):
        for rc_path in rc_paths:
            folder = rc_path.replace("\\", "_%5C_")
            class_dir = self.server_root / "projects" / "Demo" / "data" / folder
            class_dir.mkdir(parents=True, exist_ok=True)
            (class_dir / "index.json").write_text(
                json.dumps({"reserving_class": rc_path, "files": []}),
                encoding="utf-8",
            )

    def _api_module(self):
        api_module = types.ModuleType("arcrho_api")
        api_module.ArcRhoUI = lambda: self.ui
        api_module.get_server_root = lambda **_kwargs: self.server_root
        # list_reserving_classes imports the real dataset_index_contract, so
        # keep the genuine subpackage importable beside the stubbed root.
        from arcrho_api import dataset_index_contract

        api_module.dataset_index_contract = dataset_index_contract
        return patch.dict(
            sys.modules,
            {
                "arcrho_api": api_module,
                "arcrho_api.dataset_index_contract": dataset_index_contract,
            },
        )

    def _publish_with_status(self, status_by_path):
        def publish_and_respond(*, server_root, request_id, payload):
            request_path, status_path = self.single._request_paths(server_root, request_id)
            request_path.parent.mkdir(parents=True, exist_ok=True)
            request_path.write_text(json.dumps(payload), encoding="utf-8")
            status = dict(status_by_path[payload["Path"]])
            status["request_id"] = request_id
            status["contract_version"] = self.single.CONTRACT_VERSION
            status_path.parent.mkdir(parents=True, exist_ok=True)
            status_path.write_text(json.dumps(status), encoding="utf-8")
            return request_path

        return publish_and_respond

    def test_each_selected_class_is_imported_in_order_and_summarized(self):
        self.ui = _UI(selected_ids=["Auto\\NJ", "Auto\\PA"])
        statuses = {
            "Auto\\NJ": {"status": "success", "result": {"datasets_imported": 3, "errors": 0}},
            "Auto\\PA": {"status": "success", "result": {"datasets_imported": 2, "methods_imported": 1, "errors": 0}},
        }
        with (
            self._api_module(),
            patch.object(self.single, "publish_import_request", side_effect=self._publish_with_status(statuses)),
        ):
            result = self.module.run_macro()

        self.assertTrue(result["success"])
        self.assertEqual([item["path"] for item in result["results"]], ["Auto\\NJ", "Auto\\PA"])
        self.assertTrue(all(item["success"] for item in result["results"]))
        self.assertIn("Reserving classes imported: 2 of 2", result["message"])
        self.assertIn("Datasets imported: 5", result["message"])
        self.assertIn("Methods imported: 1", result["message"])
        self.assertEqual(len(self.ui.reload_calls), 1)
        # The review table listed both classes, preselected.
        rows = self.ui.review_payload["rows"]
        self.assertEqual([row["id"] for row in rows], ["Auto\\NJ", "Auto\\PA"])
        self.assertTrue(all(row["selected"] for row in rows))

    def _write_class_files(self, rc_path, *, methods=(), datasets=()):
        """Method files and datasets for one class; ``datasets`` pairs name and kind."""

        folder = rc_path.replace("\\", "_%5C_")
        class_dir = self.server_root / "projects" / "Demo" / "data" / folder
        (class_dir / "methods").mkdir(parents=True, exist_ok=True)
        for name in methods:
            (class_dir / "methods" / name).write_text("{}", encoding="utf-8")
        (class_dir / "sidecars").mkdir(parents=True, exist_ok=True)
        (class_dir / "datasets").mkdir(parents=True, exist_ok=True)
        for name, source_kind in datasets:
            (class_dir / "sidecars" / f"{name}.json").write_text(
                json.dumps({"source_kind": source_kind, "csv_file": f"{name}@12.csv"}),
                encoding="utf-8",
            )
            (class_dir / "datasets" / f"{name}@12.csv").write_text(
                "origin\n2025\n", encoding="utf-8"
            )
        return class_dir

    def test_every_class_backs_up_its_own_files_before_it_is_imported(self):
        self.ui = _UI(selected_ids=["Auto\\NJ", "Auto\\PA"])
        self._write_class_files(
            "Auto\\NJ",
            methods=["DFM@A.json", "BF@B.json"],
            datasets=[("Accounting Cutoff", "input"), ("Net Loss--Paid", "engine")],
        )
        self._write_class_files(
            "Auto\\PA", methods=["DFM@C.json"], datasets=[("Prior Qtr", "input")]
        )
        statuses = {
            "Auto\\NJ": {"status": "success", "result": {"datasets_imported": 1, "errors": 0}},
            "Auto\\PA": {"status": "success", "result": {"datasets_imported": 1, "errors": 0}},
        }
        backed_up_when_published = []

        publish_and_respond = self._publish_with_status(statuses)

        def publish(*, server_root, request_id, payload):
            class_dir = (
                self.server_root
                / self.single.IMPORT_BACKUP_RELATIVE_DIR
                / "Demo"
                / payload["Path"].replace("\\", "_%5C_")
            )
            stamp_dir = next(class_dir.iterdir()) if class_dir.is_dir() else None
            backed_up_when_published.append(
                sorted(
                    item.relative_to(stamp_dir).as_posix()
                    for item in stamp_dir.rglob("*")
                    if item.is_file() and item.name != "backup.json"
                )
                if stamp_dir is not None
                else []
            )
            return publish_and_respond(
                server_root=server_root, request_id=request_id, payload=payload
            )

        with (
            self._api_module(),
            patch.object(self.single, "publish_import_request", side_effect=publish),
        ):
            result = self.module.run_macro()

        self.assertTrue(result["success"])
        self.assertEqual(
            backed_up_when_published,
            [
                [
                    "datasets/Accounting Cutoff@12.csv",
                    "index.json",
                    "methods/BF@B.json",
                    "methods/DFM@A.json",
                    "sidecars/Accounting Cutoff.json",
                ],
                [
                    "datasets/Prior Qtr@12.csv",
                    "index.json",
                    "methods/DFM@C.json",
                    "sidecars/Prior Qtr.json",
                ],
            ],
        )
        self.assertEqual([item["backup"]["methods"] for item in result["results"]], [2, 1])
        self.assertEqual([item["backup"]["datasets"] for item in result["results"]], [1, 1])
        self.assertIn(
            "Backed up 3 method(s) and 2 dataset(s) from 2 reserving class(es)",
            result["message"],
        )
        self.assertIn("1 engine-generated dataset(s) were left out", result["message"])

    def test_a_class_whose_backup_failed_is_named_in_the_summary(self):
        self.ui = _UI(selected_ids=["Auto\\NJ", "Auto\\PA"])
        self._write_class_files("Auto\\NJ", methods=["DFM@A.json"])
        statuses = {
            "Auto\\NJ": {"status": "success", "result": {"datasets_imported": 1, "errors": 0}},
            "Auto\\PA": {"status": "success", "result": {"datasets_imported": 1, "errors": 0}},
        }
        with (
            self._api_module(),
            patch.object(
                self.single,
                "publish_import_request",
                side_effect=self._publish_with_status(statuses),
            ),
            patch.object(self.single.resq_import_backup.shutil, "copy2", side_effect=OSError("share offline")),
        ):
            result = self.module.run_macro()

        # The import still ran; only the restore point is missing. Both classes
        # are named: each holds at least its index, so each had a copy to take.
        self.assertTrue(result["success"])
        self.assertIn("no restore point for:", result["message"])
        self.assertIn("- Auto\\NJ: share offline", result["message"])
        self.assertIn("- Auto\\PA: share offline", result["message"])
        message, kwargs = self.ui.messages[-1]
        self.assertEqual(kwargs["kind"], "warning")
        self.assertIsNone(kwargs["auto_close_ms"])

    def test_a_failed_class_is_reported_and_the_batch_continues(self):
        self.ui = _UI(selected_ids=["Auto\\NJ", "Auto\\PA"])
        statuses = {
            "Auto\\NJ": {"status": "error", "message": "ResQ import failed safely."},
            "Auto\\PA": {"status": "success", "result": {"datasets_imported": 2, "errors": 0}},
        }
        with (
            self._api_module(),
            patch.object(self.single, "publish_import_request", side_effect=self._publish_with_status(statuses)),
        ):
            result = self.module.run_macro()

        self.assertFalse(result["success"])
        outcomes = {item["path"]: item["success"] for item in result["results"]}
        self.assertEqual(outcomes, {"Auto\\NJ": False, "Auto\\PA": True})
        self.assertIn("Reserving classes imported: 1 of 2", result["message"])
        self.assertIn("Auto\\NJ", result["message"])
        self.assertIn("ResQ import failed safely.", result["message"])

    def test_a_committed_class_with_skipped_items_lists_them_by_name(self):
        self.ui = _UI(selected_ids=["Auto\\NJ", "Auto\\PA"])
        statuses = {
            "Auto\\NJ": {"status": "success", "result": {
                "datasets_imported": 4,
                "errors": 1,
                "error_details": [{
                    "kind": "vector",
                    "name": "G 41 - BF Paid",
                    "message": (
                        "The Perc Developed input does not name a ResQ dataset; "
                        "its selection is blank or broken."
                    ),
                }],
            }},
            "Auto\\PA": {"status": "success", "result": {"datasets_imported": 2, "errors": 0}},
        }
        with (
            self._api_module(),
            patch.object(self.single, "publish_import_request", side_effect=self._publish_with_status(statuses)),
        ):
            result = self.module.run_macro()

        # The class committed, so it counts as imported; the skipped item is
        # reported by name instead of failing the class.
        self.assertTrue(result["success"])
        self.assertIn("Reserving classes imported: 2 of 2", result["message"])
        self.assertIn("Skipped items", result["message"])
        self.assertIn("G 41 - BF Paid", result["message"])
        self.assertIn("Perc Developed", result["message"])
        final_kwargs = self.ui.messages[-1][1]
        self.assertEqual(final_kwargs.get("kind"), "warning")
        self.assertIsNone(final_kwargs.get("auto_close_ms"))

    def test_remaining_classes_are_skipped_when_the_bridge_falls_silent(self):
        self.ui = _UI(selected_ids=["Auto\\NJ", "Auto\\PA"])
        sent = []

        def fall_silent(*, payload, **_kwargs):
            sent.append(payload["Path"])
            raise self.single.BridgeUnavailableError("Request was abandoned: silent for 30 seconds.")

        with (
            self._api_module(),
            patch.object(self.single, "publish_import_request", side_effect=fall_silent),
        ):
            result = self.module.run_macro()

        self.assertFalse(result["success"])
        self.assertEqual(sent, ["Auto\\NJ"])
        self.assertEqual(len(result["results"]), 2)
        self.assertIn("silent for 30 seconds", result["results"][0]["error"])
        self.assertIn("Skipped: the ArcRho Bridge stopped responding", result["results"][1]["error"])

    def test_a_request_error_does_not_skip_the_remaining_classes(self):
        self.ui = _UI(selected_ids=["Auto\\NJ", "Auto\\PA"])
        publish = self._publish_with_status({
            "Auto\\PA": {"status": "success", "result": {"datasets_imported": 2, "errors": 0}},
        })

        def fail_first(*, server_root, request_id, payload):
            if payload["Path"] == "Auto\\NJ":
                raise self.single.BridgeRequestError("Could not publish the request.")
            return publish(server_root=server_root, request_id=request_id, payload=payload)

        with (
            self._api_module(),
            patch.object(self.single, "publish_import_request", side_effect=fail_first),
        ):
            result = self.module.run_macro()

        outcomes = {item["path"]: item["success"] for item in result["results"]}
        self.assertEqual(outcomes, {"Auto\\NJ": False, "Auto\\PA": True})
        self.assertIn("Could not publish the request.", result["results"][0]["error"])

    def test_a_confirmed_overwrite_travels_in_every_request(self):
        # Overwrite is chosen with the checkbox in the selection window, then
        # confirmed once in the follow-up warning box.
        self.ui = _UI(
            selected_ids=["Auto\\NJ", "Auto\\PA"],
            overwrite=True,
            button_script=["Overwrite"],
        )
        statuses = {
            "Auto\\NJ": {"status": "success", "result": {"datasets_imported": 1, "errors": 0}},
            "Auto\\PA": {"status": "success", "result": {"datasets_imported": 1, "errors": 0}},
        }
        captured = []
        publish = self._publish_with_status(statuses)

        def capture_and_publish(*, server_root, request_id, payload):
            captured.append(dict(payload))
            return publish(server_root=server_root, request_id=request_id, payload=payload)

        with (
            self._api_module(),
            patch.object(self.single, "publish_import_request", side_effect=capture_and_publish),
        ):
            result = self.module.run_macro()

        self.assertTrue(result["success"])
        self.assertEqual(len(captured), 2)
        self.assertTrue(all(item["ImportPolicy"] == "overwrite" for item in captured))
        # The selection window carries the checkbox, so the only extra prompt
        # is the single confirmation for the whole batch.
        prompts = [kwargs for _msg, kwargs in self.ui.messages if kwargs.get("buttons")]
        self.assertEqual(len(prompts), 1)
        self.assertEqual(prompts[0]["buttons"], ["Overwrite", "Cancel"])
        options = self.ui.review_payload["options"]
        self.assertEqual([item["key"] for item in options], ["overwrite"])
        self.assertFalse(options[0]["checked"])

    def test_a_declined_overwrite_confirmation_imports_nothing(self):
        self.ui = _UI(
            selected_ids=["Auto\\NJ", "Auto\\PA"],
            overwrite=True,
            button_script=["Cancel"],
        )
        with (
            self._api_module(),
            patch.object(self.single, "publish_import_request") as publish,
        ):
            result = self.module.run_macro()

        self.assertFalse(result["success"])
        self.assertEqual(result["reason"], "cancelled")
        publish.assert_not_called()

    def test_other_project_folders_are_never_offered(self):
        """The table holds the fixed list only, whatever else the project has."""

        self._write_classes("Auto\\CT", "HPPREF\\HO+DF")
        self.ui = _UI(selected_ids=["Auto\\NJ", "Auto\\PA"])
        statuses = {
            "Auto\\NJ": {"status": "success", "result": {"datasets_imported": 1, "errors": 0}},
            "Auto\\PA": {"status": "success", "result": {"datasets_imported": 1, "errors": 0}},
        }
        with (
            self._api_module(),
            patch.object(self.single, "publish_import_request", side_effect=self._publish_with_status(statuses)),
        ):
            result = self.module.run_macro()

        self.assertTrue(result["success"])
        rows = self.ui.review_payload["rows"]
        self.assertEqual([row["id"] for row in rows], ["Auto\\NJ", "Auto\\PA"])
        self.assertTrue(all(row["selected"] for row in rows))
        self.assertEqual([row["cells"]["datasets"] for row in rows], ["0", "0"])

    def test_a_listed_class_without_a_folder_is_offered_as_new_and_imported(self):
        """A missing folder never blocks the import; the Bridge creates it."""

        import shutil

        shutil.rmtree(self.server_root / "projects" / "Demo" / "data" / "Auto_%5C_PA")
        self.ui = _UI(selected_ids=["Auto\\NJ", "Auto\\PA"])
        statuses = {
            "Auto\\NJ": {"status": "success", "result": {"datasets_imported": 1, "errors": 0}},
            "Auto\\PA": {"status": "success", "result": {"datasets_imported": 4, "errors": 0}},
        }
        with (
            self._api_module(),
            patch.object(self.single, "publish_import_request", side_effect=self._publish_with_status(statuses)),
        ):
            result = self.module.run_macro()

        self.assertTrue(result["success"])
        rows = {row["id"]: row for row in self.ui.review_payload["rows"]}
        self.assertTrue(rows["Auto\\PA"]["selected"])
        self.assertEqual(rows["Auto\\PA"]["cells"]["datasets"], "New")
        self.assertEqual(rows["Auto\\NJ"]["cells"]["datasets"], "0")
        self.assertIn("1 not in this project yet", self.ui.review_payload["summary"])
        created = {item["path"]: item["created"] for item in result["results"]}
        self.assertEqual(created, {"Auto\\NJ": False, "Auto\\PA": True})
        self.assertIn("New reserving classes created: 1", result["message"])
        self.assertIn("- Auto\\PA", result["message"])

    def test_an_empty_project_offers_the_whole_list_and_still_imports(self):
        import shutil

        shutil.rmtree(self.server_root / "projects" / "Demo" / "data")
        self.ui = _UI(selected_ids=["Auto\\NJ", "Auto\\PA"])
        statuses = {
            "Auto\\NJ": {"status": "success", "result": {"datasets_imported": 1, "errors": 0}},
            "Auto\\PA": {"status": "success", "result": {"datasets_imported": 1, "errors": 0}},
        }
        with (
            self._api_module(),
            patch.object(self.single, "publish_import_request", side_effect=self._publish_with_status(statuses)),
        ):
            result = self.module.run_macro()

        self.assertTrue(result["success"])
        rows = self.ui.review_payload["rows"]
        self.assertEqual([row["cells"]["datasets"] for row in rows], ["New", "New"])
        self.assertIn("New reserving classes created: 2", result["message"])

    def test_cancelling_the_review_changes_nothing(self):
        self.ui = _UI(selected_ids=None)
        with (
            self._api_module(),
            patch.object(self.single, "publish_import_request") as publish,
        ):
            result = self.module.run_macro()

        self.assertFalse(result["success"])
        self.assertEqual(result["reason"], "cancelled")
        publish.assert_not_called()

    def test_no_live_bridge_stops_before_listing_or_review(self):
        (self.server_root / self.single.BRIDGE_WORKER_DIR / "worker.json").unlink()
        self.ui = _UI(selected_ids=["Auto\\NJ"])
        with self._api_module():
            result = self.module.run_macro()

        self.assertFalse(result["success"])
        self.assertEqual(result["reason"], "bridge_unavailable")
        self.assertEqual(self.ui.commands, [])


if __name__ == "__main__":
    unittest.main()
