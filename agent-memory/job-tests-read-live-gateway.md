---
name: job-tests-read-live-gateway
description: "Since 2026-09-27 a guard keeps every test run off real Gateways; before it, tests that patched the root but not the Gateway read and wrote on production's Gateway"
metadata:
  node_type: memory
  type: project
  originSessionId: dceedf07-29d5-400b-9dfb-1b5d138ebc34
  modified: 2026-09-27T05:10:00.000Z
---

Until 2026-09-27, tests that patched `load_workspace_paths` to a temp root but left the Gateway credential alone signed requests to whichever Gateway this PC was enrolled with (production's, on the Client PC). A socket-level scan found the dataset-type and rules job tests (propagation preflight reads, audit appends), three cached-dataset delete tests (propagation busy reads) and both ResQ import macro test modules (pre-import backup mutation, Bridge liveness read) all reaching production.

Step 21 of docs/plans/client_smb_retirement.md added `python-api/src/arcrho_api/gateway_test_guard.py`. A process launched as a test run (`python -m unittest`, pytest, a `tests/test_*.py` run directly) and its children get `ARCRHO_GATEWAY_CONFIG` pointed at a missing file, and every Gateway client refuses URLs no test allowed. Tests running their own loopback Gateway call `self.addCleanup(allow_test_gateway(url))`. `ARCRHO_TEST_GATEWAY_RECORD=<file>` records refusals with the test id.

**Why:** once production's Gateway offers a kind, an unisolated test writes real entries there.

**How to apply:** a Gateway-only path answers 503 in tests now; stub the check, or patch `propagation_gateway_client.is_server_process` to True when the test already points the workspace root at its temp folder. New Gateway clients must build their opener with `gateway_test_guard.gateway_opener()`. The guard does not cover IDE test adapters whose `__main__` is their own script (VS Code's unittest adapter). Related: [[local-test-root]], [[worktree-baseline-masks-new-failures]].
