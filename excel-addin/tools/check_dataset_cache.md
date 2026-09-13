# Check: one dataset is fetched once per recalculation

A two-minute manual check that a dataset several formulas ask for during one
recalculation is read once, that a refresh still picks up an edited dataset,
that the "always refresh" setting still bypasses everything, and that the two
ribbon buttons ask the server to produce each dataset again while still paying
for it only once. There is no automated harness for the add-in's VBA, so this is
the check.

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
3. **Ribbon button.** Turn "always refresh" back off, zero the counters, and
   press **Calculate Worksheet** instead of calculating by hand. Do the same
   again with "always refresh" on: the button must behave the same either way,
   because it already asks for everything to be produced again.

   The window itself is part of what this pass checks. It first counts the
   formulas on the sheet, and its bar fills as it reads them. It then says
   `Updating 21 ArcRho range(s) ...` and counts them off one by one, which is
   the sheet's one array formula plus its twenty single-cell formulas. Cancel
   must stop it between two ranges rather than at the end.

## What to expect

| Pass | Requests | Hits | Fetches |
| :--- | :--- | :--- | :--- |
| Cold | 21 | 20 | 1 |
| Always refresh | 21 | 0 | 21 |
| Ribbon button, always refresh off | 21 | 20 | 1 |
| Ribbon button, always refresh on | 21 | 20 | 1 |

Before the dataset was remembered within a pass, the cold pass read the file
twenty-one times. The two ribbon buttons drop what is remembered at the start of
their search, so an edited dataset is still picked up.

The two ribbon rows are the point of the third pass: the button asks the server
to produce each dataset again, and one fetch rather than twenty-one shows that
it pays for that once and answers the rest from memory. Watching the fetch count
is all this sheet can show, because its triangle is hand entered and the server
answers a hand-entered dataset as it stands. To see a dataset genuinely produced
again, point one formula at a generated dataset and press the button: the
reserving class's copy of that CSV should carry a new modified time afterwards,
and the hand-entered one should not.

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
