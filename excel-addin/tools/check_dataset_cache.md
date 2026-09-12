# Check: one dataset is fetched once per recalculation

A two-minute manual check that a dataset several formulas ask for during one
recalculation is read once, that a refresh still picks up an edited dataset, and
that the "always refresh" setting still bypasses everything. There is no
automated harness for the add-in's VBA, so this is the check.

## What the add-in counts

`Core.bas` keeps three running totals for this check. They are never reset by the
add-in, so read each one before and after a pass and take the difference.

| Counter | Meaning |
| :--- | :--- |
| `datasetRequestCount` | Dataset requests the worksheet's formulas made. |
| `datasetHitCount` | Requests answered from the dataset already fetched in this pass. |
| `datasetFetchCount` | Requests that actually read the dataset's file. |

Read them in the VBA Immediate window with `?datasetRequestCount`,
`?datasetHitCount` and `?datasetFetchCount`, and zero them with
`datasetRequestCount = 0` and the same for the other two.

## The sheet

One array formula and twenty single-cell formulas over the same triangle. The
single-cell formulas index into the same call so that every formula makes the
same request; `ArcRhoTriCell` cannot be used here, because it asks for the
transposed calendar shape rather than the one the array formula asks for.

```
A1    =ArcRhoTri("HPPREF\HO+DF\NJ\Legacy\HOL","Net Loss--Incurred Adjusted***",TRUE,FALSE,FALSE,"NJ_Annual_Prod_202605_Fake",1,1)
OJ1   =INDEX(ArcRhoTri("HPPREF\HO+DF\NJ\Legacy\HOL","Net Loss--Incurred Adjusted***",TRUE,FALSE,FALSE,"NJ_Annual_Prod_202605_Fake",1,1),1,1)
OJ2   ... the same with the row index 2, and so on down to row 20
```

That triangle is hand entered, so nothing is asked of the Engine and no request
file is written while the check runs.

## The passes

Put Excel in manual calculation, then for each pass: mark the twenty-one formula
cells dirty, zero the three counters, calculate, and read the counters.

1. **Cold.** In the Immediate window run `ClearDatasetResultCache` first, so the
   pass starts with nothing remembered.
2. **Always refresh.** Turn "always refresh" on in the add-in's settings, then
   repeat.

## What to expect

| Pass | Requests | Hits | Fetches |
| :--- | :--- | :--- | :--- |
| Cold | 21 | 20 | 1 |
| Always refresh | 21 | 0 | 21 |

Before the dataset was remembered within a pass, the cold pass read the file
twenty-one times. A ribbon refresh drops what is remembered at the start of its
search and again before each block it re-enters, so an edited dataset is still
picked up.

## Recorded run

2026-09-12 on the developer Client PC `L-H2MQ6280FVP`, Excel 16.0 driven over
COM, add-in version 2.4.0, against
`Net Loss--Incurred Adjusted***` in reserving class
`HPPREF\HO+DF\NJ\Legacy\HOL` of `NJ_Annual_Prod_202605_Fake`, a 33 KB triangle of
120 rows by 113 columns.

| Pass | Requests | Hits | Fetches |
| :--- | :--- | :--- | :--- |
| Cold, before the change | 21 | 0 | 21 |
| Cold, after the change | 21 | 20 | 1 |
| Always refresh, after the change | 21 | 0 | 21 |

"Before the change" was measured with the same build with only the lookup
removed, so the two rows differ in nothing else.
