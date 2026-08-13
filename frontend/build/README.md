# frontend/build

Everything that turns this repository into a shippable ArcRho or Arcode installer.

## Start here

These are the files you run. Everything else in this folder is a helper one of them calls.

| Run this | To |
| --- | --- |
| [`build_app_from_local_repo.bat`](build_app_from_local_repo.bat) | **Build and publish a release from this PC.** No second PC, no ZIP. Start with `--check`. See [docs/BUILD_FROM_LOCAL_REPO.md](docs/BUILD_FROM_LOCAL_REPO.md). |
| [`build_app_via_local_workspace.bat`](build_app_via_local_workspace.bat) | The shared build body. Also the two-PC entry point, driven from the build share. See [docs/BUILD_FROM_ZIP_ON_SECOND_PC.md](docs/BUILD_FROM_ZIP_ON_SECOND_PC.md). |
| [`change_app_version.bat`](change_app_version.bat) | Set the app version by hand, without building. |
| [`create_build_source_zip.bat`](create_build_source_zip.bat) | Cut the curated source ZIP the two-PC workflow consumes. |
| [`deploy_build_share.bat`](deploy_build_share.bat) | Publish the `build_share` scripts to the build share. |
| [`sync_published_release.bat`](sync_published_release.bat) | Record an already-published release in this repository. |

Both release routes run the same build body, so a change to the packaging steps applies to
both. There is no third entry point: `build_app.bat` and `build_app_from_network.bat` were
removed long ago.

## Where everything else lives

| Folder | Holds |
| --- | --- |
| [`docs/`](docs) | The two release runbooks. Read one of these before your first build. |
| [`installer/`](installer) | NSIS installer sources and the Windows progress observer: `installer.nsh`, `arcode_installer.nsh`, `installer_progress_helper.cs`, `patch_nsis_installer_progress.js`, plus the two PowerShell helpers the installer runs on the user's machine. |
| [`release/`](release) | Versioning and publication: `version_manager.py`, `release_notes.py`, `release_channel.json`, `publish_github_release.ps1`, `publish_update_feed.ps1`, `sync_published_release.py`, `request_release_sync.ps1`. |
| [`transport/`](transport) | Moving source to a build PC: the ZIP creator, both workspace preparers, the build-share deployer, and the console-log wrapper. Only the two-PC workflow needs these. |
| [`arcbot_runtime/`](arcbot_runtime) | Refresh and validate the bundled ArcBot/Codex payload under `node-portable`. |
| [`helpers/`](helpers) | Small build-time generators: `convert_icon.js`, `build_python_api_wheel.js`. |
| [`build_share/`](build_share) | Canonical copies of the scripts deployed to the build share. Edit here, then run `deploy_build_share.bat`. Never edit the deployed copy. |
| `python_packages/` | Generated Python API wheel, shipped under app resources. |

The PyInstaller inputs stay at the top level on purpose — `server.spec`, `arcode_server.spec`,
`server_entry.py`, `arcode_server_entry.py`, `build_python_server.bat`,
`build_arcode_python_server.bat`, `check_python_build_env.py`, and
`write_backend_artifact_manifest.py`. The two entry-point modules resolve their `BASE_DIR`
at runtime *inside the frozen application*, and `.gitignore` ignores `*.spec` with a
per-file exception, so a path change in this group fails in a shipped installer rather than
in the build. Leave them where they are unless you can run a full packaging build.

## Conventions worth knowing

- **Batch files must stay CRLF.** `cmd.exe` finds a `call :label` target by byte offset and
  fails on an LF-only file with `The system cannot find the batch label specified`.
  `.gitattributes` pins `*.bat` and `*.cmd`, and workspace staging normalizes them.
- **A script that moves must have its own anchor checked.** Several helpers resolve the
  frontend root from their own location (`Path(__file__).parents[2]`,
  `path.resolve(__dirname, "..", "..")`, `Join-Path $scriptDir "..\..\.."`). Moving one a
  level deeper without fixing its anchor resolves silently to the wrong directory.
- **`release_channel.json` owns the GitHub repository and tag shape.** Both
  `publish_github_release.ps1` and `version_manager.py` read it; change the tag there.
- **`transport/create_build_source_zip.ps1` lists every file the build needs.** Add a new
  build input to its required-paths list, or a two-PC build fails after the ZIP is cut.
