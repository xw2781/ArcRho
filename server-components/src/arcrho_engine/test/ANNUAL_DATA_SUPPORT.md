# Annual Data Support Implementation

**Last Updated**: February 2026
**File Modified**: `e:\ADAS\core\ADAS Agent\main.py`
**Plan Reference**: `C:\Users\xwei.PRCINS\.claude\plans\valiant-gathering-squirrel.md`

---

## Executive Summary

This document captures the assumptions, implementation details, and expected behaviors for adding annual (YYYY) date format support to the data aggregation engine. The implementation preserves all existing monthly (YYYYMM) functionality.

---

## Key Assumptions

### 1. Configuration Dates (JSON) Are Always YYYYMM
- The three date fields in `general_settings.json` will **always** be provided in YYYYMM format
- Examples: `"origin_start_date": "201601"`, `"development_end_date": "202512"`
- **NO changes** to JSON format or `_parse_date_to_yyyymm` function
- This allows year extraction via integer division: `start_yrmo // 100`

### 2. Annual Data Input Constraints
- Annual data (YYYY format) will **only** support `org_len = dev_len = 12`
- This means:
  - Origin periods: 12 months = 1 year
  - Development periods: 12 months = 1 year
  - Single-year grouping, no quarterly or semi-annual breakdowns for annual data

### 3. Period Length Semantics
- `org_len` and `dev_len` **always represent months**, regardless of input data format
- For monthly data: `org_len=12` means group 12 consecutive months
- For annual data: `org_len=12` means use annual periods (12-month groups)
- The semantic interpretation changes, but the numeric value (in months) stays the same

### 4. Data-Derived Guessing Only When JSON Missing
- If JSON config is present: use dates from JSON (no data guessing)
- If JSON is missing AND data is provided: detect granularity from data and use data min/max
- If neither available: use DEFAULT constants (hardcoded fallback)
- **Priority**: JSON > Data-Derived > Defaults

### 5. Month-Specific Data Cleaning Never Triggered for Annual
- Lines 968–980 in `UDF_ADASTri` contain conditional adjustments for `dev_len in [1, 3, 6]`
- For annual data, `dev_len=12` **always**, so these conditions are never True
- This section is **safe to leave unchanged** — it will never execute for annual data
- No risk of breaking annual data aggregation due to month-based logic

---

## Changes Made

### 1. Granularity Detection in `_load_project_settings` (Lines 203-211)

**What Changed**: Added automatic detection of date format by sampling the origin date column

```python
# Detect date granularity from actual data column
if df is not None and date_cols is not None:
    try:
        sample_val = int(df[date_cols[0]].dropna().iloc[0])
        settings['date_granularity'] = 'annual' if len(str(sample_val)) == 4 else 'monthly'
    except Exception:
        settings['date_granularity'] = 'monthly'
else:
    settings['date_granularity'] = 'monthly'
```

**Key Details**:
- Samples first non-null value in origin date column
- 4-digit value → `'annual'`
- 6-digit value → `'monthly'`
- Graceful fallback to `'monthly'` if sampling fails
- Result stored in `settings['date_granularity']` and cached with other settings

### 2. New Function: `_generate_period_range` (Lines 247-263)

**What Changed**: Added wrapper function to abstract period range generation

```python
def _generate_period_range(start_yrmo, end_yrmo, date_granularity='monthly'):
    """Wrapper: generates date range matching the data granularity."""
    if date_granularity == 'annual':
        return list(range(start_yrmo // 100, end_yrmo // 100 + 1))
    return _generate_full_month_range(start_yrmo, end_yrmo)
```

**Key Details**:
- Input: YYYYMM dates from config (always)
- Output: YYYY list (annual) or YYYYMM list (monthly)
- Annual extraction: divides by 100 and uses `range()` to generate years
- Monthly delegation: calls existing `_generate_full_month_range`
- Default parameter ensures backward compatibility if granularity not specified

### 3. Modified `_calc_age` (Lines 544-554)

**What Changed**: Added format detection to compute age differently for annual vs monthly

```python
def _calc_age(acc_yrmo, sys_yrmo):
    # Detect format by digit count
    if len(str(int(acc_yrmo))) == 4:  # YYYY annual format
        return (int(sys_yrmo) - int(acc_yrmo)) * 12 + 1
    # YYYYMM monthly format (original logic)
    acc_yr = acc_yrmo//100
    sys_yr = sys_yrmo//100
    acc_mo = acc_yrmo % 100
    sys_mo = sys_yrmo % 100
    return 12*(sys_yr-acc_yr) + sys_mo-acc_mo + 1
```

