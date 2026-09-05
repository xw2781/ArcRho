---
name: rules-save-refreshes-affected-datasets
description: "A Data Processing Rules save never refreshed anything until 2026-09-05: it only counted stale caches, and datasets rebuilt on next open; the Engine rules job now regenerates affected engine datasets and walks dependents, reusing the source refresh job's per-class step"
metadata: 
  node_type: memory
  type: project
  originSessionId: dcf16d15-0c8d-4cd9-a6a1-9c91c946dfd4
  modified: 2026-09-05T20:54:42.711Z
---

Until 2026-09-05 a Data Processing Rules save (direct or Engine job) wrote the rules file,
cleared the `.temporary-view` previews, and **only counted** the engine sidecars whose
`processing.config_hash` no longer matched — the "N generated cache file(s) invalidated" text.
Nothing rebuilt them: a generated dataset applied a new rule only when someone opened it
(`arcrho_runtime_service` compares the stored hash on load), and methods built on it kept the
old values with no out-of-date marker. A user reported this as "auto refresh/propagation did
not work"; it had never existed for rules, unlike Import Data (source refresh job) and the
Dataset Types job, which both regenerate and walk dependents.

**Fix (2026-09-05, Engine deployed):** `arcrho_engine/data_processing_rules_jobs.py` now, after
the canonical save returns `changed=True`, takes `impact.affected_dataset_types`, lists the
classes holding an engine instance of those types, narrows the project-scope lease to them,
and runs `source_table_refresh._refresh_one_reserving_class` per class (regenerate via
`run_arcrho_tri`, then one dependent walk). The summary rides in the status `result["refresh"]`;
failures leave the job **successful** with a message, because the rules are already committed
and the left-behind datasets still rebuild on open. The direct (no-Engine) save stays count-only.

**How to apply:**
- `impact.affected_dataset_types` is a superset: `_describe_rule_changes` collects the target
  measure of every rule, not only the changed ones, so the refresh may touch more types than
  strictly needed. Over-refresh is harmless; do not "fix" it without checking the walk cost.
- The rules job's `record_progress` publishes every tick except in the `checking` stage (one
  tick per sidecar, left to the 5 s heartbeat); the `classes` stage writes once per class and
  dataset, like Import Data.
- Test doubles for `execute_data_processing_rules_save` must accept `narrow_lease=None`, or
  the durable job reports a 500 instead of the refusal code.

Related: [[adding-a-project-level-engine-job]], [[engine-in-process-calculator]],
[[hosted-save-fix-needs-engine-deploy]].
