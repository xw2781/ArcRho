"""Restate saved Bornhuetter Ferguson and Cape Cod percentages developed.

Both methods used to divide Latest by the ultimate behind their development
precedent to arrive at a percentage developed. That ratio is undefined whenever
an origin's latest observation is zero -- the newest origin of a paid triangle,
typically -- and it drifts whenever the Latest triangle is not the one the DFM
itself was built on. The percentage now comes from the DFM's selected
development factors instead, which describe an origin's development age
whatever its latest figure happens to be.

Saved methods keep the old figure until something recalculates them, so this is
an explicit, one-time restatement of one project. It drives the same domain
refresh the app runs when a precedent changes, so each method is rewritten,
its output vector republished, and its dependents flagged for review exactly as
an ordinary refresh would leave them.

Examples:

    python tools/restate_percentage_developed.py --project "NJ_Annual_Prod_2026 Q2-May Test" --dry-run
    python tools/restate_percentage_developed.py --project "NJ_Annual_Prod_2026 Q2-May Test" --apply
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Mapping, Tuple

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "frontend"))
sys.path.insert(0, str(REPO_ROOT / "python-api" / "src"))

from app_server import config  # noqa: E402
from app_server.services import (  # noqa: E402
    bornhuetter_ferguson_service,
    cape_cod_service,
    dependent_propagation_service,
)

# Each restatement leaves a propagation walk holding its reserving class, and
# the next save in that class is refused until the walk finishes. One method
# per class at a time, waiting for the hold to clear, is the whole reason this
# runs as a script rather than as one bulk write.
HOLD_POLL_SECONDS = 2.0
HOLD_TIMEOUT_SECONDS = 900.0

BF_PREFIX = "BF@"
CC_PREFIX = "CC@"


class RestateError(RuntimeError):
    """Raised when the project cannot be restated without guessing."""


def _read_json(path: Path) -> Dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError as err:
        raise RestateError(f"{path} is not valid JSON: {err}") from err
    return payload if isinstance(payload, dict) else {}


def _reserving_classes(project: str) -> List[str]:
    """Every reserving class the project has a data folder for, decoded."""

    from arcrho_api.dataset_index_contract import decode_filename_segment

    project_dir = config._find_existing_project_dir(project)
    if not project_dir:
        raise RestateError(f"Project folder not found under projects: {project}")
    data_dir = Path(project_dir) / config.PROJECT_DATA_DIR
    if not data_dir.is_dir():
        raise RestateError(f"Project has no data folder: {data_dir}")
    names = []
    for entry in sorted(os.scandir(data_dir), key=lambda item: item.name):
        if not entry.is_dir() or entry.name.startswith("."):
            continue
        names.append(str(decode_filename_segment(entry.name)))
    return names


def _method_names(project: str, reserving_class: str, prefix: str) -> List[str]:
    method_dir = Path(config.get_project_method_data_dir(project, reserving_class))
    if not method_dir.is_dir():
        return []
    names = []
    for entry in sorted(os.scandir(method_dir), key=lambda item: item.name):
        if not entry.is_file() or not entry.name.startswith(prefix) or not entry.name.endswith(".json"):
            continue
        payload = _read_json(Path(entry.path))
        name = str((payload.get("details_tab") or {}).get("name") or "").strip()
        if name:
            names.append(name)
    return names


def _recalculated(project: str, reserving_class: str, method: Mapping[str, Any], prefix: str) -> Dict[str, Any]:
    """Recalculate a method in memory exactly as a precedent refresh would.

    Driving the domain's own snapshot reader rather than resolving the pattern
    separately means the plan reports what an apply will really do, including
    the precedents a refresh already refuses.
    """

    if prefix == BF_PREFIX:
        return bornhuetter_ferguson_service._recalculate_with_sources(
            project,
            reserving_class,
            method,
            ("latest", "dfm", "priors"),
            changed_precedents=(),
            allow_review_needed=True,
        )
    return cape_cod_service._recalculate_with_sources(
        project,
        reserving_class,
        method,
        cape_cod_service.SOURCE_ROLES,
        changed_precedents=(),
        allow_review_needed=True,
    )


def _percentages(method: Mapping[str, Any]) -> List[Any]:
    tab = method.get("method_tab") or {}
    values = tab.get("percentage_developed")
    return list(values) if isinstance(values, list) else []


def _changed_rows(old: Any, new: Any) -> int:
    old_list = old if isinstance(old, list) else []
    new_list = new if isinstance(new, list) else []
    changed = 0
    for index in range(max(len(old_list), len(new_list))):
        before = old_list[index] if index < len(old_list) else None
        after = new_list[index] if index < len(new_list) else None
        if before is None and after is None:
            continue
        if before is None or after is None:
            changed += 1
        elif abs(float(before) - float(after)) > 1e-6:
            changed += 1
    return changed


def _plan_one(
    project: str,
    reserving_class: str,
    method_name: str,
    prefix: str,
) -> Dict[str, Any]:
    service = bornhuetter_ferguson_service if prefix == BF_PREFIX else cape_cod_service
    method = _read_json(Path(service._method_path(project, reserving_class, method_name)))
    tab = method.get("method_tab") or {}
    old = _percentages(method)
    new = _percentages(_recalculated(project, reserving_class, method, prefix))
    return {
        "reserving_class": reserving_class,
        "method": method_name,
        "kind": "BF" if prefix == BF_PREFIX else "Cape Cod",
        "origins": len(tab.get("origin_labels") or []),
        "changed_rows": _changed_rows(old, new),
        "filled_blanks": sum(
            1
            for index in range(len(new))
            if (index >= len(old) or old[index] is None) and new[index] is not None
        ),
    }


def _wait_for_class(project: str, reserving_class: str) -> None:
    """Block until no propagation walk owns the reserving class."""

    deadline = time.monotonic() + HOLD_TIMEOUT_SECONDS
    while True:
        try:
            dependent_propagation_service.require_reserving_class_writable(project, reserving_class)
            return
        except Exception as err:  # noqa: BLE001 - only a 423 is worth waiting out
            if "423" not in str(err) or time.monotonic() >= deadline:
                raise
            time.sleep(HOLD_POLL_SECONDS)


def _apply_one(project: str, reserving_class: str, method_name: str, prefix: str) -> Dict[str, Any]:
    if prefix == BF_PREFIX:
        return bornhuetter_ferguson_service.refresh_bornhuetter_ferguson_method(
            project, reserving_class, method_name
        )
    return cape_cod_service.refresh_cape_cod_method(project, reserving_class, method_name)


def run(project: str, *, apply: bool, verbose: bool) -> int:
    classes = _reserving_classes(project)
    plans: List[Dict[str, Any]] = []
    failures: List[Tuple[str, str, str]] = []
    for reserving_class in classes:
        for prefix in (BF_PREFIX, CC_PREFIX):
            for method_name in _method_names(project, reserving_class, prefix):
                try:
                    plans.append(_plan_one(project, reserving_class, method_name, prefix))
                except Exception as err:  # noqa: BLE001 - reported, never fatal
                    failures.append((reserving_class, method_name, str(err)))

    touched = [plan for plan in plans if plan["changed_rows"]]
    print(f"Project              : {project}")
    print(f"Reserving classes    : {len(classes)}")
    print(f"Methods inspected    : {len(plans)}")
    print(f"Methods to restate   : {len(touched)}")
    print(f"Rows changing        : {sum(plan['changed_rows'] for plan in plans)}")
    print(f"Blank rows filled    : {sum(plan['filled_blanks'] for plan in plans)}")
    if failures:
        print(f"Could not be read    : {len(failures)}")
        for reserving_class, method_name, reason in failures:
            print(f"  ! {reserving_class} / {method_name}: {reason}")

    if verbose:
        for plan in touched:
            print(
                f"  {plan['kind']:9} {plan['reserving_class']} / {plan['method']}: "
                f"{plan['changed_rows']} of {plan['origins']} rows"
                f" ({plan['filled_blanks']} previously blank)"
            )

    if not apply:
        print("\nDry run: nothing was written.")
        return 1 if failures else 0

    applied = 0
    apply_failures: List[Tuple[str, str, str]] = []
    for plan in touched:
        prefix = BF_PREFIX if plan["kind"] == "BF" else CC_PREFIX
        try:
            _wait_for_class(project, plan["reserving_class"])
            _apply_one(project, plan["reserving_class"], plan["method"], prefix)
            applied += 1
            print(f"  restated {plan['kind']:9} {plan['reserving_class']} / {plan['method']}")
        except Exception as err:  # noqa: BLE001 - reported, never fatal
            apply_failures.append((plan["reserving_class"], plan["method"], str(err)))
            print(f"  ! FAILED {plan['kind']:9} {plan['reserving_class']} / {plan['method']}: {err}")

    print(f"\nRestated {applied} of {len(touched)} methods.")
    if apply_failures:
        print(f"{len(apply_failures)} failed and keep their previous saved values.")
    return 1 if apply_failures or failures else 0


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--project", required=True, help="Project folder name under projects.")
    parser.add_argument("--apply", action="store_true", help="Write the restated methods.")
    parser.add_argument("--dry-run", action="store_true", help="Report without writing (default).")
    parser.add_argument("--verbose", action="store_true", help="List every method that changes.")
    args = parser.parse_args(argv)
    if args.apply and args.dry_run:
        parser.error("Choose either --apply or --dry-run.")
    return run(args.project, apply=bool(args.apply), verbose=bool(args.verbose))


if __name__ == "__main__":
    raise SystemExit(main())
