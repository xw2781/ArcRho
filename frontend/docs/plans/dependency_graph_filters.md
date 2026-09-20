# Dependency Graph Chain Filters

Status: implemented, 2026-09-20. The [interactive prototype](../ui/dependency_graph_filters.html)
uses synthetic data and is not connected to project files. This Markdown file
records the behavior; the prototype illustrates it. Production controls now
replace `pi-dependency-graph-cue` in the existing toolbar. Persisted data is unchanged.

The user confirmed that one dataset must satisfy all selected fields.
See the [rendered preview](../ui/dependency_graph_filters.png).

## Interaction

Replace the interaction cue in the existing graph toolbar with compact controls:

`Status: All   Category: All   Method Type: All   Clear filters`

**Show matched items only** is checked by default. With active filters, it
shows only matching datasets; unchecking includes their dependency context.
Without active filters, both settings show all connected indexed datasets.
The checkbox and the three field selections are remembered for this Windows
user on this PC and restored when a graph opens, including after app restarts.
They apply across projects; already-open graph windows keep their own state.

Each field uses the PI dataset table's shared filter menu: a title, Type to
search box, All checkbox, and compact value checkboxes. Search narrows the
choices, changes apply immediately, and right-click excludes that value by
selecting every other value. All or an empty selection removes that field's
restriction. Clear filters resets the three fields together and saves the reset.
The trigger displays its one selected value, or a count when several are
selected. Long values truncate in the trigger and remain readable in the
popover. Only one popover is open at a time.

| Field | Choices | Meaning |
| --- | --- | --- |
| Status | Updated, Needs Review | Persisted review status of the dataset or method output. |
| Category | Distinct categories in the indexed class; Uncategorized for blank values | The category the PI dataset table displays. |
| Method Type | Distinct method types in the indexed class; None for datasets without a method | The owning method, such as DFM or Result Selection, rather than the graph's visual family. |

Choices come from indexed nodes with at least one precedent or dependent,
independent of the other filters. Keep a selected value that has disappeared
in the menu until the user clears it;
never silently broaden the filter after a refresh.

## Matching and chain context

1. Exclude all nodes outside `index.json` and their edges, then always hide
   nodes with neither precedents nor dependents, including method outputs.
2. A dataset is a **match** when it satisfies every active field. Values within
   one field use OR; different fields use AND on that same dataset.
3. By default, display only matches. When Show matched items only is unchecked,
   include the union of their transitive precedents and transitive dependents.
   Compute both traversals from the original matches; do not recursively expand
   the context into the entire connected component.
4. Keep original edges whose endpoints both remain visible. In matched-only
   mode, connect matches through hidden intermediate nodes with dashed indirect
   arrows, stopping at the next visible match. Prefer a direct edge when both
   paths exist, deduplicate links, and do not connect sibling branches.
5. Hide unrelated nodes and relayout the visible graph. Match counts count
   datasets, not chains, because chains can overlap or converge.

For example, Needs Review + Loss + DFM matches a Loss-category DFM output
whose persisted status needs review. With Show matched items only unchecked,
its Updated inputs and downstream Result Selection remain visible as context.
Another DFM feeding the same Result Selection is outside the focus unless
it is itself an ancestor, descendant, or match. A visible node with edges to
hidden nodes shows an `N hidden links` cue; existing port lists should
report that count alongside the visible links so a partial graph cannot look
like a complete input list.

Selecting Loss and Premium together means either category. Selecting Needs
Review and DFM does not match a chain merely because one dataset needs review
and a different dataset somewhere along it is a DFM.

## Presentation

- Keep the current compact pale canvas, family accents, and graph geometry.
  Cards do not show filter-value labels. Matching datasets and nonmatching
  chain context use the same normal card emphasis.
- Cards retain their normal fill. Needs Review uses the PI dataset table's
  shared yellow warning triangle before the family text, independently of
  active filters or whether the card matches them. Clearing filters preserves
  review glyphs. Selection/search keep their existing border highlights.
- Report `2 matches · 5 context datasets · 6 hidden · 5 links` in the status line.
  The hidden count covers indexed nodes excluded from this focused view only.
- With no matches, retain the controls and show `No datasets match these
  filters` with a Clear filters action. Do not display the whole graph as a
  fallback. An empty indexed class keeps its existing empty-class message.
- On narrow windows, wrap the controls above the canvas and retain their
  labels. Popovers stay within the viewport, scroll vertically, and keep
  checkbox text readable.

## Existing controls and refresh

- **Connected datasets:** always hide nodes with neither precedents nor
  dependents, even when their metadata matches. Keep chain endpoints that
  have either inputs or dependents in the original indexed graph. A matching
  endpoint stays eligible when its neighbors are hidden by filters. There is
  no Show all control.
- **Find a dataset:** keep its present role as a name highlighter within the
  visible graph. It does not change which datasets match the metadata filters.
  Label it `Find in view` while focus is active to make its scope apparent.
