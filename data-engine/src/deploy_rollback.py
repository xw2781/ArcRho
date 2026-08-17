"""Report which build each ArcRho Server component holds, and roll one back.

A deploy rotates the live app folder into its standby slot, so the build it
replaced stays on the server as a complete folder. That makes the previous
release recoverable by the same three renames that installed the new one --
``swap_deploy`` rotates live and slot either way, so a rollback is a deploy run
backwards rather than a second transaction with its own failure modes.

Only the immediately previous build is recoverable. The slot is also the delta
base the next deploy compares against, so a second deploy overwrites it; older
releases come back by rebuilding them from the repository, not from the server.
"""

from __future__ import annotations

import argparse
import importlib
import sys
from contextlib import nullcontext
from pathlib import Path
from typing import Any


BASE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BASE_DIR.parent
for _path in (PROJECT_ROOT, BASE_DIR):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from build_runtime import (
    align_workspace_root_env,
    bundle_version,
    deploy_slot_paths,
    describe_stamp,
    read_deploy_stamp,
    swap_deploy,
)

# Must run before utils is imported: utils resolves the workspace root once at
# import time, and this reads and rotates folders in the deployed workspace.
align_workspace_root_env()

from utils import (  # noqa: E402
    DEPLOYED_COMPONENT_ROLES,
    component_app_name,
    component_key,
    get_project_root,
)


# Rolling a component back has to stop it exactly the way deploying it does, so
# the window comes from that component's own build script rather than a second
# copy of its kill-switch, heartbeat, and restart handling. Admin Control and
# Launcher deploy without a stopped window and roll back without one for the
# same reason.
STOP_CONTEXT_BY_ROLE = {
    "bridge": "bridge_stopped",
    "engine": "engines_stopped",
    "gateway": "gateway_stopped",
    "orchestrator": "orchestrator_stopped",
}


def _build_identity(stamp: dict[str, Any] | None) -> tuple[str, str, str]:
    if stamp is None:
        return ("", "", "")
    return (
        str(stamp.get("bundle_version") or ""),
        str(stamp.get("built_at") or ""),
        str(stamp.get("git_commit") or ""),
    )


def deployment_row(apps_dir: Path, role: str) -> dict[str, Any]:
    """What one component currently has deployed and parked."""

    app_name = component_app_name(role)
    live, slot, _ = deploy_slot_paths(apps_dir, app_name)
    return {
        "role": role,
        "app_name": app_name,
        "live": read_deploy_stamp(live) if live.is_dir() else None,
        "slot": read_deploy_stamp(slot) if slot.is_dir() else None,
    }


def deployment_rows(apps_dir: Path, roles: tuple[str, ...] = DEPLOYED_COMPONENT_ROLES) -> list[dict[str, Any]]:
    return [deployment_row(apps_dir, role) for role in roles]


def rollback_blocker(row: dict[str, Any]) -> str | None:
    """Why this component cannot be rolled back, or ``None`` when it can."""

    if row["slot"] is None:
        return "no parked previous build"
    live_identity = _build_identity(row["live"])
    slot_identity = _build_identity(row["slot"])
    if any(live_identity) and live_identity == slot_identity:
        # The Launcher's in-place fallback and a staged-but-unswapped deploy
        # both leave the slot holding what is already live; rotating that would
        # take a stopped window and change nothing.
        return "the parked build is the one already deployed"
    return None


def describe_deployment(stamp: dict[str, Any] | None) -> str:
    return "-" if stamp is None else describe_stamp(stamp)


def render_status(rows: list[dict[str, Any]], repository_version: str) -> str:
    lines = [
        f"{'Component':<14}{'Deployed':<46}{'Parked (rollback target)'}",
        f"{'-' * 13:<14}{'-' * 45:<46}{'-' * 45}",
    ]
    for row in rows:
        lines.append(
            f"{row['role']:<14}"
            f"{describe_deployment(row['live']):<46}"
            f"{describe_deployment(row['slot'])}"
        )

    lines.append("")
    lines.append(f"Repository bundle version: {repository_version}")
    deployed = {
        str(row["live"].get("bundle_version") or "")
        for row in rows
        if row["live"] is not None
    }
    unstamped = [row["role"] for row in rows if row["live"] is not None and not row["live"].get("bundle_version")]
    if unstamped:
        lines.append(
            "Deployed before versions were stamped, so their release is unknown: "
            + ", ".join(unstamped)
        )
    stamped = sorted(version for version in deployed if version)
    if len(stamped) > 1:
        lines.append(f"Components disagree on the bundle version: {', '.join(stamped)}")
    elif stamped and stamped[0] != repository_version:
        lines.append(
            f"The server runs {stamped[0]} while the repository is at {repository_version}."
        )
    return "\n".join(lines)


