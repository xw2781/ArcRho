Fix all open issues listed below. Once fixed, document how you fixed each issue in docs/resolved.md and move the item out of current file.

Don't clear the section headers. Ignore empty sections and don't guess a bug.

# DSV

## Temporary View Mode

# PI

## pi-hidden-tabs-menu

# DFM

- A DFM ratio can differ from ResQ by more than 4 decimal places when its input triangle is a computed "% of ..." value and lands near zero at that cell (denominator amplification). Found comparing `NJ_Annual_Prod_2026 Q3-Aug` with `python-api/migration/validation/dfm_ratio_side_by_side_review.py`: `PRNJ - PA\PA\Penn+CT\Direct Group\MP+PIP`, DFM "G 22 B - ALAE/Net Paid Loss DFM w/ Selected LDFs", origin 2025 Q2, dev "(1) 2-5" — ArcRho 1231.89947 vs ResQ 1231.89967. Root cause: ArcRho's snapshot of that input value is rounded to 10 decimal places, while ResQ keeps full double precision internally; dividing by a ~0.00014% denominator amplifies the lost tail digits into a visible ratio gap even though both systems agree on the underlying loss data. This one cell was already excluded from ResQ's own averaging. Not a data bug — only surfaces on a near-zero "% of" denominator; a real fix would mean capturing more decimal places when snapshotting a "% of" input during import/refresh.

# "ArcRho Server" Root
- If some modules are still using hard-coded "E:\ArcRho Server", they need to use the value same as that in app main menu Settings -> Server Connection -> Root Path
