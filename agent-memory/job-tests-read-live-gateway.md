---
name: job-tests-read-live-gateway
description: "Test suites that patch the root but not the Gateway reach this PC's live (production) Gateway, for reads and even writes; the rules and dataset-type job tests did until 2026-09-27"
metadata:
  node_type: memory
  type: project
  originSessionId: dceedf07-29d5-400b-9dfb-1b5d138ebc34
  modified: 2026-09-27T04:52:39.808Z
---

Tests that patch `load_workspace_paths` to a temp root but leave the Gateway credential alone still sign requests to whichever Gateway this PC is enrolled with, which on the Client PC is production's. Found 2026-09-26/27 while running docs/plans/client_smb_retirement.md: `test_dataset_types_change_jobs.py` and `test_data_processing_rules*.py` sent hosted plan reads and, after step 3, audit-log appends to production. Nothing was written only because production did not offer the new operation yet. Step 3 (commit 048f9e4a) stubbed the append in those two modules.

**Why:** once production's Gateway offers a kind, an unisolated test writes real entries (and could create "Example Project"/"Demo Project" folders) on production.

**How to apply:** until the plan's step 21 guard lands, any new test that exercises a route with a registered read/mutation/save kind must stub the Gateway client or set `ARCRHO_GATEWAY_CONFIG` to a missing file; don't treat those modules' failures as regressions without rerunning at the base commit. Related: [[local-test-root]], [[worktree-baseline-masks-new-failures]].
