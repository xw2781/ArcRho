#!/usr/bin/env python3
"""Convert a project's persisted ArcRho JSON to the v4 contract, in place.

Every v4 reader refuses a file it does not recognize, so a workspace written
before v4 has to be converted before a v4 build opens it. This walks one
project (or several, named explicitly), rewrites each persisted file through
the canonical contract module for its kind, and proves each rewrite by
re-reading the text it just produced and running the same pipeline again: a
converted file has to be a fixed point, or it is not what a fresh save writes.

Nothing is written without ``--apply``. Every file that is written is copied
into a backup folder first, and the run's manifest lets ``--rollback`` put
every one of them back.

Usage
-----
    py -3.10 tools/migrate_persisted_json_v4.py --project NJ_Annual_Prod_202605_Fake
    py -3.10 tools/migrate_persisted_json_v4.py --project NJ_Annual_Prod_202605_Fake --apply
    py -3.10 tools/migrate_persisted_json_v4.py --rollback 20260823T140501Z

Run it on the Server PC. The conversion reads bare wall-clock timestamps that
older files inherited from ResQ and resolves them in the local zone, so the
machine doing the conversion has to be the machine those readings came from.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import traceback
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator, Mapping

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "python-api" / "src"))
sys.path.insert(0, str(REPO_ROOT / "frontend"))

from arcrho_api.bootstrap_contract import BST_JSON_FORMAT, normalize_bootstrap_method
from arcrho_api.bornhuetter_ferguson_contract import (
    BF_JSON_FORMAT,
    normalize_bornhuetter_ferguson_method,
)
from arcrho_api.cape_cod_contract import CC_JSON_FORMAT, normalize_cape_cod_method
from arcrho_api.dataset_index_contract import (
    BS_CRA_JSON_FORMAT,
    BS_SR_JSON_FORMAT,
    RS_JSON_FORMAT,
)
from arcrho_api.dfm_contract import (
    DFM_JSON_FORMAT,
    normalize_dfm_method,
    persisted_projection,
)
from arcrho_api.io import persisted_json_text
from arcrho_api.persisted_json_v4_upgrade import (
    PersistedJsonUpgradeError,
    UnsupportedMethodFormatError,
    sidecar_with_method_notes,
    snake_key,
    stranded_method_notes,
    upgrade_dataset_number_formats,
    upgrade_dataset_sidecar,
    upgrade_method,
    upgrade_project_audit_log,
    upgrade_runtime_cache_provenance,
    upgrade_source_import,
)
from arcrho_api.sidecar_core_contract import validate_sidecar_core

try:  # The Result Selection normalizer is the one contract that lives app-side.
    from app_server.services.result_selection_service import (
        normalize_method_payload as _normalize_result_selection,
    )
except Exception:  # pragma: no cover - reported once, in the run header
    _normalize_result_selection = None


BACKUP_DIR_NAME = ".arcrho-v4-backup"
STAGING_DIR_NAME = ".arcrho-resq-import-staging"
CACHE_PROVENANCE_DIR_NAME = ".arcrho-cache-provenance"

KIND_METHOD = "method"
KIND_SIDECAR = "sidecar"
KIND_CACHE_PROVENANCE = "cache provenance"
KIND_PROJECT_AUDIT_LOG = "project audit log"
KIND_SOURCE_IMPORT = "source import"
KIND_NUMBER_FORMATS = "dataset number formats"

STATUS_CONVERTED = "converted"
STATUS_UNCHANGED = "unchanged"
STATUS_STRANDED = "stranded"
STATUS_FAILED = "failed"


def _dfm(payload: Mapping[str, Any]) -> dict[str, Any]:
    return persisted_projection(normalize_dfm_method(payload, require_complete=False))


def _result_selection(payload: Mapping[str, Any]) -> dict[str, Any]:
    if _normalize_result_selection is None:
        return dict(payload)
    return _normalize_result_selection(payload, require_complete_basis=False)


def _as_is(payload: Mapping[str, Any]) -> dict[str, Any]:
    # Berquist Sherman has no Python contract; its shape is owned browser-side,
    # so the upgrade module's output is already the whole conversion.
    return dict(payload)


METHOD_NORMALIZERS: dict[str, Callable[[Mapping[str, Any]], dict[str, Any]]] = {
    DFM_JSON_FORMAT: _dfm,
    BF_JSON_FORMAT: lambda p: normalize_bornhuetter_ferguson_method(p, require_complete=False),
    CC_JSON_FORMAT: lambda p: normalize_cape_cod_method(p, require_complete=False),
    BST_JSON_FORMAT: lambda p: normalize_bootstrap_method(p, require_complete=False),
    RS_JSON_FORMAT: _result_selection,
    BS_SR_JSON_FORMAT: _as_is,
    BS_CRA_JSON_FORMAT: _as_is,
}


@dataclass
class Outcome:
    """One file's result, for the run report."""

    path: Path
    kind: str
    status: str
    detail: str = ""
    before: int = 0
    after: int = 0


