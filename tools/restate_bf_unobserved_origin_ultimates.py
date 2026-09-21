"""Republish Bornhuetter Ferguson methods whose unobserved origins now take the Selected Prior.

A BF origin with no Latest value yet -- a quarter beyond the valuation in a
quarterly class -- used to leave its New Ultimate blank. It now takes the whole
Selected Prior, so a quarterly method covers the full year. Every saved BF
keeps its stored New Ultimate until something recalculates it, and the app
refuses to open, save, or refresh a method whose stored column no longer
matches the rule, so this is an explicit, one-time restatement of one project.

Each affected method is recalculated from its own embedded snapshots -- no
precedent is re-read -- and republished exactly as a precedent refresh would
publish it: method JSON, output sidecar, and output vector, with the output
flagged for review because its values changed. Every method of a reserving
class is rewritten before that class's single dependent walk is queued on the
Engine, so the walk never meets a sibling BF the app cannot yet open.

Examples:

    python tools/restate_bf_unobserved_origin_ultimates.py --project "NJ_Annual_Prod_2026 Q3-Aug" --dry-run
    python tools/restate_bf_unobserved_origin_ultimates.py --project "NJ_Annual_Prod_2026 Q3-Aug" --apply
    python tools/restate_bf_unobserved_origin_ultimates.py --all-projects --apply
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Tuple

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "frontend"))
sys.path.insert(0, str(REPO_ROOT / "python-api" / "src"))

from app_server import config  # noqa: E402
from app_server.services import (  # noqa: E402
    bornhuetter_ferguson_service as bf,
    dataset_sidecar_status_service,
    dependent_propagation_service as propagation,
)
from arcrho_api.bornhuetter_ferguson_contract import (  # noqa: E402
    recalculate_bornhuetter_ferguson_method,
)
from restate_percentage_developed import (  # noqa: E402
    BF_PREFIX,
    RestateError,
    _changed_rows,
    _method_names,
    _read_json,
    _reserving_classes,
    _wait_for_class,
)

WALK_POLL_SECONDS = 5.0
WALK_TIMEOUT_SECONDS = 1800.0


def _plan_one(project: str, reserving_class: str, method_name: str) -> Dict[str, Any]:
    method = _read_json(Path(bf._method_path(project, reserving_class, method_name)))
    refreshed = recalculate_bornhuetter_ferguson_method(method, update_refresh_timestamp=False)
    old = (method.get("method_tab") or {}).get("new_ultimate") or []
    new = refreshed["method_tab"]["new_ultimate"]
    return {
        "reserving_class": reserving_class,
        "method": method_name,
        "origins": len(new),
        "changed_rows": _changed_rows(old, new),
        "filled_blanks": sum(
            1 for index in range(len(new))
            if (index >= len(old) or old[index] is None) and new[index] is not None
        ),
        "refreshed": refreshed,
    }


def _publish_one(project: str, reserving_class: str, plan: Dict[str, Any]) -> Tuple[str, str]:
    refreshed = plan["refreshed"]
    _method_name, output_dataset = bf._identity(refreshed)
    sidecar_path = bf._sidecar_path(project, reserving_class, output_dataset)
    with dataset_sidecar_status_service.sidecar_write_lock(sidecar_path):
        existing_sidecar = bf._read_json(sidecar_path)
        if not existing_sidecar:
            raise RestateError("BF output sidecar is missing.")
        bf._publish(
            project,
            reserving_class,
            refreshed,
            existing_sidecar,
            notes=None,
            changed=True,
            automatic=True,
            write_outputs=True,
        )
    output_type = str((refreshed.get("details_tab") or {}).get("output_type") or "").strip()
    return output_dataset, output_type or output_dataset


def _apply_class(project: str, reserving_class: str, plans: List[Dict[str, Any]]) -> Dict[str, Any]:
    _wait_for_class(project, reserving_class)
    roots = []
    with bf._lock(project, reserving_class):
        for plan in plans:
            output_dataset, output_type = _publish_one(project, reserving_class, plan)
            roots.append(propagation.changed_root(output_dataset, output_type))
            print(f"  restated {reserving_class} / {plan['method']}")
    return propagation.enqueue_save_propagation(project, reserving_class, roots)


def _wait_for_walks(jobs: List[Tuple[str, str]]) -> List[Tuple[str, str]]:
    """Poll every queued walk to a terminal status; return the ones that failed."""

    pending = dict(jobs)
    failed: List[Tuple[str, str]] = []
    deadline = time.monotonic() + WALK_TIMEOUT_SECONDS
    while pending and time.monotonic() < deadline:
        for reserving_class, job_id in list(pending.items()):
            status = propagation.get_dependent_propagation_status(job_id)
            state = str(status.get("status") or "")
            if state not in ("success", "error"):
                continue
            del pending[reserving_class]
            if state == "error":
                failed.append((reserving_class, str(status.get("message") or status.get("error") or job_id)))
            print(f"  walk {state:7} {reserving_class}")
        if pending:
            time.sleep(WALK_POLL_SECONDS)
    for reserving_class, job_id in pending.items():
        failed.append((reserving_class, f"walk still running after {WALK_TIMEOUT_SECONDS:.0f}s: job {job_id}"))
    return failed


def run(project: str, *, apply: bool, verbose: bool) -> int:
    classes = _reserving_classes(project)
    plans: List[Dict[str, Any]] = []
    failures: List[Tuple[str, str, str]] = []
    for reserving_class in classes:
        for method_name in _method_names(project, reserving_class, BF_PREFIX):
            try:
                plans.append(_plan_one(project, reserving_class, method_name))
            except Exception as err:  # noqa: BLE001 - reported, never fatal
                failures.append((reserving_class, method_name, str(err)))

    touched = [plan for plan in plans if plan["changed_rows"]]
    print(f"Project              : {project}")
    print(f"Reserving classes    : {len(classes)}")
    print(f"Methods inspected    : {len(plans)}")
    print(f"Methods to restate   : {len(touched)}")
    print(f"Rows changing        : {sum(plan['changed_rows'] for plan in touched)}")
    print(f"Blank rows filled    : {sum(plan['filled_blanks'] for plan in touched)}")
    if failures:
        print(f"Could not be read    : {len(failures)}")
        for reserving_class, method_name, reason in failures:
            print(f"  ! {reserving_class} / {method_name}: {reason}")
    if verbose:
        for plan in touched:
            print(
                f"  {plan['reserving_class']} / {plan['method']}: "
                f"{plan['changed_rows']} of {plan['origins']} rows"
                f" ({plan['filled_blanks']} previously blank)"
            )

    if not apply:
        print("\nDry run: nothing was written.")
        return 1 if failures else 0

    by_class: Dict[str, List[Dict[str, Any]]] = {}
    for plan in touched:
        by_class.setdefault(plan["reserving_class"], []).append(plan)
    applied = 0
    jobs: List[Tuple[str, str]] = []
    apply_failures: List[Tuple[str, str]] = []
    for reserving_class, class_plans in by_class.items():
        try:
            result = _apply_class(project, reserving_class, class_plans)
            applied += len(class_plans)
            if result.get("ok") and result.get("job_id"):
                jobs.append((reserving_class, str(result["job_id"])))
            else:
                apply_failures.append((reserving_class, f"walk not queued: {result.get('message') or result}"))
        except Exception as err:  # noqa: BLE001 - reported, never fatal
            apply_failures.append((reserving_class, str(err)))
            print(f"  ! FAILED {reserving_class}: {err}")

    print(f"\nRestated {applied} of {len(touched)} methods; {len(jobs)} dependent walks queued.")
    apply_failures.extend(_wait_for_walks(jobs))
    if apply_failures:
        print(f"{len(apply_failures)} reserving classes need attention:")
        for reserving_class, reason in apply_failures:
            print(f"  ! {reserving_class}: {reason}")
    return 1 if apply_failures or failures else 0


def _all_projects() -> List[str]:
    return sorted(
        entry.name
        for entry in os.scandir(config.PROJECT_SETTINGS_DIR)
        if entry.is_dir() and not entry.name.startswith(".")
    )


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--project", action="append", default=[], help="Project folder name; repeatable, run in order.")
    parser.add_argument("--all-projects", action="store_true", help="Every project folder, after any --project given.")
    parser.add_argument("--apply", action="store_true", help="Write the restated methods and queue the walks.")
    parser.add_argument("--dry-run", action="store_true", help="Report without writing (default).")
    parser.add_argument("--verbose", action="store_true", help="List every method that changes.")
    args = parser.parse_args(argv)
    if args.apply and args.dry_run:
        parser.error("Choose either --apply or --dry-run.")
    projects = list(args.project)
    if args.all_projects:
        projects.extend(name for name in _all_projects() if name not in projects)
    if not projects:
        parser.error("Give --project or --all-projects.")
    exit_code = 0
    for index, project in enumerate(projects):
        if index:
            print()
        exit_code = max(exit_code, run(project, apply=bool(args.apply), verbose=bool(args.verbose)))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
