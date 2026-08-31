---
name: resq-benchmark-row-imports-as-user-entry
description: ResQ User Calculation rows import as ArcRho User Entry rows with translated in-cell formulas; shipped and deployed 2026-08-31 along with an Ex hi/lo averaging correction
metadata: 
  node_type: memory
  type: project
  originSessionId: 427fe4bc-9ba5-45c6-b0bf-80c94a582f26
  modified: 2026-08-31T20:04:34.756Z
---

Shipped 2026-08-31 (uncommitted at the time; Bridge, Engine and Gateway deployed, macro library published).

A ResQ "User Calculation" average row — in this shop, row 8 named **Benchmark**, carrying `(Average(5)+Average(6)+Average(7))/3` on every DFM in a class — now imports as an ArcRho **User Entry** row under its ResQ name, with the formula rewritten to ArcRho's quoted-label form (`=("Simple - 5"+"Simple - 3"+"Simple - 5 Ex hi/lo")/3`) in every column. It therefore recalculates with the triangle instead of being frozen. Detection reads the real row type (see [[resq-custom-average-api]]), not the row's name.

The translation **declines** — and the row keeps ResQ's frozen values, the old behaviour — when it names a row ArcRho dropped (ResQ repeats User Entry 2–3 times and ArcRho keeps the first), when two rows share a label, on self-reference, on a bare constant, or on anything beyond arithmetic.

**Two knock-on rules this created, both easy to break again:**

- "First row of type `user_entry`" no longer identifies ResQ's own User Entry row, because Benchmark is one too and sits *above* it. Both the migration merge and the export macro now prefer the row *labelled* "User Entry", then a `user_entry` row whose cells hold no quoted reference. Getting this wrong sends Benchmark's numbers into ResQ's User Entry row.
- The export never writes back to a User Calculation row; ResQ recalculates it from its own definition.

**Ex hi/lo correction shipped in the same change.** ResQ stops dropping high/low pairs "for as long as the remaining number of ratios is greater than two", so a column with two ratios keeps both; ArcRho dropped both and fell back to 1.0. The trim allowance is now `(n - 1) // 2` pairs rather than `n // 2`, in **both** `dfm_contract._selected_rows` and the frontend `buildExcludedSetForColumn` — they must stay in step. Measured over the fake project's 343 stored DFMs: 187 have an averaging row that moves, but only **3** move a *selected* factor, so ultimates barely shift. After the fix every averaging row in the sampled method matches ResQ to 2e-06.

**Still pending:** a client release, which is what carries the frontend half of the Ex hi/lo fix to the app. Stored methods only convert on re-import.
