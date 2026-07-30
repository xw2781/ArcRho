"""Remove the legacy ``EEX Formula`` column from one reserving-class JSON file.

This utility intentionally changes only the specified JSON file. It does not
modify a paired ``reserving_class_types.xlsx`` workbook.

Examples:

    Edit PROJECT_NAME and APPLY_CHANGES below, then run this file directly
    from VS Code without command-line arguments.

    py -3.10 tools/drop_eex_formula_column.py \
        --project-name "Example" \
        --dry-run

    py -3.10 tools/drop_eex_formula_column.py \
        --file "E:\\ArcRho Server\\projects\\Example\\reserving_class_types.json" \
        --apply
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import uuid
from pathlib import Path
from typing import Any, Dict, Mapping, Sequence, Tuple


EEX_COLUMN = "EEX Formula"
BACKUP_SUFFIX = ".before-eex-drop.bak"
TEMP_MARKER = ".eex-drop."
PROJECTS_ROOT = Path(r"E:\ArcRho Server\projects")
# Used when neither --project-name nor --file is supplied.
PROJECT_NAME = "NJ_Annual_Prod_2026 Q2-May Subchannel"
# False previews the change; True creates a backup and updates the JSON file.
APPLY_CHANGES = True
RESERVING_CLASS_FILENAME = "reserving_class_types.json"
_INVALID_PROJECT_NAME_CHARS = frozenset('<>:"/\\|?*\x00')


class DropEexColumnError(RuntimeError):
    """Raised when the requested JSON mutation cannot be performed safely."""


def _read_json_object(path: Path) -> Tuple[Dict[str, Any], bytes]:
    try:
        raw_bytes = path.read_bytes()
    except FileNotFoundError:
        raise DropEexColumnError(f"JSON file was not found: {path}")
    except OSError as error:
        raise DropEexColumnError(f"Failed to read JSON file {path}: {error}")

    try:
        payload = json.loads(raw_bytes.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise DropEexColumnError(f"File is not valid UTF-8 JSON: {error}")
    if not isinstance(payload, dict):
        raise DropEexColumnError("The JSON root must be an object.")
    return payload, raw_bytes


def drop_eex_formula_column(
    payload: Mapping[str, Any],
) -> Tuple[Dict[str, Any], bool, int]:
    """Return a copy of *payload* with the EEX column and matching cells removed."""

    raw_columns = payload.get("columns")
    raw_rows = payload.get("rows")
    if not isinstance(raw_columns, list):
        raise DropEexColumnError("The JSON object must contain a list-valued columns field.")
    if not isinstance(raw_rows, list):
        raise DropEexColumnError("The JSON object must contain a list-valued rows field.")

    normalized_columns = [
        str(value if value is not None else "").strip()
        for value in raw_columns
    ]
    matches = [
        index
        for index, column_name in enumerate(normalized_columns)
        if column_name == EEX_COLUMN
    ]
    if len(matches) > 1:
        raise DropEexColumnError(
            f"The columns list contains {len(matches)} duplicate {EEX_COLUMN!r} columns."
        )

    expected_width = len(raw_columns)
    normalized_rows = []
    for row_number, raw_row in enumerate(raw_rows, start=2):
        if not isinstance(raw_row, list):
            raise DropEexColumnError(f"Row {row_number} must be an array.")
        if len(raw_row) != expected_width:
            raise DropEexColumnError(
                f"Row {row_number} has {len(raw_row)} cells; expected {expected_width}."
            )
        normalized_rows.append(list(raw_row))

    if not matches:
        return dict(payload), False, len(normalized_rows)

    eex_index = matches[0]
    output = dict(payload)
    output["columns"] = [
        value for index, value in enumerate(raw_columns) if index != eex_index
    ]
    output["rows"] = [
        [value for index, value in enumerate(row) if index != eex_index]
        for row in normalized_rows
    ]
    return output, True, len(normalized_rows)


def _json_bytes(payload: Mapping[str, Any]) -> bytes:
    return (json.dumps(payload, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def _sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _write_new_file(path: Path, content: bytes) -> None:
    try:
        with path.open("xb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
    except FileExistsError:
        raise DropEexColumnError(f"Refusing to overwrite existing file: {path}")
    except OSError as error:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass
        raise DropEexColumnError(f"Failed to write {path}: {error}")


def apply_drop(path: Path) -> Dict[str, Any]:
    payload, original_bytes = _read_json_object(path)
    output, changed, row_count = drop_eex_formula_column(payload)
    backup_path = path.with_name(path.name + BACKUP_SUFFIX)
    if not changed:
        return {
            "ok": True,
            "mode": "applied",
            "changed": False,
            "path": str(path),
            "backup_path": "",
            "rows": row_count,
            "warning": "No paired XLSX workbook was modified.",
        }
    if backup_path.exists():
        raise DropEexColumnError(
            f"Backup already exists; refusing to continue: {backup_path}"
        )

    temp_path = path.with_name(f"{path.name}{TEMP_MARKER}{uuid.uuid4().hex}.tmp")
    backup_created = False
    try:
        current_bytes = path.read_bytes()
        if _sha256(current_bytes) != _sha256(original_bytes):
            raise DropEexColumnError(
                "The JSON file changed after it was read; no update was applied."
            )

        _write_new_file(backup_path, original_bytes)
        backup_created = True
        _write_new_file(temp_path, _json_bytes(output))
        os.replace(temp_path, path)

        verified, _verified_bytes = _read_json_object(path)
        verified_output, verified_changed, _verified_rows = drop_eex_formula_column(verified)
        if verified_changed or verified_output != verified:
            raise DropEexColumnError("The updated JSON file failed verification.")
    except Exception as error:
        try:
            temp_path.unlink(missing_ok=True)
        except OSError:
            pass
        if backup_created and backup_path.exists():
            try:
                os.replace(backup_path, path)
            except OSError as rollback_error:
                raise DropEexColumnError(
                    f"{error} Rollback failed: {rollback_error}"
                ) from error
        if isinstance(error, DropEexColumnError):
            raise
        raise DropEexColumnError(f"Failed to update {path}: {error}") from error

    return {
        "ok": True,
        "mode": "applied",
        "changed": True,
        "path": str(path),
        "backup_path": str(backup_path),
        "rows": row_count,
        "warning": "No paired XLSX workbook was modified.",
    }


def preview_drop(path: Path) -> Dict[str, Any]:
    payload, _original_bytes = _read_json_object(path)
    output, changed, row_count = drop_eex_formula_column(payload)
    return {
        "ok": True,
        "mode": "dry-run",
        "changed": False,
        "would_change": changed,
        "path": str(path),
        "rows": row_count,
        "columns_before": list(payload.get("columns", [])),
        "columns_after": list(output.get("columns", [])),
        "warning": "No paired XLSX workbook will be modified.",
    }


def _project_file_path(project_name: str) -> Path:
    clean_name = project_name.strip()
    if (
        not clean_name
        or clean_name in {".", ".."}
        or clean_name != project_name
        or any(character in clean_name for character in _INVALID_PROJECT_NAME_CHARS)
    ):
        raise DropEexColumnError(
            "Project name must be one valid ArcRho project directory name."
        )
    return (PROJECTS_ROOT / clean_name / RESERVING_CLASS_FILENAME).resolve()


def _target_file(args: argparse.Namespace) -> Path:
    if args.file:
        return Path(args.file).expanduser().resolve()
    return _project_file_path(args.project_name or PROJECT_NAME)


def _parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Remove the legacy EEX Formula column and corresponding row cells "
            "from one reserving-class JSON file."
        )
    )
    target = parser.add_mutually_exclusive_group()
    target.add_argument(
        "--file",
        help=(
            "Explicit path to the reserving_class_types.json file. Overrides "
            "the configured project selection."
        ),
    )
    target.add_argument(
        "--project-name",
        help=(
            "ArcRho project directory under E:\\ArcRho Server\\projects. "
            "Defaults to PROJECT_NAME configured near the top of this script."
        ),
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate and report the change without writing the file.",
    )
    mode.add_argument(
        "--apply",
        action="store_true",
        help="Create a backup and atomically update the JSON file.",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_args(argv)
    try:
        path = _target_file(args)
        should_apply = args.apply or (not args.dry_run and APPLY_CHANGES)
        result = apply_drop(path) if should_apply else preview_drop(path)
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return 0
    except DropEexColumnError as error:
        print(f"EEX column drop refused: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
