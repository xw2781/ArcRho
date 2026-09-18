"""Numeric function behavior and exact browser/server formula parity."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python-api/src"))
from arcrho_api.dataset_link_contract import (
    DatasetLinkError, canonical_dataset_formula, evaluate_dataset_formula,
    parse_dataset_formula_tree, tokenize_dataset_formula,
)

MATRICES = {"[A][1:4]": {"rows": 4, "cols": 1, "values": [[None], [0], [2], [4]]}}
MATRICES['ArcoTri(, "Paid")'] = {"rows": 2, "cols": 2, "values": [[1, 2], [3, None]]}
CASES = [
    ("=sum(1,2,3)", [[6]]), ("=MIN(3,-1,8)", [[-1]]), ("=MAX(3,-1,8)", [[8]]),
    ("=MEDIAN(9,1,3,5)", [[4]]), ("=AVERAGE(0,4,8)", [[4]]),
    ("=COUNT([A][1:4])", [[3]]), ("=ABS(-12)", [[12]]), ("=ROUND(-1.25,1)", [[-1.3]]),
    ("=AVERAGE([A][1:4])", [[2]]), ("=MEDIAN([A][1:4])", [[2]]),
    ("=IF(2>=1,SUM(3,4),1/0)", [[7]]), ("=IF(FALSE,1/0,8)", [[8]]),
    ("=IF(1<>1,7)", [[0]]), ("=IFERROR(1/0,9)", [[9]]), ("=IFERROR(5,1/0)", [[5]]),
    ('=IFERROR(1/0,"")', [[None]]), ("=2*3", [[6]]),
    ("=IFERROR(8/[A][1:4],-1)", [[-1], [-1], [4], [2]]),
    ("=IF([A][1:4]=0,0,8/[A][1:4])", [[0], [0], [4], [2]]),
    ('=IFERROR(AVERAGE(""),7)', [[7]]),
    ('=IFERROR(MEDIAN(1e308,1e308),7)', [[7]]),
    ('=TAKE({1,2,3;4,5,6},-1,-2)', [[5, 6]]),
    ('=TAKE({1,2;3,4},99)', [[1, 2], [3, 4]]),
    ('=TAKE({1,2;3,4},,-1)', [[2], [4]]),
    ('=INDEX({1,2;3,4},2,1)', [[3]]),
    ('=INDEX({1,2;3,4},0,2)', [[2], [4]]),
    ('=INDEX({1,2;3,4},2,0)', [[3, 4]]),
    ('=INDEX({1,2,3},2)', [[2]]),
    ('=TRANSPOSE(TAKE({1,2;3,4},-1))', [[3], [4]]),
    ('=IFERROR(TAKE({1,2},0),9)', [[9]]),
    ('=IFERROR(INDEX({1,2},8),9)', [[9]]),
    ('=ROUND(1.5)', [[2]]),
    ('=INDEX(ArcoTri(,"Paid"),2,1)', [[3]]),
]


def evaluate(text):
    tree = parse_dataset_formula_tree(tokenize_dataset_formula(text))
    return evaluate_dataset_formula(tree, lambda token: MATRICES.get(token["canonical"]))


class FormulaFunctionTests(unittest.TestCase):
    def test_functions(self):
        for text, expected in CASES:
            with self.subTest(formula=text):
                self.assertEqual(evaluate(text)["values"], expected)

    def test_errors_do_not_persist_partial_values(self):
        for text in ("=8/[A][1:4]", "=1e308*1e308", "=UNKNOWN(1)", "=IF(1)", "=SUM()"):
            with self.subTest(formula=text), self.assertRaises(DatasetLinkError):
                evaluate(text)

    def test_generated_browser_metadata_is_current(self):
        spec = importlib.util.spec_from_file_location("formula_metadata", ROOT / "python-api/tools/generate_dataset_formula_metadata.py")
        generator = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(generator)
        self.assertIn(generator.generated_metadata(), generator.TARGET.read_text(encoding="utf-8"))

    def test_browser_matches_full_canonical_text_and_result_payload(self):
        script = r'''
const fs = require("node:fs");
const path = require("node:path");
const root = process.cwd();
const dataUrl = text => `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const ref = dataUrl(read("frontend/ui/shared/integrations/excel_reference.js"));
const internal = dataUrl(read("frontend/ui/shared/dataset/dataset_internal_reference.js"));
const source = read("frontend/ui/shared/dataset/dataset_formula.js")
  .replace('"/ui/shared/integrations/excel_reference.js?v=20260715a"', JSON.stringify(ref))
  .replace('"/ui/shared/dataset/dataset_internal_reference.js?v=20260830a"', JSON.stringify(internal));
(async () => {
  const formula = await import(dataUrl(source));
  const payload = JSON.parse(fs.readFileSync(0, "utf8"));
  const result = payload.cases.map(text => {
    const parsed = formula.parseDatasetFormula(text);
    if (!parsed.ok) throw new Error(parsed.error);
    const evaluated = formula.evaluateDatasetFormula(parsed.tree, token => payload.matrices[token.canonical]);
    if (!evaluated.ok) throw new Error(evaluated.error);
    const { ok, ...matrix } = evaluated;
    return { canonical: parsed.canonical, matrix };
  });
  process.stdout.write(JSON.stringify(result));
})().catch(error => { console.error(error); process.exitCode = 1; });
'''
        result = subprocess.run(
            [str(ROOT / "frontend/node-portable/node.exe"), "-e", script],
            cwd=ROOT, input=json.dumps({"cases": [text for text, _ in CASES], "matrices": MATRICES}),
            text=True, encoding="utf-8", capture_output=True, check=True,
        )
        expected = [{"canonical": canonical_dataset_formula(text), "matrix": evaluate(text)} for text, _ in CASES]
        self.assertEqual(json.loads(result.stdout), expected)


if __name__ == "__main__":
    unittest.main()
