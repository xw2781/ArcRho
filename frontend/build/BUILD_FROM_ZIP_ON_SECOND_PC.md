# ArcRho Two-PC ZIP Build Workflow

## Purpose

Use this workflow when the ArcRho repository is maintained on one Windows PC, but application packaging must run on another Windows PC because the source PC cannot execute the complete build toolchain with the required permissions.

The ZIP is a transport artifact. The build PC reads it through its permanent `E:` mapping to the source PC, copies it to a local workspace, extracts it locally, and runs the complete build from that local workspace.

```text
Source PC repository
    -> curated ArcRho.zip
    -> permanent E: mapping on build PC
    -> build PC local Documents workspace
    -> Python + Electron + NSIS build
    -> installer and published update feed
```

## Roles and Default Paths

| Role | Example path | Purpose |
| --- | --- | --- |
| Source repository | `E:\XWSpace\Repos\ArcRho` on the source PC | Source of truth for files placed in the build ZIP. |
| Source ZIP | `E:\XWSpace\Build ArcRho App\ArcRho.zip` on the source PC | Curated build input copied across the network. |
| Network view from build PC | `E:\XWSpace\Build ArcRho App\ArcRho.zip` | The build PC's permanent `E:` mapping to the source PC. |
| Local build workspace | `%USERPROFILE%\Documents\build_arcrho_app` on the build PC | Disposable local extraction and build directory. |
| Local installer output | `%USERPROFILE%\Documents\build_arcrho_app\frontend\dist` | Installer produced by the local build. |
| Published installer feed | `E:\ArcRho Server\releases\installers` on the build PC | Installer, checksum, and `latest.json` published after a successful build. |
| Shared build logs | `E:\XWSpace\Build ArcRho App\logs\<COMPUTERNAME>` | Timestamped ZIP-creation and application-build logs from both PCs. |

This workflow assumes that `E:` on the build PC is permanently mapped to `E:` on the source PC. The default ZIP and wrapper paths already use that mapping, so `ARCRHO_LOCAL_BUILD_SOURCE_ZIP` does not need to be set.

## Build-PC Prerequisites

Before starting a full build, confirm that the build PC has:

- Windows PowerShell 5.1 or later.
- Python 3.10.6 or newer within the Python 3.10 line. The build rejects Python 3.11 or later.
- Permission to install missing Python build dependencies, or all required dependencies already installed.
- Permission to execute files from the local workspace, including portable Node, `app-builder.exe`, PyInstaller, and NSIS.
- Read access to the source-PC share and write access to the local workspace.
- Write access through the mapped `E:` drive to `E:\ArcRho Server\releases\installers` and `E:\ArcRho Server\packages`, or an appropriate `PYTHON_API_PACKAGE_DIR` override for the Python package destination.
- Enough local disk space for the copied ZIP, its expanded contents, PyInstaller work files, Electron output, and the installer.

The wrapper deletes the entire local build workspace before each extraction. Never set `ARCRHO_LOCAL_BUILD_ROOT` to a directory containing files that must be preserved.

## Step 1: Create a Curated ZIP on the Source PC

Do not ZIP the live repository folder directly. A raw repository ZIP includes `.git`, agent metadata, old build outputs, caches, and logs. Those files make the archive much larger and can trigger Windows path-length and extraction failures.

Use the clean ZIP creator beside the build scripts. It creates a disposable curated staging tree, validates required build inputs, and only replaces the existing ZIP after the new archive passes validation.

First check the source prerequisites without creating an archive:

```bat
call "E:\XWSpace\Repos\ArcRho\frontend\build\create_build_source_zip.bat" --check
```

Then create the archive:

```bat
call "E:\XWSpace\Repos\ArcRho\frontend\build\create_build_source_zip.bat"
```

With the repository at the standard location, the default outputs are:

```text
E:\XWSpace\Build ArcRho App\ArcRho.zip
E:\XWSpace\Build ArcRho App\ArcRho.zip.sha256
```

