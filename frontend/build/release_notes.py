from __future__ import annotations

import argparse
import json
import shutil
import sys
from dataclasses import dataclass
from datetime import date
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
CHANGES_ROOT = REPO_ROOT / "changes"
UNRELEASED_DIR = CHANGES_ROOT / "unreleased"
ARCHIVE_DIR = CHANGES_ROOT / "archive"
RELEASES_DIR = REPO_ROOT / "docs" / "releases"
RELEASE_INDEX_PATH = RELEASES_DIR / "INDEX.md"

ALLOWED_TYPES = ("feature", "improvement", "fix", "breaking")
ALLOWED_AUDIENCES = ("user", "internal")
TYPE_TITLES = {
    "feature": "Features",
    "improvement": "Improvements",
    "fix": "Fixes",
    "breaking": "Breaking Changes",
}


@dataclass(frozen=True)
class Fragment:
    path: Path
    type: str
    scope: str
    audience: str
    summary: str
    details: tuple[str, ...]


def parse_version(version: str) -> tuple[int, int, int]:
    parts = version.strip().split(".")
    if len(parts) != 3 or any(not part.isdigit() for part in parts):
        raise ValueError(
            f"Invalid version '{version}'. Use semantic version format like 1.0.1 or 2.0.0."
        )
    return tuple(int(part) for part in parts)


def version_sort_key(path: Path) -> tuple[int, int, int]:
    return parse_version(path.stem)


def ensure_dirs() -> None:
    UNRELEASED_DIR.mkdir(parents=True, exist_ok=True)
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    RELEASES_DIR.mkdir(parents=True, exist_ok=True)


def normalize_scope(value: object, fragment_path: Path) -> str:
    scope = str(value or "").strip()
    if not scope:
        raise ValueError(f"{fragment_path}: 'scope' is required.")
    return scope


def normalize_summary(value: object, fragment_path: Path) -> str:
    summary = str(value or "").strip()
    if not summary:
        raise ValueError(f"{fragment_path}: 'summary' is required.")
    return summary


def normalize_details(value: object, fragment_path: Path) -> tuple[str, ...]:
    if value is None:
        return tuple()
    if not isinstance(value, list):
        raise ValueError(f"{fragment_path}: 'details' must be an array of strings.")
    details: list[str] = []
    for item in value:
        text = str(item or "").strip()
        if not text:
            raise ValueError(f"{fragment_path}: 'details' entries must be non-empty strings.")
        details.append(text)
    return tuple(details)


def load_fragment(path: Path) -> Fragment:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"{path}: invalid JSON ({exc})") from exc
    if not isinstance(payload, dict):
        raise ValueError(f"{path}: fragment must contain a JSON object.")

    fragment_type = str(payload.get("type", "")).strip().lower()
    if fragment_type not in ALLOWED_TYPES:
        raise ValueError(
            f"{path}: 'type' must be one of {', '.join(ALLOWED_TYPES)}."
        )

    audience = str(payload.get("audience", "")).strip().lower()
    if audience not in ALLOWED_AUDIENCES:
        raise ValueError(
            f"{path}: 'audience' must be one of {', '.join(ALLOWED_AUDIENCES)}."
        )

    return Fragment(
        path=path,
        type=fragment_type,
        scope=normalize_scope(payload.get("scope"), path),
        audience=audience,
        summary=normalize_summary(payload.get("summary"), path),
        details=normalize_details(payload.get("details"), path),
    )


def load_unreleased_fragments() -> list[Fragment]:
    ensure_dirs()
    fragments: list[Fragment] = []
    for path in sorted(UNRELEASED_DIR.glob("*.json")):
        if path.name.startswith("_"):
            continue
        fragments.append(load_fragment(path))
    return fragments


def render_fragment_entry(fragment: Fragment) -> list[str]:
    lines = [f"- **{fragment.scope}**: {fragment.summary}"]
    for detail in fragment.details:
        lines.append(f"  - {detail}")
    return lines


