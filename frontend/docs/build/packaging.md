# Build and Packaging

## Purpose
<!-- MANUAL:BEGIN -->
Document Electron + Python packaging inputs and scripts.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN build.packaging.entry_points -->
| Script | Command |
| --- | --- |
| `npm run arcode` | `set ARCRHO_APP_MODE=arcode&& electron .` |
| `npm run build` | `npm run build:python-api && npm run build:python && npm run build:electron && npm run clean:python-artifacts` |
| `npm run build:arcode` | `build\build_arcode_python_server.bat && set ARCRHO_APP_MODE=arcode&& node-portable\node.exe build/convert_icon.js icons/icon_wing_geo_v8.svg build/generated/arcode-icons && node-portable\node.exe build/patch_nsis_installer_progress.js && node-portable\node.exe node_modules/electron-builder/cli.js --config electron-builder.arcode.json --win && node-portable\node.exe -e "const fs=require('fs'); ['python_dist/arcode_server','python_build'].forEach((p)=>fs.rmSync(p,{recursive:true,force:true}));"` |
| `npm run build:arcode:electron` | `set ARCRHO_APP_MODE=arcode&& node-portable\node.exe build/convert_icon.js icons/icon_wing_geo_v8.svg build/generated/arcode-icons && node-portable\node.exe build/patch_nsis_installer_progress.js && node-portable\node.exe node_modules/electron-builder/cli.js --config electron-builder.arcode.json --win` |
| `npm run build:arcode:icons` | `node-portable\node.exe build/convert_icon.js icons/icon_wing_geo_v8.svg build/generated/arcode-icons` |
| `npm run build:arcode:python` | `build\build_arcode_python_server.bat` |
| `npm run build:electron` | `node-portable\node.exe build/patch_nsis_installer_progress.js && node-portable\node.exe node_modules/electron-builder/cli.js --win` |
| `npm run build:python` | `build\build_python_server.bat` |
| `npm run build:python-api` | `node-portable\node.exe build/build_python_api_wheel.js` |
| `npm run clean:arcode-python-artifacts` | `node-portable\node.exe -e "const fs=require('fs'); ['python_dist/arcode_server','python_build'].forEach((p)=>fs.rmSync(p,{recursive:true,force:true}));"` |
| `npm run clean:python-artifacts` | `node -e "const fs=require('fs'); ['python_dist','python_build','build/python_packages'].forEach((p)=>fs.rmSync(p,{recursive:true,force:true}));"` |
| `npm run electron` | `electron .` |

