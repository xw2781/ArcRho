---
name: bulk-method-restatement-hold
description: Restating many methods in one reserving class must wait out the propagation hold each refresh leaves behind, or every method after the first is refused with 423
metadata:
  type: feedback
---

A script that calls `refresh_bornhuetter_ferguson_method` / `refresh_cape_cod_method` in a loop cannot just iterate: each refresh enqueues a dependent-propagation walk that holds its reserving class, so the next method in that same class is refused with `423 Dependent updates are currently running for this reserving class`. On 2026-08-30 this failed 23 of 48 methods on the first pass.

**Why:** the 423 preflight (`dependent_propagation_service.require_reserving_class_writable`) is the race backstop between a walk and a new write; it is doing its job, not misfiring.

**How to apply:** poll `require_reserving_class_writable` before each method and sleep while the error contains `423` (2 s poll, ~15 min ceiling). `tools/restate_percentage_developed.py` does exactly this in `_wait_for_class`. The refreshes are idempotent, so re-running the script picks up whatever a previous pass left behind — plan first, and let the plan shrink to zero.

Related: [[propagation-hold-and-test-isolation]], [[hosted-save-fix-needs-engine-deploy]]
