"""Side-by-side ArcRho vs ResQ review of the Prior Qtr vectors (81 and 82).

For every vector named like ``C 81``, ``D 82``, ``E1 81`` ... in the 17
reserving-class paths of a project, this lays the persisted ArcRho values and
the live ResQ values next to each other with a difference matrix, using the
same workbook as ``dataset_side_by_side_review.py``. Use it after the "Load
Prior Quarter Vectors" macro to confirm the loaded 81/82 vectors match what
ResQ holds for the same project.

Nothing is written back to ArcRho or ResQ.

Run with Python 3.10 from the repository root, on a machine that can reach ResQ:

    py -3.10 python-api/migration/validation/prior_quarter_vectors_side_by_side_review.py --project "NJ_Annual_Prod_2026 Sep"
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

_VALIDATION_DIR = Path(__file__).resolve().parent
for _import_root in (_VALIDATION_DIR.parent, _VALIDATION_DIR):
    if str(_import_root) not in sys.path:
        sys.path.insert(0, str(_import_root))

import resq_data_migration as migration  # noqa: E402
from resq_migration.core import _encode_rc_folder, _normalize_import_name, _safe_attr  # noqa: E402
from resq_migration.extractors import export_vector  # noqa: E402

import dataset_side_by_side_review as review  # noqa: E402

PRIOR_QTR_VECTOR = re.compile(r"^[A-Za-z]\d? 8[12]\b")
SOURCE_KINDS = ("input",)


def _is_prior_qtr_vector(name: str) -> bool:
    return bool(PRIOR_QTR_VECTOR.match(name))


def _read_resq_prior_qtr_vectors(reserving_class, progress) -> dict[tuple[str, str], dict]:
    out: dict[tuple[str, str], dict] = {}
    for vector in list(reserving_class.Vectors()):
        name = _normalize_import_name(_safe_attr(vector, "Name", ""))
        if _is_prior_qtr_vector(name):
            progress(f"    vector: {name}")
            out[(review.VECTOR_KIND, name)] = export_vector(vector)
    return out


def run_comparison(project_name: str, rc_paths: list[str], progress=print):
    import win32com.client
    from win32com.client import gencache

    previous_scope = migration._apply_runtime_scope(project_name, migration.SERVER_ROOT)
    valuation_months = review._valuation_months(project_name)
    account = review.resq_credentials()
    app = gencache.EnsureDispatch("ResQ3Automation.ResQApplication")
    records: list[dict] = []
    rc_errors: list[tuple[str, str]] = []
    try:
        app.ConnectByName(account["connection_name"], account["user_name"], account["password"])
        project = app.Projects().Item(project_name)
        for number, rc_path in enumerate(rc_paths, start=1):
            progress(f"RC {number}/{len(rc_paths)}: {rc_path}")
            rc_dir = migration.PROJECT_DATA_DIR / _encode_rc_folder(rc_path)
            arcrho = {
                key: dataset
                for key, dataset in review._read_arcrho_datasets(rc_dir, SOURCE_KINDS, valuation_months).items()
                if key[0] == review.VECTOR_KIND and _is_prior_qtr_vector(key[1])
            }
            try:
                resq = _read_resq_prior_qtr_vectors(project.ReservingClasses().Item(rc_path), progress)
            except Exception as exc:
                rc_errors.append((rc_path, f"could not read ResQ reserving class: {type(exc).__name__}: {exc}"))
                continue
            for kind, name in sorted(set(arcrho) | set(resq), key=lambda key: key[1].casefold()):
                records.append(review._build_record(rc_path, kind, name, arcrho.get((kind, name)), resq.get((kind, name))))
    finally:
        try:
            app.Disconnect()
        except Exception:
            pass
        migration._restore_runtime_scope(previous_scope)
    return records, rc_errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--project", required=True, help="Project name, the same in ArcRho and ResQ.")
    parser.add_argument("--rc", action="append", help="Only reserving classes whose path contains this text; repeatable.")
    parser.add_argument("--no-open", action="store_true", help="Do not open the workbook when the run finishes.")
    args = parser.parse_args(argv)

    rc_paths = review.RC_PATHS
    if args.rc:
        needles = [text.casefold() for text in args.rc]
        rc_paths = [path for path in rc_paths if any(needle in path.casefold() for needle in needles)]
        if not rc_paths:
            print("No reserving class matched --rc.")
            return 2

    records, rc_errors = run_comparison(args.project, rc_paths)
    output_path = _VALIDATION_DIR / "results" / f"prior_quarter_vectors_side_by_side_{args.project}.xlsx"
    review.write_workbook(
        output_path, records, rc_errors,
        project_name=args.project, rc_paths=rc_paths, source_kinds=SOURCE_KINDS,
    )
    flagged = [record for record in records if record["needs_review"]]
    print(f"Compared {len(records)} Prior Qtr vector(s) across {len(rc_paths)} reserving class(es).")
    print(f"{len(flagged)} need review" + (f", {len(rc_errors)} reserving-class error(s)" if rc_errors else "") + ".")
    print(f"Excel report: {output_path}")
    attention = bool(flagged or rc_errors)
    if attention and not args.no_open:
        try:
            os.startfile(output_path)  # noqa: S606 - opening the report just written
        except Exception as exc:
            print(f"Could not open the report automatically: {type(exc).__name__}: {exc}")
    return 1 if attention else 0


if __name__ == "__main__":
    raise SystemExit(main())
