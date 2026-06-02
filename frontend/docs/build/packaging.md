# Build and Packaging

## Purpose
<!-- MANUAL:BEGIN -->
Document Electron + Python packaging inputs and scripts.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN build.packaging.entry_points -->
| Script | Command |
| --- | --- |
| `npm run build` | `npm run build:python-api && npm run build:python && npm run build:electron && npm run clean:python-artifacts` |
| `npm run build:electron` | `node-portable\node.exe build/patch_nsis_installer_progress.js && node-portable\node.exe node_modules/electron-builder/cli.js --win` |
| `npm run build:python` | `build\build_python_server.bat` |
| `npm run build:python-api` | `node-portable\node.exe build/build_python_api_wheel.js` |
| `npm run clean:python-artifacts` | `node -e "const fs=require('fs'); ['python_dist','python_build','build/python_packages'].forEach((p)=>fs.rmSync(p,{recursive:true,force:true}));"` |
| `npm run electron` | `electron .` |

Electron main entry: `electron/main.js`
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN build.packaging.key_files -->
- [`package.json`](../../package.json) - Build scripts, Electron builder config, installer metadata.
- [`build/server.spec`](../../build/server.spec) - PyInstaller spec for Python app-server executable.
- [`build/server_entry.py`](../../build/server_entry.py) - PyInstaller entrypoint for the bundled app server.
- [`build/release_notes.py`](../../build/release_notes.py) - Release fragment validator and versioned release note generator.
- [`electron/main.js`](../../electron/main.js) - Electron main process entry.
- [`app_launcher.py`](../../app_launcher.py) - Python host launcher used by packaged runtime.
- [`build/installer.nsh`](../../build/installer.nsh) - NSIS custom installer script include.
- [`build/patch_nsis_installer_progress.js`](../../build/patch_nsis_installer_progress.js) - Build-time helper that enables NSIS built-in file progress before electron-builder runs.
- [`build/build_app.bat`](../../build/build_app.bat) - Convenience build script wrapper.
- [`build/convert_icon.js`](../../build/convert_icon.js) - Build helper for regenerating Windows icon assets.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- Node scripts from `package.json` drive build orchestration.
- PyInstaller spec (`build/server.spec`) builds backend executable artifacts and includes the served `ui/` and `icons/` asset trees.
- `build/release_notes.py` validates unreleased change fragments and generates versioned release notes in `docs/releases/`.
- `build/build_app.bat` updates the app version before packaging: by default it bumps the patch version, and an explicit semantic version argument overrides that default.
- `build/build_app.bat` mirrors console output into timestamped `build/log/build_app_<timestamp>.log` files for troubleshooting packaging failures.
- `build/build_app_network.bat` maps its UNC build directory with `pushd`, resolves Python 3.10, and delegates to `build/build_app.bat`; use it when starting the build from a shared path such as `\\Ne7saswpn02\e\XWSpace\Repos\ArcRho\frontend\build`.
- Windows packaging currently sets `win.signAndEditExecutable` to `false` so local unsigned test installers skip Electron Builder's executable signing/resource-edit helper on locked-down PCs.
- Electron packaging enables NSIS's built-in compressor path before `electron-builder` runs so installer file progress is visible during the main install phase.
- Successful build flows now clean `python_dist/` and `python_build/` automatically.
- Published Windows installers can be staged in `E:\ArcRho Server\installer` for the desktop startup update check. The preferred feed shape is `latest.json`, `ArcRho-Setup-<version>.exe`, and `ArcRho-Setup-<version>.exe.sha256`; `latest.json` should include `version`, `installer`, and `sha256`, with optional `releaseNotes`, `mandatory`, and `publishedAt`.
- `build/publish_update_feed.ps1 -InstallerPath dist\ArcRho-Setup-<version>.exe` publishes that feed shape to `E:\ArcRho Server\installer` by default.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Build outputs: `dist/`, `python_build/`, `python_dist/`.
- The packaged server bundle is expected to contain `python_dist/arcrho_server/_internal/ui/index.html` and `python_dist/arcrho_server/_internal/icons/icon.png`; `build/build_python_server.bat` fails fast when either served asset tree is missing.
- Build logs: `build/log/build_app_<timestamp>.log`.
- Installer settings in `package.json`, `build/installer.nsh`, and `build/patch_nsis_installer_progress.js`.
- Release tracking data lives under `changes/unreleased/`, `changes/archive/`, and `docs/releases/`.
- `python_dist/` and `python_build/` are transient and removed after successful packaging.
- Runtime update feed files are external deployment artifacts under `E:\ArcRho Server\installer`; they are not build outputs and must be written by the release publishing process.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Update app packaging metadata: edit `package.json` `build` block.
2. Update bundled backend: edit `build/server.spec` and verify `extraResources` mappings.
3. Add or update unreleased change fragments in `changes/unreleased/` before packaging a release.
4. If you need a specific release version, run `build\build_app.bat <version>` (for example `build\build_app.bat 2.0.0`); otherwise the script auto-increments the patch version.
5. From another Windows PC, run `"\\Ne7saswpn02\e\XWSpace\Repos\ArcRho\frontend\build\build_app_network.bat"`; use `--check` first to verify the network path and Python 3.10 environment without starting a build.
6. If a packaged build fails, inspect the newest `build\log\build_app_<timestamp>.log`.
7. If inspecting PyInstaller artifacts is needed, run `npm run build:python` directly (the full build cleans them on success).
8. If electron-builder is reinstalled or upgraded, rerun `npm run build:electron` or `build\build_app.bat`; both paths reapply the ArcRho NSIS installer-progress patch before packaging.
9. After validating a release installer, publish it to the startup update feed with `build\publish_update_feed.ps1 -InstallerPath dist\ArcRho-Setup-<version>.exe -ReleaseNotes "<summary>"`.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Packaging excludes can accidentally omit runtime files.
- Divergence between dev and packaged paths causes startup failures.
- Disabling `win.signAndEditExecutable` is intended for local unsigned launch testing; restore the normal resource-edit/signing path before preparing a polished release installer.
- electron-builder NSIS implementation changes can break the ArcRho installer-progress patch; `build/patch_nsis_installer_progress.js` fails fast when the upstream compressor setting no longer matches the expected form.
<!-- MANUAL:END -->
