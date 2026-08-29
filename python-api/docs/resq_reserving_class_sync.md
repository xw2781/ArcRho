# One-way ResQ reserving-class sync

The `Sync Reserving Class with ResQ` macro
(`python-api/macros/sync_reserving_class_with_resq.py`) compares one ArcRho
reserving class with the identically scoped ResQ data and pushes it one way,
from whichever side changed last.
The ArcRho project name is also used as the ResQ project name, and the selected
reserving-class path must exist in that project on both sides. The UI does not
offer a project or path mapping override.

## Review and timestamp rules

The macro inventories the logical datasets and method outputs of both sides,
pairing names case-insensitively after whitespace normalization, and reviews
only the items that exist on both. An item on one side only is not shown: a
new dataset or method reaches the other side through an import, not through
this review. Before any write, it opens a review table with type, logical
name, both timestamps, status, a review mark, and details, under a header that
names the class's direction and the two latest timestamps that decided it.

ResQ names can carry stray double spaces (`C 81 -  Prior Qtr Indicated`) and
they are left as they are. ArcRho keeps the normalized name, and every place a
ResQ name meets an ArcRho name — the review pairing, the preflight checks, the
read-back after a write, and the exporter's object lookups — goes through the
same whitespace-normalized, case-insensitive key, so each ResQ object maps
onto exactly one ArcRho item. The ResQ spelling is only ever used to address
the ResQ object or to name it in a message.

On the ArcRho side a method's timestamp is its last user Save
(`method_metadata.last_modified`). A propagation refresh records itself as
`data_refreshed` and leaves that stamp alone, for Result Selections as for
DFM, BF and Cape Cod, so a method ArcRho recomputed because one of its inputs
changed is never offered as an edit to push.

- `Unknown` means the item exists, but no usable last-modified timestamp was
  available. If ResQ exposes `Created` but not `Modified`, the table shows the
  created value for context as `Unknown Modified; Created ...`; it is not used
  to choose a direction.
- ArcRho normally uses the persisted dataset or method modified timestamp.
  Engine datasets prefer `source_modified`; if metadata has no usable value,
  the file modification time is shown and identified as `File modified`.
- ResQ uses the dataset or method-output object's `Modified` value. A missing
  `Modified` value never falls back to the current time.

## Direction

The whole reserving class is pushed one way. Each side's timestamp is the
latest usable modified timestamp among the items the review shows, and the
newer side is the source for every row (`resq_migration.sync.plan_direction`).
The review window's header shows both timestamps and the direction, and the
accept button reads `Sync to ResQ` or `Sync to ArcRho`. Matching or unknown
latest timestamps give no direction, so nothing is pushed.

A row is pushed when it changed on either side: on its first comparison, when
its two timestamps differ; afterwards, when either side moved from the
recorded baseline. `Same timestamp` and `Synchronized` rows are left alone, as
are rows with an unknown timestamp or an incomplete baseline; a matching
timestamp does not assert that the contents are identical. A row whose change
sits on the side being written over — `ResQ changed` or `Both changed` when
the class goes ArcRho to ResQ, and the reverse — is marked `Review`, because
that push overwrites an edit rather than delivering one. The mark is a caution
and never a block: the row stays ticked, and the user unticks it to keep that
side's copy. ResQ timestamps without an offset are treated as local wall-clock
time, so clock or timezone errors can affect a first-time comparison.

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

Every supported row starts ticked, marked for review or not. The user can
untick rows, accept, or cancel. Cancel and an empty accepted selection perform
no writes.

## Durable baseline and stale reviews

After a row succeeds and both sides can be inventoried with usable timestamps,
the macro atomically records both observed timestamps in a project-owned sync
state file under `sync/resq/`. Later comparisons use this durable baseline:

- neither side changed: report `Synchronized` and leave the row alone;
- one or both sides changed: push the row in the class's direction, marked
  `Review` when the changed side is the one being written over.

This paired baseline is what stops a push from bouncing back. ResQ's `Save()`
re-stamps every written object, so on the next run the class's latest
timestamp sits on the ResQ side, but every row compares as `Synchronized` and
nothing is pushed until someone edits. A run that ends
before its final baseline is recorded leaves no trace in the state file: the
next review simply compares the current timestamps against the last recorded
baseline, so an interrupted item shows up as the plain change it is.

The macro re-inventories selected rows after review and again after acquiring
the reserving-class locks. If any selected observation is stale — a timestamp
moved, or the class's direction flipped — it aborts before applying the batch
and asks the user to rerun the review. Every row is rechecked again immediately before its own write, against
the side it is written from: an ArcRho-to-ResQ row is refused when its ArcRho
source moved, a ResQ-to-ArcRho row when its ResQ source moved, and either when
an item changed identity or disappeared. The target side is allowed to move,
because the batch itself moves it: saving a DFM into ResQ makes ResQ
recalculate every Result Selection downstream of it, and an import refreshes
ArcRho's dependents, so a Result Selection written after the DFMs it depends
on is still written from the ArcRho copy the review showed.

