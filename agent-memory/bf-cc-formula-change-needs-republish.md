---
name: bf-cc-formula-change-needs-republish
description: A change to how BF or Cape Cod derives its calculated columns makes every persisted method unopenable until republished; never deploy such a change alone
metadata: 
  node_type: memory
  type: project
  originSessionId: c19a115a-399f-4590-8c80-4476ba5f4c0c
  modified: 2026-09-21T15:48:20.010Z
---

On 2026-09-21 a BF change (New Ultimate = Selected Prior when Latest is blank) was deployed to Engine, Gateway and Bridge, and every quarterly BF method stopped opening with "BF new_ultimate does not match the embedded source snapshots". The three components were rolled back with `deploy.py --ref 22c39cea bridge engine gateway`.

**Why:** `bornhuetter_ferguson_contract._validate_complete` requires the stored `selected_prior_values`/`new_ultimate` to equal a recalculation from the embedded snapshots, and `bornhuetter_ferguson_service._validate_pair` requires the sidecar's `publication_revision` (which covers `new_ultimate`) to equal the method's. Cape Cod has the same pair of checks. The load, the save (which normalises `current` with `require_complete=True`), the manual refresh and the dependent walk's `_refresh_one` all run those checks, so a stale file cannot heal itself through the app. In NJ_Annual_Prod_202605_Fake 20 of 75 BF methods were affected; there are 818 BF method files across all projects.

**How to apply:** Treat any change to `_calculate_vectors` (BF) or the Cape Cod equivalent as a persisted-data migration: ship the contract change together with a republish of every affected method file (method JSON, output sidecar with a new publication revision, output CSV) and a dependent walk, or with an approved tolerance in the load path. Ask the user which before deploying. Related: [[hosted-save-fix-needs-engine-deploy]], [[deploy-only-when-released-app-is-safe]], [[bulk-method-restatement-hold]].
