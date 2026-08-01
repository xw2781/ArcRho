"""Publish active ArcRho macros to the shared server macro library.

Copies active ``*.py`` macros in this folder to the shared library that the
ArcRho app's "Macro Library" window reads (default
``E:\\ArcRho Server\\shared\\macros``, override with ``--library-dir`` or the
``ARCRHO_MACRO_LIBRARY_DIR`` environment variable). Use ``--only`` to publish
selected macros.

For each macro it:
- validates the ``<arcrho-macro>`` metadata block has a semantic ``Version``
  and a non-empty single-line ``Release Note`` (see README.md);
- archives the library copy it replaces to
  ``<library>/archive/<macro-stem>/<old-version>/<macro-file>``;
- replaces the library file atomically (temp file + ``os.replace``) so
  readers never observe a half-written macro.

Run by deployers only; the library folder should be read-only for users.

Usage:
    python publish_macro_library.py [--library-dir PATH] [--dry-run]
"""
from __future__ import annotations

import argparse
import os
import re
import sys
import tempfile
from pathlib import Path

DEFAULT_LIBRARY_DIR = r"E:\ArcRho Server\shared\macros"
LIBRARY_DIR_ENV = "ARCRHO_MACRO_LIBRARY_DIR"
ARCHIVE_DIR_NAME = "archive"
META_BEGIN = "# <arcrho-macro>"
META_END = "# </arcrho-macro>"
SEMVER_PATTERN = re.compile(r"^\d+\.\d+\.\d+$")

SOURCE_DIR = Path(__file__).resolve().parent


def parse_meta_field(text: str, field: str) -> str:
    in_block = False
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if line == META_BEGIN:
            in_block = True
            continue
        if line == META_END:
            break
        if not in_block:
            continue
        if line.startswith("#"):
            line = line[1:].strip()
        if ":" in line:
            key, value = line.split(":", 1)
            if key.strip().lower() == field.lower():
                return value.strip()
    return ""


def validate_macro(path: Path, text: str) -> list[str]:
    problems: list[str] = []
    if META_BEGIN not in text:
        problems.append("missing <arcrho-macro> metadata block")
        return problems
    version = parse_meta_field(text, "Version")
    if not SEMVER_PATTERN.match(version):
        problems.append(f"Version must be major.minor.patch, found: {version or '(empty)'}")
    if not parse_meta_field(text, "Release Note"):
        problems.append("Release Note is missing or empty")
    return problems


def atomic_write(target: Path, data: bytes) -> None:
    fd, temp_name = tempfile.mkstemp(prefix=".publish_", suffix=".tmp", dir=str(target.parent))
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(temp_name, target)
    except BaseException:
        try:
            os.remove(temp_name)
        except OSError:
            pass
        raise


def archive_replaced_copy(library_dir: Path, target: Path, dry_run: bool) -> str:
    old_text = target.read_text(encoding="utf-8-sig")
    old_version = parse_meta_field(old_text, "Version") or "unversioned"
    archive_path = library_dir / ARCHIVE_DIR_NAME / target.stem / old_version / target.name
    if archive_path.exists():
        return f"archive already holds v{old_version}"
    if not dry_run:
        archive_path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write(archive_path, target.read_bytes())
    return f"archived previous v{old_version}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--library-dir",
        default=os.environ.get(LIBRARY_DIR_ENV) or DEFAULT_LIBRARY_DIR,
        help="Shared macro library folder (default: %(default)s)",
    )
    parser.add_argument("--dry-run", action="store_true", help="Report actions without writing")
    parser.add_argument(
        "--only",
        action="append",
        default=None,
        metavar="MACRO_FILE",
        help="Publish only the named macro file(s); repeatable (default: all active macros)",
    )
    args = parser.parse_args()

    library_dir = Path(args.library_dir)
    macros = sorted(
        (p for p in SOURCE_DIR.glob("*.py") if p.name != Path(__file__).name),
        key=lambda p: p.name.lower(),
    )
    if args.only:
        wanted = {name.lower() for name in args.only}
        macros = [p for p in macros if p.name.lower() in wanted]
        missing = wanted - {p.name.lower() for p in macros}
        if missing:
            print(f"Unknown macro file(s): {', '.join(sorted(missing))}")
            return 1
    if not macros:
        print(f"No macro files found in {SOURCE_DIR}")
        return 1

    failures = 0
    for path in macros:
        text = path.read_text(encoding="utf-8-sig")
        problems = validate_macro(path, text)
        if problems:
            failures += 1
            print(f"FAIL  {path.name}: {'; '.join(problems)}")
            continue
    if failures:
        print(f"\n{failures} macro(s) failed validation; nothing was published.")
        return 1

    if not args.dry_run:
        library_dir.mkdir(parents=True, exist_ok=True)

    for path in macros:
        data = path.read_bytes()
        text = path.read_text(encoding="utf-8-sig")
        version = parse_meta_field(text, "Version")
        target = library_dir / path.name
        notes: list[str] = []
        if target.exists():
            if target.read_bytes() == data:
                print(f"SKIP  {path.name}: library already has v{version}")
                continue
            notes.append(archive_replaced_copy(library_dir, target, args.dry_run))
        if not args.dry_run:
            atomic_write(target, data)
        action = "WOULD PUBLISH" if args.dry_run else "PUBLISH"
        suffix = f" ({'; '.join(notes)})" if notes else ""
        print(f"{action}  {path.name} v{version}{suffix}")

    print(f"\nLibrary: {library_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
