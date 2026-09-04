---
name: resq-com-probe-dont-call-blindly
description: "A ResQ COM probe that loops over every member and calls each one mutates the in-memory method (SelectWholeTailCurve, Refresh*, Toggle*, Reset*, Save*); filter to getters and never Save"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: dd9a0016-daa7-4ab9-8ad1-13933b77fa01
  modified: 2026-09-04T02:02:33.041Z
---

On 2026-09-03 a discovery probe that iterated `dir(dfm)` and invoked every callable with indices 0..12 silently ran `SelectWholeTailCurve(12)`, `RefreshCurveBenchmark`, `RefreshCurvePattern` and `RefreshRatioPattern` on the fake project's C 12 method. The in-memory selection changed (the selected tail read 1.0 instead of 1.0005 for the rest of that process) and every later read in that probe was of a mutated object. Nothing was persisted only because `Save` was never called and the process exited.

**Why:** ResQ exposes action methods beside its properties with no naming convention that separates them, and pywin32 makes both look like attributes.

**How to apply:** when probing, list `dir()` first and read only members you have named; treat anything starting with `Set`, `Select`, `Refresh`, `Toggle`, `Reset`, `Save`, `Delete`, `Load`, `Export`, `Add` as an action; run a second, read-only pass in a fresh process to confirm values before trusting them; and for deliberate in-memory write tests, say so in the script, never call `Save()`, and re-read in a fresh process afterwards. Related: [[resq-com-probe]], [[resq-dfm-curves-com-api]].
