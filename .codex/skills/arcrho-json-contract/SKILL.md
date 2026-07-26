---
name: arcrho-json-contract
description: Keep ArcRho dataset sidecar JSON, reserving-class index.json, frontend JSON writers/readers, and ResQ data migration behavior consistent. Use when refining or changing dataset JSON sidecars/sidercars, data storage formats, JSON field names or structures, python-api/migration/resq_data_migration.py output, ResQ migration behavior, or any cross-component data storage contract.
---

# ArcRho JSON Contract

## Overview

Use this skill to preserve ArcRho's JSON contract when migration code, frontend-generated JSON, dataset sidecars, or reserving-class indexes change.

## Core Rule

When changing dataset sidecar JSON or reserving-class `index.json` formats, structures, or field names, keep every producer and consumer of that contract in sync. Producers of the same persisted file must emit the exact same full parsed payload for the same logical inputs, including identical schema/version, field inclusion and omission, defaults, normalization, timestamp representation, and deterministic list order. Treat these as cross-component changes unless the user explicitly scopes the request to investigation only.

## Required Coordination

- Coordinate changes to `python-api/migration/resq_data_migration.py` with the frontend app code that writes or reads dataset sidecars and per-reserving-class `index.json` files.
- If the user asks to revise JSON emitted by `python-api/migration/resq_data_migration.py`, proactively update the corresponding frontend JSON writers/readers in the same task unless the user explicitly limits the scope to migration-only exploration.
- Keep one canonical owner for the reserving-class `index.json` schema, version, minimal entry projection, and normalization rules. The frontend app server, public Python API, migration modules, migration entry script, and mirrored macro must import, generate from, or delegate to that owner; do not maintain producer-specific copies or enrich the index in only one path.
- Keep `index.json` a compact scalar summary. Exclude arrays and nested sidecar/method details, including `origin_labels`, dependency graphs, audit logs, and similar payloads that belong in their owning detail JSON.
- Persist only location-independent, reserving-class-owned values. Do not store absolute drive/UNC paths or project/global rebuild-time enrichment in `index.json`; hydrate local paths and presentation data only in responses or consumers.
- A read of a valid current `index.json` must not scan sidecars or methods and must not rewrite or enrich the index. Rebuild only for a missing, invalid, explicitly refreshed, durably stale, or outdated-version/schema index.
- Propagate network and permission read failures during rebuild so the last valid index is preserved; never persist a partial/degraded index after an I/O failure.
- In the current phase, do not add legacy-format compatibility unless explicitly requested. Prefer a clean, coordinated refactor across all producers and consumers of the JSON contract.
- Use the ResQ API examples in `python-api/migration/references` when migration tasks need ResQ API behavior guidance.
- Keep the macro source files in `python-api/macros` in sync with `python-api/migration/resq_data_migration.py` when changing ResQ migration behavior.
- After adding or editing a macro in `python-api/macros`, copy all active macros from that folder to `C:\Users\xwei.PRCINS\Documents\ArcRho\macros`. If deploying the user macro copies is blocked by filesystem permissions, clearly report the required matching change.

## Workflow

1. Read the applicable repository instructions first, including root `AGENTS.md`; read `frontend/AGENTS.md` before changing files under `frontend/`.
2. Identify the JSON contract surface: migration output, dataset sidecar files, reserving-class `index.json`, frontend writers, frontend readers, and any macro behavior that mirrors the migration.
3. Make the contract change across producers and consumers together.
4. Remove clearly obsolete code in the touched area when fixing a bug, but ask before broader cleanup or cleanup with behavior risk.
5. Add an exact full-payload parity test that exercises every producer with the same logical inputs and verifies path-alias independence, plus a no-rebuild test proving that reading a valid current index performs no sidecar/method scan and no index write.
6. Validate with targeted checks that fit the repository validation limit, preferring Python 3.10 and the bundled frontend Node/npm runtime where applicable.

## Data Access Reminder

When inspecting on-disk ArcRho Server project metadata, obey the project data access restrictions in root `AGENTS.md`. Do not use this skill as permission to inspect non-default project metadata.

- If the task needs existing sidecars, method JSON, dataset JSON, or related project files, inspect the paths allowed by root `AGENTS.md` when needed.
- If the user mentions a specific dataset name but does not provide an explicit reserving-class data path, use the default ArcRho Server data folder from root `AGENTS.md` and look for that dataset there.
- If the user does not mention a dataset or path but the task requires concrete on-disk examples, use the default ArcRho Server data folder from root `AGENTS.md`.
- If the dataset appears to belong to a non-default ArcRho Server project, ask for session-specific permission before reading that project's on-disk metadata JSON files.