**Key Details**:
- Detects format by counting digits of the accident date
- **Annual formula**: `(sys_yr - acc_yr) * 12 + 1`
  - Example: `_calc_age(2017, 2017)` = 1 (first year)
  - Example: `_calc_age(2017, 2018)` = 13 (second year)
  - Example: `_calc_age(2017, 2019)` = 25 (third year)
- **Monthly formula**: Unchanged original logic
- Both formulas are 1-indexed (first period = 1, not 0)

### 4. Modified `_get_org_label` (Lines 556-576)

**What Changed**: Added format detection to generate appropriate labels

```python
def _get_org_label(date_val, org_len):
    if len(str(int(date_val))) == 4:  # YYYY annual format
        return int(date_val)  # org_len==12 always for annual
    # YYYYMM monthly format (original logic)
    # ... month-based quarter/half-year labeling ...
```

**Key Details**:
- For annual: simply returns the year as integer (e.g., `2017`, `2018`)
- For monthly: unchanged original logic (returns month, quarter, half-year, or year based on `org_len`)
- Annual data org_len is always 12, so only returns the year

### 5. Modified `UDF_ADASHeaders` (Lines 834-856)

**Changes**:
- Line 834-836: Replace `_generate_full_month_range()` with `_generate_period_range()`
- Line 838: Compute org slicing step based on granularity
  - Annual: `org_step = 1` (group by 1 year)
  - Monthly: `org_step = org_len` (group by org_len months)
- Line 851-856: Same changes in Development Period block
- Line 856: Fix `dev_cnt` computation
  - Annual: `len(acc_yrmo_all)` (number of years = number of periods)
  - Monthly: `round(len(acc_yrmo_all) / dev_len)` (original logic)

**Example for Annual**:
```
Config: origin_start=201601, origin_end=202612 (2016 Jan to 2026 Dec)
acc_yrmo_all = [2016, 2017, ..., 2026]  (11 years)
dev_cnt = 11
org_step = 1
org_index_grp = [(2016,), (2017,), ..., (2026,)]  (11 groups of 1 year each)
```

### 6. Modified `UDF_ADASTri` (Lines 957-975)

**Changes**: Identical to `UDF_ADASHeaders` modifications
- Line 957-959: Use `_generate_period_range()` wrapper
- Line 961-962: Fix `dev_cnt` computation with annual branch
- Line 974: Compute `org_step` based on granularity
- Line 975: Use `org_step` for slicing instead of hardcoded `org_len`

---

## Expected Behaviors

### For Monthly Data (Unchanged)

| Aspect | Behavior |
|--------|----------|
| **Data format** | YYYYMM integers (e.g., 202601) |
| **Granularity detected** | `'monthly'` |
| **Range generation** | Uses `_generate_full_month_range()` → YYYYMM list |
| **Age calculation** | Uses original formula: `12*(sys_yr-acc_yr) + sys_mo-acc_mo + 1` |
| **Labels** | Month, quarter, half-year, or year based on `org_len` |
| **Org grouping** | Slice `acc_yrmo_all` by `org_len` months |
| **Dev periods** | Computed as `len(acc_yrmo_all) / dev_len` |
| **Data cleaning** | Lines 968–980 execute if `dev_len in [1,3,6]` |

### For Annual Data (New)

| Aspect | Behavior |
|--------|----------|
| **Data format** | YYYY integers (e.g., 2026) |
| **Granularity detected** | `'annual'` |
| **Range generation** | Uses `_generate_period_range()` → YYYY list (years) |
| **Age calculation** | Uses annual formula: `(sys_yr - acc_yr) * 12 + 1` |
| **Labels** | Year integer (e.g., `2017`, `2018`) |
| **Org grouping** | Slice `acc_yrmo_all` by 1 year per group |
| **Dev periods** | Computed as `len(acc_yrmo_all)` (number of years) |
| **Data cleaning** | Lines 968–980 skipped (dev_len=12 ≠ [1,3,6]) |
| **Constraint** | `org_len = dev_len = 12` (enforced externally) |

### Development Label Example

**Annual data with `dev_end = 202502` (config), `org_len = dev_len = 12`**:

```python
first_mon = 202502 % 100  # = 2 (February)
dev_cnt = 10  # 10 years: 2017-2026
dev_label = range(2, 10*12+1, 12)  # = [2, 14, 26, 38, 50, 62, 74, 86, 98, 110]
# Add prior periods (backward):
dev_label = [-10, -22, ...] + [2, 14, 26, ...]  # months before and after dev_end
```

Interpretation:
- `2`: Development age 2 months (first annual period)
- `14`: Development age 14 months (second annual period)
- `26`: Development age 26 months (third annual period)
- Etc.

