/*
Shared Data-tab grid placeholder.

Every dataset grid stands in one of three non-data states: a load is running, no
dataset is selected, or a load failed.  This module owns all three so that the
Dataset Viewer grid, the DFM Data/Ratios/Results grids, and the run controller
cannot drift into telling the user different stories about the same condition.

The loading state matters most on a Client PC, where project data lives on a
network drive and a first paint can trail the window by several seconds.  A bare
"No dataset loaded." sentence claims the load already finished and found
nothing, so the placeholder renders a skeleton of the grid that is on its way
instead, and only names the wait once it is long enough for the user to notice.

Phase state lives on the shared dataset state object rather than in module
scope, so hosts that import this module through different cache-busted URLs
still observe one placeholder phase.
*/

import { state } from "/ui/shared/dataset/dataset_state.js";
import {
  formatDatasetOriginLabel,
  normalizeDatasetOriginLength,
} from "/ui/shared/dataset/dataset_origin_labels.js";

const PLACEHOLDER_CLASS = "dsGridPlaceholder";
const DEFAULT_SKELETON_ROWS = 8;
const DEFAULT_SKELETON_COLUMNS = 8;
// A skeleton is a preview, not a rehearsal of the whole grid: past this size it
// costs real paint time without telling the user anything new.
const MAX_SKELETON_ROWS = 16;
const MAX_SKELETON_COLUMNS = 14;
// Cell bars imitate numbers of differing magnitude so the preview reads as data
// rather than as a uniform gray block.
const SKELETON_BAR_WIDTHS = [86, 62, 74, 52, 92, 68];

const DEFAULT_LOADING_MESSAGE = "Loading dataset";
const DEFAULT_EMPTY_TITLE = "No Dataset Loaded";
const DEFAULT_EMPTY_HINT = "Select a project, reserving class, and dataset to load data.";
const DEFAULT_ERROR_TITLE = "Load Failed";

function placeholderState() {
  if (!state.gridPlaceholder || typeof state.gridPlaceholder !== "object") {
    state.gridPlaceholder = {
      phase: "loading",
      pending: new Set(),
      nextToken: 1,
      startedAt: 0,
      message: "",
      title: "",
      hint: "",
    };
  }
  if (!(state.gridPlaceholder.pending instanceof Set)) {
    state.gridPlaceholder.pending = new Set();
  }
  return state.gridPlaceholder;
}

/*
The phase a host should paint right now.

The starting phase is "loading" so the first paint of a window that is already
fetching is a skeleton rather than a claim that nothing is there.  A host that
renders before any load was ever registered has nothing on the way, though, so
it gets the empty state instead of a skeleton for a dataset nobody requested.
*/
function resolvedPhase() {
  const placeholder = placeholderState();
  if (placeholder.phase !== "loading") return placeholder.phase;
  if (!placeholder.pending.size && !placeholder.startedAt) return "empty";
  return "loading";
}

export function isDatasetGridLoading() {
  return resolvedPhase() === "loading";
}

export function getDatasetGridPlaceholderPhase() {
  return resolvedPhase();
}

/*
Register an in-flight dataset load.

Loads overlap: a boot sequence schedules a run, a run ends by loading the
dataset it produced, and a queued run can start before the previous one has
settled.  Tokens are counted rather than toggled so the skeleton survives every
handoff between them and disappears exactly once, when nothing is left running.
*/
export function beginDatasetGridLoading(options = {}) {
  const placeholder = placeholderState();
  const token = placeholder.nextToken++;
  if (!placeholder.pending.size) placeholder.startedAt = performance.now();
  placeholder.pending.add(token);
  const message = String(options?.message || "").trim();
  if (message) placeholder.message = message;
  // A new attempt outdates whatever the previous one concluded.
  placeholder.title = "";
  placeholder.hint = "";
  placeholder.phase = "loading";
  refreshMountedPlaceholders();
  return token;
}

/*
Release a load registration.

Once the last one goes, nothing is arriving any more, so the phase must not stay
on "loading": a later render with no model would otherwise show a skeleton for a
dataset nobody is fetching. A caller that knows why the load settled without
data (nothing selected, request failed) has already recorded that; this only
supplies the neutral empty state for the rest.
*/
export function endDatasetGridLoading(token) {
  const placeholder = placeholderState();
  if (token !== undefined && token !== null) placeholder.pending.delete(token);
  if (placeholder.pending.size) return;
  placeholder.message = "";
  if (placeholder.phase === "loading") {
    placeholder.phase = "empty";
    placeholder.title = DEFAULT_EMPTY_TITLE;
    placeholder.hint = DEFAULT_EMPTY_HINT;
  }
  refreshMountedPlaceholders();
}

