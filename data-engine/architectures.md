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
