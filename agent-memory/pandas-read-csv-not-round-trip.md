---
name: pandas-read-csv-not-round-trip
description: pd.read_csv's default float parser caps at 17 digit characters including leading zeros, so DFM/BS/BF/CC/bootstrap source reads are not exact round-trip; float_precision="round_trip" is
metadata:
  type: project
---

Measured 2026-09-03 with pandas 2.2.2 (bridge and engine venvs): `pd.read_csv(path, header=None)` with the default `float_precision` reads `0.0001722001827229328` as `0.0001722001827229` and `0.34558535664550893` as `0.3455853566455089`. Currency-like figures with two decimals are exact; ratio-like values with 16-17 significant digits differ in roughly a quarter to a third of cases, and near-zero values lose the most (relative error up to about 1e-12, thousands of ULPs). `float_precision="round_trip"` matched Python `float()` on 200,006 random values with zero mismatches.

Every method service reads source CSVs this way: dfm_service (the DFM input snapshot, so the 2026-09-03 "full double precision" DFM fix is still bounded by this parser), berquist_sherman_service, bornhuetter_ferguson_service, cape_cod_service, bootstrap_service, and dataset_service's cache load. The python-api canonical reader (`dfm.py::_parse_csv_cell`, plain `float()`) is exact.

**Why:** "full double precision" was claimed for DFM inputs, and the BS precision check on 2026-09-03 found the parser was the only remaining place a digit is lost; it is shared by every method page, so DFM and BS are consistent with each other.

**How to apply:** if a ratio ever needs to match ResQ beyond about 1e-12 relative, add `float_precision="round_trip"` to those reads in one shared helper rather than per service. Below that threshold it is invisible at four decimals and not worth a change. See [[mixed-origin-length-precedents]] for the other precedent-refresh limits.
