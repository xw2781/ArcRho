# Data-engine Architecture Notes

## Deployment model

ArcRho Server components run on the Windows PC that locally hosts the selected
ArcRho Server workspace. The workspace folder may have any name; a frozen
component discovers it structurally from `<workspace>\apps\<component>` and an
explicit `ARCRHO_ROOT` remains the highest-precedence override.

Five components ship as one versioned server release:

- **ArcRho Engine** processes calculation, propagation, duplication, and other
  durable workspace requests. The Orchestrator normally maintains five workers.
- **ArcRho Orchestrator** supervises Engine and Bridge processes.
- **ArcRho Bridge** provides per-interactive-user ResQ automation. Its worker
  needs that user's ResQ GUI and COM session, so it is not a Windows service.
- **ArcRho Launcher** registers per-user login startup and starts Orchestrator
  and Bridge.
- **ArcRho Admin Control** exposes local component/configuration administration.

The offline companion installer and lifecycle contract are documented in
[Server Components Deployment](docs/server-components-deployment.md). The
frontend installer never owns these shared binaries.

## Component build deployment

`build_runtime.py` owns the copy-and-swap transaction every `build_exe.py`
deploys through; no build script restates it. A component keeps two folders
under `apps`: the live `<App Name>` and a standby `.<App Name>.slot`.

A deploy mirrors the new build into the standby slot while the component is
still running, then stops it only for three renames — live to `.<App Name>.prev`,
slot to live, `.prev` back to slot. Renames are executed by the file server, so
the stopped window is seconds rather than the length of a copy, and the build
that was live stays intact in the slot as both the rollback copy and the base
the next deploy compares against.

The copy is a delta because the slot already holds a build of the same
component; a rebuilt dist reuses the interpreter, site-packages, and DLLs
unchanged. PyInstaller stamps every file it collects with the moment of the
build, so timestamps alone report all ~1650 files as new even when ~99% are
byte for byte what was deployed. Each deployed folder therefore carries a
`.arcrho-deploy-manifest.json` recording its files' size, SHA-256, and
timestamp. Staging restores the deployed timestamp on files whose bytes are
unchanged — hashing the local dist, never reading back across the network — and
the mirror then skips them for one metadata round trip each.

Practical consequences:

- Do not delete a `.slot` folder or its manifest. Nothing breaks if they go, but
  the next deploy falls back to a full copy.
- The rotation needs two deploys to warm up: the first leaves no slot behind and
  the second parks a build that predates any manifest. Deltas start on the third.
- A deploy interrupted between the renames leaves the last good build in
  `.<App Name>.prev`; the next staging restores it before reusing the name.

## `data-engine/src/arcrho_bridge`

- ResQ import/export only; a separate module from permanent ArcRho processing.
- One supervisor per interactive user session; each user contributes the Bridge
  tied to their own ResQ GUI/license.
- Intended for migration support and removable when the ResQ transition ends.

## `data-engine/src/arcrho_engine`

- Handles transformations and durable shared-workspace jobs.
- Runs as a worker pool on the local workspace host.
- Uses lease-backed request processing so concurrent workers do not update the
  same reserving class or project segment simultaneously.
