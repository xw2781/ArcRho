# ArcRho and Arcode Local Release Build

## Purpose

Use this workflow when the repository, the build toolchain, and an authenticated `gh` CLI
all live on the same Windows PC. It builds the installer, publishes the GitHub Release, and
records what shipped without a second PC, a build share, a source ZIP, or a listener.

```text
This PC's repository
    -> build_app_from_local_repo.bat
    -> prerequisite checks
    -> in-place build of frontend\ (Python + Electron + NSIS)
    -> published GitHub Release
    -> release bookkeeping committed in this repository
```

The [two-PC ZIP workflow](BUILD_FROM_ZIP_ON_SECOND_PC.md) is unchanged and remains the route
to use when the PC holding the repository cannot run the full toolchain. Both entry points
run the same build body in `build_app_via_local_workspace.bat`, so a change to the packaging
steps affects both.

## Why There Is No Repository Sync Step

The two-PC workflow builds in a disposable workspace, so everything the build writes back
into the source tree is destroyed with that workspace: the version bump, the generated
release notes, and the archiving of the changelog fragments the release consumed. That is
what `sync_published_release.py` exists to reconstruct, and why the source ZIP has to carry
a fragment snapshot.

A local build has no such gap. It runs in the repository, so `version_manager.py` bumps
`package.json` in place, `release_notes.py` writes `docs\releases\<version>.md`, and the
fragments it consumed are archived into `changes\archive\<version>` — all in the working
tree, as they happen. Nothing needs reconstructing, and the fragment accounting is exact by
construction: the release consumes what was on disk when it ran.

The final step therefore only refreshes the documentation index and commits, through
`sync_published_release.py --bookkeeping-only`. That reuses the same staged-path list and
commit message as the two-PC sync, so both routes record a release identically.

## Prerequisites

`build_app_from_local_repo.bat --check` verifies all of these and builds nothing:

- Windows PowerShell 5.1 or later.
- Python 3.10.6 or newer within the Python 3.10 line. The build rejects Python 3.11 or later.
- `frontend\node-portable\node.exe` with a complete ArcBot/Codex payload. This directory is
  **not in Git**, so a fresh clone will not have it. Copy it from a machine that does, then
  refresh it with `build\arcbot_runtime\refresh_bundled_codex_runtime.ps1`.
- `frontend\node_modules\electron-builder\cli.js`. Run `npm install` in `frontend` if absent.
- The `gh` CLI installed and authenticated (`gh auth login`, or `GH_TOKEN`) with permission to
  create releases on the repository named in `release_channel.json`. This is required twice:
  the version step reads the published release history to decide the next version, and the
  publish step creates the release the packaged app's update checker reads.
- A reachable `PYTHON_API_PACKAGE_DIR`. It defaults to `E:\ArcRho Server\packages`, which on a
  client PC is a **mapped network drive**. An ArcRho build publishes the shared Python API
  wheel there, so that step still depends on the machine hosting `ArcRho Server`. Override the
  variable to build without it.
- Valid release fragments under `changes\unreleased`.

The check runs the same ArcBot runtime smoke the build runs first, so an incomplete
`node-portable` fails in seconds instead of after a version bump and a full package.

## Running a Release

```bat
frontend\build\build_app_from_local_repo.bat --check
frontend\build\build_app_from_local_repo.bat
```

To use a specific semantic version instead of auto-incrementing the patch version:

```bat
frontend\build\build_app_from_local_repo.bat 1.3.0
```

To write the release bookkeeping but review it before committing:

```bat
frontend\build\build_app_from_local_repo.bat --no-commit
```

For standalone Arcode, select the product first. Arcode does not publish the Python API wheel:

```bat
set ARCRHO_BUILD_PRODUCT=arcode
frontend\build\build_app_from_local_repo.bat
```

### Environment Overrides

| Variable | Default | Purpose |
| --- | --- | --- |
| `ARCRHO_BUILD_PRODUCT` | `arcrho` | Select `arcrho` or `arcode`. |
| `ARCRHO_LOCAL_RELEASE_WORK_DIR` | `%USERPROFILE%\Documents\ArcRho Local Build` | Build logs and the version handover file. Deliberately outside the repository. |
| `PYTHON_API_PACKAGE_DIR` | `E:\ArcRho Server\packages` | Shared Python API wheel destination. |
| `PYTHON_EXE` | resolved via `py -3.10` | Python 3.10 interpreter used for packaging. |

## What the Build Writes Into the Repository

A local build is not read-only against the working tree. On success it leaves:

- `package.json`, `package-lock.json`, `ui\index.html`, and `ui\splash.html` at the new version.
- `docs\releases\<version>.md` and a regenerated `docs\releases\INDEX.md`.
- `changes\unreleased\*.json` moved into `changes\archive\<version>`.
- `docs\generated\file_manifest.md` refreshed by the documentation index builder.

Unless `--no-commit` was passed, exactly those paths are committed and nothing is pushed.
Unrelated work in the worktree is never staged.

Build outputs (`dist\`, `python_dist\`, `python_build\`, `build\generated\`) are also written
into `frontend`, but they are ignored by Git and the build removes the transient ones on
success.

## Verifying the Result

A successful run reports exit code `0` and produces:

- `frontend\dist\ArcRho-Setup-<version>.exe`
- A GitHub Release tagged `ArcRho-v<version>` with the installer and its `.sha256` attached.
  This is what the packaged app's update checker reads, and the history the next build's
  version number is derived from.
- `E:\ArcRho Server\packages\arcrho_api-latest.whl`, unless `PYTHON_API_PACKAGE_DIR` overrides it.
- One local commit recording the release bookkeeping.

The tag name and target repository come from `release_channel.json`, which both
`publish_github_release.ps1` and `version_manager.py` read. Change the tag shape there rather
than in either script.

## When Something Fails

A failure after the version step leaves the version bump in the working tree. The installer
is only published once packaging has succeeded, so the repository can be ahead of what
shipped. Inspect and reset with:

```bat
git status --short
git checkout -- frontend/package.json frontend/package-lock.json frontend/ui/index.html frontend/ui/splash.html
```

If the build published the release but the commit step failed, the installer is already live
and only the bookkeeping is missing. Finish it by hand from `frontend`:

```bat
python build\release\sync_published_release.py <version> --bookkeeping-only --commit
```

That command refuses to run unless the build really did write the version, the release notes,
and the fragment archive, so it cannot silently produce a half-recorded release.

### The ArcBot runtime check fails

`node-portable` is not in Git and a copied runtime can be missing the Codex shim. Refresh it:

```bat
powershell -NoProfile -ExecutionPolicy Bypass -File frontend\build\arcbot_runtime\refresh_bundled_codex_runtime.ps1
```

### The Python API wheel step fails

`PYTHON_API_PACKAGE_DIR` points at the `ArcRho Server` workspace. On a client PC that is a
mapped network drive, so it needs the hosting machine to be up. Reconnect the drive, or set
the variable to a local folder when you only need the installer.

### Electron Builder reports `spawn EPERM` for `app-builder.exe`

```bat
powershell -NoProfile -Command "Get-Item '.\node_modules\app-builder-bin\win\x64\app-builder.exe' | Unblock-File"
```

## Completion Checklist

- `--check` passed before the build was started.
- The build exited with code `0`.
- The GitHub Release the update checker reads was created with the installer and checksum.
- The pre-build and `win-unpacked` ArcBot runtime checks both passed.
- `changes\unreleased` drained into `changes\archive\<version>`.
- The release bookkeeping commit exists locally and was reviewed before pushing.
