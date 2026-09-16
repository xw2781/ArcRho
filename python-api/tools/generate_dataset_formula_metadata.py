"""Generate the browser grammar metadata from its canonical Python owner."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python-api" / "src"))
from arcrho_api.dataset_link_contract import FORMULA_FUNCTION_ARITY, _BINARY_PRECEDENCE

TARGET = ROOT / "frontend/ui/shared/dataset/dataset_formula.js"
BEGIN = "// BEGIN GENERATED FORMULA METADATA"
END = "// END GENERATED FORMULA METADATA"


def generated_metadata() -> str:
    return "\n".join([
        BEGIN,
        "// Owner: arcrho_api.dataset_link_contract; generate_dataset_formula_metadata.py --write.",
        f"const BINARY_PRECEDENCE = {json.dumps(_BINARY_PRECEDENCE)};",
        f"export const FORMULA_FUNCTION_ARITY = {json.dumps(FORMULA_FUNCTION_ARITY)};",
        END,
    ])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
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
