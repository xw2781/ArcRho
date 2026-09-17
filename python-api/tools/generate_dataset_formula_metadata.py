"""Generate the browser grammar metadata from its canonical Python owner."""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python-api" / "src"))
from arcrho_api.dataset_link_contract import FORMULA_FUNCTION_ARITY, FORMULA_FUNCTION_ARGUMENTS, _BINARY_PRECEDENCE

TARGET = ROOT / "frontend/ui/shared/dataset/dataset_formula.js"
BEGIN = "// BEGIN GENERATED FORMULA METADATA"
END = "// END GENERATED FORMULA METADATA"


def addin_catalog():
    source = (ROOT / "excel-addin/src_vba/ArcRhoFunctions.bas").read_text(encoding="utf-8-sig")
    functions = {}
    for match in re.finditer(r"Public Function (ArcRho(?:Tri(?:Diag|Cell|Origin)?|Vec(?:Cell)?))\(\s*_([\s\S]*?)\) As Variant", source):
        arguments = []
        for raw in match[2].replace("_", "").split(","):
            part = raw.strip()
            arg = re.fullmatch(r'(Optional\s+)?(\w+)(?:\s+As\s+\w+)?(?:\s*=\s*(.*))?', part)
            default = arg[3]
            if default in ("True", "False"): default = default == "True"
            elif default and default.startswith('"'): default = default[1:-1]
            elif default is not None: default = int(default)
            arguments.append({"name": arg[2], "optional": bool(arg[1]), "default": default})
        functions[match[1].upper()] = {"name": match[1], "minimum": sum(not arg["optional"] for arg in arguments), "arguments": arguments}
    return functions


def generated_metadata() -> str:
    return "\n".join([
        BEGIN,
        "// Owner: arcrho_api.dataset_link_contract; generate_dataset_formula_metadata.py --write.",
        f"const BINARY_PRECEDENCE = {json.dumps(_BINARY_PRECEDENCE)};",
        f"export const FORMULA_FUNCTION_ARITY = {json.dumps(FORMULA_FUNCTION_ARITY)};",
        f"export const FORMULA_FUNCTION_ARGUMENTS = {json.dumps(FORMULA_FUNCTION_ARGUMENTS)};",
        f"export const ARCRHO_FORMULA_FUNCTIONS = {json.dumps(addin_catalog())};",
        END,
    ])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    catalog_target = ROOT / "python-api/src/arcrho_api/arcrho_formula_catalog.py"
    catalog_text = '# Generated from excel-addin/src_vba/ArcRhoFunctions.bas; do not edit.\nARCRHO_FORMULA_FUNCTIONS = ' + repr(addin_catalog()) + '\n'
    if args.write:
        catalog_target.write_text(catalog_text, encoding="utf-8")
    elif not catalog_target.exists() or catalog_target.read_text(encoding="utf-8") != catalog_text:
        print("ArcRho add-in formula catalog is stale; run with --write.")
        return 1
    source = TARGET.read_text(encoding="utf-8")
    start, end = source.index(BEGIN), source.index(END) + len(END)
    expected = source[:start] + generated_metadata() + source[end:]
    if args.write:
        TARGET.write_text(expected, encoding="utf-8")
    elif source != expected:
        print("Dataset formula metadata is stale; run with --write.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
