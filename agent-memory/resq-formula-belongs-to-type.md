---
name: resq-formula-belongs-to-type
description: "How to decide whether a formula ResQ keeps only on dataset instances should be promoted to the ArcRho dataset type: no instance may hold data without it"
metadata: 
  node_type: memory
  type: project
  modified: 2026-08-31T03:24:59.226Z
  originSessionId: a0129d51-dcbc-4b6c-ba44-31d461d6e4d4
---

ResQ stores formulas in two independent places: `DatasetType.Formula` (project-wide) and each `Vector`/`Triangle`'s own `Formula` (per reserving class). A type can be un-calculated project-wide while every instance carries the same formula — that is exactly the `D 31 / F 31 / F 35 - Claim Count * Severity` case, and `C 61 Reported - CWOP` before it.

**The decision rule, validated 2026-08-31 over 260 types and 3,962 reserving classes in `NJ_Annual_Prod_202605_Fake`:** a formula belongs to the dataset type when **no instance holds data without it**. Not "all instances are identical" — that is too strict, because it counts empty stubs against the type.

- **Blank + empty** = abandoned stub, ignore it. All 38 blank instances of ResQ-calculated types sit in three shell classes (`ALN_HPPREF\HO\Penn\All Channels\HOP`, `...\Prudential Agent\HOP_CAT`, `...\All Channels\HOP_CAT`) and every one has `Count = None`.
- **Blank + holds numbers** = a real hand-entered input, and it disqualifies the type.

The test separates the two groups with no overlap: C 61 (49 instances), D 31 (3), F 31 (19, 3 empty stubs) and F 35 (1) have **zero** populated blanks; `G 42 - Prior for BF Paid` (21), `F 42 - Prior for BF Incurred` (27), `D 42` (5) and `P 06 Net Loss--Expected Net Loss %` (6) all do, so they stay editable inputs.

**Validation of the forward direction:** of the 71 types ResQ itself marks calculated, 68 have instances, and all 68 carry exactly one distinct formula text equal to the type formula. The single blemish is `Severity--Adjusted Net Incurred per Reported ex CWOP`, where one class of three says `Adjusted*2` instead of `Adjusted*` — a typo, not a real disagreement.

**Caveats.** Unanimity is necessary, not sufficient: [[arcrho-dataset-types-win-over-resq]] is a deliberate policy override sitting on top of it — the 14 Prior Qtr `81`/`82` types are unanimously calculated in ResQ against a frozen `- Feb 2026` snapshot, and ArcRho keeps them as editable inputs anyway. Also weigh sample size: F 35 is "unanimous" across a single instance, which is one observation, not a pattern. Read every ResQ property with `gencache.EnsureDispatch` — see [[resq-com-probe]], late binding silently reports `Calculated=False, Formula=''` for every type.
