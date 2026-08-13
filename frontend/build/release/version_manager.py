from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path


SEMVER_RE = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
DEFAULT_RELEASE_CHANNEL_PATH = Path(__file__).resolve().parent / "release_channel.json"
TAG_FORMAT_PRODUCT = "{product}"
TAG_FORMAT_VERSION = "{version}"
GITHUB_RELEASE_QUERY_LIMIT = 200
ABOUT_VERSION_RE = re.compile(
    r'(<div id="aboutVersion">)Version\s+\d+\.\d+\.\d+(</div>)'
)
SPLASH_VERSION_RE = re.compile(
    r'(<div class="version" id="version">)v\d+\.\d+\.\d+(</div>)'
)


def load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8-sig") as handle:
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


def max_version(versions: list[str]) -> str:
    return max(versions, key=parse_version)


def load_release_channel(channel_path: Path) -> tuple[str, str]:
    """Return the (github_repo, tag_format) pair that owns published release naming."""
    channel = load_json(channel_path)
    github_repo = str(channel.get("githubRepo", "")).strip()
    tag_format = str(channel.get("tagFormat", "")).strip()
    if not github_repo:
        raise ValueError(f"{channel_path} is missing a 'githubRepo' value.")
    if TAG_FORMAT_PRODUCT not in tag_format or TAG_FORMAT_VERSION not in tag_format:
        raise ValueError(
            f"{channel_path} 'tagFormat' must contain both "
            f"{TAG_FORMAT_PRODUCT} and {TAG_FORMAT_VERSION}."
        )
    return github_repo, tag_format


def build_release_tag_re(tag_format: str, product: str) -> re.Pattern[str]:
    pattern = re.escape(tag_format)
    pattern = pattern.replace(re.escape(TAG_FORMAT_PRODUCT), re.escape(product))
    pattern = pattern.replace(re.escape(TAG_FORMAT_VERSION), r"(\d+\.\d+\.\d+)")
    return re.compile(pattern)