def render_release_notes(version: str, released_on: str, fragments: list[Fragment]) -> str:
    lines: list[str] = [
        f"# Release {version}",
        "",
        f"Released on {released_on}.",
        "",
    ]

    user_fragments = [fragment for fragment in fragments if fragment.audience == "user"]
    internal_fragments = [fragment for fragment in fragments if fragment.audience == "internal"]

    if user_fragments:
        lines.extend(["## User-Facing Changes", ""])
        for fragment_type in ALLOWED_TYPES:
            typed = [fragment for fragment in user_fragments if fragment.type == fragment_type]
            if not typed:
                continue
            lines.append(f"### {TYPE_TITLES[fragment_type]}")
            for fragment in typed:
                lines.extend(render_fragment_entry(fragment))
            lines.append("")
    else:
        lines.extend(
            [
                "## User-Facing Changes",
                "",
                "No user-facing changes were recorded for this release.",
                "",
            ]
        )

    if internal_fragments:
        lines.extend(["## Internal Notes", ""])
        for fragment in internal_fragments:
            lines.extend(render_fragment_entry(fragment))
        lines.append("")

    lines.extend(
        [
            "## Fragment Sources",
            "",
        ]
    )
    for fragment in fragments:
        lines.append(f"- `{fragment.path.relative_to(REPO_ROOT).as_posix()}`")
    lines.append("")
    return "\n".join(lines)


def render_release_index(release_files: list[Path]) -> str:
    lines = [
        "# Release Notes",
        "",
        "Generated release note index.",
        "",
    ]
    if not release_files:
        lines.append("_No releases have been generated yet._")
        lines.append("")
        return "\n".join(lines)

    lines.extend(
        [
            "| Version | Release Notes |",
            "| --- | --- |",
        ]
    )
    for path in release_files:
        rel = path.relative_to(REPO_ROOT).as_posix()
        lines.append(f"| `{path.stem}` | [{path.stem}](../../{rel}) |")
    lines.append("")
    return "\n".join(lines)


def archive_fragments(version: str, fragments: list[Fragment]) -> None:
    archive_target = ARCHIVE_DIR / version
    archive_target.mkdir(parents=True, exist_ok=True)
    for fragment in fragments:
        destination = archive_target / fragment.path.name
        if destination.exists():
            destination.unlink()
        shutil.move(str(fragment.path), str(destination))


def cmd_check() -> int:
    fragments = load_unreleased_fragments()
    print(f"Validated {len(fragments)} unreleased fragment(s).")
    return 0


def release_fragments(version: str, fragments: list[Fragment]) -> Path:
    """Write the release notes for one version and archive the fragments it consumed.

    Callers pass the fragment list explicitly so a release can consume the exact set
    that was built, rather than whatever happens to be unreleased at the time.
    """
    parse_version(version)
    released_on = date.today().isoformat()

    release_path = RELEASES_DIR / f"{version}.md"
    release_path.write_text(
        render_release_notes(version, released_on, fragments),
        encoding="utf-8",
    )

    archive_fragments(version, fragments)

    release_files = sorted(
        (path for path in RELEASES_DIR.glob("*.md") if path.name != "INDEX.md"),
        key=version_sort_key,
        reverse=True,
    )
    RELEASE_INDEX_PATH.write_text(
        render_release_index(release_files),
        encoding="utf-8",
    )
    return release_path


def cmd_release(version: str, path_file: str | None = None) -> int:
    release_path = release_fragments(version, load_unreleased_fragments())

    release_note_path = str(release_path.relative_to(REPO_ROOT).as_posix())
    if path_file:
        Path(path_file).write_text(release_note_path + "\n", encoding="utf-8")
    print(release_note_path)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate changelog fragments and generate release notes."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("check", help="Validate unreleased changelog fragments.")
    release_parser = subparsers.add_parser(
        "release",
        help="Generate release notes for a version and archive unreleased fragments.",
    )
    release_parser.add_argument("version", help="Release version in semantic format.")
    release_parser.add_argument(
        "--path-file",
        help="Optional file that receives the generated release note path.",
    )

    args = parser.parse_args()

    if args.command == "check":
        return cmd_check()
    if args.command == "release":
        return cmd_release(args.version, args.path_file)
    raise ValueError(f"Unsupported command: {args.command}")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