def stopped_window(role: str):
    """The component's own deploy-time stopped window, or nothing to stop."""

    context_name = STOP_CONTEXT_BY_ROLE.get(role)
    if context_name is None:
        return nullcontext()
    module = importlib.import_module(f"arcrho_{role}.build_exe")
    return getattr(module, context_name)()


def rollback(apps_dir: Path, role: str) -> dict[str, Any]:
    """Rotate the parked previous build back into place for one component."""

    row = deployment_row(apps_dir, role)
    blocker = rollback_blocker(row)
    if blocker is not None:
        raise RuntimeError(f"Cannot roll back {row['app_name']}: {blocker}.")

    print(f"\n>>> Rolling {row['app_name']} back to {describe_stamp(row['slot'])}")
    with stopped_window(role):
        swap_deploy(apps_dir, row["app_name"])
    return deployment_row(apps_dir, role)


def resolve_roles(requested: list[str] | None) -> tuple[str, ...]:
    if not requested:
        return DEPLOYED_COMPONENT_ROLES
    roles: list[str] = []
    for value in requested:
        role = component_key(value)
        if role not in DEPLOYED_COMPONENT_ROLES:
            raise ValueError(f"{value!r} is not a deployed server component.")
        if role not in roles:
            roles.append(role)
    return tuple(roles)


def cmd_status(apps_dir: Path, roles: tuple[str, ...]) -> int:
    print(f"Workspace: {apps_dir}\n")
    print(render_status(deployment_rows(apps_dir, roles), bundle_version()))
    return 0


def cmd_rollback(apps_dir: Path, roles: tuple[str, ...], assume_yes: bool) -> int:
    rows = deployment_rows(apps_dir, roles)
    eligible = [row for row in rows if rollback_blocker(row) is None]
    for row in rows:
        blocker = rollback_blocker(row)
        if blocker is not None:
            print(f"Skipping {row['app_name']}: {blocker}.")
    if not eligible:
        print("\nNothing to roll back.")
        return 1

    print("\nPlanned rollback:")
    for row in eligible:
        print(
            f"  {row['app_name']}: {describe_deployment(row['live'])}"
            f" -> {describe_stamp(row['slot'])}"
        )
    if not assume_yes:
        answer = input("\nProceed? [y/N] ").strip().lower()
        if answer not in ("y", "yes"):
            print("Aborted.")
            return 1

    completed: list[str] = []
    try:
        for row in eligible:
            rollback(apps_dir, row["role"])
            completed.append(row["app_name"])
    finally:
        # A bundle left half rolled back is the outcome that most needs saying
        # out loud, so report it whether or not the run finished cleanly.
        remaining = [row["app_name"] for row in eligible if row["app_name"] not in completed]
        if remaining:
            print("\nNot rolled back: " + ", ".join(remaining))
    print("\nRolled back: " + ", ".join(completed))
    return 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Inspect and roll back deployed ArcRho Server components."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    for name, help_text in (
        ("status", "Show the deployed and parked build of each component."),
        ("rollback", "Restore the parked previous build."),
    ):
        subparser = subparsers.add_parser(name, help=help_text)
        subparser.add_argument(
            "--role",
            action="append",
            help="Limit to one component; repeatable. Defaults to the whole bundle.",
        )
        if name == "rollback":
            subparser.add_argument(
                "--yes", action="store_true", help="Skip the confirmation prompt."
            )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    apps_dir = get_project_root() / "apps"
    roles = resolve_roles(args.role)
    if args.command == "status":
        return cmd_status(apps_dir, roles)
    return cmd_rollback(apps_dir, roles, args.yes)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