After the batch, the review items downstream of what it wrote are baselined
too. Both systems recalculate a Result Selection, or a method whose input was
written, from the inputs the batch just synchronized and re-stamp it, so a
move between the batch's opening and closing observations on such an item is
the batch's own doing. The walk follows ArcRho's sidecar graph across the whole
reserving class, calculated datasets included, plus the links in the review
rows' method tabs; ResQ holds the same graph once the inputs match. The same
graph decides the write order, so a row that reads a calculated dataset is
written after the rows that dataset derives from. Only the
side that moved takes its closing timestamp, so a change that was already
pending before the batch stays pending, and an item with no baseline yet is
baselined only when it showed no difference before the batch. These items
appear in the results table as `Recalculated` rows; nothing is written for
them.

## Supported actions

- Ordinary ArcRho triangle/vector datasets can sync in either direction when
  their canonical metadata and CSV cache exist and the Dataset Type is known.
- Calculated datasets are left out of the review entirely, on both sides.
  Propagation recomputes them from their formula inputs in ArcRho and in
  ResQ alike and nobody edits them directly, so their timestamps only ever
  record the last propagation and there is nothing to reconcile.
- Engine-generated datasets are left out the same way: ArcRho rebuilds them
  through the Engine and ResQ through its own generator, so neither side holds
  a hand-edited copy. On the ArcRho side that is every `engine` sidecar; on the
  ResQ side it is every dataset whose Dataset Type is flagged `Generated` and
  whose name equals that type, the rule the import already uses to route a
  dataset to the Engine.
- DFM, Bornhuetter Ferguson, Cape Cod, and Result Selection methods can sync in
  either direction through their method output rows. ArcRho-to-ResQ rows are
  labeled `supported fields only`: they use the existing, deliberately partial
  ResQ writer (for example, BF supports one prior; Cape Cod scaling type and
  some collapsed modes are not reconstructed; DFM formula definitions are not
  pushed). Notes sync in both directions for every dataset and method. ArcRho
  keeps them in the sidecar — a dataset's own, or the output sidecar of a
  method, never the method JSON — so the inventory attaches the sidecar
  `notes` to each row whenever that sidecar is readable; the writer sets the
  ResQ `Notes` of the triangle, vector, or method with line breaks normalized
  to `\r\n` (an empty value clears them, an unreadable sidecar leaves them
  unchanged), and the read-back verification compares them like every other
  applied field. A ResQ-to-ArcRho row lands ResQ's Notes in the rewritten
  sidecar because the triangle, vector, and method readers all read them.
  Missing required ResQ dependencies and unremovable Result Selection sources
  block the action before mutation.
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
the sidecar `precedents` of the accepted rows — a dataset row's own sidecar,
a method row's output sidecar — so only rows in the same run reorder each
other.

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
sides afterward.

## Results table

When at least one row was accepted, the results open in the same Project
Instance review window the plan used, as a read-only table (`selectable:
false`, one `Close` button, no tick column): one row per written item in
write order, then one row per dependent-refresh warning. Each row shows the
type, logical name, an outcome of `Applied`, `Failed`, `Warning`, or
`Recalculated`, and the Bridge's message for that item; the header names the
run's one direction and gives the counts. A
`Recalculated` row is an item the writes made both systems recompute; its
baseline was updated and nothing was written. The macro keeps running until the
window is closed. A stale review or an empty selection applied nothing, so
those two outcomes stay a short message box. For an ArcRho-to-ResQ method row, `Synchronized` means neither
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

The queue client — request building, publication, the wait on the status
file, and the Bridge liveness preflight — is `arcrho_api.resq_sync_queue`,
which the `Export Reserving Class to ResQ` macro shares; the macro itself
keeps only the review table, the results table, and the flow between them.

Inside the ArcRho app neither half of that exchange crosses the share. The
request is published through the `resq_sync_request_publish` hosted
workspace mutation (`app_server.services.resq_sync_queue_service`), which
runs the same on-disk write on the Server PC through the Gateway and stamps
the acting user's login as the request's `UserName`; it is idempotent by
request id, so a response the client never saw cannot queue a second run.
Every poll of the status file is the hosted `bridge_worker_liveness` read,
which carries the status payload along with the worker heartbeats, so the
worker is judged from the same look the result comes from and thirty seconds
of silent looks abandon the wait. Only a script outside the app, where the
app server cannot be imported, writes and reads the queue files directly.

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

The same queue serves a third phase, `export`, which the Export macro
publishes: it takes the same lease and pushes the whole reserving class from
ArcRho with no review and no signature. See
[resq_reserving_class_export.md](resq_reserving_class_export.md).

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
