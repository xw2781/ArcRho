---
name: resq-percentage-developed-enum
description: ResQ PercentageDevelopedType has 4 codes (not 3); typelib constants via gencache reveal authoritative enums
metadata: 
  node_type: memory
  type: project
  originSessionId: 8f51e9f3-af12-4885-a187-91d95dc2547a
  modified: 2026-08-07T15:51:38.196Z
---

The ResQ `PercentageDevelopedType` enum has **four** values: `pdInternal=0` (Latest/Ultimates), `pdPattern=1`, `pdCumDevFactors=2` (DFM dev factors), `pdCumDevFactorsAdjusted=3`. The repo's reference `ResQToolBox2.py` dict only lists 0–2 and is incomplete. Since 2026-08-07 the importer maps codes 2/3 to `latest_ultimates` (extractors.py `CC_PERCENTAGE_DEVELOPED_TYPE_MODES`), deriving prior ultimates as `Latest / PercentageDevelopedValues` when the referenced DFM vector is empty. In the live NJ_Annual_Prod projects most CC methods use code 2 or 3, and ~16 CC methods in non-active RCs have **no Exposure dataset attached in ResQ** — those still fail import with "precedent does not expose a dataset name" (pre-existing, not fixable ArcRho-side).

**Why:** For all codes, ResQ's `PercentageDevelopedValues == Latest/prior-vector` exactly when the DFM output is populated; when it is empty ResQ falls back to a flat 1.0 pattern from the DFM CDFs, so snapshotting the stored (zero) vector would blank the method.

**How to apply:** To get authoritative ResQ enum names, use `win32com.client.gencache.EnsureDispatch("ResQ3Automation.ResQApplication")` then merge `win32com.client.constants.__dicts__`. Full CC COM objects come from `rc.GetCapeCodeMethod(name)` — items iterated from `rc.CapeCodMethods()` expose only a partial interface (no Latest/Exposure). Related: [[resq-com-probe]].
