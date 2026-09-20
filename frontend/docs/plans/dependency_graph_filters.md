# Dependency Graph Chain Filters

Status: proposed design, 2026-09-20. The [interactive prototype](../ui/dependency_graph_filters.html)
uses synthetic data and is not connected to project files. This Markdown file
owns the proposed behavior; the prototype illustrates it. No production code
or persisted-data contract changes are included in this design task.

The user confirmed that one dataset must satisfy all selected fields.
See the [rendered preview](../ui/dependency_graph_filters.png).

## Interaction

Add one compact filter row beneath the existing graph toolbar:

`Status: All   Category: All   Method Type: All   Clear filters`

Each field opens a checkbox popover. Users can select multiple values, with
changes applied immediately. An empty selection means All; Clear inside a
popover resets that field. Clear filters resets the three fields together.
The trigger displays its one selected value, or a count when several are
selected. Long values truncate in the trigger and remain readable in the
popover. Only one popover is open at a time.

| Field | Choices | Meaning |
| --- | --- | --- |
| Status | Updated, Needs Review | Persisted review status of the dataset or method output. |
| Category | Distinct categories in the indexed class; Uncategorized for blank values | The category the PI dataset table displays. |
| Method Type | Distinct method types in the indexed class; None for datasets without a method | The owning method, such as DFM or Result Selection, rather than the graph's visual family. |

Choices and counts come from the full indexed graph, independent of the other
filters. Counts mean datasets with that value, not complete chains or the
number that another click would add. Refresh updates counts. Keep a selected
value that has disappeared visible with count zero until the user clears it;
never silently broaden the filter after a refresh.

## Matching and chain context

1. Exclude all nodes outside `index.json` and their edges, as the window does now.
2. A dataset is a **match** when it satisfies every active field. Values within
   one field use OR; different fields use AND on that same dataset.
3. Display the matches plus the union of their transitive precedents and
   transitive dependents. Compute both traversals from the original matches.
   Do not recursively expand the context into the entire connected component.
4. Keep original edges whose endpoints both remain visible; do not invent
   shortcut edges across hidden datasets. Deduplicate shared nodes and links.
5. Hide unrelated nodes and relayout the visible graph. Match counts count
   datasets, not chains, because chains can overlap or converge.

For example, Needs Review + Loss + DFM matches a Loss-category DFM output
whose persisted status needs review. Its Updated inputs and downstream
Result Selection remain visible as context even though they do not match.
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
  Give direct matches a small **Match** tag and an accent border. Keep context
  nodes readable with their existing family styles; do not gray out the very
  dependencies the user is trying to follow.
- Keep review status visible independently of Match. Color alone must not
  convey status or matching. A small legend explains Match versus Chain Context.
- Report `2 matches · 5 context datasets · 6 hidden · 5 links` in the status line.
  The hidden count covers indexed nodes excluded from this focused view only.
- With no matches, retain the controls and show `No datasets match these
  filters` with a Clear filters action. Do not display the whole graph as a
  fallback. An empty indexed class keeps its existing empty-class message.
- On narrow windows, wrap the controls above the canvas and retain their
  labels. Popovers stay within the viewport, scroll vertically, and keep
  checkbox text readable.

## Existing controls and refresh

- **Show all:** with no active filters, retain today's rule for unused datasets.
  While filters are active, temporarily disable Show all and include every
  matching dataset, even an unused one. Retain the checkbox's previous state
  and restore it when filters clear. It never restores unindexed datasets.
- **Find a dataset:** keep its present role as a name highlighter within the
  visible graph. It does not change which datasets match the metadata filters.
  Label it `Find in view` while focus is active to make its scope apparent.
- **Click and open:** preserve the current chain highlight and dataset/method
  opening behaviors. Match tags remain visible during selection highlighting.
  A selected node that leaves the view is deselected. Clicking a context node
  does not expand the filter into neighboring branches.
- **Viewport:** after an explicit filter change, fit the resulting graph once.
  Refresh reapplies the same filters and preserves pan/zoom, as today. Fit
  remains available if changed data moves the graph outside the current view.
- **Lifetime:** selections belong to this graph window in memory, survive its
  refresh and minimize/restore, and reset on close. They are independent of PI
  table filters and other reserving-class windows. No preference storage is added.
- **Keyboard:** Enter/Space opens a trigger, Tab reaches checkboxes and Clear,
  and Space toggles a value. Escape closes the open filter and restores focus
  to its trigger before existing graph Escape behavior runs. Outside click
  closes the popover. Announce updated counts through the existing live status.

## Data ownership and implementation

The existing [graph service](../../app_server/services/dataset_dependency_graph_service.py)
already projects `status` and `method_type`. Its response currently omits
category, so add a scalar `dataset_category` presentation field to each indexed
node. Do not modify or enrich persisted `index.json`.

The PI table resolves category from the instance's stored `dataset_category`
(or its existing category alias), otherwise its project Dataset Type category
(`getDatasetRecordCellValue`, category case, in
[the table controller](../../ui/project_instance/project_instance_dataset_table.js)).
The graph must use the same resolution. Extract that projection into a shared
owner consumed by the table and graph instead of introducing a second rule;
resolve project type data once per hosted request, sharing the existing
Dataset Types snapshot with engine-formula hydration where applicable.

Use [review_status.js](../../ui/shared/dataset/review_status.js) for persisted
status normalization and comparison. The PI table's Excel-link freshness
observation is separate from persisted review status and is not included in
this filter. Explain that scope in the Status popover's help text.

Use the graph's existing canonical method type values and the same display
label mapping as PI, including Berquist-Sherman labels. Do not encode method
types as a new static list; None remains a selectable value.

Keep filtering and traversal in a small pure `dependency_graph_filters.js`
module and popover state/binding in a separate controller. Reuse
`dependencyGraphReach`, `pruneDependencyGraph`, and `layoutDependencyGraph`.
The current window controller already exceeds 1,000 lines; avoid growing it
with filter mechanics. Preserve the hosted graph read and make filter clicks
entirely local: no request per value or per node.

Adding category to the response requires coordinated service, renderer, tests,
and domain-document updates, but no index schema or producer-parity change.
Production implementation will require the repository's server-component
deployment workflow after validation. This design-only change requires no rebuild.

## Acceptance cases for implementation

- Needs Review + DFM retains nonmatching predecessors and successors.
- Multiple categories use OR; Status + Category + Method Type use same-node AND.
- A sibling branch at a merge does not leak into the focus; hidden-link counts
  explain the omitted connections.
- Overlapping chains draw shared nodes and edges once; cycles terminate.
- An unused matching dataset appears while Show all is unchecked.
- None and Uncategorized are selectable, and an unmatched combination shows
  the filter-specific empty state.
- Neither filtering nor Clear nor Show all restores an unindexed dataset.
- Search, node selection, opening, refresh, and keyboard dismissal retain the
  behaviors above. Selected values removed by refresh retain a zero count.
- Category agrees with the PI table, including project-type resolution; filter
  changes make no network or disk request.

## Prototype coverage

The prototype implements checkbox filters, same-node matching, directional
chain context, visible counts, hidden-link cues, Find in view, Show all,
selection details, and the empty state using an invented class. It opens
with Needs Review + DFM selected to illustrate the behavior. Production
would open with all three fields unrestricted. The prototype is standalone;
live refresh, window hosting, pan/zoom, port menus, and opening real datasets
remain the existing production window's responsibilities.
