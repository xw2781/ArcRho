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

## Timestamps and time zones

The same instant is written three ways along the sync path, and reading two of
them side by side has repeatedly looked like a four-hour error. It is not one;
the four hours are the Server PC's UTC offset (Eastern Daylight Time is UTC−4).

- **ResQ keeps a local wall-clock reading** and its windows show it as such:
  `8/13/2026 2:49:34 PM`. COM hands the same value back as a datetime labelled
  UTC, which is false; `resq_migration.core._iso_or_text` drops the label and
  reads the value in the Server PC's zone. That is one reason the migration and
  the Bridge run on the Server PC — a client in another zone would move every
  ResQ timestamp by the difference.
- **ArcRho persists every time in UTC** with a `Z` suffix, the one rule in
  `arcrho_api.timestamps`: the ResQ reading above is stored as
  `2026-08-13T18:49:34.302Z`. Method and sidecar JSON, the sync state file, and
  the preview signatures all hold that form or its epoch seconds.
- **The review table shows local time** in the app's list format, produced by
  `arcrho_api.timestamps.format_display_timestamp` for both columns, so a row
  reads the same as ResQ's window and the ArcRho method list. The comparison
  runs on epoch seconds and never on the displayed text.

A genuine zone error has a signature: the difference is exactly the offset, and
a row synchronized moments ago reports `ResQ changed` or `Both changed` on the
very next preview with no edit in between. Check the epoch values in the
`sync/resq/` state file against the persisted `last_modified` before changing
any conversion. The 2026-08-26 report (`18:49:34` shown for ResQ's `2:49:34 PM`)
failed that test: the baseline was recorded on 2026-08-12 at 10:36 PM, ResQ's
method really was saved on 2026-08-13 at 2:49 PM, and the ArcRho method had
been rewritten by that evening's import, so `Both changed; ArcRho newer` was
the correct verdict and only the rendering was misleading.

Note that an import from ResQ stamps the ArcRho method with the time of the
import, not ResQ's `Modified`, and records no sync baseline. The next preview
therefore reports the imported row as `ArcRho changed` (or `Both changed` when
ResQ had moved since the last baseline) although its content came from ResQ.
That is a baseline gap, not a timezone error.

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
review. Every row is rechecked again immediately before its own write; a row
that an earlier write in the batch changed fails individually instead of
using an old plan.

## Supported actions

- Ordinary ArcRho triangle/vector datasets can sync in either direction when
  their canonical metadata and CSV cache exist and the Dataset Type is known.
- Calculated datasets are left out of the review entirely, on both sides.
  Propagation recomputes them from their formula inputs in ArcRho and in
  ResQ alike and nobody edits them directly, so their timestamps only ever
  record the last propagation and there is nothing to reconcile.
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
and a method-coded output whose ResQ method object cannot be found.

## Write order

Accepted rows are written one at a time. ArcRho-to-ResQ rows go first, then
ResQ-to-ArcRho rows, and within each direction the rows follow ArcRho's own
dependency graph: a DFM comes after its input triangle, a BF or Cape Cod
method after the DFM output and priors it links, and a Result Selection after
every source it loads. Rows with no link between them keep the review-table
order, datasets before methods. The graph is read from the method tabs and
any sidecar `precedents` of the accepted rows, so only rows in the same run
reorder each other.

A method whose linked dataset is created earlier in the same run passes
preflight on that promise; the strict check runs again right before the row
is written, so an input that failed still blocks every row that reads it.

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

ResQ automation exists only where ResQ itself is installed, which is usually not
the machine ArcRho runs on. The macro therefore owns no ResQ session: it
publishes logical requests to the shared Bridge queue under
`requests\RPC bridgeesq_reserving_class_sync\`, and a ResQ-connected ArcRho
Bridge worker runs the canonical session
(`python-api/migration/resq_migration/sync_session.py`) on its behalf. Any
Client PC can therefore synchronize, provided some machine is running ResQ with
ArcRho open; the macro refuses before publishing anything when no ResQ-connected
worker heartbeat is live, and says so rather than failing on a COM error.

The queue carries logical identifiers only. The server root, queue folders, and
status path are derived by each side from its own ArcRho Server root, so no
producer-local mapped-drive path is ever accepted. Progress and the terminal
result are published to `statuses\<RequestId>.json`, which the macro polls.

The session runs in two phases, one request each:

- `preview` is read-only. It returns the review rows together with the
  `signature` of each observation.
- `apply` receives the accepted rows *with those signatures*, takes the same
  reserving-class job lease a ResQ import takes -- so a synchronization and an
  import can never write one reserving class at the same time -- and writes only
  when every reviewed signature still matches a freshly observed plan. Because
  the reviewed signature travels with the request, a change made while the
  review table was open is caught; the old single-process macro could only
  compare two observations taken seconds apart inside one call.

The Bridge runs its frozen copy of the session and of the ResQ exporter
(`arcrho_bridge/bundled_sources.py` owns that list), so an edit to either has no
effect on a synchronization until the Bridge is rebuilt and redeployed. The
worker refuses a bundle whose `SYNC_SESSION_API_VERSION` it was not built
against rather than driving it.

The session connects to ResQ with the shared service account from the server
`config.json` (`resq.connection_name`, `resq.user_name`, `resq.password`),
handed in through `build_runtime`, never with the worker's own Windows
identity. Bridge workers run one per signed-in user session and whichever
claims a request first runs it, so a session that connected as the claiming
user saw that user's ResQ projects: a project another user owned came back as
`ResQ project not found` from one worker and synchronized normally from the
next.

The active ArcRho window must have no unsaved dataset or method changes before
the interactive macro will proceed.

For read-only automation, call `resq_migration.sync_session.preview_sync(...)`;
`apply_sync(...)` authorizes only the reviewed rows handed to it, each with the
signature the preview reported.