@dataclass
class ClassPlan:
    """A reserving class folder, and the notes and revisions its methods produced."""

    root: Path
    staged: bool = False
    publication_revisions: dict[str, str] = field(default_factory=dict)
    rescued_notes: dict[str, list[str]] = field(default_factory=dict)


class ConversionFailure(RuntimeError):
    """A file the conversion refuses to guess at."""


def _long(path: Path) -> str:
    """The path in the form Windows accepts beyond 260 characters.

    The backup mirror adds its own root on top of a path that is already long
    -- a staged ResQ import nests a session id and an escaped reserving class
    under the project -- and Windows refuses the copy unless it is asked in
    the extended form. Everything the conversion touches goes through here so
    the length of a workspace path is never what stops a run.
    """

    text = str(path)
    if os.name != "nt" or text.startswith("\\\\?\\"):
        return text
    return "\\\\?\\" + str(Path(text).resolve())


def _read_json(path: Path) -> Any:
    with open(_long(path), "r", encoding="utf-8") as handle:
        return json.load(handle)


def _shallow_snake(payload: Mapping[str, Any]) -> dict[str, Any]:
    return {snake_key(key): value for key, value in payload.items()}


def _output_dataset_name(payload: Mapping[str, Any], path: Path | None = None) -> str:
    """The dataset a method writes, whatever spelling the file uses.

    Only DFM names it ``output_dataset``; BF, Cape Cod, Bootstrap, Result
    Selection and both Berquist Sherman kinds call the same thing ``name``.
    A method the app already refused is read the same way, and falls back to
    its own file name, which is the output dataset behind a kind prefix.
    """

    details: Any = None
    if isinstance(payload, Mapping):
        details = payload.get("details_tab")
        if not isinstance(details, Mapping):
            details = payload.get("details tab")
    if isinstance(details, Mapping):
        fields = _shallow_snake(details)
        for key in ("output_dataset", "name"):
            value = str(fields.get(key) or "").strip()
            if value:
                return value
    if path is not None:
        stem = path.stem
        return stem.split("@", 1)[1].strip() if "@" in stem else stem.strip()
    return ""


def _publication_revision(payload: Mapping[str, Any]) -> str:
    metadata = payload.get("method_metadata")
    if not isinstance(metadata, Mapping):
        return ""
    return str(metadata.get("publication_revision") or "").strip()


def _json_format(payload: Mapping[str, Any]) -> str:
    if not isinstance(payload, Mapping):
        return ""
    return str(payload.get("json_format") or payload.get("json format") or "").strip()