Electron main entry: `electron/main.js`
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN build.packaging.key_files -->
- [`package.json`](../../package.json) - Build scripts, Electron builder config, installer metadata.
- [`build/server.spec`](../../build/server.spec) - PyInstaller spec for Python app-server executable.
- [`build/server_entry.py`](../../build/server_entry.py) - PyInstaller entrypoint for the bundled app server.
- [`build/write_backend_artifact_manifest.py`](../../build/write_backend_artifact_manifest.py) - Build-time identity manifest for the complete collected backend bundle.
- [`build/release_notes.py`](../../build/release_notes.py) - Release fragment validator and versioned release note generator.
- [`electron/main.js`](../../electron/main.js) - Electron main process entry.
- [`app_launcher.py`](../../app_launcher.py) - Python host launcher used by packaged runtime.
- [`build/installer.nsh`](../../build/installer.nsh) - NSIS custom installer script include.
- [`build/patch_nsis_installer_progress.js`](../../build/patch_nsis_installer_progress.js) - Build-time helper that restores NSIS's built-in file installation path and compiles the progress observer before electron-builder runs.
- [`build/installer_progress_helper.cs`](../../build/installer_progress_helper.cs) - Isolated Windows UI observer that derives installer percentage and time remaining from the native progress control.
- [`build/build_app_via_local_workspace.bat`](../../build/build_app_via_local_workspace.bat) - The only supported ArcRho application build entry point; prepares a local workspace and runs the complete package build.
- [`build/convert_icon.js`](../../build/convert_icon.js) - Build helper for regenerating Windows icon assets.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- Node scripts from `package.json` drive build orchestration.
- `launch_arcrho_dev_mode.bat` is the single development launcher for both products: no argument launches ArcRho, an `arcode` argument launches Arcode. It runs `electron_shell.py` under `pythonw` with `ARCRHO_BACKEND_CONSOLE=hidden`, so neither the supervisor nor the backend opens a console window, and it leaves the display version to `app.getVersion()`. Only the supervisor uses `pythonw`: `PYTHON_EXE` stays the console build because Electron passes it to the app server, and uvicorn logs to stderr, which is `None` under a GUI-subsystem interpreter with no console. The backend stays windowless through Electron's `windowsHide` and ignored stdio instead. For the same reason the supervisor redirects its own child to the null device whenever its streams are absent. It replaces `start_electron.bat`, `start_electron_no_python_window.bat`, and `start_arcode.bat`.
- PyInstaller spec (`build/server.spec`) builds backend executable artifacts and includes the served `ui/` and `icons/` asset trees. Both ArcRho and Arcode specs prepend the monorepo `python-api/src` path before collecting `arcrho_api`, so a separately installed older wheel cannot replace the canonical source bundled for that build.
- After each ArcRho or Arcode PyInstaller collection completes, `build/write_backend_artifact_manifest.py` hashes every collected backend file except its own output and atomically writes `backend-artifact.json`. Electron passes that immutable full-bundle identity to the server and uses it to reject a stale same-version listener.
- `build/release_notes.py` validates unreleased change fragments and generates versioned release notes in `docs/releases/`.
- `build/build_app.bat` updates the app version before packaging: by default it bumps the patch version, and an explicit semantic version argument overrides that default.
- `build/build_app.bat` mirrors console output into timestamped `E:\XWSpace\Build ArcRho App\logs\<COMPUTERNAME>\build_app_<timestamp>.log` files for troubleshooting packaging failures from either PC.
- `build/create_build_source_zip.bat` creates and validates the curated `ArcRho.zip` consumed by the local-workspace build wrapper, preserving portable Node dependencies while excluding repository metadata and generated artifacts; it logs each run to `E:\XWSpace\Build ArcRho App\logs\<COMPUTERNAME>\create_build_source_zip_<timestamp>.log`.
- `build/build_app_from_network.bat` maps its UNC build directory with `pushd`, resolves Python 3.10, and delegates to `build/build_app.bat`; use it when starting the build from a shared path such as `\\Ne7saswpn02\e\XWSpace\Repos\ArcRho\frontend\build`.
- Windows packaging currently sets `win.signAndEditExecutable` to `false` so local unsigned test installers skip Electron Builder's executable signing/resource-edit helper on locked-down PCs.
- ArcRho and Arcode packaging use electron-builder's built-in `APP_BUILD_DIR` / `File /r` installation path, preserving NSIS's native green progress behavior. For ArcRho, the patcher compiles a hidden x86 .NET Framework observer before packaging; the InstFiles page launches it before the installation worker starts, and it reads the native progress control to update the visible percentage and elapsed-rate estimate without running callbacks inside the NSIS interpreter. The time-left value refreshes every five seconds and is capped at five minutes while the percentage can continue advancing between estimate refreshes.
- The assisted ArcRho installer keeps action-level output in a details panel that is collapsed by default. The same native NSIS details button is used in both states: **Show details** expands the panel, then the observer moves that control below the panel and relabels it **Hide details**; its native click signal restores the collapsed layout. The InstFiles header omits the redundant **Installing** title while retaining its explanatory subtitle, and the status caption above the green bar remains reserved for percentage and estimated time remaining.
- The custom NSIS include loads `MUI2.nsh` before using Modern UI header macros because electron-builder prepends the custom include ahead of its base installer template. That position also puts it ahead of `multiUser.nsh` and of electron-builder's `!addplugindir` lines, so its install-mode variables (`$perUserInstallationFolder`, `$perMachineInstallationFolder`) and StdUtils plugin calls are only usable from the `customInit` macro, which is expanded inside `.onInit`. Using either in a function body fails the build - makensis runs with `-WX`, so the unknown-variable warning becomes an error, and the plugin cannot be resolved that early.
- The patcher also raises electron-builder's `spawnAndWrite` kill timeout in `builder-util` from 4 to 30 minutes. That budget assumes makensis only embeds a pre-built `app.7z`; ArcRho compresses the whole unpacked app inside makensis, which takes longer. The kill arrives as a signal, so a build that hits it reports `Exit code: null` with empty compiler output and no diagnostics.
- On fresh ArcRho installs running on `NE7SASWPN02`, setup detects the Windows login name and prepares `E:\<login>\ArcRho` as the directory-page default. Existing install locations and explicit `/D` paths retain precedence. If setup cannot create and verify the E-drive directory, it leaves electron-builder's standard per-user location unchanged (normally on C:). The build patcher supplies an invisible pre-directory hook so the visible directory field receives this default after the install-mode page; silent installs apply the same rule during initialization.
- The ArcRho assisted installer's Setup Options page also offers a "Launch ArcRho data engine at login" checkbox next to the Excel add-in option. It is enabled and checked by default only when the detected `ArcRho Server` folder sits on a local fixed drive (`GetDriveType` = `DRIVE_FIXED`), i.e. the install runs on the computer that hosts the server folder; on a mapped network drive the checkbox is disabled with an explanatory note. When selected, the installer runs `<server root>\apps\ArcRho Launcher\ArcRho Launcher.exe` (legacy fallback `ADAS Shell`); the launcher itself registers its shortcut in the user's `shell:startup` folder and starts the orchestrator and bridge, so the installer does not duplicate that logic.
- The ArcRho assisted installer shows an Excel add-in option at the start of setup, checked by default. It first scans available drive roots for an existing `ArcRho Server` folder and uses that folder when found; otherwise, it asks the user to choose the root drive from a dropdown and derives `<drive>\ArcRho Server\Excel Add-ins\ArcRho.xlam` from that selection. When selected, the installer opens `User Guide.xlsm` in an isolated hidden Excel instance, runs its `InstallNetworkXLAM` macro with the derived add-in path, and verifies that Excel reports the add-in as installed. Excel's configured Trust Center policy remains in force; the installer does not lower macro security.
- Successful build flows now clean `python_dist/` and `python_build/` automatically.
- The desktop startup update check reads GitHub Releases on `xw2781/ArcRho` (override with `ARCRHO_UPDATE_GITHUB_REPO`/`ARCODE_UPDATE_GITHUB_REPO`), matching a release asset named `ArcRho-Setup-<version>.exe`/`Arcode-Setup-<version>.exe` with a sibling `<installer>.sha256` checksum asset; release notes and an optional `mandatory: true` marker line come from the release body.
- `build/publish_github_release.ps1 -InstallerPath dist\ArcRho-Setup-<version>.exe -ProductName ArcRho` publishes (or updates) the GitHub Release tagged `ArcRho-v<version>` with the installer and its `.sha256` checksum as assets, using the `gh` CLI (`gh auth login` or `GH_TOKEN` must be configured on the build machine first).
- Published Windows installers are also staged in `E:\ArcRho Server\releases\installers` as a manual/backup copy; the desktop app no longer reads this feed for update checks. The preferred feed shape is `latest.json`, `ArcRho-Setup-<version>.exe`, and `ArcRho-Setup-<version>.exe.sha256`; `latest.json` should include `version`, `installer`, and `sha256`, with optional `releaseNotes`, `mandatory`, and `publishedAt`.
- `build/build_app.bat` publishes the generated installer, checksum, and `latest.json` to `E:\ArcRho Server\releases\installers` after generating release notes.
- `build/publish_update_feed.ps1 -InstallerPath dist\ArcRho-Setup-<version>.exe` publishes that backup feed shape to `E:\ArcRho Server\releases\installers` by default.
- `npm run build:arcode` builds the standalone Arcode product from the ArcRho-owned Arcode source, using `build/arcode_server.spec`, `electron-builder.arcode.json`, and the `python_dist/arcode_server` extra resource.
- Standalone Arcode packaging uses product name `Arcode`, appId `com.arcode.app`, artifact `Arcode-Setup-<version>.exe`, and a slim scripting-only app server.
- The Arcode Python server bundle includes `snowflake-connector-python` for the Snowflake SQL console; `build/check_python_build_env.py` fails fast when the selected Python 3.10 environment is missing it.
- `build/check_python_build_env.py` also requires `pyodbc`, which `build/server.spec` bundles for the managed source-table import. Both the module and the ODBC driver stay optional at runtime, so a build machine without `pyodbc` would otherwise ship a server whose SQL Server import always answers `503`.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Build outputs: `dist/`, `python_build/`, `python_dist/`.
- The packaged server bundle is expected to contain `python_dist/arcrho_server/_internal/ui/index.html` and `python_dist/arcrho_server/_internal/icons/icon.png`; `build/build_python_server.bat` fails fast when either served asset tree is missing.
- Packaged ArcRho and Arcode server bundles contain a sibling `backend-artifact.json` manifest covering the executable, Python runtime, and served assets. The manifest is generated only after required bundle files are validated.
- The packaged Arcode server bundle is expected to contain `python_dist/arcode_server/_internal/ui/arcode/main.html`, `python_dist/arcode_server/_internal/ui/ai-assistant/index.js`, `python_dist/arcode_server/_internal/ui/libs/monaco-editor/min/vs/loader.js`, and the Snowflake connector runtime modules; `build/build_arcode_python_server.bat` fails fast when required served assets are missing.
- Shared build logs: `E:\XWSpace\Build ArcRho App\logs\<COMPUTERNAME>\create_build_source_zip_<timestamp>.log`, `build_app_via_local_workspace_<timestamp>.log`, and `build_app_<timestamp>.log` for direct builds.
- Installer settings in `package.json`, `build/installer.nsh`, `build/installer_progress_helper.cs`, `build/install_arcrho_excel_addin.ps1`, and `build/patch_nsis_installer_progress.js`.
- Release tracking data lives under `changes/unreleased/`, `changes/archive/`, and `docs/releases/`.
- `python_dist/` and `python_build/` are transient and removed after successful packaging.
- Runtime update feed files are external deployment artifacts under `E:\ArcRho Server\releases\installers`; `build/build_app.bat` writes them during release packaging.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Update app packaging metadata: edit `package.json` `build` block.
2. Update bundled backend: edit `build/server.spec` for ArcRho or `build/arcode_server.spec` for Arcode and verify `extraResources` mappings.
3. Add or update unreleased change fragments in `changes/unreleased/` before packaging a release.
4. If you need a specific release version, run `build\build_app.bat <version>` (for example `build\build_app.bat 2.0.0`); otherwise the script auto-increments the patch version.
5. From another Windows PC, follow the [two-PC ZIP build workflow](../../build/BUILD_FROM_ZIP_ON_SECOND_PC.md) and run `build\build_app_via_local_workspace.bat` so packaging executes from a local filesystem; `build_app_from_network.bat` remains the direct network-build fallback.
6. If a packaged build fails, inspect the newest `E:\XWSpace\Build ArcRho App\logs\<COMPUTERNAME>\build_app_via_local_workspace_<timestamp>.log` (or `build_app_<timestamp>.log` for a direct build).
7. If inspecting PyInstaller artifacts is needed, run `npm run build:python` or `npm run build:arcode:python` directly (the full build cleans them on success).
8. If electron-builder is reinstalled or upgraded, rerun `npm run build:electron` or `build\build_app.bat`; both paths reapply the ArcRho NSIS installer-progress patch before packaging.
9. After validating a release installer outside the normal build flow, publish it to GitHub Releases (the source the desktop app actually checks) with `build\publish_github_release.ps1 -InstallerPath dist\ArcRho-Setup-<version>.exe -ReleaseNotes "<summary>"`, and optionally also to the backup network feed with `build\publish_update_feed.ps1 -InstallerPath dist\ArcRho-Setup-<version>.exe -ReleaseNotes "<summary>"`.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Packaging excludes can accidentally omit runtime files.
- Divergence between dev and packaged paths causes startup failures.
- With `asar: true`, `APP_ROOT` resolves inside `resources\app.asar`, a virtual path only Electron's patched `fs` can see. Windows cannot use it as a child-process working directory, and such a spawn fails as `spawn <command> ENOENT`, which misleadingly reads as a missing executable. `electron/main.js` therefore launches host commands from `getHostSpawnCwd()`, which skips `.asar` candidates and falls back to the app's user-data directory, and resolves `powershell.exe` under `%SystemRoot%` instead of relying on the inherited `PATH`.
- Disabling `win.signAndEditExecutable` is intended for local unsigned launch testing; restore the normal resource-edit/signing path before preparing a polished release installer.
- electron-builder NSIS implementation changes can break the ArcRho installer-progress patch; `build/patch_nsis_installer_progress.js` fails fast when the upstream compressor, details, or extraction templates no longer match a supported form.
- ArcRho installer packaging requires the Windows .NET Framework 4 C# compiler to build the isolated progress observer. The helper has no network or filesystem behavior at runtime, but managed endpoint security should still be smoke-tested against the generated executable launched from NSIS's plugin directory.
<!-- MANUAL:END -->
