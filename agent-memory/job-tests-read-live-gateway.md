---
name: job-tests-read-live-gateway
description: "test_dataset_types_change_jobs and test_data_processing_rules_jobs patch the root but not the Gateway, so their plan read goes to this PC's live Gateway; failures there are environment, not code"
metadata:
  node_type: memory
  type: project
  originSessionId: dceedf07-29d5-400b-9dfb-1b5d138ebc34
  modified: 2026-09-27T01:52:49.122Z
---

`frontend/tests/test_dataset_types_change_jobs.py` and `test_data_processing_rules_jobs.py` patch `load_workspace_paths` to a temp root but leave the Gateway credential alone. The change plan is built through a hosted read when a Gateway is configured, so on the Client PC that read goes to production's Gateway with a temp project name (read-only; the job files themselves land in the temp root). Their pass/fail depends on which Gateway is live. Seen 2026-09-26 while running the server switcher plan (docs/plans/local_server_root_and_server_switcher.md).

**Why:** after that plan's step 6 gives production a `server_id`, the identity check will refuse these reads (the temp root has no id), changing how they fail.

**How to apply:** do not treat their failures as regressions without rerunning at the base commit; the real fix is setting `ARCRHO_GATEWAY_CONFIG` to a missing file in their setUp. Related: [[local-test-root]], [[worktree-baseline-masks-new-failures]].
