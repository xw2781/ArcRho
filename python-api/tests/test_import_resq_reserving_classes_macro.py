from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch


_REPO_ROOT = Path(__file__).resolve().parents[2]
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


class ListReservingClassesTests(unittest.TestCase):
    def setUp(self):
        self.module = load_macro_module()

    def test_index_owns_the_name_and_the_folder_is_the_fallback(self):
        import tempfile

        with tempfile.TemporaryDirectory(dir=_REPO_ROOT) as root:
            data = Path(root) / "projects" / "Demo" / "data"
            indexed = data / "HPPREF_%5C_HO+DF"
            indexed.mkdir(parents=True)
            (indexed / "index.json").write_text(
                json.dumps({
                    "reserving_class": "HPPREF\\HO+DF",
                    "files": [{"name": "Paid"}, {"name": "Premium"}],
                }),
                encoding="utf-8",
            )
            (data / "Auto_%5C_NJ").mkdir()
            (data / ".arcrho-cache").mkdir()

            classes = self.module.list_reserving_classes(root, "Demo")

        self.assertEqual(
            classes,
            [
                {"path": "Auto\\NJ", "dataset_count": None},
                {"path": "HPPREF\\HO+DF", "dataset_count": 2},
            ],
        )

    def test_a_project_with_no_data_folder_lists_nothing(self):
        self.assertEqual(self.module.list_reserving_classes("Q:\\absent", "Demo"), [])


class BatchImportMacroTests(unittest.TestCase):
    """End-to-end run_macro flow against the real sibling queue adapter."""

    def setUp(self):
        import tempfile

        self.module = load_macro_module()
        self.single = self.module._load_single_import_macro()
        self.tempdir = tempfile.TemporaryDirectory(dir=_REPO_ROOT)
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

    def test_the_canonical_default_list_preselects_the_review_rows(self):
        """RC_PATH from the shared support release drives the preselection."""

        release = self.server_root / "shared" / "python-api" / "releases" / "abc123"
        migration_dir = release / "migration"
        migration_dir.mkdir(parents=True)
        (migration_dir / "resq_data_migration.py").write_text(
            'RC_PATH = ["Auto\\\\PA"]\n',
            encoding="utf-8",
        )
        (self.server_root / "shared" / "python-api" / "current.json").write_text(
            json.dumps({"relative_root": "releases/abc123"}),
            encoding="utf-8",
        )
        self.ui = _UI(selected_ids=["Auto\\PA"])
        statuses = {
            "Auto\\PA": {"status": "success", "result": {"datasets_imported": 1, "errors": 0}},
        }
        with (
            self._api_module(),
            patch.object(self.single, "publish_import_request", side_effect=self._publish_with_status(statuses)),
        ):
            result = self.module.run_macro()

        self.assertTrue(result["success"])
        selected_by_id = {row["id"]: row["selected"] for row in self.ui.review_payload["rows"]}
        self.assertEqual(selected_by_id, {"Auto\\NJ": False, "Auto\\PA": True})

    def test_a_missing_support_bundle_falls_back_to_selecting_everything(self):
        self.assertEqual(self.module.default_rc_paths(self.server_root), [])
        payload = self.module.review_table_payload(
            [{"path": "Auto\\NJ", "dataset_count": 1}],
            "Demo",
            1,
            [],
        )
        self.assertTrue(all(row["selected"] for row in payload["rows"]))

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
