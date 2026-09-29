#!/usr/bin/env python3
"""Put calculated vector sidecars back into the vector layout, in place.

A vector sidecar records its display period under ``period_length`` and carries
none of the triangle fields. Until the dependent walk was fixed it rewrote a
recalculated calculated vector in the triangle layout instead -- ``origin_length``,
``development_length``, ``cumulative`` and ``calendar`` in place of
``period_length`` -- so the period the dataset was shown at was lost. This finds
those files and rewrites them through ``arcrho_api.sidecar_core_contract``,
taking the display period from ``origin_length``. Everything else in a file, its
order included, is left as it is, and a file already in the vector layout is
not touched, so the run is repeatable.

Nothing is written without ``--apply``.

Usage
-----
    py -3.10 tools/repair_calculated_vector_sidecars.py --project "NJ_Annual_Prod_202605_Fake"
    py -3.10 tools/repair_calculated_vector_sidecars.py --project "NJ_Annual_Prod_202605_Fake" --apply
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Iterator

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "python-api" / "src"))

from arcrho_api.io import persisted_json_text  # noqa: E402
from arcrho_api.sidecar_core_contract import (  # noqa: E402
    SIDECAR_DISPLAY_ORIGIN_FIELD,
    SIDECAR_DISPLAY_PERIOD_FIELD,
    apply_display_length_fields,
    display_lengths,
    is_vector_format,
)

DEFAULT_WORKSPACE = r"E:\ArcRho Server"


def sidecar_files(workspace: Path, projects: list[str]) -> Iterator[Path]:
    """Every sidecar of every named project, or of the whole workspace."""

    root = workspace / "projects"
    names = projects or sorted(entry.name for entry in root.iterdir() if entry.is_dir())
    for name in names:
        for sidecar_dir in sorted((root / name / "data").glob("*/sidecars")):
            yield from sorted(sidecar_dir.glob("*.json"))


def repaired(payload: dict[str, Any]) -> dict[str, Any] | None:
    """*payload* in the vector layout, or None when it already is one."""

    if payload.get("source_kind") != "calculated" or not is_vector_format(payload.get("data_format")):
        return None
    period = display_lengths(payload)[0] or int(payload.get(SIDECAR_DISPLAY_ORIGIN_FIELD) or 0)
    if not period:
        raise ValueError("it records no display period")
    fixed = dict(payload)
    apply_display_length_fields(fixed, "Vector", period)
    if fixed == payload:
        return None
    # ``period_length`` takes the place ``origin_length`` held, so the file
    # reads the way every builder writes it.
    order = [SIDECAR_DISPLAY_PERIOD_FIELD if key == SIDECAR_DISPLAY_ORIGIN_FIELD else key for key in payload]
    return {key: fixed[key] for key in order if key in fixed}


def repair(path: Path, apply: bool) -> dict[str, Any] | None:
    """Repair one sidecar; returns what changed, or None when it need not."""

    payload = json.loads(path.read_text(encoding="utf-8"))
    fixed = repaired(payload)
    if fixed is None:
        return None
    if apply:
        # Through a temporary file, as every other sidecar writer does: a run
        # stopped part way leaves the old file, never half of the new one.
        temp = path.with_name(f"{path.name}.{uuid.uuid4()}.tmp")
        try:
            temp.write_text(persisted_json_text(fixed), encoding="utf-8", newline="\n")
            os.replace(temp, path)
        finally:
            if temp.exists():
                temp.unlink()
    return {
        "file": str(path),
        "period_length": fixed[SIDECAR_DISPLAY_PERIOD_FIELD],
        "removed": sorted(set(payload) - set(fixed)),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--workspace", default=DEFAULT_WORKSPACE, help="Workspace root (default: %(default)s)")
    parser.add_argument("--project", action="append", default=[], help="Project folder name; repeatable")
    parser.add_argument("--apply", action="store_true", help="Write the repair (default is a dry run)")
    parser.add_argument("--workers", type=int, default=32, help="Files read at once (default: %(default)s)")
    args = parser.parse_args(argv)

    workspace = Path(args.workspace)
    if not (workspace / "projects").is_dir():
        print(f"Workspace not found: {workspace}", file=sys.stderr)
        return 2

    changed: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    paths = list(sidecar_files(workspace, args.project))

    def run(path: Path) -> tuple[Path, dict[str, Any] | None, str]:
        try:
            return path, repair(path, args.apply), ""
        except Exception as err:  # a sidecar that cannot be repaired is reported, never skipped silently
            return path, None, f"{type(err).__name__}: {err}"

    # Every file on the share is a network round trip, so the walk pays them
    # in parallel rather than one awaited read at a time.
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        for path, result, error in pool.map(run, paths):
            if error:
                failures.append({"file": str(path), "error": error})
            elif result:
                changed.append(result)

    print(f"Workspace: {workspace}")
    print(f"Sidecars scanned:  {len(paths):,}")
    print(f"Sidecars repaired: {len(changed):,}{'' if args.apply else ' (dry run, nothing written)'}")
    for entry in changed:
        print(f"  period_length {entry['period_length']:>2}  {entry['file']}")
    for failure in failures:
        print(f"  FAILED  {failure['file']}: {failure['error']}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