class Migration:
    """One conversion run over one or more projects."""

    def __init__(
        self,
        workspace: Path,
        *,
        apply: bool,
        keep_going: bool,
        backup_root: Path,
        run_id: str,
        include_shared_config: bool,
    ) -> None:
        self.workspace = workspace
        self.apply = apply
        self.keep_going = keep_going
        self.backup_root = backup_root
        self.run_id = run_id
        self.include_shared_config = include_shared_config
        self.outcomes: list[Outcome] = []
        self.backups: list[dict[str, str]] = []
        self.stopped = False
        self.revisions_paired = 0
        self.revisions_unpaired = 0
        self.notes_applied = 0
        self.notes_unplaced: list[str] = []

    # -- writing -----------------------------------------------------------

    def _backup(self, path: Path) -> None:
        try:
            relative = path.relative_to(self.workspace)
        except ValueError:
            relative = Path(path.name)
        target = self.backup_root / relative
        os.makedirs(_long(target.parent), exist_ok=True)
        shutil.copy2(_long(path), _long(target))
        self.backups.append({"source": str(path), "backup": str(target)})

    def _write(self, path: Path, text: str) -> None:
        if not self.apply:
            return
        self._backup(path)
        temp = path.with_name(f"{path.name}.v4tmp")
        try:
            with open(_long(temp), "w", encoding="utf-8", newline="\n") as handle:
                handle.write(text)
            os.replace(_long(temp), _long(path))
        except OSError:
            try:
                os.unlink(_long(temp))
            except OSError:
                pass
            raise

    # -- the one conversion step -------------------------------------------

    def _convert(
        self,
        path: Path,
        kind: str,
        pipeline: Callable[[Any], dict[str, Any]],
    ) -> dict[str, Any] | None:
        """Run *pipeline*, prove the result is a fixed point, and write it.

        Returns the converted payload so a caller can read values out of it,
        or ``None`` when the file failed and the run is keeping going.
        """

        before = path.stat().st_size
        try:
            raw = _read_json(path)
            converted = pipeline(raw)
            text = persisted_json_text(converted)
            # A converted file has to survive its own round trip: parse the
            # text back, run the same pipeline, and land on the same bytes.
            if persisted_json_text(pipeline(json.loads(text))) != text:
                raise ConversionFailure("the converted file is not a fixed point")
        except UnsupportedMethodFormatError:
            raise
        except Exception as error:  # noqa: BLE001 - every failure is reported
            self._fail(path, kind, error, before)
            return None

        current = open(_long(path), "r", encoding="utf-8").read()
        if current == text:
            self.outcomes.append(
                Outcome(path, kind, STATUS_UNCHANGED, "already v4", before, before)
            )
            return converted

        try:
            self._write(path, text)
        except Exception as error:  # noqa: BLE001
            self._fail(path, kind, error, before)
            return None

        self.outcomes.append(
            Outcome(path, kind, STATUS_CONVERTED, "", before, len(text.encode("utf-8")))
        )
        return converted

    def _fail(self, path: Path, kind: str, error: Exception, before: int) -> None:
        detail = f"{type(error).__name__}: {error}"
        self.outcomes.append(Outcome(path, kind, STATUS_FAILED, detail, before, before))
        if self.apply and not self.keep_going:
            self.stopped = True

    # -- walks -------------------------------------------------------------

    def _class_roots(self, project_dir: Path) -> Iterator[ClassPlan]:
        data = project_dir / "data"
        if data.is_dir():
            for child in sorted(data.iterdir()):
                if child.is_dir() and not child.name.startswith("."):
                    yield ClassPlan(child)
        staging = data / STAGING_DIR_NAME
        if staging.is_dir():
            for session in sorted(staging.iterdir()):
                if not session.is_dir() or session.name.startswith("."):
                    continue
                session_data = session / "data"
                if not session_data.is_dir():
                    continue
                for child in sorted(session_data.iterdir()):
                    if child.is_dir() and not child.name.startswith("."):
                        yield ClassPlan(child, staged=True)

    def _convert_methods(self, plan: ClassPlan) -> None:
        folder = plan.root / "methods"
        if not folder.is_dir():
            return
        for path in sorted(folder.glob("*.json")):
            if self.stopped:
                return
            self._convert_one_method(plan, path)

    def _convert_one_method(self, plan: ClassPlan, path: Path) -> None:
        try:
            raw = _read_json(path)
        except Exception as error:  # noqa: BLE001
            self._fail(path, KIND_METHOD, error, path.stat().st_size)
            return

        stamp = _json_format(raw)
        try:
            upgraded, notes = upgrade_method(raw)
        except UnsupportedMethodFormatError:
            # The app refused this file long before v4. Rescue its commentary
            # into the output dataset's sidecar and leave the file where it is.
            notes = stranded_method_notes(raw)
            dataset = _output_dataset_name(raw, path)
            if notes and dataset:
                plan.rescued_notes.setdefault(dataset.casefold(), []).append(notes)
            detail = f"{stamp or 'no json_format'}; retired before v4"
            if notes:
                detail += f"; notes rescued to {dataset or 'no output dataset'}"
            size = path.stat().st_size
            self.outcomes.append(Outcome(path, KIND_METHOD, STATUS_STRANDED, detail, size, size))
            return
        except PersistedJsonUpgradeError as error:
            self._fail(path, KIND_METHOD, error, path.stat().st_size)
            return

        normalizer = METHOD_NORMALIZERS.get(_json_format(upgraded))
        if normalizer is None:
            self._fail(
                path,
                KIND_METHOD,
                ConversionFailure(f"no contract for {_json_format(upgraded)!r}"),
                path.stat().st_size,
            )
            return

        def pipeline(payload: Any) -> dict[str, Any]:
            converted, _ = upgrade_method(payload)
            return normalizer(converted)

        result = self._convert(path, KIND_METHOD, pipeline)
        if result is None:
            return

        dataset = _output_dataset_name(result) or _output_dataset_name(upgraded, path)
        if dataset:
            revision = _publication_revision(result)
            if revision:
                plan.publication_revisions[dataset.casefold()] = revision
            if notes:
                plan.rescued_notes.setdefault(dataset.casefold(), []).append(notes)

    def _convert_sidecars(self, plan: ClassPlan) -> None:
        folder = plan.root / "sidecars"
        if not folder.is_dir():
            return
        seen: set[str] = set()
        for path in sorted(folder.glob("*.json")):
            if self.stopped:
                return
            # Match on the name the sidecar carries, never on its file name: a
            # dataset called "C 12 - CWP DFM w/ Selected LDFs" is stored as
            # "C 12 - CWP DFM w_%2F_ Selected LDFs.json", so the two strings
            # are not the same and pairing by file name silently finds nothing.
            try:
                name = str(_read_json(path).get("dataset_name") or "").strip() or path.stem
            except Exception:  # noqa: BLE001 - the conversion below reports it
                name = path.stem
            name = name.casefold()
            seen.add(name)
            revision = plan.publication_revisions.get(name)
            notes = plan.rescued_notes.get(name) or []

            def pipeline(payload: Any) -> dict[str, Any]:
                converted = upgrade_dataset_sidecar(payload, publication_revision=revision)
                for note in notes:
                    converted = sidecar_with_method_notes(converted, note)
                validate_sidecar_core(converted)
                return converted

            if self._convert(path, KIND_SIDECAR, pipeline) is not None:
                if revision:
                    self.revisions_paired += 1
                if notes:
                    self.notes_applied += len(notes)

        # A method whose output sidecar does not exist would drop its revision
        # and, worse, its rescued commentary. Both are reported, never silent.
        self.revisions_unpaired += sum(1 for name in plan.publication_revisions if name not in seen)
        for name, notes in plan.rescued_notes.items():
            if name not in seen:
                self.notes_unplaced.extend(
                    f"{plan.root.name} -> {name}: {note[:80]}" for note in notes
                )

    def _convert_cache_provenance(self, plan: ClassPlan) -> None:
        folder = plan.root / CACHE_PROVENANCE_DIR_NAME
        if not folder.is_dir():
            return
        for path in sorted(folder.glob("*.json")):
            if self.stopped:
                return
            self._convert(path, KIND_CACHE_PROVENANCE, upgrade_runtime_cache_provenance)

    def _convert_project_files(self, project_dir: Path) -> None:
        audit_log = project_dir / "audit_log.json"
        if audit_log.is_file() and not self.stopped:
            self._convert(audit_log, KIND_PROJECT_AUDIT_LOG, upgrade_project_audit_log)
        source_import = project_dir / "source" / "source_import.json"
        if source_import.is_file() and not self.stopped:
            self._convert(source_import, KIND_SOURCE_IMPORT, upgrade_source_import)

    def _convert_shared_config(self) -> None:
        # One file for the whole workspace, so it is converted once per run and
        # not once per project. Every v4 client refuses the old stamp, so it
        # has to move even when a single project is being converted.
        path = self.workspace / "config" / "dataset_number_formats.json"
        if path.is_file() and not self.stopped:
            self._convert(path, KIND_NUMBER_FORMATS, upgrade_dataset_number_formats)

    def run(self, project_dirs: list[Path]) -> None:
        for project_dir in project_dirs:
            if self.stopped:
                break
            for plan in self._class_roots(project_dir):
                if self.stopped:
                    break
                # Methods first: an output sidecar takes its publication
                # revision from the converted method, never from disk.
                self._convert_methods(plan)
                self._convert_sidecars(plan)
                self._convert_cache_provenance(plan)
            self._convert_project_files(project_dir)
        if self.include_shared_config:
            self._convert_shared_config()

    # -- reporting ---------------------------------------------------------

    def report(self) -> dict[str, Any]:
        by_kind: dict[str, dict[str, int]] = {}
        totals = {STATUS_CONVERTED: 0, STATUS_UNCHANGED: 0, STATUS_STRANDED: 0, STATUS_FAILED: 0}
        bytes_before = 0
        bytes_after = 0
        for outcome in self.outcomes:
            bucket = by_kind.setdefault(
                outcome.kind,
                {STATUS_CONVERTED: 0, STATUS_UNCHANGED: 0, STATUS_STRANDED: 0, STATUS_FAILED: 0,
                 "before": 0, "after": 0},
            )
            bucket[outcome.status] += 1
            bucket["before"] += outcome.before
            bucket["after"] += outcome.after
            totals[outcome.status] += 1
            bytes_before += outcome.before
            bytes_after += outcome.after
        return {
            "run_id": self.run_id,
            "mode": "apply" if self.apply else "dry-run",
            "workspace": str(self.workspace),
            "stopped_early": self.stopped,
            "totals": totals,
            "bytes_before": bytes_before,
            "bytes_after": bytes_after,
            "by_kind": by_kind,
            "revisions_paired": self.revisions_paired,
            "revisions_unpaired": self.revisions_unpaired,
            "notes_applied": self.notes_applied,
            "notes_unplaced": self.notes_unplaced,
            "stranded": [
                {"path": str(o.path), "detail": o.detail}
                for o in self.outcomes
                if o.status == STATUS_STRANDED
            ],
            "failures": [
                {"path": str(o.path), "detail": o.detail}
                for o in self.outcomes
                if o.status == STATUS_FAILED
            ],
            "backups": len(self.backups),
        }

    def write_manifest(self) -> Path | None:
        if not self.apply or not self.backups:
            return None
        self.backup_root.mkdir(parents=True, exist_ok=True)
        manifest = self.backup_root / "manifest.json"
        manifest.write_text(
            json.dumps({"run_id": self.run_id, "files": self.backups}, indent=2),
            encoding="utf-8",
        )
        return manifest


