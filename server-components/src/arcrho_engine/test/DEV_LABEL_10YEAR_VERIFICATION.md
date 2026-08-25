# Development Label Verification: 10-Year Standard Scenario

**Typical Scenario**:
- `origin_start = 201701` (Jan 2017)
- `origin_end = 202612` (Dec 2026)
- `dev_end = 202603` (March 2026)
- Annual YYYY data format

**Question**: Should dev_label length = 10 (matching the 10 years of data)?

---

## Step-by-Step Calculation

### Step 1: Generate Period Range
**Code** (Line 260-262):
```python
if date_granularity == 'annual':
    return list(range(start_yrmo // 100, end_yrmo // 100 + 1))
```

**With Your Values**:
```
start_yrmo = 201701
end_yrmo = 202612

start_yrmo // 100 = 201701 // 100 = 2017
end_yrmo // 100 = 202612 // 100 = 2026

range(2017, 2026 + 1) = range(2017, 2027)
```

**Result**: `acc_yrmo_all = [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]`

**Count**:
```
2026 - 2017 + 1 = 10 years ✓
```

### Step 2: Compute dev_cnt
**Code** (Line 855-856):
```python
is_annual = project_settings.get('date_granularity') == 'annual'
dev_cnt = len(acc_yrmo_all) if is_annual else round(len(acc_yrmo_all)/dev_len)
```

**With Your Values**:
```
is_annual = True
dev_cnt = len([2017, 2018, ..., 2026]) = 10
```

**Result**: `dev_cnt = 10` ✓

### Step 3: Extract Month from dev_end
**Code** (Line 857):
```python
first_mon = int(project_settings['dev_end'] % 100)
```

**With Your Values**:
```
dev_end = 202603
first_mon = 202603 % 100 = 3
```

**Result**: `first_mon = 3` ✓

### Step 4: Generate Development Labels
**Code** (Line 859):
```python
dev_label = list(range(first_mon, dev_cnt*dev_len+1, dev_len))
```

**With Your Values** (Note: `dev_len = org_len = 12` for annual):
```
first_mon = 3
dev_cnt = 10
dev_len = 12

range(first_mon, dev_cnt*dev_len+1, dev_len)
= range(3, 10*12+1, 12)
= range(3, 120+1, 12)
= range(3, 121, 12)
```

**Manual Expansion**:
```
Start: 3
Step: 12

Values:
1.  3     (start)
2.  15    (3 + 12)
3.  27    (15 + 12)
4.  39    (27 + 12)
5.  51    (39 + 12)
6.  63    (51 + 12)
7.  75    (63 + 12)
8.  87    (75 + 12)
9.  99    (87 + 12)
10. 111   (99 + 12)
11. 123   (111 + 12) ← This would be next, but 123 ≥ 121, so range stops

range(3, 121, 12) = [3, 15, 27, 39, 51, 63, 75, 87, 99, 111]
```

**Result**: `dev_label = [3, 15, 27, 39, 51, 63, 75, 87, 99, 111]`

**Count**: 10 values ✓

### Step 5: Add Backward Periods
**Code** (Lines 861-866):
```python
for i in range(1, 999):
    prior_mon = first_mon - dev_len*i
    if prior_mon > 0:
        dev_label = [prior_mon] + dev_label
    else:
        break
```

**With Your Values**:
```
i=1: prior_mon = 3 - 12*1 = -9 (NOT > 0, break immediately)
```

**Result**: No prior periods added ✓

### Step 6: Add Month Suffix
**Code** (Line 868):
```python
dev_label = list(map(lambda x:f"{x}m", dev_label))
```

**Result**: `dev_label = ['3m', '15m', '27m', '39m', '51m', '63m', '75m', '87m', '99m', '111m']`

---

## Verification Summary

### Quick Check: Length Match

| Metric | Value | Match? |
|--------|-------|--------|
| **Years in data** (2017-2026) | 10 | ✓ |
| **dev_cnt computed** | 10 | ✓ |
| **dev_label length** | 10 | ✓ |
| **dev_label values** | [3, 15, 27, ..., 111] | ✓ |

### Answer: ✅ **YES, CORRECT**

The development label length **exactly matches** the number of years (10):
- **10 years of data** (2017-2026)
- **10 development periods** [3m, 15m, 27m, 39m, 51m, 63m, 75m, 87m, 99m, 111m]

---

## Why This Works

The key formula that ensures this match:

```
dev_label = range(first_mon, dev_cnt*dev_len + 1, dev_len)
           = range(first_mon, len(acc_yrmo_all)*dev_len + 1, dev_len)
           = range(first_mon, num_years*12 + 1, 12)
```

Number of elements in this range:
```
Number of steps = (end - start) / step
                = (dev_cnt*dev_len - first_mon) / dev_len  (approximately)
                = dev_cnt*dev_len/dev_len  (when first_mon << dev_cnt*dev_len)
                = dev_cnt
                = len(acc_yrmo_all)
                = number of years
```

So the **length always equals the number of years**, which is the correct and expected behavior.

---

## General Formula for Any Scenario

For any annual data scenario:

| Parameter | Formula | Your Value |
|-----------|---------|-----------|
| **Number of years** | `end_year - start_year + 1` | 2026 - 2017 + 1 = 10 |
| **dev_cnt** | `num_years` | 10 |
| **dev_label length** | `num_years` | 10 |
| **Last dev_label** | `first_mon + (num_years-1)*12` | 3 + 9*12 = 111 ✓ |

### Verification for Different Scenarios

**Scenario A: 5 years (2022-2026), dev_end=202603**
```
dev_cnt = 5
dev_label = range(3, 5*12+1, 12) = range(3, 61, 12) = [3, 15, 27, 39, 51]
Length = 5 ✓
```

**Scenario B: 15 years (2012-2026), dev_end=202603**
```
dev_cnt = 15
dev_label = range(3, 15*12+1, 12) = range(3, 181, 12) = [3, 15, 27, ..., 171]
Length = 15 ✓
```

**Scenario C: Different month, 10 years, dev_end=202512 (Dec 2025)**
```
first_mon = 202512 % 100 = 12
dev_cnt = 10
dev_label = range(12, 10*12+1, 12) = range(12, 121, 12) = [12, 24, 36, 48, 60, 72, 84, 96, 108, 120]
Length = 10 ✓
```

---

## Conclusion

✅ **Development label length is always correct**

For your standard 10-year scenario (2017-2026):
- **Number of years**: 10
- **dev_cnt**: 10
- **dev_label length**: 10 ✓
- **dev_label values** (for March): [3, 15, 27, 39, 51, 63, 75, 87, 99, 111] ✓

The logic is robust and will work correctly for any number of years.
