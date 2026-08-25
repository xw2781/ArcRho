# Edge Cases and Potential Risks

**Purpose**: Document potential edge cases, risks, and validation gaps in the annual data support implementation.

**Assumptions** (Given by user):
- ✅ Date columns will NEVER contain mixed formats (either all YYYY or all YYYYMM, never mixed)
- ✅ Date columns will ALWAYS have valid values (no NULLs, no empty values)
- ✅ Date values are always convertible to integers

Given these guarantees:
- ❌ **Removed from risk analysis**: 3 critical risks (mixed formats, NULL values, non-integer dates)
- ✅ **Still relevant**: Configuration validation, cache behavior, test coverage

This updated document focuses only on **remaining actionable edge cases**.

---

## Quick Summary

| Category | Risk Count | Status |
|----------|-----------|--------|
| Critical data quality risks | 3 | ✅ **Eliminated** (assumed never occur) |
| High-risk configuration issues | 3 | ⚠️ Still need validation |
| Medium-risk edge cases | 5 | ℹ️ Acceptable or require testing |
| Low-risk edge cases | 3 | ✅ No action needed |

---

## 🟠 HIGH-RISK EDGE CASES (Still Applicable)

### 4. Invalid Year Range (origin_start > origin_end)
**Scenario**: Configuration error where start > end (e.g., origin_start=202612, origin_end=201701)

**Current Behavior** (Line 262):
```python
return list(range(start_yrmo // 100, end_yrmo // 100 + 1))
# range(2026, 2017 + 1) = range(2026, 2018) = []
```

**Impact**:
- ❌ **Empty range**: `acc_yrmo_all = []`
- ❌ **Empty triangle**: Division by zero or NaN results downstream
- ❌ **Silent failure**: No validation error raised

**Example Impact**:
```python
acc_yrmo_all = []
dev_cnt = 0  # len([]) = 0
dev_label = range(3, 0*12+1, 12) = range(3, 1, 12) = []  # empty!
```

**Mitigation**:
```python
if start_yrmo > end_yrmo:
    raise ValueError(f"Invalid range: origin_start ({start_yrmo}) > origin_end ({end_yrmo})")
```

---

### 5. Project Settings Cache Not Clearing
**Scenario**: Project data changes from monthly to annual (or vice versa) without restarting application

**Current Behavior** (Lines 152-154, 214):
```python
if project_name in PROJECT_SETTINGS_CACHE:
    return PROJECT_SETTINGS_CACHE[project_name]
# ... later ...
PROJECT_SETTINGS_CACHE[project_name] = settings
```

**Impact**:
- ❌ **Stale cache**: Old granularity used for new data
- ❌ **Mismatched aggregation**: Monthly logic applied to annual data or vice versa
- **Example**: Run project as monthly, then swap data to annual, run again → old granularity from cache

**Mitigation**:
- Add cache invalidation when data file is updated
- Add manual cache clearing function
- Add timestamp to cached settings and invalidate if data is newer
- Document cache behavior in code

---

### 6. Partial Year Coverage
**Scenario**: origin_start and origin_end don't align with calendar years (e.g., origin_start=201707, origin_end=202605)

**Current Behavior**:
```python
# For annual:
acc_yrmo_all = list(range(2017, 2027))  # [2017, 2018, ..., 2026]
# But actual data only covers July 2017 to May 2026
```

**Impact**:
- ⚠️ **Not wrong, but potentially confusing**: Triangle has 10 rows, but first row only has July-Dec (6 months) and last row only has Jan-May (5 months)
- ⚠️ **Data quality issue**: Users might not realize their data doesn't cover full years
- ✅ **Code handles it**: No crash, but triangle might have patterns that reflect incomplete years

**Mitigation**:
- Document this behavior clearly
- Add warning if origin_start/end don't align with year boundaries
- Consider rounding to calendar years or documenting the partial coverage

---

### 7. Single Year of Data
**Scenario**: origin_start = 202601, origin_end = 202612 (only 1 year)

**Current Behavior**:
```python
acc_yrmo_all = [2026]  # 1 year
dev_cnt = 1
dev_label = range(3, 1*12+1, 12) = range(3, 13, 12) = [3]  # 1 dev period
```

**Impact**:
- ⚠️ **1×1 triangle**: Trivial triangle with only 1 cell
- ✅ **Code handles it**: No crash, results are valid but not meaningful
- **Use case**: Not typical, but shouldn't fail

**Mitigation**:
- Add validation to warn if very few years (< 3)
- Consider requiring minimum years for meaningful reserving analysis

