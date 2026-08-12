# Bidirectional ResQ reserving-class sync

The `Sync Reserving Class with ResQ` macro
(`python-api/macros/sync_reserving_class_with_resq.py`) compares and selectively
synchronizes one ArcRho reserving class with the identically scoped ResQ data.
The ArcRho project name is also used as the ResQ project name, and the selected
reserving-class path must exist in that project on both sides. The UI does not
offer a project or path mapping override.

## Review and timestamp rules

The macro inventories the union of logical datasets and method outputs, pairing
names case-insensitively after whitespace normalization. Before any write, it
opens a review table with type, logical name, status, proposed direction, and
details. **Every row always contains both `ArcRho Timestamp` and `ResQ
Timestamp` columns**, including rows that exist on only one side.

- `Not present` means that logical item was not found on that side.
- `Unknown` means the item exists, but no usable last-modified timestamp was
  available. If ResQ exposes `Created` but not `Modified`, the table shows the
  created value for context as `Unknown Modified; Created ...`; it is not used
  to choose a direction.
- ArcRho normally uses the persisted dataset or method modified timestamp.
  Engine datasets prefer `source_modified`; if metadata has no usable value,
  the file modification time is shown and identified as `File modified`.
- ResQ uses the dataset or method-output object's `Modified` value. A missing
  `Modified` value never falls back to the current time.

On an item's first comparison, the newer usable timestamp determines the
proposed direction. Matching timestamps produce `Same timestamp`; this does
not assert that the contents are identical. An unknown timestamp disables
automatic direction selection. ResQ timestamps without an offset are treated
as local wall-clock time, so clock or timezone errors can affect a first-time
comparison.

Straightforward supported actions are selected initially. If both sides
changed since the last accepted sync, the newer side is proposed but the row
is marked as a conflict and starts unchecked. The user can select or deselect
enabled rows, choose `Apply Selected`, or cancel. Cancel and an empty accepted
selection perform no writes.

## Durable baseline and stale reviews

After a row succeeds and both sides can be inventoried with usable timestamps,
the macro atomically records both observed timestamps in a project-owned sync
state file under `sync/resq/`. Later comparisons use this durable baseline:

- only ArcRho changed: propose ArcRho to ResQ;
- only ResQ changed: propose ResQ to ArcRho;
- neither changed: report `Synchronized`;
- both changed: report a conflict and require explicit selection.

This paired baseline prevents a ResQ `Save()` timestamp from causing the next
run to send the same item back in the opposite direction. Before the first
accepted mutation, selected rows are marked pending. If a process ends before
the final baseline is recorded, a later run reports `Previous sync incomplete`
as an unchecked conflict and preserves the originally accepted direction,
including when the timestamps now match. Inspect both timestamps and explicitly
select that direction only when it is the intended recovery action.

The macro re-inventories selected rows after review and again after acquiring
the reserving-class locks. If any selected observation or proposed action is
stale, it aborts before applying the batch and asks the user to rerun the
review. Methods are rechecked after selected dataset work as well; a method
changed during that phase fails individually instead of using an old plan.

## Supported actions

- Ordinary ArcRho triangle/vector datasets can sync in either direction when
  their canonical metadata and CSV cache exist, the Dataset Type is known,
  and a ResQ target is not calculated.
- DFM, Bornhuetter Ferguson, Cape Cod, and Result Selection methods can sync in
  either direction through their method output rows. ArcRho-to-ResQ rows are
  labeled `supported fields only`: they use the existing, deliberately partial
  ResQ writer (for example, BF supports one prior; Cape Cod scaling type and
  some collapsed modes are not reconstructed; DFM notes/formula definitions
  are not pushed). Missing required ResQ dependencies and unremovable Result
  Selection sources block the action before mutation.
- Berquist-Sherman Settlement Rate and Case Reserve Adequacy can import from
  ResQ into ArcRho only. ArcRho-to-ResQ creation/write-back is not supported.
- Bootstrap synchronization is not supported.

Unsupported actions are displayed but disabled. Duplicate normalized names are
`Ambiguous name`. Kind, data-format, Dataset Type, or method/output identity
disagreements are mismatch rows and are also disabled. Other examples include
a missing ArcRho sidecar or CSV cache, a ResQ Dataset Type unknown to ArcRho,
a method-coded output whose ResQ method object cannot be found, and a
calculated ResQ dataset that owns its recomputation.

## Apply and recovery boundaries

Only accepted logical rows are touched. For ResQ-to-ArcRho work, the macro
backs up the selected row's existing CSV, sidecar, and method JSON, deletes
only that selected logical target group, and delegates import to the canonical
ResQ migration writers. A failed row is restored from its temporary backup
when possible. Successful imports refresh sidecar dependency graphs, dependent
DFMs, and the reserving-class index while the reserving-class I/O lock and
durable lease are held.

The full selection is not a cross-database transaction. Each ResQ object is
saved independently, successful rows remain applied when another row fails,
and the macro cannot roll back an already saved ResQ object. ArcRho rollback is
limited to the selected logical artifacts captured before that row's import;
if rollback itself fails, the final summary reports both failures. Dependency
refresh warnings are reported but do not reverse completed imports. Baselines
are finalized only for successfully applied rows that are readable on both
sides afterward. For an ArcRho-to-ResQ method row, `Synchronized` means neither
side's timestamp changed since the accepted supported-field write; it is not a
claim that unsupported method fields are byte-for-byte equivalent.

## Runtime constraints

The macro uses `ResQ3Automation.ResQApplication` directly from the ArcRho
app-server process, using the configured ResQ connection and credentials. ResQ
and its COM automation runtime must therefore be installed and usable on the
machine running ArcRho, and that account must have permission to read and save
the selected ResQ project. This is not a Bridge-hosted operation for client PCs
without ResQ. The active ArcRho window must also have no unsaved dataset or
method changes before the interactive macro will proceed.

The shared macro publisher also copies the canonical migration Python runtime
to an immutable release under `E:\ArcRho Server\shared\python-api\releases`
and atomically switches `shared\python-api\current.json`. A Client PC loads
this read-only support bundle through its ArcRho Server mapping, so it does not
need the development repository. Publishing only the macro file without that
support bundle is incomplete.

For read-only automation, call `sync_reserving_class_with_resq(...)` without a
selection; it returns `review_required` and a serializable preview. Supplying
row IDs or a selection callback authorizes only those reviewed, enabled rows.