This matches the existing monthly convention where `dev_label` represents 12-month development periods.

### Age Mapping

**Annual data with origin year 2017, dev_label = [2, 14, 26, ...]**:

```python
Age Assignment (line 932):
df1['Age*Grp'] = df1['Age*'].apply(lambda x: min([i for i in dev_label if i >= x]))

Examples:
- Accident 2017, System Date 2017: Age = 1 → Age*Grp = 2 ✓
- Accident 2017, System Date 2018: Age = 13 → Age*Grp = 14 ✓
- Accident 2017, System Date 2019: Age = 25 → Age*Grp = 26 ✓
```

**Monthly data (unchanged) with dev_label = [2, 3, 4, ...]**:

```python
- Accident 202602, System Date 202602: Age = 1 → Age*Grp = 2 ✓
- Accident 202601, System Date 202612: Age = 12 → Age*Grp = 12 ✓
```

---

## Triangle Shape and Output

### Monthly Data
```
            1m   2m   3m  ...  12m
202601      X    X    X       X
202602      X    X    X
202603      X    X
...
202612      X
```
- Rows: Monthly origin periods (org_len=12 → 12-month grouping = 1 year)
- Columns: Monthly development ages (dev_len=1 → 1-month periods)

### Annual Data
```
           2    14    26  ...  110
2017       X     X     X       X
2018       X     X     X
2019       X     X
...
2026       X
```
- Rows: Annual origin periods (each year as separate row)
- Columns: Annual development ages in months (12-month buckets)
- Upper-right: Null-masked (no future development data)

---

## Backward Compatibility Checklist

- ✅ `_parse_date_to_yyyymm` unchanged (config parsing unaffected)
- ✅ `_generate_full_month_range` unchanged (called by wrapper)
- ✅ Lines 766–768 unchanged (use config YYYYMM, unaffected)
- ✅ Lines 968–980 unchanged (never triggered for annual via dev_len condition)
- ✅ All monthly data paths use original logic when `date_granularity='monthly'`
- ✅ Default granularity is `'monthly'` for safety

---

## Verification Strategy

### Test Case 1: Monthly Data (Existing)
**Expectation**: Output identical to pre-implementation version

1. Run existing monthly project
2. Verify: `date_granularity = 'monthly'`
3. Verify: `acc_yrmo_all` contains YYYYMM integers
4. Verify: `dev_label = [2, 3, 4, ..., 12, ...1]m` (monthly)
5. Verify: Origin labels include quarters/half-years based on `org_len`
6. Verify: Triangle shape and values unchanged

### Test Case 2: Annual Data (New)
**Expectation**: Annual aggregation works correctly

1. Create CSV with YYYY date columns (e.g., 2017, 2018, ..., 2026)
2. Create JSON config with YYYYMM dates
3. Run aggregation
4. Verify: `date_granularity = 'annual'`
5. Verify: `acc_yrmo_all = [2017, 2018, ..., 2026]`
6. Verify: `dev_label = [2, 14, 26, ...]` (12-month spacing)
7. Verify: Origin labels are year integers
8. Verify: Triangle shape = `n_years × n_dev_periods`
9. Verify: Upper-right null masking works (lines 968–980 skipped)

### Test Case 3: Mixed Scenarios
- Missing JSON, data-derived annual values → should work
- Missing JSON, data-derived monthly values → should work
- Annual data with `org_len ≠ 12` → behavior undefined (constraint violation, but won't crash)

---

## Known Limitations and Future Enhancements

### Current Limitations
1. **No quarterly/semi-annual for annual data**: `org_len=12` is the only meaningful value
2. **No sub-year periods for annual data**: No monthly breakdown within each year
3. **Data cleaning assumes monthly dev_len**: If annual constraint violated, data cleaning may not work correctly (but external validation should prevent this)

### Potential Future Enhancements
1. Support quarterly grouping for annual data (org_len=3, org_len=4, etc.)
2. Support mixed-frequency triangles (monthly origins, annual developments, or vice versa)
3. Better error messages if annual constraint (org_len=dev_len=12) is violated
4. Explicit granularity parameter in function signatures instead of relying on settings dict

---

## References

- **Implementation Plan**: `C:\Users\xwei.PRCINS\.claude\plans\valiant-gathering-squirrel.md`
- **Earlier Analysis**: `C:\Users\xwei.PRCINS\.claude\projects\e--ADAS\memory\`
  - `annual_data_support_evaluation.md` — Feasibility analysis
  - `critical_issues_annual_support.md` — Issue breakdown
  - `simplified_implementation_plan.md` — Approach refinement

---

**End of Document**