def rollback(workspace: Path, run_id: str) -> int:
    manifest = workspace / BACKUP_DIR_NAME / run_id / "manifest.json"
    if not manifest.is_file():
        print(f"No backup manifest for run {run_id} at {manifest}", file=sys.stderr)
        return 2
    payload = json.loads(manifest.read_text(encoding="utf-8"))
    restored = 0
    for entry in payload.get("files") or []:
        source = Path(entry["source"])
        backup = Path(entry["backup"])
        if not os.path.isfile(_long(backup)):
            print(f"  missing backup, skipped: {backup}", file=sys.stderr)
            continue
        os.makedirs(_long(source.parent), exist_ok=True)
        shutil.copy2(_long(backup), _long(source))
        restored += 1
    print(f"Restored {restored} of {len(payload.get('files') or [])} files from run {run_id}.")
    return 0


def _percent(before: int, after: int) -> str:
    if not before:
        return "n/a"
    return f"{(after - before) / before * 100:+.1f}%"


def print_summary(report: Mapping[str, Any]) -> None:
    totals = report["totals"]
    print()
    print(f"Run {report['run_id']}  ({report['mode']})")
    print(f"Workspace: {report['workspace']}")
    print()
    header = f"{'File kind':<24}{'Converted':>10}{'Unchanged':>11}{'Stranded':>10}{'Failed':>8}{'Bytes before':>14}{'Bytes after':>13}{'Change':>9}"
    print(header)
    print("-" * len(header))
    for kind, bucket in sorted(report["by_kind"].items()):
        print(
            f"{kind:<24}{bucket[STATUS_CONVERTED]:>10}{bucket[STATUS_UNCHANGED]:>11}"
            f"{bucket[STATUS_STRANDED]:>10}{bucket[STATUS_FAILED]:>8}"
            f"{bucket['before']:>14,}{bucket['after']:>13,}"
            f"{_percent(bucket['before'], bucket['after']):>9}"
        )
    print("-" * len(header))
    print(
        f"{'Total':<24}{totals[STATUS_CONVERTED]:>10}{totals[STATUS_UNCHANGED]:>11}"
        f"{totals[STATUS_STRANDED]:>10}{totals[STATUS_FAILED]:>8}"
        f"{report['bytes_before']:>14,}{report['bytes_after']:>13,}"
        f"{_percent(report['bytes_before'], report['bytes_after']):>9}"
    )

    print()
    print(f"Publication revisions carried from method to sidecar: {report['revisions_paired']:,}")
    if report["revisions_unpaired"]:
        print(f"  methods whose output sidecar is missing: {report['revisions_unpaired']:,}")
    print(f"Rescued method notes written into a sidecar:          {report['notes_applied']:,}")
    if report["notes_unplaced"]:
        print(f"  NOTES WITH NOWHERE TO GO ({len(report['notes_unplaced'])}):")
        for line in report["notes_unplaced"]:
            print(f"    {line}")

    if report["stranded"]:
        print()
        print(f"Left alone -- refused by the app before v4 ({len(report['stranded'])}):")
        for entry in report["stranded"]:
            print(f"  {entry['path']}")
            print(f"      {entry['detail']}")

    if report["failures"]:
        print()
        print(f"FAILED ({len(report['failures'])}):")
        for entry in report["failures"]:
            print(f"  {entry['path']}")
            print(f"      {entry['detail']}")

    if report["stopped_early"]:
        print()
        print("Stopped at the first failure. Nothing after it was touched;")
        print(f"roll the run back with  --rollback {report['run_id']}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--workspace", default=r"E:\ArcRho Server", help="Workspace root (default: %(default)s)")
    parser.add_argument("--project", action="append", default=[], help="Project folder name; repeatable")
    parser.add_argument("--apply", action="store_true", help="Write the conversion (default is a dry run)")
    parser.add_argument("--keep-going", action="store_true", help="Do not stop at the first failure when applying")
    parser.add_argument("--skip-shared-config", action="store_true", help="Leave the workspace-wide number formats file alone")
    parser.add_argument("--report", default="", help="Write the full JSON report to this path")
    parser.add_argument("--rollback", default="", help="Restore every file written by the named run and exit")
    args = parser.parse_args(argv)

    workspace = Path(args.workspace)
    if not workspace.is_dir():
        print(f"Workspace not found: {workspace}", file=sys.stderr)
        return 2

    if args.rollback:
        return rollback(workspace, args.rollback)

    if not args.project:
        print("Name at least one project with --project.", file=sys.stderr)
        return 2

    project_dirs: list[Path] = []
    for name in args.project:
        project_dir = workspace / "projects" / name
        if not project_dir.is_dir():
            print(f"Project not found: {project_dir}", file=sys.stderr)
            return 2
        project_dirs.append(project_dir)

    if _normalize_result_selection is None:
        print("WARNING: the Result Selection normalizer did not import; those files", file=sys.stderr)
        print("         would be renamed but not re-normalized. Fix the import first.", file=sys.stderr)
        return 2

    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    migration = Migration(
        workspace,
        apply=args.apply,
        keep_going=args.keep_going,
        backup_root=workspace / BACKUP_DIR_NAME / run_id,
        run_id=run_id,
        include_shared_config=not args.skip_shared_config,
    )

    print(f"{'Applying' if args.apply else 'Dry run'}: {', '.join(args.project)}")
    if args.apply:
        print(f"Backups: {migration.backup_root}")
    migration.run(project_dirs)

    manifest = migration.write_manifest()
    report = migration.report()
    print_summary(report)
    if manifest:
        print()
        print(f"Backup manifest: {manifest}")

    if args.report:
        report_path = Path(args.report)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(f"Report: {report_path}")

    return 1 if report["totals"][STATUS_FAILED] else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:  # pragma: no cover
        print("\nInterrupted.", file=sys.stderr)
        raise SystemExit(130)