- **Click and open:** preserve the current chain highlight and dataset/method
  opening behaviors. Filters do not dim chain context; selection and search
  retain their existing highlighting.
  A selected node that leaves the view is deselected. Clicking a context node
  does not expand the filter into neighboring branches.
- **Context menu:** Set Reviewed signs off a review-needed method output in the
  graph's pinned class. View in Dataset Table reveals and selects the exact row
  in PI, opening its group and removing blocking table filters, then minimizes
  the graph. Failures remain visible without losing the graph.
- **Viewport:** after an explicit filter change, fit the resulting graph once.
  Refresh reapplies the same filters and preserves pan/zoom, as today. Fit
  remains available if changed data moves the graph outside the current view.
- **Lifetime:** selections survive refresh and minimize/restore. Each change
  immediately saves the three filters and matched-only choice through
  `dependency_graph_preferences.js` to local-user browser storage under
  `arcrho_dependency_graph_filters`. A new graph restores the last saved choices;
  first use defaults to All and matched-only checked. PI table preferences and
  already-open graph windows are independent. No project files are modified.
- **Keyboard:** Enter/Space opens a trigger and focuses search; Tab reaches
  All, the value checkboxes, and Clear filters,
  and Space toggles a value. Escape closes the open filter and restores focus
  to its trigger before existing graph Escape behavior runs. Outside click
  closes the popover. Announce updated counts through the existing live status.

## Data ownership and implementation

The existing [graph service](../../app_server/services/dataset_dependency_graph_service.py)
projects `status`, `method_type`, the stored `dataset_category`, and a
`dataset_type_category` presentation field on each indexed node. It does not
modify or enrich persisted `index.json`.

The PI table resolves category from the instance's stored `dataset_category`
(or its existing category alias), otherwise its project Dataset Type category
(`getDatasetRecordCellValue`, category case, in
[the table controller](../../ui/project_instance/project_instance_dataset_table.js)).
Both consumers use [dataset_category.js](../../ui/shared/dataset/dataset_category.js)
for this resolution. The hosted graph service reads one Dataset Types snapshot
for every nonempty class, sharing it with engine-formula hydration.

Use [review_status.js](../../ui/shared/dataset/review_status.js) for persisted
status normalization and comparison. The PI table's Excel-link freshness
observation is separate from persisted review status and is not included in
this filter. Explain that scope in the Status popover's help text.

Use the graph's existing canonical method type values and the same display
label mapping as PI, including Berquist-Sherman labels. Do not encode method
types as a new static list; None remains a selectable value.

Keep filtering and traversal in a small pure `dependency_graph_filters.js`
module and popover state/binding in a separate controller. Two independent
multi-source walks compute context, visiting each edge once per direction;
`pruneDependencyGraph` and `layoutDependencyGraph` build the visible view.
The current window controller already exceeds 1,000 lines; avoid growing it
with filter mechanics. Preserve the hosted graph read and make filter clicks
entirely local: no request per value or per node.

Adding category to the response requires coordinated service, renderer, tests,
and domain-document updates, but no index schema or producer-parity change.
The graph read requires the Gateway on Client PCs and reports its failures
without falling back to SMB. Server processes keep the canonical local read.
Service changes require the repository's server-component deployment workflow.

## Acceptance cases

- Show matched items only starts checked and hides nonmatching cards. Unchecking
  restores their predecessors and successors at normal emphasis. Refresh keeps
  the checkbox state; clearing filters shows all connected indexed nodes and
  persists the cleared selections.
- Dashed indirect links preserve paths through hidden nodes without connecting
  sibling branches or skipping another visible match; cycles terminate.
- Multiple categories use OR; Status + Category + Method Type use same-node AND.
- A sibling branch at a merge does not leak into the focus; hidden-link counts
  explain the omitted connections.
- Overlapping chains draw shared nodes and edges once; cycles terminate.
- An isolated matching dataset or method output stays hidden, including after
  Clear or refresh. A non-method endpoint with precedents remains visible.
- None and Uncategorized are selectable, and an unmatched combination shows
  the filter-specific empty state.
- Neither filtering nor Clear restores an unindexed or isolated dataset.
- Search, node selection, opening, refresh, and keyboard dismissal retain the
  behaviors above. Selected values removed by refresh retain a zero count.
- Category agrees with the PI table, including project-type resolution; filter
  changes make no network or disk request.

## Prototype coverage

The prototype implements checkbox filters, same-node matching, directional
chain context, visible counts, hidden-link cues, Find in view,
selection details, and the empty state using an invented class. It opens
with Needs Review + DFM selected to illustrate the behavior. Production
restores the user's last choices, or starts unrestricted on first use. The
prototype uses the production filter controls without saving preferences.
Serve the standalone prototype over
HTTP so it can import the shared PI status glyph;
live refresh, window hosting, pan/zoom, port menus, review/table actions, and opening real datasets
remain the existing production window's responsibilities.
