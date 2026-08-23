"""Agent-oriented command helpers for compact DFM reads and controlled edits."""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from .dfm import DfmMethod
from .exceptions import ArcRhoApiError


def _json_out(payload: dict[str, Any]) -> int:
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


def _load(args: argparse.Namespace) -> DfmMethod:
    return DfmMethod.load_file(args.file, read_only=bool(getattr(args, "read_only", False)))


def cmd_summary(args: argparse.Namespace) -> int:
    dfm = _load(args)
    return _json_out(dfm.agent_summary())


def cmd_component(args: argparse.Namespace) -> int:
    dfm = _load(args)
    name = str(args.name or "").strip().lower().replace("_", "-")
    if name in {"data", "data-triangle", "input-data-triangle"}:
        payload = {
            "api method": "DfmMethod.input_data_triangle",
            "component": "input data triangle",
            "values": dfm.input_data_triangle(),
        }
    elif name in {"ratio", "ratio-triangle", "ratio-values"}:
        payload = {
            "api method": "DfmMethod.ratio_values",
            "component": "ratio_triangle",
            "origin_labels": dfm.ratio_triangle.get("origin_labels") or [],
            "development_labels": dfm.ratio_triangle.get("development_labels") or [],
            "values": dfm.ratio_values(),
            "excluded": dfm.ratio_triangle.get("excluded") or [],
        }
    elif name in {"average", "average-formulas", "avg"}:
        payload = dfm.average_formula_summary()
    elif name in {"ultimate", "ultimate-vector", "results"}:
        payload = {
            "api method": "DfmMethod.ultimate_vector",
            "component": "ultimate_vector",
            "values": dfm.ultimate_vector(),
        }
    else:
        raise ArcRhoApiError(f"Unknown DFM component: {args.name}")
    return _json_out(payload)


def cmd_inspect(args: argparse.Namespace) -> int:
    dfm = _load(args)
    return _json_out(dfm.agent_inspect(include=args.include, origins=args.origin))


def cmd_ratio_row(args: argparse.Namespace) -> int:
    dfm = _load(args)
    return _json_out(dfm.ratio_row(args.origin))


def cmd_exclude_ratio(args: argparse.Namespace) -> int:
    dfm = _load(args)
    dfm.exclude_ratio(args.origin, args.development)
    dfm.save()
    return _json_out({
        "api method": "DfmMethod.exclude_ratio",
        "ok": True,
        "origin": args.origin,
        "development": args.development,
        "file": str(dfm.file_path),
    })


def cmd_include_ratio(args: argparse.Namespace) -> int:
    dfm = _load(args)
    dfm.include_ratio(args.origin, args.development)
    dfm.save()
    return _json_out({
        "api method": "DfmMethod.include_ratio",
        "ok": True,
        "origin": args.origin,
        "development": args.development,
        "file": str(dfm.file_path),
    })


def cmd_select_average(args: argparse.Namespace) -> int:
    dfm = _load(args)
    dfm.set_selected_average_by_label(args.label, args.development)
    dfm.save()
    return _json_out({
        "api method": "DfmMethod.set_selected_average_by_label",
        "ok": True,
        "label": args.label,
        "development": args.development,
        "file": str(dfm.file_path),
    })


def cmd_set_user_entry(args: argparse.Namespace) -> int:
    dfm = _load(args)
    dfm.set_user_ratio(float(args.value), dfm._resolve_development_col(args.development) + 1)
    dfm.save()
    return _json_out({
        "api method": "DfmMethod.set_user_ratio",
        "ok": True,
        "value": float(args.value),
        "development": args.development,
        "file": str(dfm.file_path),
    })


def cmd_validate(args: argparse.Namespace) -> int:
    dfm = _load(args)
    return _json_out({
        "api method": "DfmMethod.load_file",
        "ok": True,
        "file": str(dfm.file_path),
        "summary": dfm.agent_summary(),
    })


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m arcrho_api.agent",
        description="Compact DFM reads and controlled edits for ArcRho agents.",
    )
    parser.add_argument("--file", required=True, help="DFM method JSON file, usually active-method.json.")
    parser.add_argument("--read-only", action="store_true", help="Block commands that save changes.")
    sub = parser.add_subparsers(dest="command", required=True)

    summary = sub.add_parser("summary", help="Return compact DFM metadata and available sections.")
    summary.set_defaults(func=cmd_summary)

    component = sub.add_parser("component", help="Return one DFM component.")
    component.add_argument("name", help="data-triangle, ratio-triangle, average-formulas, or ultimate-vector.")
    component.set_defaults(func=cmd_component)

    inspect = sub.add_parser("inspect", help="Return one bundled DFM inspection payload.")
    inspect.add_argument(
        "--include",
        default="summary,average-formulas",
        help="Comma-separated components: summary, data-triangle, ratio-triangle, average-formulas, ultimate-vector.",
    )
    inspect.add_argument(
        "--origin",
        action="append",
        default=[],
        help="Origin label or 1-based row number to include as a ratio row. Can be repeated or comma-separated.",
    )
    inspect.set_defaults(func=cmd_inspect)

    ratio_row = sub.add_parser("ratio-row", help="Return one ratio row with exclusion flags.")
    ratio_row.add_argument("--origin", required=True, help="Origin label or 1-based row number.")
    ratio_row.set_defaults(func=cmd_ratio_row)

    exclude = sub.add_parser("exclude-ratio", help="Mark one ratio cell as excluded.")
    exclude.add_argument("--origin", required=True, help="Origin label or 1-based row number.")
    exclude.add_argument("--development", required=True, help="Development label or 1-based column number.")
    exclude.set_defaults(func=cmd_exclude_ratio)

    include = sub.add_parser("include-ratio", help="Mark one ratio cell as included.")
    include.add_argument("--origin", required=True, help="Origin label or 1-based row number.")
    include.add_argument("--development", required=True, help="Development label or 1-based column number.")
    include.set_defaults(func=cmd_include_ratio)

    select = sub.add_parser("select-average", help="Select an average formula for one or all development columns.")
    select.add_argument("--label", required=True, help="Average formula label.")
    select.add_argument("--development", default="all", help="Development label, 1-based column number, or all.")
    select.set_defaults(func=cmd_select_average)

    user_entry = sub.add_parser("set-user-entry", help="Set and select the User Entry value for one development column.")
    user_entry.add_argument("--development", required=True, help="Development label or 1-based column number.")
    user_entry.add_argument("--value", required=True, help="Numeric User Entry value.")
    user_entry.set_defaults(func=cmd_set_user_entry)

    validate = sub.add_parser("validate", help="Load and validate the DFM method JSON.")
    validate.set_defaults(func=cmd_validate)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args) or 0)
    except Exception as err:
        print(json.dumps({
            "ok": False,
            "error": str(err),
            "error type": err.__class__.__name__,
        }, ensure_ascii=False, indent=2), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