---

### 8. Invalid Month in dev_end
**Scenario**: dev_end has invalid month (e.g., 202600, 202613, 202699)

**Current Behavior** (Line 857):
```python
first_mon = int(project_settings['dev_end'] % 100)
# 202600 % 100 = 0  → first_mon = 0
# 202613 % 100 = 13 → first_mon = 13
# 202699 % 100 = 99 → first_mon = 99
```

**Impact**:
- ⚠️ **Invalid month values**: dev_label = [0, 12, 24, ...] or [13, 25, 37, ...]
- ❌ **Semantic error**: Labels don't represent valid months
- ✅ **No crash**: Code runs but produces nonsensical output

**Mitigation**:
```python
first_mon = int(project_settings['dev_end'] % 100)
if first_mon < 1 or first_mon > 12:
    raise ValueError(f"Invalid month in dev_end: {first_mon} (from {project_settings['dev_end']})")
```

---

## 🟡 MEDIUM-RISK EDGE CASES

### 9. Org_len/dev_len Constraint Not Enforced
**Scenario**: Annual data provided with org_len=12, dev_len=6 (violates constraint)

**Current Behavior** (Line 847-848):
```python
if (dev_len == 'Default') or (org_len % dev_len != 0):
    dev_len = org_len
```

**Impact**:
- ✅ **Self-corrects**: dev_len is forced to match org_len
- ⚠️ **Silent override**: User's requested dev_len is silently changed
- ⚠️ **No warning**: User won't know the override occurred

**Mitigation**:
```python
if is_annual and (org_len != 12 or dev_len != 12):
    print(f"Warning: Annual data requires org_len=dev_len=12. Overriding org_len={org_len}, dev_len={dev_len} to 12.")
    org_len = dev_len = 12
```

---

### 10. Data Cleaning Logic Assumptions
**Scenario**: Annual data with unexpected org_len/dev_len values somehow bypassing constraints

**Current Behavior** (Lines 968-980):
```python
if dev_len == 1:
    max_dev_age = max_dev_age - (12 - max_sys_month)
if dev_len == 3:
    # quarterly logic
if dev_len == 6:
    # half-yearly logic
# if dev_len == 12: no adjustment
```

**Impact**:
- ✅ **Safe for annual**: dev_len=12 never enters these conditions
- ✅ **Safe for monthly**: Conditions match monthly use cases
- ⚠️ **Assumes valid input**: If constraints are violated, this logic is untested for edge cases

**Mitigation**:
- Add assertion for annual: `assert org_len == 12 and dev_len == 12` if `is_annual`
- Add test cases for constraint violations

---

### 11. Large Year Spans
**Scenario**: Very old data (origin_start=190001, origin_end=209912)

**Current Behavior**:
```python
range(1900, 2100)  # 200 years!
acc_yrmo_all = [1900, 1901, ..., 2099]  # 200 elements
```

**Impact**:
- ⚠️ **Memory**: Large list, but Python handles this fine
- ⚠️ **Performance**: 200×200 triangle is large, but not prohibitive
- ⚠️ **Semantic**: Is 100+ year old data realistic? Likely data quality issue

**Mitigation**:
```python
num_years = end_year - start_year + 1
if num_years > 100:
    print(f"Warning: Very large year span ({num_years} years) detected. Check data quality.")
```

---

## 🟢 LOW-RISK EDGE CASES

### 12. Vector Format with Annual Data
**Scenario**: Annual data with output_data_format = 'Vector'

**Current Behavior** (Line 986-987):
```python
if output_data_format == 'Vector' or arg['Function'] == 'ADASVec':
    df2 = df2.iloc[:, [0]]  # Keep only first column
```

**Impact**:
- ✅ **Likely works**: Logic applies to both monthly and annual
- ⚠️ **Untested**: Vector format for annual data not explicitly tested
- ✅ **No changes needed**: Generic column slicing, format-agnostic

**Mitigation**:
- Add test case for annual vector format
- Document that vector format is supported for annual

---

### 13. Extreme Years (1900s, 2100s)
**Scenario**: Historical data or far-future scenarios

**Current Behavior**:
```python
# Python handles arbitrary year integers fine
# range(1850, 2150) works fine
```

**Impact**:
- ✅ **No code error**: Python handles large integers
- ⚠️ **Semantic question**: Is year 1850 data realistic for insurance reserves?
- ✅ **No mitigation needed**: Code is robust

---

