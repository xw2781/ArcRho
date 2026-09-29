import json
import sys
import unittest
from pathlib import Path

FRONTEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(FRONTEND_ROOT))
from app_server.services import scripting_intelligence as intelligence
from app_server.services import scripting_service as service


class ScriptingIntelligenceTests(unittest.TestCase):
    def setUp(self):
        self.sid = "intelligence-test"
        service.reset_session(self.sid)
        result = service.run_script('''
import math
def custom(first, second="a,b", *, flag=True):
    """Describe a custom function without calling it."""
    raise RuntimeError("Must not execute during help")
''', self.sid)
        self.assertTrue(result["success"], result["error"])

    def tearDown(self):
        service._SESSION_STATES.pop(self.sid, None)

    def test_help_for_custom_builtin_and_imported_functions_in_both_execution_paths(self):
        for query, expected in [("?custom", "Describe a custom"), ("?len", "number of items"), ("math.sqrt?", "square root")]:
            with self.subTest(query=query):
                normal = service.run_script(query, self.sid)
                self.assertTrue(normal["success"], normal["error"])
                self.assertIn(expected, normal["output"])
                events = [json.loads(line) for line in service.run_script_stream(query, self.sid)]
                self.assertTrue(events[-1]["success"], events[-1]["error"])
                self.assertEqual(normal["output"], events[-1]["output"])

    def test_missing_name_is_an_explicit_execution_error(self):
        result = service.run_script("?not_defined", self.sid)
        self.assertFalse(result["success"])
        self.assertIn("not_defined", result["error"])

    def test_help_does_not_truncate_long_docs_or_replace_last_expression(self):
        ns = service._get_or_create_session_state(self.sid).namespace
        ns["custom"].__doc__ = "D" * 3000
        service.run_script("42", self.sid)
        result = service.run_script("?custom", self.sid)
        self.assertIn("D" * 3000, result["output"])
        self.assertEqual(ns["_"], 42)
        self.assertEqual(service.run_script('"?custom"', self.sid)["output"], "'?custom'")

    def complete(self, code):
        return service.complete_code(code, len(code), self.sid)

    def test_signature_and_keyword_completions(self):
        result = self.complete("custom(fi")
        self.assertIn("custom(first, second='a,b', *, flag=True)", result["signature"]["signature"])
        self.assertIn("Describe a custom", result["signature"]["docstring"])
        self.assertIn("first=", [item["label"] for item in result["suggestions"]])
        self.assertEqual(self.complete("custom(flag=")["active_parameter"], 2)
        self.assertTrue(self.complete("len(")["signature"]["docstring"])
        self.assertTrue(self.complete("math.sqrt(")["signature"]["docstring"])

    def test_nested_calls_strings_containers_and_multiline_arguments(self):
        for code, name, active in [
            ('custom("a,b", ', 'custom', 1),
            ('custom([1, 2], ', 'custom', 1),
            ('custom({"x": (1, 2)}, ', 'custom', 1),
            ('custom(\n  1,\n  ', 'custom', 1),
            ('custom(len(', 'len', 0),
            ('custom(len([1, 2]), ', 'custom', 1),
            ('custom("unfinished, string', 'custom', 0),
        ]:
            with self.subTest(code=code):
                result = self.complete(code)
                self.assertTrue(result["signature"]["signature"].startswith(name + "("))
                self.assertEqual(result["active_parameter"], active)

    def test_completions_include_runtime_names_builtins_and_module_members(self):
        for code, expected in [("cus", "custom"), ("pri", "print"), ("math.sq", "sqrt")]:
            self.assertIn(expected, [item["label"] for item in self.complete(code)["suggestions"]])
        self.assertFalse(service.inspect_object("custom", 6, "other-session")["found"])
        service._SESSION_STATES.pop("other-session", None)

    def test_inspection_and_completion_share_signature_metadata(self):
        inspected = service.inspect_object("custom", 6, self.sid)
        completed = self.complete("custom(")["signature"]
        for field in ("signature", "parameters", "docstring"):
            self.assertEqual(inspected[field], completed[field])
        self.assertIsNone(self.complete("custom(1)")["signature"])

    def test_execution_retains_last_expression_behavior(self):
        self.assertEqual(service.run_script("x = 4\nx + 2", self.sid)["output"], "6")
        self.assertEqual(service.run_script("_", self.sid)["output"], "6")
        self.assertFalse(service.run_script("x =", self.sid)["success"])


if __name__ == "__main__":
    unittest.main()
