from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


SEMVER_RE = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
ABOUT_VERSION_RE = re.compile(
    r'(<div id="aboutVersion">)Version\s+\d+\.\d+\.\d+(</div>)'
)


def load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError(f"{path} does not contain a JSON object")
    return data


def dump_json(path: Path, payload: dict) -> None:
    text = json.dumps(payload, indent=2) + "\n"
    path.write_text(text, encoding="utf-8")


def parse_version(value: str) -> tuple[int, int, int]:
    match = SEMVER_RE.fullmatch(value.strip())
    if not match:
        raise ValueError(
            f"Invalid version '{value}'. Use semantic version format like 1.0.1 or 2.0.0."
        )
    return tuple(int(part) for part in match.groups())


def bump_patch(version: str) -> str:
    major, minor, patch = parse_version(version)
    return f"{major}.{minor}.{patch + 1}"


def is_strictly_greater_version(candidate: str, current: str) -> bool:
    return parse_version(candidate) > parse_version(current)


def resolve_target_version(current_version: str, requested_version: str | None) -> str:
    if requested_version:
        requested_version = requested_version.strip()
        parse_version(requested_version)
        if not is_strictly_greater_version(requested_version, current_version):
            raise ValueError(
                f"Requested version '{requested_version}' must be greater than current version '{current_version}'."
            )
        return requested_version
    return bump_patch(current_version)


def update_about_dialog(index_html_path: Path, version: str) -> None:
    text = index_html_path.read_text(encoding="utf-8")
    updated, count = ABOUT_VERSION_RE.subn(rf"\1Version {version}\2", text, count=1)
    if count != 1:
        raise ValueError(f"Could not update About dialog version in {index_html_path}")
    index_html_path.write_text(updated, encoding="utf-8")


def sync_package_lock(package_lock_path: Path, package_name: str, version: str) -> None:
    package_lock = load_json(package_lock_path)
    package_lock["name"] = package_name
    package_lock["version"] = version
    packages = package_lock.get("packages")
    if isinstance(packages, dict):
        root_package = packages.get("")
        if isinstance(root_package, dict):
            root_package["name"] = package_name
            root_package["version"] = version
    dump_json(package_lock_path, package_lock)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Update ArcRho build version metadata."
    )
    parser.add_argument(
        "version",
        nargs="?",
        help="Optional explicit semantic version to set. Defaults to patch bump.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Compute the next version without modifying files.",
    )
    parser.add_argument(
        "--version-file",
        help="Optional file that receives the computed version.",
    )
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parent.parent
    package_json_path = repo_root / "package.json"
    package_lock_path = repo_root / "package-lock.json"
    index_html_path = repo_root / "ui" / "index.html"

    package_json = load_json(package_json_path)
    current_version = str(package_json.get("version", "")).strip()
    package_name = str(package_json.get("name", "")).strip()
    if not current_version:
        raise ValueError(f"package.json is missing a version: {package_json_path}")
    if not package_name:
        raise ValueError(f"package.json is missing a name: {package_json_path}")

    target_version = resolve_target_version(current_version, args.version)

    if args.dry_run:
        if args.version_file:
            Path(args.version_file).write_text(target_version + "\n", encoding="utf-8")
        print(target_version)
        return 0

    package_json["version"] = target_version
    dump_json(package_json_path, package_json)
    sync_package_lock(package_lock_path, package_name, target_version)
    update_about_dialog(index_html_path, target_version)

    if args.version_file:
        Path(args.version_file).write_text(target_version + "\n", encoding="utf-8")
    print(target_version)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
