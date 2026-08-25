# Development Label Generation Verification

**Scenario**: Annual YYYY data with `dev_end = 202603` from JSON
**Expected Result**: `dev_label = [3, 15, 27, ...]`

---

## Step-by-Step Code Trace

### Step 1: Generate Period Range
**Function**: `_generate_period_range()` (Line 247-263)

**Inputs**:
- `start_yrmo = 201601` (from JSON: `origin_start_date`)
- `end_yrmo = 202612` (from JSON: `origin_end_date`)
- `date_granularity = 'annual'` (detected from data column having YYYY values)

**Code Logic** (Line 260-262):
```python
if date_granularity == 'annual':
    return list(range(start_yrmo // 100, end_yrmo // 100 + 1))
```

**Calculation**:
```
start_yrmo // 100 = 201601 // 100 = 2016
end_yrmo // 100 = 202612 // 100 = 2026
range(2016, 2026 + 1) = range(2016, 2027) = [2016, 2017, ..., 2026]
```

**Output**: `acc_yrmo_all = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]`
- **Count**: 11 years

---

### Step 2: Compute dev_cnt
**Line 855-856**:
```python
is_annual = project_settings.get('date_granularity') == 'annual'
dev_cnt = len(acc_yrmo_all) if is_annual else round(len(acc_yrmo_all)/dev_len)
```

**Calculation**:
```
is_annual = True
dev_cnt = len([2016, 2017, ..., 2026]) = 11
```

**Output**: `dev_cnt = 11`

---

### Step 3: Extract Month from dev_end
**Line 857**:
```python
first_mon = int(project_settings['dev_end'] % 100)
```

**Calculation**:
```
dev_end = 202603 (March 2026 in YYYYMM format)
first_mon = 202603 % 100 = 3 (extract the month part)
```

**Output**: `first_mon = 3` ✓

---

### Step 4: Generate Forward Development Labels
**Line 859**:
```python
dev_label = list(range(first_mon, dev_cnt*dev_len+1, dev_len))
```

**Calculation** (Note: `dev_len = org_len = 12` for annual):
```
first_mon = 3
dev_cnt = 11
dev_len = 12 (annual data always uses org_len = dev_len = 12)

Start: first_mon = 3
End: dev_cnt*dev_len + 1 = 11*12 + 1 = 132 + 1 = 133
Step: dev_len = 12

range(3, 133, 12) = [3, 15, 27, 39, 51, 63, 75, 87, 99, 111, 123]
```

**Verification**:
- 1st: 3 + 0*12 = 3 ✓
- 2nd: 3 + 1*12 = 15 ✓
- 3rd: 3 + 2*12 = 27 ✓
- 4th: 3 + 3*12 = 39
- 5th: 3 + 4*12 = 51
- 6th: 3 + 5*12 = 63
- 7th: 3 + 6*12 = 75
- 8th: 3 + 7*12 = 87
- 9th: 3 + 8*12 = 99
- 10th: 3 + 9*12 = 111
- 11th: 3 + 10*12 = 123
- Next: 3 + 11*12 = 135 > 132, stops

**Output**: `dev_label = [3, 15, 27, 39, 51, 63, 75, 87, 99, 111, 123]` (11 values)

---

### Step 5: Add Prior Development Periods (Backward)
**Lines 861-866**:
```python
for i in range(1, 999):
    prior_mon = first_mon - dev_len*i
    if prior_mon > 0:
        dev_label = [prior_mon] + dev_label
    else:
        break
```

**Calculation**:
```
i=1: prior_mon = 3 - 12*1 = 3 - 12 = -9 (NOT > 0, break immediately)
```

**Output**: No prior periods added
`dev_label = [3, 15, 27, 39, 51, 63, 75, 87, 99, 111, 123]` (unchanged)

---

### Step 6: Add Month Suffix
**Line 868**:
```python
dev_label = list(map(lambda x:f"{x}m", dev_label))
```

**Calculation**:
```
Map each integer to string with "m" suffix:
3 → "3m"
15 → "15m"
27 → "27m"
... (all 11 values get the "m" suffix)
```

**Output**: `dev_label = ['3m', '15m', '27m', '39m', '51m', '63m', '75m', '87m', '99m', '111m', '123m']`

---

## Summary

### Expected vs Actual

| Aspect | Expected | Actual | Match? |
|--------|----------|--------|--------|
| **dev_label (numeric)** | [3, 15, 27, ...] | [3, 15, 27, 39, 51, 63, 75, 87, 99, 111, 123] | ✅ |
| **First value** | 3 | 3 | ✅ |
| **Second value** | 15 | 15 | ✅ |
| **Third value** | 27 | 27 | ✅ |
| **Step size** | 12 months | 12 months | ✅ |
| **Count** | 11 values | 11 values | ✅ |
| **Final format** | ['3m', '15m', '27m', ...] | ['3m', '15m', '27m', ...] | ✅ |

---

## Interpretation

### What the dev_label Represents

Each value in `dev_label` represents a **12-month development period** (bucket) measured in months:

| dev_label | Month Range | Year 1 → Year 2 |
|-----------|-------------|-----------------|
| 3 | Months 1-3 | Accident year, by end of March |
| 15 | Months 13-15 | Accident year + 1, by end of March |
| 27 | Months 25-27 | Accident year + 2, by end of March |
| 39 | Months 37-39 | Accident year + 3, by end of March |
| ... | ... | ... |

For example, if an accident occurred in 2016 (origin year):
- At age 3 months (end of March 2016): data falls into bucket **3m**
- At age 15 months (end of March 2017): data falls into bucket **15m**
- At age 27 months (end of March 2018): data falls into bucket **27m**

---

## Conclusion

✅ **The development label generation is CORRECT**

The code logic properly:
1. ✅ Extracts month (3) from `dev_end = 202603`
2. ✅ Computes dev_cnt (11) as the number of years
3. ✅ Generates forward range with 12-month spacing: [3, 15, 27, ...]
4. ✅ Skips backward periods (first_mon - dev_len = -9, which is not > 0)
5. ✅ Applies the 'm' suffix for display

The resulting `dev_label = [3, 15, 27, 39, ...]` is **exactly as expected** for annual data with March development end dates.
