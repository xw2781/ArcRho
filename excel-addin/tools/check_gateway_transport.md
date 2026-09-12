# Check: formulas read the same figures from the server as from the share

A ten-minute manual check that every worksheet function returns the same value
whether it reads project data from the ArcRho Server or from the workspace
share, and how long a full recalculation takes each way. There is no automated
harness for the add-in's VBA, so this is the check.

## The setting that forces the share

With a Gateway credential installed, every formula reads from the server. Run
this in the Immediate window to send them back to the share, and again with
`False` to undo it:

```
ArcRhoForceSharePath True
ArcRhoForceSharePath False
```

The choice is remembered with the add-in's other settings and is off for
everyone by default. It exists only for this comparison and is removed once the
share path is gone.

## The workbook

One sheet covering every worksheet function, all against
`NJ_Annual_Prod_202605_Fake`, reserving class `HPPREF\HO+DF\NJ\Legacy\HOL`:

| Block | Formula |
| :--- | :--- |
| array triangle | `ArcRhoTri(class,"Net Loss--Incurred Adjusted***",TRUE,FALSE,FALSE,project,1,1)` |
| single cell | `ArcRhoTriCell(class,"Net Loss--Incurred Adjusted***",2,3,TRUE,project,1,1)` |
| diagonal | `ArcRhoTriDiag(class,"Net Loss--Incurred Adjusted***",0,TRUE,FALSE,project,1,1)` |
| origin row | `ArcRhoTriOrigin(class,"Net Loss--Incurred Adjusted***",2,TRUE,FALSE,project,1,1)` |
| vector | `ArcRhoVec(class,"C 81 - Prior Qtr Indicated",FALSE,project,12)` |
| vector cell | `ArcRhoVecCell(class,"C 81 - Prior Qtr Indicated",2,project,12)` |
| period headings | `ArcRhoHeaders(0,TRUE,12,project,-1,FALSE)` and the same with `1` |
| project settings | `ArcRhoProjectSettings(project)` |
| coarser view | `ArcRhoTri(class,"Net Loss--Incurred Adjusted***",TRUE,FALSE,FALSE,project,12,12)` |

Each array block is entered over a fixed range so that the two passes can be
compared cell by cell.

## The passes

Put Excel in manual calculation. Then, alternating and starting with a warm-up
pass on each side: set the force setting, wait twelve seconds so Windows drops
the share's cached directory metadata, recalculate everything, and read every
block. Three measured passes each way; take the median of the three times.

Without that wait the share is measured warmer than a user opening a workbook
ever meets it, because Windows answers a repeated look at the same folder from
its own cache for about ten seconds.

## What to expect

Every cell holds the same value on both paths. A failure is expected to read
differently: the server's own message is passed through, where the share path
could only say that a file was missing.

## Recorded run

2026-09-12 on the developer Client PC `L-H2MQ6280FVP`, Excel 16.0 driven over
COM, add-in version 2.5.0, against the Gateway on `NE7SASWPN02`, with the Engine
and Gateway redeployed the same day.

### Values

| Workbook | Cells compared | Cells that differ |
| :--- | :--- | :--- |
| The nine blocks above that both paths can serve | 566 | 0 |
| Twenty-three annual triangles in one class | 1,104 | 0 |

The coarser-view block, 400 more cells, could not be compared on this PC. The
server answered it correctly; the share path failed with "a dataset view must be
written to the reserving class's view cache" because a beta add-in loaded from
the repository works out the workspace root as a UNC path, which the server's
view handler will not accept as the same location as its own drive letter. An
add-in loaded from the share, as every user's is, does not have that problem.

### Times

| Workbook | Share | Server |
| :--- | :--- | :--- |
| Ten blocks, nine datasets | 0.46 s | 0.60 s |
| Twenty-three annual triangles | 1.03 s | 1.14 s |

Both are medians of three alternating passes. One dataset costs roughly 45 ms
over the share and 50 ms over the server on this network on this day, and a
second formula asking for the same dataset in the same pass costs 10 ms either
way, because the add-in already remembers it.

The share is therefore as fast as the server for a warm workbook of hand-entered
datasets in one reserving class, which is not what the plan's own measurement
predicted; see the open decision in
[docs/plans/excel_addin_gateway_transport.md](../../docs/plans/excel_addin_gateway_transport.md).
The server's advantage that this run does show is the coarser view, which it
builds in memory in about 90 ms and which the share path cannot serve at all
here.

### Two failures that are not about the transport

Both predate this change and appear identically on both paths:

- **A calendar-period view of a hand-entered triangle is unavailable.** The
  roll-up will only build a view from a stored triangle whose own calendar mode
  matches, so both paths refuse. `ArcRhoTriDiag` and `ArcRhoTriCell` ask for one
  without meaning to, because of the way they pass their arguments on.
- **`ArcRhoTriDiag` asks for the transposed calendar shape** rather than the one
  its caller asked for, so the diagonal of a hand-entered triangle fails on both
  paths.
