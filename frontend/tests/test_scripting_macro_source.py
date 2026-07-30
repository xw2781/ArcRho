from __future__ import annotations

import copy
import sys
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app_server.services import scripting_macro_service


class _FakeDfm:
    def __init__(self) -> None:
        self.payload = {"value": 1}

    def to_dict(self):
        return copy.deepcopy(self.payload)


class MacroSourceExecutionTests(unittest.TestCase):
    def test_macro_worker_initializes_and_uninitializes_com_on_its_execution_thread(self) -> None:
        events = []
        com_apartment = Mock()
        com_apartment.CoUninitialize.side_effect = lambda: events.append(
            ("uninitialize", threading.get_ident())
        )

        def initialize():
            events.append(("initialize", threading.get_ident()))
            return com_apartment

        source = "import threading\nprint(f'runner={threading.get_ident()}')"
        with (
            patch.object(scripting_macro_service, "_initialize_macro_com_apartment", side_effect=initialize),
            patch.object(scripting_macro_service, "_MacroTaskDesignerProxy", return_value=Mock()),
        ):
            result = scripting_macro_service.run_macro_source(source, "com_macro.py", {})

        runner_thread = int(result["stdout"].strip().split("=", 1)[1])
        self.assertTrue(result["success"], result)
        self.assertEqual(events, [
            ("initialize", runner_thread),
            ("uninitialize", runner_thread),
        ])

    def test_apply_growth_adjustments_is_valid_unregistered_macro_source(self) -> None:
        macro_path = Path(__file__).resolve().parents[2] / "python-api" / "macros" / "apply_growth_adjustments.py"
        source = macro_path.read_text(encoding="utf-8-sig")
        namespace = {"__name__": "__arcrho_macro_contract_test__", "__file__": str(macro_path)}

        exec(compile(source, str(macro_path), "exec"), namespace)

        self.assertTrue(callable(namespace.get("run_macro")))
        self.assertRegex(namespace.get("_REVIEW_QUARTER", ""), r"^\d{4}Q[1-4]$")

        smoke_source = source + """
def run_macro(active_dfm, active_context=None):
    print(f"loaded {_REVIEW_QUARTER}")
    return {'message': 'apply_growth_adjustments loaded in source runner'}
"""
        with patch.object(scripting_macro_service, "_MacroTaskDesignerProxy", return_value=Mock()):
            result = scripting_macro_service.run_macro_source(
                smoke_source,
                macro_path.name,
                {},
                source_path=str(macro_path),
            )
        self.assertTrue(result["success"])
        self.assertIn("apply_growth_adjustments loaded", result["message"])
        self.assertRegex(result["stdout"], r"loaded \d{4}Q[1-4]")

    def test_run_macro_source_invokes_buffer_entry_point_with_live_context(self) -> None:
        dfm = _FakeDfm()
        source = """
def run_macro(active_dfm, active_context):
    print(f"context={active_context['label']}")
    active_dfm.payload['value'] = 7
    return {'message': 'updated live DFM'}
"""
        with (
            patch.object(scripting_macro_service, "_build_active_dfm", return_value=dfm),
            patch.object(scripting_macro_service, "_MacroTaskDesignerProxy", return_value=Mock()),
        ):
            result = scripting_macro_service.run_macro_source(
                source,
                "feature.py",
                {"activeJson": {"details tab": {}}, "label": "live"},
                source_path=r"E:\work\feature.py",
            )

        self.assertTrue(result["success"])
        self.assertEqual(result["payload"]["value"], 7)
        self.assertEqual(result["message"], "updated live DFM")
        self.assertIn("context=live", result["stdout"])
        self.assertEqual(result["path"], r"E:\work\feature.py")

    def test_run_macro_source_supports_zero_argument_main_and_returned_payload(self) -> None:
        source = """
def main():
    return {'payload': {'from_main': True}}
"""
        with patch.object(scripting_macro_service, "_MacroTaskDesignerProxy", return_value=Mock()):
            result = scripting_macro_service.run_macro_source(source, "scratch.py", {})

        self.assertTrue(result["success"])
        self.assertEqual(result["payload"], {"from_main": True})

    def test_run_macro_source_does_not_emit_payload_for_no_op_script(self) -> None:
        dfm = _FakeDfm()
        with (
            patch.object(scripting_macro_service, "_build_active_dfm", return_value=dfm),
            patch.object(scripting_macro_service, "_MacroTaskDesignerProxy", return_value=Mock()),
        ):
            result = scripting_macro_service.run_macro_source(
                "print('inspection only')",
                "inspect_only.py",
                {"activeJson": {"details tab": {}}},
            )

        self.assertTrue(result["success"])
        self.assertNotIn("payload", result)
        self.assertIn("inspection only", result["stdout"])

    def test_run_macro_source_times_out_runaway_python(self) -> None:
        with (
            patch.object(scripting_macro_service, "_MacroTaskDesignerProxy", return_value=Mock()),
            patch.object(scripting_macro_service, "_MACRO_TIMEOUT_SEC", 0.05),
        ):
            result = scripting_macro_service.run_macro_source("while True:\n    pass", "runaway.py", {})

        self.assertFalse(result["success"])
        self.assertIn("timeout", result["message"])

    def test_run_macro_source_extends_timeout_when_activity_is_reported(self) -> None:
        source = """
import time
for _ in range(4):
    report_macro_activity()
    time.sleep(0.03)
"""
        with (
            patch.object(scripting_macro_service, "_MacroTaskDesignerProxy", return_value=Mock()),
            patch.object(scripting_macro_service, "_MACRO_TIMEOUT_SEC", 0.05),
        ):
            result = scripting_macro_service.run_macro_source(source, "active_import.py", {})

        self.assertTrue(result["success"], result)

    def test_run_macro_source_trusted_call_suspends_and_restores_trace(self) -> None:
        source = """
import sys

trace_before = sys.gettrace()
trace_inside = run_trusted_macro_call(sys.gettrace)

def fail_while_untraced():
    assert sys.gettrace() is None
    raise ValueError("expected")

try:
    run_trusted_macro_call(fail_while_untraced)
except ValueError:
    pass

print(f"suspended={trace_inside is None}")
print(f"restored={sys.gettrace() is trace_before}")
"""
        with patch.object(scripting_macro_service, "_MacroTaskDesignerProxy", return_value=Mock()):
            result = scripting_macro_service.run_macro_source(source, "trusted_call.py", {})

        self.assertTrue(result["success"], result)
        self.assertIn("suspended=True", result["stdout"])
        self.assertIn("restored=True", result["stdout"])

    def test_cooperative_macro_cancel_checker_raises_when_signalled(self) -> None:
        cancel_event = threading.Event()
        check_macro_cancelled = scripting_macro_service._make_cooperative_cancel_checker(cancel_event)

        check_macro_cancelled()
        cancel_event.set()

        with self.assertRaisesRegex(KeyboardInterrupt, "cancelled by user"):
            check_macro_cancelled()

    def test_registered_macro_delegates_to_canonical_source_runner(self) -> None:
        with (
            patch.object(scripting_macro_service, "_safe_macro_path", return_value=r"E:\macros\registered.py"),
            patch.object(scripting_macro_service.os.path, "isfile", return_value=True),
            patch.object(Path, "read_text", return_value="def main(): pass"),
            patch.object(scripting_macro_service, "run_macro_source", return_value={"success": True}) as runner,
        ):
            result = scripting_macro_service.run_macro("registered.py", {"activeJson": {}})

        self.assertTrue(result["success"])
        runner.assert_called_once_with(
            "def main(): pass",
            "registered.py",
            {"activeJson": {}},
            source_path=r"E:\macros\registered.py",
            task_window_id="",
            task_session_id="",
            task_mode="",
        )

    def test_arcrho_bridge_captures_executes_and_applies(self) -> None:
        capture = {
            "ok": True,
            "result": {
                "activeContext": {"activeJson": {"details tab": {}}},
                "target": {"token": "capture-token", "tabId": "dfm-1"},
            },
        }
        review = {"ok": True, "result": {"applied": True, "message": "Applied."}}
        with (
            patch("app_server.services.ui_automation_service.submit_command", side_effect=[capture, review]) as submit,
            patch.object(
                scripting_macro_service,
                "run_macro_source",
                return_value={
                    "success": True,
                    "message": "Ran feature.py",
                    "stdout": "done\n",
                    "payload": {"value": 2},
                },
            ) as execute,
        ):
            result = scripting_macro_service.run_macro_source_in_arcrho(
                "def run_macro(active_dfm, active_context): pass",
                "feature.py",
                r"E:\work\feature.py",
            )

        self.assertTrue(result["success"])
        self.assertTrue(result["applied"])
        self.assertNotIn("payload", result)
        self.assertEqual(submit.call_args_list[0].args[0], "macro.captureActiveDfmContext")
        self.assertEqual(submit.call_args_list[1].args[0], "macro.reviewAndApplyResult")
        self.assertEqual(submit.call_args_list[1].args[2]["target"]["token"], "capture-token")
        self.assertGreater(submit.call_args_list[1].args[2]["expiresAt"], 0)
        execute.assert_called_once()

    def test_arcrho_bridge_allows_ui_only_source_without_active_dfm(self) -> None:
        capture = {
            "ok": True,
            "result": {
                "activeContext": {"available": False, "pageType": "home"},
                "target": {"token": "ui-token", "kind": "ui"},
            },
        }
        review = {"ok": True, "result": {"applied": False, "message": "UI script completed."}}
        with (
            patch("app_server.services.ui_automation_service.submit_command", side_effect=[capture, review]),
            patch.object(
                scripting_macro_service,
                "run_macro_source",
                return_value={"success": True, "message": "Ran ui_only.py", "stdout": "shown\n"},
            ) as execute,
        ):
            result = scripting_macro_service.run_macro_source_in_arcrho("print('shown')", "ui_only.py")

        self.assertTrue(result["success"])
        self.assertFalse(result["applied"])
        self.assertEqual(execute.call_args.args[2]["pageType"], "home")


if __name__ == "__main__":
    unittest.main()
