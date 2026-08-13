# ArcRho Server Components Deployment

## Release artifact

`ArcRho-Server-Setup-<version>.exe` is the offline, per-user companion installer
for ArcRho Engine, Orchestrator, Bridge, Launcher, and Admin Control. Its version
must match `frontend/package.json`. It is published beside the matching
`ArcRho-v<version>` frontend release with a SHA-256 checksum and is also copied
to `releases/server-installers` in the ArcRho Server release share.

Build with Python 3.10:

```powershell
py -3.10 data-engine/server-installer/build_release.py
```

The build runs every component's PyInstaller build with
`ARCRHO_STAGE_ONLY=1`, freezes the deployment helper, stages the five complete
one-directory apps, writes `payload-manifest.json`, validates the staged
inventory, and compiles the standalone NSIS installer. Generated output is
under `data-engine/server-installer/out/<version>/`.

Every component build verifies that its cached virtual environment is Python
3.10 and replaces a stale environment created by another Python version. The
release copy excludes Python/source caches and migration validation-result
output before calculating the manifest, so machine-local build artifacts cannot
enter the client payload.

For an already validated local component/helper build, use
`--reuse-component-builds --reuse-deployer-build`. `--stage-only` validates the
payload without invoking NSIS.

## Workspace and ownership

Setup accepts any writable absolute folder on a local fixed Windows disk. UNC
paths, mapped drives, drive roots, protected system/program folders, files, and
invalid paths are rejected before live workspace mutation. A root that would make an
installed payload file exceed the Windows-safe path boundary is also rejected
with a prompt to choose a shorter folder. The selected workspace owns:

- `apps`: installed component directories and the hidden installer receipt;
- `config`: shared component configuration;
- `projects`, `requests`, and `runtime`: shared operational data.

The receipt at `apps/.arcrho-server-installer/install-receipt.json` records its
schema version, installation ID, normalized root, installed version, UTC install
time, canonical component inventory, file sizes, and SHA-256 hashes. It is
installer metadata, not project data. Unknown apps and all non-`apps` workspace
data remain outside installer ownership.

## Install, adoption, upgrade, and repair

The helper selects the lifecycle operation from the receipt and workspace:

- an empty unreceipted workspace is a clean install;
- an existing unreceipted workspace is adopted;
- a newer payload upgrades a receipted workspace;
- the same version repairs it;
- an older payload is rejected as a downgrade.

Before mutation, the helper validates every payload file against the manifest,
acquires an exclusive per-workspace lock, creates/merges canonical configuration
defaults, and copies the complete payload into a same-volume staging folder.
Adoption merges missing defaults only; worker choices, ResQ credentials, unknown
configuration, projects, and queued requests are retained.

For replacement, the helper preserves all kill-switch values, signals Engine,
Bridge, Orchestrator, and Admin Control to stop, and aborts before changing live
binaries if their heartbeats do not disappear. It then renames all five live
folders to a transaction backup and all staged folders into place. Any swap,
receipt, configuration, launch, or heartbeat-verification failure stops the new
processes and restores every prior folder and the prior receipt. Backups are
deleted only after fresh Orchestrator and Engine heartbeats prove startup.
Atomic renames retry bounded transient antivirus/file-lock errors; a persistent
lock aborts and rolls back rather than falling back to an in-place overwrite.

Launcher remains a per-user login program because Bridge requires an interactive
ResQ session. Setup also adds an Admin Control Start Menu shortcut. If requested,
it calls the canonical Python API `set_server_root` to configure
`%APPDATA%\ArcRho\workspace_paths.json` without changing that file's schema.

## Uninstall and publication

Uninstall stops components, transactionally parks only the five receipted app
folders, deletes the parked binaries, then removes the receipt and startup/Start
Menu integration. It preserves projects, requests, configuration, credentials,
runtime history, and unrelated apps. A deletion problem fails the uninstall and
retains the receipt so a subsequent repair or uninstall can recover ownership;
shared data is never exposed to recursive deletion.

Publish only after the matching frontend GitHub release exists:

```powershell
powershell -NoProfile -File data-engine/server-installer/publish_server_installer.ps1 `
  -InstallerPath data-engine/server-installer/out/<version>/ArcRho-Server-Setup-<version>.exe
```

Server upgrades are operator-initiated; neither ArcRho Desktop startup nor its
updater silently replaces shared host components.
