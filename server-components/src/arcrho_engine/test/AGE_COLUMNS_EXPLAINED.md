# Age Columns Explained: `Age` vs `Age*`

**Lines of Interest**: 951, 982-983

---

## Quick Answer

| Column | Calculated Using | Purpose | Used For |
|--------|------------------|---------|----------|
| `Age` (Line 951) | Actual origin date of each row | Individual row-level age | Display/validation only (not used) |
| `Age*` (Line 983) | **Group START date** (Org*Start) | Age based on origin period group | ✅ **Actual aggregation** (Line 932) |

---

## Detailed Explanation

### `df1['Age']` - Line 951
```python
df1['Age'] = df1.apply(lambda row: _calc_age(row[date_cols[0]], row[date_cols[1]]), axis=1)
```

**Calculation**:
- `acc_yrmo` = Actual origin date from data (date_cols[0])
- `sys_yrmo` = Actual system/dev date from data (date_cols[1])
- Age = difference between these two dates

**Example** (Monthly data):
```
Row 1: Origin=202601, Dev=202604 → Age = 4 months
Row 2: Origin=202602, Dev=202604 → Age = 3 months
Row 3: Origin=202601, Dev=202604 → Age = 4 months
```

**Purpose**: None really. This column is calculated but **never used** in aggregation.

---

### `df1['Age*']` - Line 983
```python
df1['Age*'] = df1.apply(lambda row: _calc_age(row['Org*Start'], row[date_cols[1]]), axis=1)
```

**Calculation**:
- `acc_yrmo` = **Group START date** (Org*Start) from Line 982
- `sys_yrmo` = Actual system/dev date from data (date_cols[1])
- Age = difference between group start and dev date

**How Org*Start is Determined** (Line 982):
```python
df1['Org*Start'] = df1[date_cols[0]].map(org_index_map)
```

Where `org_index_map` (Line 976) maps each date to its **period group's starting date**:
```python
org_index_map = {val: group[0] for group in org_index_grp for val in group}
```

**Example** (Monthly data with org_len=12):
```
Origin periods: [201701-201712], [201801-201812], ...

Row 1: Origin=202602, Group=(202601-202612) → Org*Start=202601 → Age*=4
Row 2: Origin=202610, Group=(202601-202612) → Org*Start=202601 → Age*=4 ← Same group!
Row 3: Origin=202701, Group=(202701-202712) → Org*Start=202701 → Age*=2 ← Different group
```

Notice: Rows 1 and 2 have same `Age*` because they're in the same origin period group, despite having different actual origin dates.

**Purpose**: ✅ **This is used for aggregation** (Line 932):
```python
df1['Age*Grp'] = df1['Age*'].apply(lambda x: min([i for i in dev_label if i >= x]))
```

---

## Data Flow Diagram

```
df1 rows (from CSV):
├─ date_cols[0]: Actual origin date (e.g., 202602, 202610)
└─ date_cols[1]: Actual dev date (e.g., 202604)

↓ (Line 980) Create origin groups
df1['Org*Grp']: Group label (e.g., "2026" for annual, "Q1 2026" for quarterly)

↓ (Line 982) Map to group start
df1['Org*Start']: First date in the group (e.g., 202601 for rows in Jan-Dec 2026)

↓ (Line 951) Calculate individual age (rarely used)
df1['Age']: Actual age = dev_date - actual_origin_date

↓ (Line 983) Calculate group-based age ✓ USED FOR AGGREGATION
df1['Age*']: Group age = dev_date - group_start_date

↓ (Line 932) Map to development period
df1['Age*Grp']: Development label (e.g., 2, 14, 26, ...)

↓ (Line 934) Grouping and aggregation
df.groupby(['Org*Grp', 'Age*Grp']).sum() ← Uses Org*Grp and Age*Grp, NOT Age or Age*
```

---

## Why Two Ages?

### Scenario: Monthly data, org_len=12 (group by 12 months = 1 year)

**Three claims in same origin period (2026):**
```
Claim A: Origin=202601, Dev=202604 → Age=4, Age*=4 (group start=202601)
Claim B: Origin=202603, Dev=202604 → Age=2, Age*=4 (group start=202601) ← Different!
Claim C: Origin=202612, Dev=202604 → Age=? (impossible, dev before origin!)
```

**For Aggregation**:
- We don't care that Claim A and B have different actual ages
- We care that they're BOTH in the same origin period (2026)
- They should both contribute to the same row of the development triangle
- `Age*` ensures they're both assigned to the same development age bucket (4 months)

### Scenario: Annual data, org_len=12

**Three claims in same origin period (2017):**
```
Claim A: Origin=2017, Dev=2018 → Age=13, Age*=13
Claim B: Origin=2017, Dev=2018 → Age=13, Age*=13 (same!)
Claim C: Origin=2017, Dev=2019 → Age=25, Age*=25
```

For annual data with org_len=12:
- All rows in origin year 2017 have Origin=2017
- So `Age` and `Age*` are identical!
- But the logic still works the same way

---

## Summary

| Aspect | Age | Age* |
|--------|-----|------|
| **Uses** | origin date from data | group start date from grouping logic |
| **Meaning** | Individual claim's development age | Age relative to origin period group |
| **In triangle** | ❌ Not used | ✅ Used (via Age*Grp) |
| **For annual** | All rows in same group have same value | All rows in same group have same value |
| **For monthly with org_len<12** | Varies within group | Same within group |

---

## Code Notes

**Why calculate both?**

Honestly, `Age` is calculated but appears to **never be used**. It could be removed without affecting the aggregation. The code is organized this way for:
- Clarity/documentation (shows the individual calculation)
- Debugging (if you want to verify data matches expected ages)
- Historical reasons (legacy code structure)

The **actual aggregation only uses**:
- `Org*Grp` (which origin period group)
- `Age*Grp` (which development age bucket)

Both of which are derived from the `Age*` calculation, not `Age`.