export function setDatasetGridEmpty(options = {}) {
  const placeholder = placeholderState();
  placeholder.phase = "empty";
  placeholder.title = String(options?.title || "").trim() || DEFAULT_EMPTY_TITLE;
  placeholder.hint = Object.prototype.hasOwnProperty.call(options, "hint")
    ? String(options.hint || "").trim()
    : DEFAULT_EMPTY_HINT;
  refreshMountedPlaceholders();
}

export function setDatasetGridError(message, options = {}) {
  const placeholder = placeholderState();
  placeholder.phase = "error";
  placeholder.title = String(options?.title || "").trim() || DEFAULT_ERROR_TITLE;
  placeholder.hint = String(message || "").trim() || "The dataset could not be loaded.";
  refreshMountedPlaceholders();
}

function resolveOriginLength() {
  return normalizeDatasetOriginLength(document.getElementById("originLenSelect")?.value, 12);
}

function clampCount(value, fallback, max) {
  const count = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(count) || count <= 0) return fallback;
  return Math.min(count, max);
}

/*
Shape of the preview.

Labels already resolved by an earlier load or by the headers service are reused,
so a reload previews the grid the user is actually waiting for and the swap to
live values shifts almost nothing.  Without them the preview falls back to a
plain triangle, which is what a first open of an unknown dataset is most likely
to become.
*/
function resolveSkeletonShape(options = {}) {
  const originLabels = Array.isArray(state.headerLabels) ? state.headerLabels : [];
  const devLabels = Array.isArray(state.devHeaderLabels) ? state.devHeaderLabels : [];
  const rows = clampCount(
    options.rows ?? originLabels.length,
    DEFAULT_SKELETON_ROWS,
    MAX_SKELETON_ROWS,
  );
  const columns = clampCount(
    options.columns ?? devLabels.length,
    DEFAULT_SKELETON_COLUMNS,
    MAX_SKELETON_COLUMNS,
  );
  const shape = String(options.shape || (columns === 1 ? "vector" : "triangle"));
  return {
    rows,
    columns,
    shape,
    originLabels: originLabels.length >= rows ? originLabels.slice(0, rows) : [],
    devLabels: devLabels.length >= columns ? devLabels.slice(0, columns) : [],
  };
}

function isSkeletonCellFilled(shape, rowIndex, columnIndex) {
  if (shape.shape !== "triangle") return true;
  // A loss triangle loses one development column per newer origin period.
  return columnIndex < Math.max(1, shape.columns - rowIndex);
}

function appendSkeletonBar(cell, widthPercent, options = {}) {
  const bar = document.createElement("span");
  bar.className = "dsGridSkeletonBar";
  if (options.centered) bar.classList.add("dsGridSkeletonBarCentered");
  bar.style.width = `${widthPercent}%`;
  cell.appendChild(bar);
}

