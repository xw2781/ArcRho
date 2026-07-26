# Business Logic Contract

## Purpose
Set lightweight app-server and domain behavior guardrails for the current pre-production app.

Prefer clean coordinated refactors over compatibility shims unless the user explicitly asks for migration support.

## Scope
This contract applies when changing app-server routes, schemas, services, runtime path config, workflow persistence, project settings persistence, cache/refresh behavior, reserving-class data, dataset behavior, or frontend consumers that depend on those contracts.

## Core Rules
1. Keep domain logic layered: routers handle transport/validation, schemas define request shapes, and services own persistence and business logic.
2. Change route paths, request/response shapes, saved file schemas, and cache semantics only as coordinated refactors. Update all known producers, consumers, docs, and generated indexes in the same change.
3. Keep `workspace_paths.json` and `app_server/config.py` as the single source for workspace paths. Do not duplicate path derivation in services.
4. Preserve data integrity for filesystem-backed operations. Project settings, workflow files, caches, and audit logs should fail clearly rather than silently diverging or corrupting state.
5. Keep API validation and status behavior explicit. Input problems should not become generic `500` responses, and lock/contention cases should remain distinguishable.
6. Keep refresh/cache side effects visible in route behavior and docs when they matter to users or downstream features.
7. Keep dataset number-format defaults in the workspace-global `config/dataset_number_formats.json`; ResQ migration and frontend-generated dataset producers must resolve the same fallback and Dataset Type Name overrides across all reserving-class paths.
8. Keep current Result Selection method JSON self-contained. A valid v2 open reads only its own method JSON and output sidecar; source values, weights, native origin lengths, all configured Ratio Basis vectors, calculated/final ultimates, and overrides come from the method JSON. Durable precedent changes must refresh registered RS artifacts before the sidecar is marked current, and a failed refresh must preserve the last valid artifacts with review-needed status. Only an exact v1 marker may take the one-time dependency-reading upgrade path.
9. Keep current DFM method JSON self-contained. A valid v2 open reads only `DFM@<method name>.json` and the declared output dataset sidecar; the input triangle snapshot, Ratio Basis snapshot, calculated ratios and averages, selected ultimate vector, display metadata, and source revisions come from the method JSON. ArcRho-managed precedent saves refresh affected DFM-derived state before calculated and Result Selection descendants, while preserving DFM-owned selections, formulas, stored Excel results, and notes. Failed refreshes preserve the last valid publication and mark only the failed branch for review. Only an exact v1 marker may read its precedents for a transactional one-time upgrade.

## Before Finishing
1. State which business-logic area changed, or state "no business-logic impact."
2. Update affected MANUAL sections in `docs/app_server/*.md`, `docs/app_server/domains/*.md`, or `docs/runtime/*.md` when behavior changes.
3. Run `python tools/docs_index_builder.py --write`.
4. Run `python tools/docs_index_builder.py --check`.
