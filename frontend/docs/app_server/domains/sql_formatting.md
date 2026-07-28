# App Server Domain: SQL Formatting

## Purpose
<!-- MANUAL:BEGIN -->
Provides one parser-backed, dialect-aware SQL formatting preview for the Arcode editor toolbar and ArcBot SQL Format Validation skill.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN app_server.sql_formatting.entry_points -->
| Method | Path | Handler | Request Model | Schema | Service Calls |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/arcode/sql/format-preview` | `format_sql_preview` | `SqlFormattingPreviewRequest` | [`app_server/schemas/sql_formatting.py`](../../../app_server/schemas/sql_formatting.py) | `sql_formatting_service.preview` |
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN app_server.sql_formatting.key_files -->
- [`app_server/api/sql_formatting_router.py`](../../../app_server/api/sql_formatting_router.py) - Thin SQL formatting preview route.
- [`app_server/services/sql_formatting_service.py`](../../../app_server/services/sql_formatting_service.py) - Shared formatter lifetime and request delegation.
- [`app_server/services/sql_formatting/engine.py`](../../../app_server/services/sql_formatting/engine.py) - Canonical parser-backed formatter and atomic safety gates.
- [`app_server/services/sql_formatting/version.py`](../../../app_server/services/sql_formatting/version.py) - Canonical SQLFluff distribution and version requirement.
- [`app_server/services/sql_formatting/advisories.py`](../../../app_server/services/sql_formatting/advisories.py) - Canonical-lexer SQL advisory rules.
- [`app_server/schemas/sql_formatting.py`](../../../app_server/schemas/sql_formatting.py) - Typed preview, diagnostic, advisory, nested-region, and safety contracts.
- [`ui/ai-assistant/skills.js`](../../../ui/ai-assistant/skills.js) - Shared Arcode and ArcBot SQL formatting client contract.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- `POST /arcode/sql/format-preview` accepts the exact source text, an explicit `tsql` or `snowflake` dialect, and the T-SQL nested-`OPENQUERY` mode.
- The response includes exact-source and formatted SHA-256 values, the proposed text, structured diagnostics/advisories, engine metadata, and a safety report.
- A preview is applicable only when the source parses before and after formatting, non-layout tokens are equivalent, protected strings/comments/quoted identifiers are preserved, and a second pass is identical.
- Malformed, unsupported, unstable, or otherwise unsafe input returns the original text with `safe_to_apply: false`; the service never writes an editor file.
- T-SQL formatting can safely format recognized literal Snowflake `OPENQUERY` bodies. Standalone Snowflake tabs use the explicit Snowflake dialect instead of passing through T-SQL rules.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- The formatter profile uses the canonical pinned SQLFluff version and limits automatic changes to layout plus parser-classified keyword/literal casing. Function and datatype casing remains unchanged because user-defined names can be case-sensitive.
- One process-level formatter instance serializes SQLFluff access; previews and findings are otherwise request-local and are not persisted.
- Deterministic advisories use the formatter's canonical protected-text-aware lexer rather than scanning raw strings with a second SQL tokenizer.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Parser acceptance and token preservation are formatting safety gates, not proof that a SQL batch has the intended business semantics or performance.
- Missing semicolons, `SELECT *`, `DISTINCT`, `SELECT INTO`, dynamic SQL, cursors, and cleanup concerns remain advisories; automatic formatting does not add or remove semantic tokens.
- SQLFluff and its package metadata/data files must remain in both PyInstaller server bundles, and both runtime and build checks must use the canonical version from `services/sql_formatting/version.py`.
<!-- MANUAL:END -->