Disposable `.arczip-*` staging folders, `.building-*` files, and atomic `.backup-*` files are also kept under `E:\XWSpace\Build ArcRho App`. They are removed after success; a replacement backup is retained and reported if publication fails.

To use another repository or output path, call the PowerShell implementation directly:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File 'E:\XWSpace\Repos\ArcRho\frontend\build\create_build_source_zip.ps1' `
  -SourceRoot 'E:\XWSpace\Repos\ArcRho' `
  -OutputZip 'E:\XWSpace\Build ArcRho App\ArcRho.zip'
```

The creator always includes `frontend\node-portable` and `frontend\node_modules`. They are required when the restricted build PC cannot restore Node dependencies itself.

### Required ZIP Content

The ZIP may contain one top-level `ArcRho` folder or the repository contents directly. It must contain at least:

- `frontend\build\build_app.bat`
- `frontend\build\build_app_via_local_workspace.bat`
- `frontend\build\prepare_local_build_workspace_from_zip.ps1`
- `frontend\package.json`
- `frontend\node-portable\node.exe`
- `frontend\node_modules\electron-builder\cli.js`
- `frontend\node_modules\app-builder-bin\win\x64\app-builder.exe`
- The frontend application source, Electron host, icons, build resources, release fragments, and documentation.
- `python-api\pyproject.toml`
- `python-api\src`
- `python-api\tools`
- `BUILD_SOURCE_MANIFEST.json`, containing the ZIP creation time and available Git revision state.

The ZIP creator excludes generated content such as `frontend\dist`, `frontend\python_dist`, `frontend\python_build`, logs, cached Python packages, notebooks, editor/agent state, virtual environments, and Python cache files. The curated staging process never copies root repository metadata such as `.git`, `.agents`, or `.codex`.

## Step 2: Verify the Permanent E: Mapping on the Build PC

The build PC is expected to keep the source PC mapped as `E:`. Confirm the mapping and required files before each build:

```bat
net use E:
dir "E:\XWSpace\Build ArcRho App\ArcRho.zip"
dir "E:\XWSpace\Repos\ArcRho\frontend\build\build_app_via_local_workspace.bat"
```

If `E:` is unavailable or points somewhere else, restore the established mapping before continuing. Do not substitute another drive letter for this workflow.

## Step 3: Configure and Check the Wrapper on the Build PC

Open CMD on the build PC. The wrapper already defaults to `E:\XWSpace\Build ArcRho App\ArcRho.zip`; only the local workspace override is optional:

```bat
set "ARCRHO_LOCAL_BUILD_ROOT=%USERPROFILE%\Documents\build_arcrho_app"
call "E:\XWSpace\Repos\ArcRho\frontend\build\build_app_via_local_workspace.bat" --check
```

The `--check` command prints the resolved configuration and verifies that the ZIP preparation helper is beside the wrapper. The full run performs the source-ZIP existence and timestamp checks.

## Step 4: Run the Build on the Build PC

Run without an argument to auto-increment the patch version:

```bat
call "E:\XWSpace\Repos\ArcRho\frontend\build\build_app_via_local_workspace.bat"
```

Or pass an explicit semantic version through to `build_app.bat`:

```bat
call "E:\XWSpace\Repos\ArcRho\frontend\build\build_app_via_local_workspace.bat" 1.2.0
```

The wrapper performs these steps:

1. Verifies the source ZIP and checks whether its timestamp matches the last successful ZIP build.
2. Deletes and recreates the local build workspace.
3. Copies the ZIP from the source PC to the local workspace.
4. Extracts the source locally while rejecting unsafe paths and skipping repository/agent metadata.
5. Enters the local `frontend` directory and enables installation of missing Python build dependencies.
6. Builds the Python API wheel and PyInstaller app server.
7. Builds the Electron application and NSIS installer.
8. Generates release notes and publishes the installer update feed and Python API package.
9. Records the source-ZIP timestamp only after the complete build succeeds.

Do not run `build_app.bat` directly from the mapped repository. The purpose of this workflow is to ensure that dependency execution, PyInstaller, Electron Builder, and NSIS all run from a local filesystem on the build PC.

## Step 5: Verify Outputs and Preserve Logs

A successful build reports exit code `0` and produces:

- `%ARCRHO_LOCAL_BUILD_ROOT%\frontend\dist\ArcRho-Setup-<version>.exe`
- `E:\ArcRho Server\releases\installers\ArcRho-Setup-<version>.exe`
- `E:\ArcRho Server\releases\installers\ArcRho-Setup-<version>.exe.sha256`
- `E:\ArcRho Server\releases\installers\latest.json`
- `E:\ArcRho Server\packages\arcrho_api-latest.whl`, unless `PYTHON_API_PACKAGE_DIR` overrides that destination.

ZIP-creation and application-build logs from both PCs are written directly to the shared handoff folder, separated by Windows computer name:

```text
E:\XWSpace\Build ArcRho App\logs\<COMPUTERNAME>\create_build_source_zip_<timestamp>.log
E:\XWSpace\Build ArcRho App\logs\<COMPUTERNAME>\build_app_via_local_workspace_<timestamp>.log
```

The build-PC local-workspace log covers ZIP validation, local copying and extraction, the complete application build, publishing, and the final exit code. Direct `build_app.bat` runs use `build_app_<timestamp>.log`. Logs no longer need to be copied back from the build PC's local workspace.

## ZIP Freshness Rules

- Regenerate `ArcRho.zip` after every source change that must be included in the final app.
- The ZIP is a snapshot; editing the repository after ZIP creation does not update the build input.
- The wrapper warns when the ZIP timestamp matches the archive used by the previous successful build. Continue with an unchanged ZIP only when rebuilding the same snapshot intentionally.
- A failed build does not update the successful-build timestamp marker.
- The ZIP creator writes `ArcRho.zip.sha256`. For important releases, compare that value with `Get-FileHash -Algorithm SHA256` on the build PC.

## Troubleshooting

### ZIP extraction fails on `.agents` or another directory entry

Use the current `prepare_local_build_workspace_from_zip.ps1`. It handles standard forward-slash ZIP directory entries that Windows PowerShell 5.1 `Expand-Archive` can misinterpret.

### ZIP extraction reports a very long `.git\refs\codex` path

The archive was created from the raw repository instead of the clean ZIP creator. Regenerate it using Step 1. The current extractor skips root `.git`, `.agents`, and `.codex` entries, but those files should not be transported in the first place.

### NSIS reports `macro named "MUI_HEADER_TEXT" not found`

This is an installer-source/include-order problem, not a ZIP, mapped-drive, or permission problem. Fix `frontend\build\installer.nsh` so `MUI2.nsh` is available before `MUI_HEADER_TEXT` is expanded, regenerate the ZIP, and rebuild.

### Electron Builder reports `spawn EPERM` for `app-builder.exe`

From the local `frontend` workspace on the build PC, unblock the executable and rerun the build:

```bat
powershell -NoProfile -Command "Get-Item '.\node_modules\app-builder-bin\win\x64\app-builder.exe' | Unblock-File"
```

### Python validation fails

Install Python 3.10.6 or newer within the Python 3.10 line, or set `PYTHON_EXE` to the compatible interpreter before invoking the wrapper.

### Publishing fails after the installer builds

Verify that the build PC can write through its mapped `E:` drive to `E:\ArcRho Server\releases\installers` and the configured Python package destination on the source PC.

## Completion Checklist

- The ZIP was regenerated from the intended source revision.
- The ZIP was created with `create_build_source_zip.bat`, not from the raw repository.
- The build PC's permanent `E:` mapping is available and can read the source ZIP.
- The build ran from `%USERPROFILE%\Documents\build_arcrho_app`, not the network share.
- The build exited with code `0`.
- The installer, checksum, update manifest, release notes, and Python API package were published.
- The timestamped build log was retained when troubleshooting was required.
