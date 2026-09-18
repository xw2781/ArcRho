"""Synthetic formula reads: scope, Excel shape options, refresh and transport."""
import importlib
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
for folder in (ROOT / "frontend", ROOT / "python-api" / "src"):
    sys.path.insert(0, str(folder))

from fastapi import HTTPException
from arcrho_api.arcrho_formula_reference import arcrho_formula_references
from arcrho_api.dataset_link_contract import link_precedent_names
from arcrho_api.dfm_contract import dataset_reference_tokens, _substitute_dataset_references, _safe_arithmetic
from app_server.services import arcrho_runtime_service, dfm_service
from app_server.services.arcrho_formula_service import resolve_arcrho_reference


class ArcRhoFormulaTests(unittest.TestCase):
    def setUp(self):
        self.reader = patch.object(arcrho_runtime_service, "run_arcrho_dataset_csv", return_value={"ok": True, "csv_text": "10,20,30\n40,50,\n60,,\n"}).start()
        self.addCleanup(patch.stopall)

    def values(self, formula, cache=None):
        result = resolve_arcrho_reference(formula, "Current", "Current/RC", cache)
        return [[cell["value"] for cell in result["cells"][r:r + result["column_count"]]] for r in range(0, len(result["cells"]), result["column_count"])]

    def test_empty_context_defaults_and_remote_scope_keep_shape_options(self):
        self.values('ArcoTri(,"Paid",FALSE,,TRUE,,6,3)')
        pairs = dict(self.reader.call_args.args[0])
        self.assertEqual((pairs["ProjectName"], pairs["Path"]), ("Current", "Current/RC"))
        self.assertEqual((pairs["OriginLength"], pairs["DevelopmentLength"], pairs["Cumulative"], pairs["Calendar"]), ("6", "3", "False", "True"))
        self.values('ArcoVec("Other/RC","Premium",FALSE,"Other",6)')
        pairs = dict(self.reader.call_args.args[0])
        self.assertEqual((pairs["ProjectName"], pairs["Path"], pairs["OriginLength"]), ("Other", "Other/RC", "6"))

    def test_related_functions_and_transposition_share_one_read_per_shape(self):
        cache = {}
        self.assertEqual(self.values('ArcoTriCell(,"Paid",2,1)', cache), [[40]])
        self.assertEqual(self.values('ArcoTriOrigin(,"Paid",1,,TRUE)', cache), [[10], [20], [30]])
        self.assertEqual(self.values('ArcoTriDiag(,"Paid")', cache), [[30], [50], [60]])
        self.assertEqual(self.values('ArcoTriDiag(,"Paid",-1)', cache), [[20], [40], [0]])
        self.assertEqual(self.reader.call_count, 1)
        self.reader.return_value = {"ok": True, "csv_text": "10\n20\n30\n"}
        self.assertEqual(self.values('ArcoVecCell(,"Premium",2)'), [[20]])
        self.assertEqual(self.values('ArcoVec(,"Premium",TRUE)'), [[10, 20, 30]])

    def test_invalid_coordinates_and_read_failures_are_visible(self):
        for formula in ['ArcoVecCell(,"V",0)', 'ArcoTri(,"T",,,,,0)', 'ArcoTriCell(,"T",99,1)']:
            with self.subTest(formula=formula), self.assertRaises(HTTPException): self.values(formula)
        self.reader.return_value = {"ok": False, "error": "Dataset not found"}
        with self.assertRaisesRegex(HTTPException, "Dataset not found"): self.values('ArcoVec(,"Missing")')

    def test_dfm_recalculation_resolves_saved_index_formulas_with_remote_context(self):
        self.reader.return_value = {"ok": True, "csv_text": "1.5\n2.5\n"}
        raw = '=INDEX(TRANSPOSE(ArcoVec("Other/RC","Factors",,"Other")),1,2)'
        tokens = dataset_reference_tokens(raw)
        values = dfm_service._resolved_reference_token_values("Current", "Current/RC", tokens)
        self.assertEqual(_safe_arithmetic(_substitute_dataset_references(raw, tokens, values).lstrip("=")), 2.5)

    def test_local_edges_use_full_context_and_remote_names_do_not_alias_local_datasets(self):
        formulas = [{'formula': '=ArcoVec("Current/RC","Local",,"Current")'}, {'formula': '=ArcoVec("Other/RC","Remote",,"Other")'}]
        self.assertEqual(link_precedent_names([], formulas, project_name="Current", reserving_class="Current/RC"), ["Local"])

    def test_call_text_inside_dataset_names_is_not_a_function(self):
        self.assertEqual(arcrho_formula_references('=[ArcoVec(fake)][1]'), [])

    def test_formula_route_requires_gateway_and_preserves_transport_errors(self):
        router = importlib.import_module("app_server.api.dataset_router")
        request = router.DatasetInternalLinksResolveRequest(project_name="Current", reserving_class="RC", references=['=ArcoVec(,"Paid")'])
        with patch.object(router.workspace_read_client, "run_workspace_read", return_value={"ok": True}) as transport:
            router.resolve_dataset_internal_links(request)
            self.assertTrue(transport.call_args.kwargs["gateway_required"])
            router.list_cached_dataset_names("Current", "RC")
            self.assertTrue(transport.call_args.kwargs["gateway_required"])
        with patch.object(router.workspace_read_client, "run_workspace_read", side_effect=HTTPException(503, "Gateway unavailable")), self.assertRaises(HTTPException) as error:
            router.resolve_dataset_internal_links(request)
        self.assertEqual(error.exception.status_code, 503)
        self.reader.assert_not_called()


if __name__ == "__main__":
    unittest.main()