### 14. Floating-Point Years in Data (if present)
**Scenario**: Date column contains floats (e.g., 2026.5 instead of 2026)

**Current Behavior**:
```python
sample_val = int(df[date_cols[0]].dropna().iloc[0])
# int(2026.5) → 2026 ✓ Works fine (truncates)
```

**Impact**:
- ✅ **Graceful handling**: int() truncates float correctly
- ✅ **No code error**: Works as expected
- ℹ️ **Data quality**: Float dates suggest upstream data quality issue (but not our problem)

---

## 📋 VALIDATION CHECKLIST

Given the data quality guarantees, simplified validation is needed:

```python
def _validate_project_settings(settings, date_granularity):
    """Validate project settings for safety."""
    errors = []
    warnings = []

    # Check 1: Year range validity
    if settings['origin_start'] > settings['origin_end']:
        errors.append(f"origin_start ({settings['origin_start']}) > origin_end ({settings['origin_end']})")

    # Check 2: Month validity (only for YYYYMM)
    for key in ['origin_start', 'origin_end', 'dev_end']:
        val = settings[key]
        # Only extract month if this is a 6-digit YYYYMM value
        if len(str(val)) == 6:
            month = val % 100
            if month < 1 or month > 12:
                errors.append(f"{key} has invalid month: {month}")

    # Check 3: Annual data constraints (should be enforced by calling code)
    if date_granularity == 'annual':
        warnings.append("Annual data: Ensure org_len=dev_len=12")

    # Check 4: Data span
    num_years = settings['origin_end'] // 100 - settings['origin_start'] // 100 + 1
    if num_years < 1:
        errors.append("No years in range")
    if num_years > 100:
        warnings.append(f"Large year span: {num_years} years - verify data quality")
    if num_years < 3:
        warnings.append(f"Small data span: {num_years} years - may not be meaningful for reserving")

    if errors:
        raise ValueError(f"Settings validation failed: {errors}")

    return warnings
```

---

## Summary Table

| # | Edge Case | Risk Level | Impact | Mitigation | Status |
|---|-----------|-----------|--------|-----------|--------|
| 1 | ~~Mixed date formats~~ | ~~🔴 Critical~~ | N/A | N/A | ✅ Assumed never |
| 2 | ~~All NULL dates~~ | ~~🔴 Critical~~ | N/A | N/A | ✅ Assumed never |
| 3 | ~~Non-integer dates~~ | ~~🔴 Critical~~ | N/A | N/A | ✅ Assumed never |
| 4 | Invalid year range | 🟠 High | Empty triangle | Validate origin_start ≤ origin_end | ⚠️ Should validate |
| 5 | Settings cache stale | 🟠 High | Wrong granularity | Invalidate on data update | ⚠️ Document behavior |
| 6 | Partial year coverage | 🟠 High | Confusing results | Document behavior clearly | ℹ️ Acceptable |
| 7 | Single year data | 🟡 Medium | Trivial 1×1 output | Warn if < 3 years | ℹ️ Acceptable |
| 8 | Invalid month in dev_end | 🟡 Medium | Wrong labels | Validate 1 ≤ month ≤ 12 | ⚠️ Should validate |
| 9 | Org/dev_len not enforced | 🟡 Medium | Silent override | Add warning message | ℹ️ Works but warn |
| 10 | Data cleaning assumptions | 🟡 Medium | Untested paths | Add assertion for annual | ℹ️ Safe (dev_len=12) |
| 11 | Large year spans | 🟡 Medium | Performance | Warn if > 100 years | ℹ️ Acceptable |
| 12 | Vector format untested | 🟢 Low | Unknown behavior | Test with annual data | ⚠️ Should test |
| 13 | Extreme years (1900s, 2100s) | 🟢 Low | Semantic question | No code changes needed | ✅ No action |
| 14 | Float date values | 🟢 Low | Data quality signal | No code changes (int() handles) | ✅ No action |

---

## Recommended Priority

**Immediate** (before production use):
1. ✅ Add validation: `origin_start ≤ origin_end`
2. ✅ Add validation: month values 1-12 (for YYYYMM config values)
3. ⚠️ Add warning: If org_len/dev_len mismatch for annual data
4. ⚠️ Document: Settings cache behavior and when to clear

**Before first annual project**:
5. ⚠️ Test Vector format with annual data
6. ℹ️ Verify data cleaning logic skips month-based adjustments (should already work)

**Nice to have** (low priority):
7. ℹ️ Add warnings for edge cases (partial years, very small/large spans)

