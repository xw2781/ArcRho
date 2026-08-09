"""Bring the repository in line with a release that has already been published.

The application build runs from a disposable local workspace on the build PC, so
everything it writes back into the source tree is discarded with that workspace:
the version bump in package.json, the generated release notes, and the archiving
of the changelog fragments the release consumed. The repository therefore drifts
behind what has actually shipped, unreleased fragments never drain, and every
later release regenerates notes covering the entire fragment history.

Run this on the source PC, in the repository, after a build has published a
release. It verifies the release exists, syncs the version metadata to it, writes
its release notes, and archives the fragments it consumed.

GitHub Releases is the source of truth for what shipped. This script verifies
against the release tag through `git ls-remote` rather than the gh CLI, so it does
not require gh to be installed on the source PC.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import zipfile
from pathlib import Path

import release_notes
import version_manager


DEFAULT_SOURCE_ZIP = Path(r"E:\XWSpace\Build ArcRho App\ArcRho.zip")
ZIP_FRAGMENT_PREFIX = "frontend/changes/unreleased/"


def resolve_release_tag(product: str, channel_path: Path) -> str:
    _, tag_format = version_manager.load_release_channel(channel_path)
    return tag_format.replace(
        version_manager.TAG_FORMAT_PRODUCT, product
    ).replace(version_manager.TAG_FORMAT_VERSION, "{version}")


def remote_tag_exists(tag: str, remote: str) -> bool:
    completed = subprocess.run(
        ["git", "ls-remote", "--tags", remote, f"refs/tags/{tag}"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        cwd=str(release_notes.REPO_ROOT),
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()
        raise RuntimeError(f"Could not read tags from '{remote}'. {detail}".strip())
    return bool((completed.stdout or "").strip())


def read_zip_fragment_names(source_zip: Path) -> set[str] | None:
    """Return the fragment file names the build ZIP carried, or None if unavailable.

    The ZIP is the exact input the published build consumed. Restricting the release
    to those fragments keeps work added after the ZIP was cut out of the release it
    was never part of.
    """
    if not source_zip.is_file():
        return None
    names: set[str] = set()
    try:
        with zipfile.ZipFile(source_zip) as archive:
            for entry in archive.namelist():
                normalized = entry.replace("\\", "/")
                index = normalized.find(ZIP_FRAGMENT_PREFIX)
                if index == -1 or normalized.endswith("/"):
                    continue
                name = normalized[index + len(ZIP_FRAGMENT_PREFIX) :]
                if name and "/" not in name and name.endswith(".json"):
                    names.add(name)
    except (zipfile.BadZipFile, OSError) as exc:
        print(f"WARNING: Could not read fragments from {source_zip}: {exc}", file=sys.stderr)
        return None
    return names or None


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Sync the repository to an already-published release.",
    )
    parser.add_argument("version", help="Published version, such as 1.2.5.")
    parser.add_argument(
        "--product",
        default="ArcRho",
        help="Product whose release tag is verified. Defaults to ArcRho.",
    )
    parser.add_argument(
        "--remote",
        default="origin",
        help="Git remote that holds the release tags. Defaults to origin.",
    )
    parser.add_argument(
        "--source-zip",
        default=str(DEFAULT_SOURCE_ZIP),
        help=(
            "Build ZIP whose fragment list defines what the release consumed. When it "
            "is missing or no longer matches, every unreleased fragment is consumed."
        ),
    )
    parser.add_argument(
        "--release-channel-file",
        help="Optional override for the release channel definition.",
    )
    parser.add_argument(
        "--skip-tag-check",
        action="store_true",
        help="Do not verify that the release tag exists on the remote.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-run for a version that has already been synced.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report what would change without writing anything.",
    )
    args = parser.parse_args()

    version_manager.parse_version(args.version)

    channel_path = (
        Path(args.release_channel_file)
        if args.release_channel_file
        else version_manager.DEFAULT_RELEASE_CHANNEL_PATH
    )
    tag = resolve_release_tag(args.product, channel_path).replace("{version}", args.version)

    if args.skip_tag_check:
        print(f"Skipping the remote tag check for {tag}.")
    elif not remote_tag_exists(tag, args.remote):
        raise ValueError(
            f"Release tag '{tag}' was not found on '{args.remote}'. Publish the release "
            "before syncing the repository to it, or pass --skip-tag-check if the tag is "
            "intentionally absent."
        )
    else:
        print(f"Verified published release tag {tag} on {args.remote}.")

    archive_target = release_notes.ARCHIVE_DIR / args.version
    if archive_target.exists() and not args.force:
        raise ValueError(
            f"{archive_target} already exists, so {args.version} looks synced already. "
            "Pass --force to run it again."
        )

    fragments = release_notes.load_unreleased_fragments()
    built_names = read_zip_fragment_names(Path(args.source_zip))
    if built_names is None:
        print(
            "No usable build ZIP fragment list; consuming every unreleased fragment.",
            file=sys.stderr,
        )
        consumed = fragments
        deferred: list[release_notes.Fragment] = []
    else:
        consumed = [fragment for fragment in fragments if fragment.path.name in built_names]
        deferred = [fragment for fragment in fragments if fragment.path.name not in built_names]

    if not consumed:
        raise ValueError(
            f"No unreleased fragments belong to {args.version}. The repository may already "
            "be synced, or the build ZIP has been replaced by a later build."
        )

    package_json = version_manager.load_json(release_notes.REPO_ROOT / "package.json")
    current_version = str(package_json.get("version", "")).strip()

    print("")
    print(f"Version metadata : {current_version} -> {args.version}")
    print(f"Fragments to release : {len(consumed)}")
    print(f"Fragments left unreleased : {len(deferred)}")
    for fragment in deferred:
        print(f"  keeping {fragment.path.name}")

    if args.dry_run:
        print("")
        print("Dry run: nothing was written.")
        return 0

    version_manager.update_version_metadata(release_notes.REPO_ROOT, args.version)
    release_path = release_notes.release_fragments(args.version, consumed)

    print("")
    print(f"Release notes written: {release_path.relative_to(release_notes.REPO_ROOT).as_posix()}")
    print(f"Fragments archived to: changes/archive/{args.version}")
    print("Review and commit the result; this script does not commit.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