def collect_github_release_versions(
    github_repo: str,
    product: str,
    tag_format: str,
) -> list[str]:
    """Read every published version for one product from the GitHub Releases history.

    GitHub Releases is the only durable record of what has shipped: the build runs from a
    throwaway local workspace, so the repository's package.json never sees the built version.
    Any failure here is raised rather than swallowed, because silently returning no history
    would rebuild a version number that is already public.
    """
    gh_executable = shutil.which("gh")
    if gh_executable is None:
        raise RuntimeError(
            "The gh CLI is required to read published release versions but was not found on PATH. "
            "Install GitHub CLI on this build machine and run 'gh auth login'."
        )

    completed = subprocess.run(
        [
            gh_executable,
            "release",
            "list",
            "--repo",
            github_repo,
            "--limit",
            str(GITHUB_RELEASE_QUERY_LIMIT),
            "--json",
            "tagName",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()
        raise RuntimeError(
            f"Could not read published releases from {github_repo} "
            f"(gh exit code {completed.returncode}). {detail}".strip()
        )

    try:
        payload = json.loads(completed.stdout or "[]")
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"Could not parse the gh release list response for {github_repo}: {exc}"
        ) from exc
    if not isinstance(payload, list):
        raise RuntimeError(f"Unexpected gh release list response for {github_repo}.")

    tag_re = build_release_tag_re(tag_format, product)
    versions: list[str] = []
    for entry in payload:
        if not isinstance(entry, dict):
            continue
        match = tag_re.fullmatch(str(entry.get("tagName", "")).strip())
        if match:
            versions.append(match.group(1))
    return versions


def resolve_target_version(
    current_version: str,
    requested_version: str | None,
    published_versions: list[str] | None = None,
    require_increase: bool = False,
) -> str:
    highest_published = max_version(published_versions) if published_versions else None

    if requested_version:
        requested_version = requested_version.strip()
        parse_version(requested_version)
        if require_increase and parse_version(requested_version) <= parse_version(current_version):
            raise ValueError(
                f"Requested version '{requested_version}' must be higher than current version '{current_version}'."
            )
        if not require_increase and parse_version(requested_version) < parse_version(current_version):
            raise ValueError(
                f"Requested version '{requested_version}' must not be lower than current version '{current_version}'."
            )
        if highest_published and parse_version(requested_version) <= parse_version(highest_published):
            raise ValueError(
                f"Requested version '{requested_version}' must be higher than the highest "
                f"published version '{highest_published}'."
            )
        return requested_version

    baseline_versions = [current_version]
    if published_versions:
        baseline_versions.extend(published_versions)
    return bump_patch(max_version(baseline_versions))


def update_about_dialog(index_html_path: Path, version: str) -> None:
    text = index_html_path.read_text(encoding="utf-8")
    updated, count = ABOUT_VERSION_RE.subn(rf"\1Version {version}\2", text, count=1)
    if count != 1:
        raise ValueError(f"Could not update About dialog version in {index_html_path}")
    index_html_path.write_text(updated, encoding="utf-8")


def update_splash_page(splash_html_path: Path, version: str) -> None:
    text = splash_html_path.read_text(encoding="utf-8")
    updated, count = SPLASH_VERSION_RE.subn(rf"\1v{version}\2", text, count=1)
    if count != 1:
        raise ValueError(f"Could not update splash version in {splash_html_path}")
    splash_html_path.write_text(updated, encoding="utf-8")


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


def update_version_metadata(repo_root: Path, version: str) -> None:
    """Write one version into every file in the frontend that carries it."""
    parse_version(version)
    package_json_path = repo_root / "package.json"
    package_json = load_json(package_json_path)
    package_name = str(package_json.get("name", "")).strip()
    if not package_name:
        raise ValueError(f"package.json is missing a name: {package_json_path}")

    package_json["version"] = version
    dump_json(package_json_path, package_json)
    sync_package_lock(repo_root / "package-lock.json", package_name, version)
    update_about_dialog(repo_root / "ui" / "index.html", version)
    update_splash_page(repo_root / "ui" / "splash.html", version)


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
    parser.add_argument(
        "--github-release-product",
        help=(
            "Product name whose GitHub Releases history defines the published baseline, "
            "such as ArcRho or Arcode. When no explicit version is provided, the patch "
            "bump starts from the newest package or published release version."
        ),
    )
    parser.add_argument(
        "--release-channel-file",
        help=(
            "Optional override for the release channel definition that owns the GitHub "
            f"repository and release tag format. Defaults to {DEFAULT_RELEASE_CHANNEL_PATH.name} "
            "beside this script."
        ),
    )
    parser.add_argument(
        "--allow-empty-release-history",
        action="store_true",
        help=(
            "Permit a patch bump when the GitHub Releases history contains no release for "
            "the product. Use only to bootstrap a product that has never been published."
        ),
    )
    parser.add_argument(
        "--require-increase",
        action="store_true",
        help="Require an explicit version to be higher than the current package version.",
    )
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[2]
    package_json_path = repo_root / "package.json"

    package_json = load_json(package_json_path)
    current_version = str(package_json.get("version", "")).strip()
    if not current_version:
        raise ValueError(f"package.json is missing a version: {package_json_path}")

    published_versions: list[str] = []
    if args.github_release_product:
        channel_path = (
            Path(args.release_channel_file)
            if args.release_channel_file
            else DEFAULT_RELEASE_CHANNEL_PATH
        )
        github_repo, tag_format = load_release_channel(channel_path)
        published_versions = collect_github_release_versions(
            github_repo,
            args.github_release_product,
            tag_format,
        )
        if not published_versions and not args.version and not args.allow_empty_release_history:
            raise ValueError(
                f"No published {args.github_release_product} releases were found in {github_repo}, "
                "so the next version cannot be derived from release history. Publish the current "
                "installer to GitHub Releases first, pass an explicit version, or rerun with "
                "--allow-empty-release-history to bootstrap a product that has never shipped."
            )

    target_version = resolve_target_version(
        current_version,
        args.version,
        published_versions=published_versions,
        require_increase=args.require_increase,
    )

    if args.dry_run:
        if args.version_file:
            Path(args.version_file).write_text(target_version + "\n", encoding="utf-8")
        print(target_version)
        return 0

    update_version_metadata(repo_root, target_version)

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