function buildSkeletonTable(options = {}) {
  const shape = resolveSkeletonShape(options);
  const originLen = resolveOriginLength();
  const table = document.createElement("table");
  table.className = "arSpreadsheetTable dsGridSkeletonTable";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const corner = document.createElement("th");
  if (options.cornerLabel) corner.textContent = String(options.cornerLabel);
  else appendSkeletonBar(corner, 70, { centered: true });
  headRow.appendChild(corner);

  for (let c = 0; c < shape.columns; c += 1) {
    const th = document.createElement("th");
    if (shape.devLabels.length) th.textContent = String(shape.devLabels[c] ?? "");
    else appendSkeletonBar(th, 42, { centered: true });
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (let r = 0; r < shape.rows; r += 1) {
    const row = document.createElement("tr");
    const rowHeader = document.createElement("th");
    if (shape.originLabels.length) {
      rowHeader.textContent = formatDatasetOriginLabel(shape.originLabels[r], originLen);
    } else {
      appendSkeletonBar(rowHeader, 56, { centered: true });
    }
    row.appendChild(rowHeader);

    for (let c = 0; c < shape.columns; c += 1) {
      const cell = document.createElement("td");
      if (isSkeletonCellFilled(shape, r, c)) {
        appendSkeletonBar(cell, SKELETON_BAR_WIDTHS[(r * 3 + c) % SKELETON_BAR_WIDTHS.length]);
      } else {
        cell.className = "dsGridSkeletonCellBlank";
      }
      row.appendChild(cell);
    }
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  return table;
}

function startElapsedTicker(root, elapsedEl) {
  const placeholder = placeholderState();
  const tick = () => {
    if (!root.isConnected || root.dataset.phase !== "loading") return;
    const seconds = Math.max(0, (performance.now() - placeholder.startedAt) / 1000);
    elapsedEl.textContent = `${seconds.toFixed(1)}s`;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function buildLoadingNote(root) {
  const placeholder = placeholderState();
  const note = document.createElement("div");
  note.className = "dsGridPlaceholderNote dsGridPlaceholderNoteLoading";
  note.setAttribute("role", "status");
  note.setAttribute("aria-live", "polite");

  const text = document.createElement("span");
  text.className = "dsGridPlaceholderNoteText";
  text.textContent = `${placeholder.message || DEFAULT_LOADING_MESSAGE}...`;
  note.appendChild(text);

  const elapsed = document.createElement("span");
  elapsed.className = "dsGridPlaceholderElapsed";
  note.appendChild(elapsed);
  startElapsedTicker(root, elapsed);

  return note;
}

/*
Empty text is host-specific: the Data grid asks for a dataset selection, while a
derived grid asks for the dataset its calculation reads.  A host may supply both
strings; a failure message always comes from whoever observed the failure.
*/
function buildStaticNote(phase, options = {}) {
  const placeholder = placeholderState();
  const note = document.createElement("div");
  note.className = "dsGridPlaceholderNote";
  if (phase === "error") note.classList.add("dsGridPlaceholderNoteError");

  const hostTitle = phase === "empty" ? String(options?.emptyTitle || "").trim() : "";
  const title = document.createElement("div");
  title.className = "dsGridPlaceholderTitle";
  title.textContent = hostTitle
    || placeholder.title
    || (phase === "error" ? DEFAULT_ERROR_TITLE : DEFAULT_EMPTY_TITLE);
  note.appendChild(title);

  const hostHint = phase === "empty" ? String(options?.emptyHint || "").trim() : "";
  const hint = hostHint || String(placeholder.hint || "").trim();
  if (hint) {
    const hintEl = document.createElement("div");
    hintEl.className = "dsGridPlaceholderHint";
    hintEl.textContent = hint;
    note.appendChild(hintEl);
  }
  return note;
}

function placeholderSignature(phase) {
  const placeholder = placeholderState();
  return [phase, placeholder.message, placeholder.title, placeholder.hint].join(" ");
}

/*
Paint the placeholder that matches the current phase into a grid host.

The rendered node keeps its own options and signature so a later phase change
can repaint it without the host having to re-run its own render path.
*/
export function renderDatasetGridPlaceholder(host, options = {}) {
  if (!host) return null;
  const phase = resolvedPhase();
  const root = document.createElement("div");
  root.className = PLACEHOLDER_CLASS;
  root.dataset.phase = phase;
  root.dataset.options = JSON.stringify(options || {});
  root.dataset.signature = placeholderSignature(phase);

  if (phase === "loading") {
    const grid = document.createElement("div");
    grid.className = "dsGridSkeleton";
    grid.setAttribute("aria-hidden", "true");
    grid.appendChild(buildSkeletonTable(options));
    root.appendChild(grid);
    root.appendChild(buildLoadingNote(root));
  } else {
    root.appendChild(buildStaticNote(phase, options));
  }

  host.replaceChildren(root);
  return root;
}

function refreshMountedPlaceholders() {
  const phase = resolvedPhase();
  const signature = placeholderSignature(phase);
  for (const node of Array.from(document.querySelectorAll(`.${PLACEHOLDER_CLASS}`))) {
    if (node.dataset.signature === signature) continue;
    const host = node.parentElement;
    if (!host) continue;
    let options = {};
    try {
      options = JSON.parse(node.dataset.options || "{}");
    } catch {
      options = {};
    }
    renderDatasetGridPlaceholder(host, options);
  }
}
