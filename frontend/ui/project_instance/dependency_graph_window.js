// Dependency Graph page.
//
// This runs inside a Project Instance nested window (pi-window). The host frame
// in project_instance_windows.js owns the titlebar, dragging, resizing,
// minimize/maximize/close and the dock; this page owns the diagram: every
// dataset and method output of one reserving class as a box, every precedent
// as an arrow into what reads it. The window is pinned to the reserving class
// it was opened on, which arrives in the query string, so selecting another
// class in the tree leaves it alone exactly like a Dataset or DFM window.
//
// The whole graph is one hosted read (/datasets/dependency-graph); the layout
// is computed here from dependency_graph_layout.js. A dataset nothing depends
// on is left out by default and comes back with the Show all box. A single
// click selects a box and keeps its chain lit - inputs in blue, what depends
// on it in green, everything else dimmed - until another box is selected or
// the background is clicked; a double click, and the right-click menu, ask the
// Project Instance page to open it - a dataset in Dataset Viewer, a method
// output in its method page - through the same
// arcrho:project-instance-open-dependent-dataset message a method page uses
// for a precedent. Opening a box never disturbs the lit chain: the right-click
// menu leaves the selection alone, and a double click puts back whatever its
// own first click replaced. Hovering a box scrolls a name too long to fit
// through its own line, and reveals two ports on the box's edges: the left one
// lists the box's precedents, the right one its dependents, and each name in
// the list scrolls the diagram to that box.
//
// The diagram pans inside a scrolling canvas that draws no scrollbars: the SVG
// is sized to the zoomed graph plus half a canvas of margin on every side, so
// a box on any edge can be dragged to the middle of the window, and dragging
// the background, the wheel, and a jump from the port list all move the
// canvas's scroll offsets. The host posts
// arcrho:dependency-graph-refresh whenever it reloads its own dataset table
// from disk, so the diagram follows a save, a delete, or an import without a
// manual refresh.
import { openContextMenu } from "/ui/shared/components/context_menu/context_menu.js?v=20260811b";
import { attachArcrhoTooltip } from "/ui/shared/components/tooltip/tooltip.js?v=20260812a";
import {
  buildDependencyGraph,
  dependencyGraphHiddenByDefault,
  dependencyGraphKey,
  dependencyGraphReach,
  layoutDependencyGraph,
  pruneDependencyGraph,
} from "/ui/project_instance/dependency_graph_layout.js?v=20260910a";
import "/ui/shared/integrations/zoom_bridge.js?v=20260521a";

const GRAPH_ENDPOINT = "/datasets/dependency-graph";
const SVG_NS = "http://www.w3.org/2000/svg";
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 1.2;
// Zoom comparisons are float maths, so the floor needs a hair of slack.
const ZOOM_EPSILON = 1e-6;
// Breathing room between the fitted graph and the edge of the canvas.
const CANVAS_PADDING = 16;
// The node holder overhangs the box on both sides so the ports can straddle
// the edge an arrow attaches to.
const PORT_OVERHANG = 7;
const PORT_OPEN_DELAY_MS = 120;
const PORT_CLOSE_GRACE_MS = 260;
const PORT_POPOVER_GAP = 6;
const PORT_POPOVER_MARGIN = 8;
const TARGET_FLASH_MS = 1600;
// A hovered name travels at a reading pace rather than in a fixed time, waits
// out the settle before it first moves, and rests at each end of the trip so
// the tail can be read before it slides back. Even a name hanging a few
// pixels over its box makes the trip, but never quicker than the floor, so it
// drifts rather than flicking. Only a rounded pixel of overflow is ignored.
const NAME_SCROLL_PX_PER_S = 38;
const NAME_SCROLL_MIN_PX = 2;
const NAME_SCROLL_MIN_MS = 1200;
const NAME_SCROLL_START_MS = 450;
const NAME_SCROLL_HOLD_MS = 1500;
// A background press that travels less than this is a click, not a pan.
const CLICK_SLOP_PX = 3;

const PORT_SIDES = Object.freeze({
  in: { field: "precedents", title: "Precedents", empty: "No precedents" },
  out: { field: "dependents", title: "Dependents", empty: "No dependents" },
});

function text(value) {
  return String(value ?? "").trim();
}

function count(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

export function dependencyGraphSummary({ nodeCount, edgeCount, reviewCount, hiddenCount }) {
  const nodes = count(nodeCount);
  const hidden = count(hiddenCount);
  if (!nodes) return hidden ? `${hidden} dataset${hidden === 1 ? "" : "s"} hidden.` : "";
  const edges = count(edgeCount);
  const review = count(reviewCount);
  return `${nodes} object${nodes === 1 ? "" : "s"}, ${edges} link${edges === 1 ? "" : "s"}.`
    + (review ? ` ${review} need${review === 1 ? "s" : ""} review.` : "")
    + (hidden ? ` ${hidden} dataset${hidden === 1 ? "" : "s"} hidden.` : "");
}

/**
 * The open request one box sends the Project Instance page.
 *
 * A method output opens as its method, by the method name the index recorded,
 * so a DFM whose method name differs from its output dataset still opens. A
 * name the index no longer lists cannot be opened at all.
 */
export function dependencyGraphOpenRequest(node, { projectName, reservingClass } = {}) {
  if (!node || node.inIndex === false) return null;
  const request = {
    datasetName: node.name,
    datasetTypeName: node.datasetType || node.name,
    projectName: text(projectName),
    reservingClass: text(reservingClass),
    openMethod: !!node.methodType,
  };
  if (node.methodType) {
    request.methodType = node.methodType;
    request.methodName = node.methodName || node.name;
  }
  return request;
}

/**
 * What one port of a box lists: the direct precedents of the left port, the
 * direct dependents of the right one, each with the label its own box shows.
 * The names keep the graph's order, which the server sorted.
 */
export function dependencyGraphPortList(node, graph, side) {
  const spec = PORT_SIDES[side] || PORT_SIDES.in;
  const entries = (node?.[spec.field] || [])
    .map((key) => graph?.byKey?.get(key))
    .filter(Boolean)
    .map((other) => ({ key: other.key, name: other.name, label: other.kind.label, family: other.kind.family }));
  return {
    title: entries.length ? `${spec.title} (${entries.length})` : spec.title,
    empty: entries.length ? "" : spec.empty,
    entries,
  };
}

/**
 * How the zoomed graph sits in the scroll surface.
 *
 * The graph is surrounded by half a canvas of empty space on every side, so a
 * box against any edge can still be dragged to the middle of the window
 * instead of stopping against its frame - which is where the leftmost column
 * and the rightmost method always sit. The margin is what the pan and the
 * jump-to-box scroll move through, never a visual gap: nothing is drawn in it,
 * a graph smaller than the canvas still comes out centred, and the zoom that
 * fits the whole diagram is measured against CANVAS_PADDING instead.
 */
export function dependencyGraphViewport(layout, canvas, scale, padding = CANVAS_PADDING) {
  const marginX = Math.max(padding, canvas.width / 2);
  const marginY = Math.max(padding, canvas.height / 2);
  return {
    width: layout.width * scale + marginX * 2,
    height: layout.height * scale + marginY * 2,
    offsetX: marginX,
    offsetY: marginY,
  };
}

/**
 * The zoom at which the whole graph fits the canvas, never magnifying past
 * 1:1. Fit lands on it, and zooming out stops there, so a diagram already
 * showing every box cannot be shrunk into a speck. Zero when there is
 * nothing to measure.
 */
export function dependencyGraphFitScale(layout, canvas, padding = CANVAS_PADDING) {
  if (!layout?.width || !layout?.height || !canvas.width || !canvas.height) return 0;
  const scale = Math.min(
    (canvas.width - padding * 2) / layout.width,
    (canvas.height - padding * 2) / layout.height,
    1,
  );
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, scale));
}

/** The scroll offsets that put one graph point under one canvas point. */
export function dependencyGraphScrollTo(viewport, scale, graphPoint, canvasPoint) {
  return {
    scrollLeft: viewport.offsetX + graphPoint.x * scale - canvasPoint.x,
    scrollTop: viewport.offsetY + graphPoint.y * scale - canvasPoint.y,
  };
}

const params = new URLSearchParams(window.location.search);
const inst = text(params.get("inst"));
const projectName = text(params.get("project"));
const reservingClass = text(params.get("class"));

const els = {
  search: document.getElementById("dependencyGraphSearch"),
  showAll: document.getElementById("dependencyGraphShowAll"),
  zoomOut: document.getElementById("dependencyGraphZoomOut"),
  zoomIn: document.getElementById("dependencyGraphZoomIn"),
  fit: document.getElementById("dependencyGraphFit"),
  refresh: document.getElementById("dependencyGraphRefresh"),
  canvas: document.getElementById("dependencyGraphCanvas"),
  svg: document.getElementById("dependencyGraphSvg"),
  menu: document.getElementById("dependencyGraphMenu"),
  state: document.getElementById("dependencyGraphState"),
  status: document.getElementById("dependencyGraphStatus"),
};

const view = {
  // The whole class as the server sent it, and the part of it on screen.
  fullGraph: null,
  graph: null,
  layout: null,
  hiddenCount: 0,
  showAll: false,
  viewport: null,
  nodeEls: new Map(),
  placedNodes: new Map(),
  edgeEls: [],
  scale: 1,
  selectedKey: "",
  // What the chain looked like before the first click of a double click, so
  // opening a box can put it back.
  chainBeforeClick: "",
  query: "",
  requestSeq: 0,
  loading: false,
  loaded: false,
  // A frame resize keeps the diagram fitted until the user pans or zooms.
  userSteered: false,
  flashTimer: 0,
};

function postToParent(type, payload = {}) {
  try {
    window.parent?.postMessage({ type, inst, ...payload }, "*");
  } catch {}
}

function setStatus(message, tone = "") {
  if (!els.status) return;
  els.status.textContent = message || "";
  els.status.classList.toggle("error", tone === "error");
}

function showState(message) {
  if (!els.state) return;
  els.state.textContent = message || "";
  els.state.hidden = !message;
}

function syncControls() {
  const busy = view.loading;
  const empty = !view.layout?.nodes.length;
  if (els.refresh) els.refresh.disabled = busy;
  if (els.showAll) els.showAll.disabled = busy || !view.loaded;
  for (const button of [els.zoomIn, els.fit]) {
    if (button) button.disabled = busy || empty;
  }
  // Nothing is gained by shrinking a diagram that already shows every box.
  const wholeGraphShowing = !empty && view.scale <= zoomOutFloor() + ZOOM_EPSILON;
  if (els.zoomOut) els.zoomOut.disabled = busy || empty || wholeGraphShowing;
}

// ---------------------------------------------------------------------------
// Viewport: the SVG sized to the zoomed graph inside a scrolling canvas
// ---------------------------------------------------------------------------

function canvasSize() {
  return { width: els.canvas?.clientWidth || 0, height: els.canvas?.clientHeight || 0 };
}

/** Sizes the SVG to the current zoom and returns where the graph sits in it. */
function applyViewport() {
  const layout = view.layout;
  if (!layout || !els.svg) return null;
  const viewport = dependencyGraphViewport(layout, canvasSize(), view.scale);
  els.svg.setAttribute("width", String(Math.round(viewport.width)));
  els.svg.setAttribute("height", String(Math.round(viewport.height)));
  view.viewport?.setAttribute("transform", `translate(${viewport.offsetX} ${viewport.offsetY}) scale(${view.scale})`);
  return viewport;
}

function scrollCanvasTo(scrollLeft, scrollTop) {
  if (!els.canvas) return;
  els.canvas.scrollLeft = Math.max(0, scrollLeft);
  els.canvas.scrollTop = Math.max(0, scrollTop);
}

/** The floor zooming out stops at: the zoom that shows the whole graph. */
function zoomOutFloor() {
  if (!view.layout?.nodes.length) return ZOOM_MIN;
  return dependencyGraphFitScale(view.layout, canvasSize()) || ZOOM_MIN;
}

function fitGraph() {
  if (!view.layout?.nodes.length) return;
  const size = canvasSize();
  const scale = dependencyGraphFitScale(view.layout, size);
  if (!scale) return;
  view.scale = scale;
  const viewport = applyViewport();
  // The graph sits inside a margin the pan moves through, so the fit scrolls
  // it back to the middle of the canvas rather than to the scroll origin.
  const target = dependencyGraphScrollTo(
    viewport,
    scale,
    { x: view.layout.width / 2, y: view.layout.height / 2 },
    { x: size.width / 2, y: size.height / 2 },
  );
  scrollCanvasTo(target.scrollLeft, target.scrollTop);
  syncControls();
}

function zoomAt(factor, clientX, clientY) {
  if (!view.layout?.nodes.length) return;
  // Zooming out never goes below the fit, but a canvas that has since been
  // resized may leave the diagram under it already: hold it where it is.
  const floor = factor < 1 ? Math.min(zoomOutFloor(), view.scale) : ZOOM_MIN;
  const next = Math.max(floor, Math.min(ZOOM_MAX, view.scale * factor));
  if (next === view.scale) return;
  closePortPopover();
  closeNodeMenu();
  const canvas = els.canvas;
  const rect = canvas.getBoundingClientRect();
  const size = canvasSize();
  const canvasPoint = {
    x: clientX == null ? size.width / 2 : clientX - rect.left,
    y: clientY == null ? size.height / 2 : clientY - rect.top,
  };
  // The graph point under the cursor stays under the cursor.
  const before = dependencyGraphViewport(view.layout, size, view.scale);
  const graphPoint = {
    x: (canvas.scrollLeft + canvasPoint.x - before.offsetX) / view.scale,
    y: (canvas.scrollTop + canvasPoint.y - before.offsetY) / view.scale,
  };
  view.scale = next;
  const after = applyViewport();
  const target = dependencyGraphScrollTo(after, next, graphPoint, canvasPoint);
  scrollCanvasTo(target.scrollLeft, target.scrollTop);
  syncControls();
}

/** Scrolls the diagram so one box sits in the middle of the canvas and flashes it. */
function goToNode(key) {
  const node = view.placedNodes.get(key);
  const box = view.nodeEls.get(key);
  if (!node || !box) return;
  const size = canvasSize();
  if (size.width && size.height) {
    const viewport = dependencyGraphViewport(view.layout, size, view.scale);
    const target = dependencyGraphScrollTo(
      viewport,
      view.scale,
      { x: node.x + node.width / 2, y: node.y + node.height / 2 },
      { x: size.width / 2, y: size.height / 2 },
    );
    view.userSteered = true;
    scrollCanvasTo(target.scrollLeft, target.scrollTop);
  }
  if (view.flashTimer) window.clearTimeout(view.flashTimer);
  for (const el of view.nodeEls.values()) el.classList.remove("is-target");
  box.classList.add("is-target");
  view.flashTimer = window.setTimeout(() => {
    box.classList.remove("is-target");
    view.flashTimer = 0;
  }, TARGET_FLASH_MS);
  try { box.focus({ preventScroll: true }); } catch {}
}

function installPanAndZoom() {
  const svg = els.svg;
  const canvas = els.canvas;
  if (!svg || !canvas) return;
  let drag = null;
  const stop = () => {
    if (!drag) return;
    try { svg.releasePointerCapture(drag.pointerId); } catch {}
    svg.removeEventListener("pointermove", onMove);
    svg.removeEventListener("pointerup", onUp);
    svg.removeEventListener("pointercancel", stop);
    svg.removeEventListener("lostpointercapture", stop);
    svg.classList.remove("is-panning");
    drag = null;
  };
  const onMove = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) < CLICK_SLOP_PX && Math.abs(dy) < CLICK_SLOP_PX) return;
    drag.moved = true;
    view.userSteered = true;
    // Dragging the background moves the scrollbars, the same as scrolling.
    scrollCanvasTo(drag.scrollLeft - dx, drag.scrollTop - dy);
  };
  const onUp = (event) => {
    // A press on the background that never became a pan clears the
    // selection, so the lit chain has an obvious way off.
    if (drag && event.pointerId === drag.pointerId && !drag.moved) setSelection("");
    stop();
  };
  svg.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || drag) return;
    if (event.target.closest(".dg-node-holder")) return;
    closePortPopover();
    drag = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      scrollLeft: canvas.scrollLeft,
      scrollTop: canvas.scrollTop,
      moved: false,
    };
    svg.setPointerCapture(event.pointerId);
    svg.classList.add("is-panning");
    svg.addEventListener("pointermove", onMove);
    svg.addEventListener("pointerup", onUp);
    svg.addEventListener("pointercancel", stop);
    svg.addEventListener("lostpointercapture", stop);
    event.preventDefault();
  });
  canvas.addEventListener("wheel", (event) => {
    // The application zoom bridge owns Ctrl + wheel; a plain wheel zooms the
    // diagram around the cursor, and Shift + wheel pans it sideways now that
    // there are no scrollbars to leave it to.
    if (event.ctrlKey) return;
    if (event.shiftKey) {
      event.preventDefault();
      view.userSteered = true;
      scrollCanvasTo(canvas.scrollLeft + event.deltaY, canvas.scrollTop);
      return;
    }
    event.preventDefault();
    view.userSteered = true;
    zoomAt(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, event.clientX, event.clientY);
  }, { passive: false });
  window.addEventListener("beforeunload", stop);
}

/** The canvas pans without scrollbars, so a pan only closes what floats over it. */
function installScrollSurface() {
  const canvas = els.canvas;
  if (!canvas) return;
  canvas.addEventListener("scroll", () => {
    closePortPopover();
    closeNodeMenu();
  }, { passive: true });
}

// ---------------------------------------------------------------------------
// Port popover: the precedent or dependent list of one box
// ---------------------------------------------------------------------------

const popover = {
  el: null,
  port: null,
  openTimer: 0,
  closeTimer: 0,
};

function ensurePortPopover() {
  if (popover.el) return popover.el;
  const el = document.createElement("div");
  el.className = "dg-port-popover ar-framed-scroll";
  el.hidden = true;
  el.setAttribute("role", "dialog");
  // The list stays open while the pointer is on it (arcrho-ui-design C17):
  // crossing from the port to the list is still inside the open branch.
  el.addEventListener("pointerenter", cancelPortClose);
  el.addEventListener("pointerleave", schedulePortClose);
  el.addEventListener("pointerdown", (event) => event.stopPropagation());
  document.body.appendChild(el);
  popover.el = el;
  return el;
}

function cancelPortOpen() {
  if (popover.openTimer) window.clearTimeout(popover.openTimer);
  popover.openTimer = 0;
}

function cancelPortClose() {
  if (popover.closeTimer) window.clearTimeout(popover.closeTimer);
  popover.closeTimer = 0;
}

function schedulePortClose() {
  cancelPortOpen();
  cancelPortClose();
  popover.closeTimer = window.setTimeout(closePortPopover, PORT_CLOSE_GRACE_MS);
}

function closePortPopover() {
  cancelPortOpen();
  cancelPortClose();
  popover.port?.classList.remove("is-open");
  popover.port = null;
  if (popover.el) popover.el.hidden = true;
}

function placePortPopover(portEl, side) {
  const el = popover.el;
  const rect = portEl.getBoundingClientRect();
  const size = el.getBoundingClientRect();
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  let left = side === "in" ? rect.left - PORT_POPOVER_GAP - size.width : rect.right + PORT_POPOVER_GAP;
  let top = rect.top + rect.height / 2 - size.height / 2;
  const fitsBeside = side === "in"
    ? left >= PORT_POPOVER_MARGIN
    : left + size.width <= viewportWidth - PORT_POPOVER_MARGIN;
  if (!fitsBeside) {
    // No room beside the port: hang the list below it (or lift it above),
    // growing away from the box rather than covering the box.
    left = side === "in" ? rect.left : rect.right - size.width;
    top = rect.bottom + PORT_POPOVER_GAP;
    if (top + size.height > viewportHeight - PORT_POPOVER_MARGIN) top = rect.top - PORT_POPOVER_GAP - size.height;
  }
  left = Math.max(PORT_POPOVER_MARGIN, Math.min(left, viewportWidth - size.width - PORT_POPOVER_MARGIN));
  top = Math.max(PORT_POPOVER_MARGIN, Math.min(top, viewportHeight - size.height - PORT_POPOVER_MARGIN));
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

function openPortPopover(node, side, portEl) {
  cancelPortOpen();
  cancelPortClose();
  if (popover.port === portEl && !popover.el?.hidden) return;
  popover.port?.classList.remove("is-open");
  const el = ensurePortPopover();
  const list = dependencyGraphPortList(node, view.graph, side);
  el.replaceChildren();
  el.dataset.side = side;

  const title = document.createElement("div");
  title.className = "dg-port-popover-title";
  title.textContent = list.title;
  el.appendChild(title);

  if (!list.entries.length) {
    const empty = document.createElement("div");
    empty.className = "dg-port-popover-empty";
    empty.textContent = list.empty;
    el.appendChild(empty);
  } else {
    const rows = document.createElement("div");
    rows.className = "dg-port-popover-list";
    for (const entry of list.entries) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "dg-port-popover-row";
      row.dataset.family = entry.family;
      row.dataset.key = entry.key;
      const name = document.createElement("span");
      name.className = "dg-port-popover-name";
      name.textContent = entry.name;
      const label = document.createElement("span");
      label.className = "dg-port-popover-kind";
      label.textContent = entry.label;
      row.append(name, label);
      row.addEventListener("click", (event) => {
        event.stopPropagation();
        closePortPopover();
        goToNode(entry.key);
      });
      rows.appendChild(row);
    }
    el.appendChild(rows);
  }

  popover.port = portEl;
  portEl.classList.add("is-open");
  el.hidden = false;
  placePortPopover(portEl, side);
}

function schedulePortOpen(node, side, portEl) {
  cancelPortOpen();
  cancelPortClose();
  if (popover.port === portEl && !popover.el?.hidden) return;
  popover.openTimer = window.setTimeout(() => {
    popover.openTimer = 0;
    if (portEl.isConnected) openPortPopover(node, side, portEl);
  }, PORT_OPEN_DELAY_MS);
}

function buildPortElement(node, side) {
  const spec = PORT_SIDES[side];
  const port = document.createElement("button");
  port.type = "button";
  port.className = `dg-port is-${side}`;
  port.tabIndex = -1;
  port.dataset.side = side;
  const total = node[spec.field].length;
  port.classList.toggle("is-empty", !total);
  port.setAttribute("aria-label", `${spec.title} of ${node.name}${total ? ` (${total})` : ""}`);
  port.addEventListener("pointerenter", () => schedulePortOpen(node, side, port));
  port.addEventListener("pointerleave", schedulePortClose);
  // A press on a port belongs to the port: it must neither select nor open
  // the box, nor start a pan.
  port.addEventListener("pointerdown", (event) => event.stopPropagation());
  port.addEventListener("click", (event) => {
    event.stopPropagation();
    openPortPopover(node, side, port);
  });
  port.addEventListener("dblclick", (event) => event.stopPropagation());
  return port;
}

// ---------------------------------------------------------------------------
// Box context menu: opening one box without touching the lit chain
// ---------------------------------------------------------------------------

const nodeMenu = { node: null, box: null };

function closeNodeMenu() {
  if (!els.menu) return;
  // openContextMenu shows the menu with an inline display; clearing it hands
  // the menu back to the stylesheet's hidden default.
  els.menu.style.display = "";
  nodeMenu.box?.classList.remove("is-context-target");
  nodeMenu.node = null;
  nodeMenu.box = null;
}

function openNodeMenu(node, box, event) {
  if (!els.menu) return;
  closeNodeMenu();
  closePortPopover();
  nodeMenu.node = node;
  nodeMenu.box = box;
  // The menu marks its own box rather than selecting it, so the chain the user
  // is reading survives a right click.
  box.classList.add("is-context-target");
  const item = els.menu.querySelector('[data-action="open"]');
  if (item) {
    item.textContent = node.methodType ? "Show Method" : "Show Dataset";
    item.disabled = node.inIndex === false;
  }
  openContextMenu(els.menu, {
    anchorEl: box,
    clientX: Number(event?.clientX),
    clientY: Number(event?.clientY),
    offset: 8,
    align: "top-left",
  });
  item?.focus();
}

function wireNodeMenu() {
  const menu = els.menu;
  if (!menu) return;
  menu.addEventListener("click", (event) => {
    const item = event.target.closest?.(".ctx-item");
    if (!item) return;
    const node = nodeMenu.node;
    closeNodeMenu();
    if (node && item.dataset.action === "open") openNode(node);
  });
  document.addEventListener("mousedown", (event) => {
    if (!menu.contains(event.target)) closeNodeMenu();
  }, true);
  window.addEventListener("resize", closeNodeMenu);
  window.addEventListener("blur", closeNodeMenu);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function svgEl(tag, attributes = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, String(value));
  return el;
}

function arrowMarker(id, className) {
  const marker = svgEl("marker", {
    id,
    viewBox: "0 0 10 10",
    refX: 9,
    refY: 5,
    markerWidth: 7,
    markerHeight: 7,
    orient: "auto",
    markerUnits: "strokeWidth",
  });
  const path = svgEl("path", { d: "M0 1L9 5L0 9z" });
  path.setAttribute("class", className);
  marker.appendChild(path);
  return marker;
}

function openNode(node) {
  const request = dependencyGraphOpenRequest(node, { projectName, reservingClass });
  if (!request) {
    setStatus(`${node.name} is not in the class index and cannot be opened.`, "error");
    return;
  }
  postToParent("arcrho:project-instance-open-dependent-dataset", request);
  setStatus(request.openMethod
    ? `Opening ${node.methodType} method ${node.name}...`
    : `Opening dataset ${node.name}...`);
}

// Only the hovered name travels, so one handle is enough to stop it.
const nameScroll = { el: null, timer: 0 };

/** Puts a travelling name back where it started and forgets it. */
function stopNameScroll(textEl) {
  if (textEl && nameScroll.el !== textEl) return;
  if (nameScroll.timer) window.clearTimeout(nameScroll.timer);
  nameScroll.timer = 0;
  nameScroll.el?.classList.remove("is-scrolling", "is-scrolled");
  nameScroll.el = null;
}

/**
 * Walks a name too long for its box from end to end while the pointer is on
 * the box.
 *
 * How far it has to travel is that one name's overflow at this moment, so it
 * is measured here and handed to the stylesheet, which owns the slide itself.
 * The pace is fixed rather than the duration, so a long name is not whipped
 * past faster than a short one, and no trip is quicker than the floor. The
 * rest at each end is a fixed wait instead, because a name is read while it
 * is still - which is why the pacing is a timer here rather than one CSS
 * animation: keyframe holds are a share of the whole, so a long name would
 * sit for many seconds and a short one would barely stop. A name that fits
 * keeps its resting ellipsis and never moves.
 */
function startNameScroll(textEl) {
  stopNameScroll();
  // scrollWidth is rounded up, so a name that just fits can report a pixel of
  // overflow that is not worth a trip.
  const shift = textEl.scrollWidth - textEl.clientWidth;
  if (shift < NAME_SCROLL_MIN_PX) return;
  const travelMs = Math.round(Math.max(NAME_SCROLL_MIN_MS, (shift / NAME_SCROLL_PX_PER_S) * 1000));
  textEl.style.setProperty("--dg-name-shift", `${-shift}px`);
  textEl.style.setProperty("--dg-name-duration", `${travelMs}ms`);
  textEl.classList.add("is-scrolling");
  nameScroll.el = textEl;
  let scrolled = false;
  const turn = () => {
    scrolled = !scrolled;
    textEl.classList.toggle("is-scrolled", scrolled);
    nameScroll.timer = window.setTimeout(turn, travelMs + NAME_SCROLL_HOLD_MS);
  };
  nameScroll.timer = window.setTimeout(turn, NAME_SCROLL_START_MS);
}

function buildNodeElement(node) {
  const box = document.createElement("div");
  box.className = "dg-node";
  box.dataset.key = node.key;
  box.dataset.family = node.kind.family;
  box.tabIndex = 0;
  box.setAttribute("role", "button");
  box.setAttribute("aria-label", node.methodType
    ? `${node.methodType} method ${node.name}. Click to select, double-click or right-click to open.`
    : `Dataset ${node.name}. Click to select, double-click or right-click to open.`);

  const name = document.createElement("span");
  name.className = "dg-node-name";
  // The name line is the window; the span inside it is what scrolls when the
  // name is too long for the box.
  const nameText = document.createElement("span");
  nameText.className = "dg-node-name-text";
  nameText.textContent = node.name;
  name.appendChild(nameText);
  box.appendChild(name);

  const kind = document.createElement("span");
  kind.className = "dg-node-kind";
  const label = document.createElement("span");
  label.className = "dg-node-kind-label";
  label.textContent = node.kind.label;
  kind.appendChild(label);
  if (node.status === 2) {
    const review = document.createElement("span");
    review.className = "dg-node-review";
    review.setAttribute("title", "Needs review");
    kind.appendChild(review);
  }
  box.appendChild(kind);

  // A single click pins the chain; a double click opens the box and hands the
  // chain back to whatever was lit before its own first click, so opening one
  // box never costs the user the chain they were reading.
  box.addEventListener("click", (event) => {
    if (event.detail <= 1) view.chainBeforeClick = view.selectedKey;
    setSelection(node.key);
  });
  box.addEventListener("dblclick", (event) => {
    event.preventDefault();
    setSelection(view.chainBeforeClick);
    openNode(node);
  });
  box.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openNodeMenu(node, box, event);
  });
  box.addEventListener("pointerenter", () => startNameScroll(nameText));
  box.addEventListener("pointerleave", () => stopNameScroll(nameText));
  box.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      openNode(node);
    } else if (event.key === " ") {
      event.preventDefault();
      setSelection(view.selectedKey === node.key ? "" : node.key);
    }
  });
  return box;
}

function buildNodeHolder(node) {
  const holder = svgEl("foreignObject", {
    x: node.x - PORT_OVERHANG,
    y: node.y,
    width: node.width + PORT_OVERHANG * 2,
    height: node.height,
  });
  holder.setAttribute("class", "dg-node-holder");
  const wrap = document.createElement("div");
  wrap.className = "dg-node-wrap";
  wrap.style.setProperty("--dg-port-overhang", `${PORT_OVERHANG}px`);
  const box = buildNodeElement(node);
  wrap.appendChild(box);
  wrap.appendChild(buildPortElement(node, "in"));
  wrap.appendChild(buildPortElement(node, "out"));
  holder.appendChild(wrap);
  return { holder, box };
}

function render() {
  const svg = els.svg;
  const layout = view.layout;
  if (!svg || !layout) return;
  closePortPopover();
  closeNodeMenu();
  stopNameScroll();
  if (view.flashTimer) window.clearTimeout(view.flashTimer);
  view.flashTimer = 0;
  svg.replaceChildren();
  view.nodeEls = new Map();
  view.placedNodes = new Map();
  view.edgeEls = [];

  const defs = svgEl("defs");
  defs.appendChild(arrowMarker("dgArrow", "dg-arrow"));
  defs.appendChild(arrowMarker("dgArrowUpstream", "dg-arrow dg-arrow-upstream"));
  defs.appendChild(arrowMarker("dgArrowDownstream", "dg-arrow dg-arrow-downstream"));
  svg.appendChild(defs);

  const viewport = svgEl("g");
  viewport.setAttribute("class", "dg-viewport");
  for (const edge of layout.edges) {
    const path = svgEl("path", { d: edge.path });
    path.setAttribute("class", edge.back ? "dg-edge is-back" : "dg-edge");
    viewport.appendChild(path);
    view.edgeEls.push({ edge, el: path });
  }
  for (const node of layout.nodes) {
    const { holder, box } = buildNodeHolder(node);
    viewport.appendChild(holder);
    view.nodeEls.set(node.key, box);
    view.placedNodes.set(node.key, node);
  }
  svg.appendChild(viewport);
  view.viewport = viewport;
  // A selected box that the reload dropped or the filter hid is no longer selected.
  if (view.selectedKey && !view.nodeEls.has(view.selectedKey)) view.selectedKey = "";
  if (view.chainBeforeClick && !view.nodeEls.has(view.chainBeforeClick)) view.chainBeforeClick = "";
  applyViewport();
  applyHighlight();
}

// ---------------------------------------------------------------------------
// Highlighting: the selected chain and search matches
// ---------------------------------------------------------------------------

function setSelection(key) {
  if (view.selectedKey === key) return;
  view.selectedKey = key;
  applyHighlight();
}

function applyHighlight() {
  const graph = view.graph;
  if (!graph) return;
  const query = view.query;
  const focus = view.selectedKey;
  const reach = focus ? dependencyGraphReach(graph, focus) : null;
  const matches = new Set();
  if (query) {
    for (const node of graph.nodes) {
      if (node.key.includes(query) || dependencyGraphKey(node.datasetType).includes(query)) matches.add(node.key);
    }
  }
  for (const [key, el] of view.nodeEls) {
    const isFocus = key === focus;
    const inReach = !!reach && (reach.upstream.has(key) || reach.downstream.has(key));
    const isMatch = matches.has(key);
    el.classList.toggle("is-focus", isFocus);
    el.classList.toggle("is-upstream", !!reach && reach.upstream.has(key));
    el.classList.toggle("is-downstream", !!reach && reach.downstream.has(key));
    el.classList.toggle("is-match", isMatch);
    el.classList.toggle("is-dim", focus ? !(isFocus || inReach) : (!!query && !isMatch));
  }
  for (const { edge, el } of view.edgeEls) {
    const upstream = !!reach && reach.upstream.has(edge.source)
      && (edge.target === focus || reach.upstream.has(edge.target));
    const downstream = !!reach && reach.downstream.has(edge.target)
      && (edge.source === focus || reach.downstream.has(edge.source));
    el.classList.toggle("is-upstream", upstream);
    el.classList.toggle("is-downstream", downstream);
    el.classList.toggle("is-dim", focus
      ? !(upstream || downstream)
      : (!!query && !(matches.has(edge.source) && matches.has(edge.target))));
  }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Lays out the loaded class, leaving out the boxes the Show all box hides. */
function applyGraph({ keepViewport = false } = {}) {
  const full = view.fullGraph;
  if (!full) return;
  const hidden = view.showAll ? new Set() : dependencyGraphHiddenByDefault(full);
  view.hiddenCount = hidden.size;
  view.graph = pruneDependencyGraph(full, hidden);
  view.layout = layoutDependencyGraph(view.graph);
  render();
  if (!view.layout.nodes.length) {
    showState(view.hiddenCount
      ? "Every dataset in this reserving class is hidden. Tick Show all to see them."
      : "This reserving class has no datasets yet.");
  } else {
    showState("");
    if (!keepViewport) fitGraph();
  }
  setStatus(dependencyGraphSummary({
    nodeCount: view.layout.nodes.length,
    edgeCount: view.layout.edges.length,
    reviewCount: view.layout.nodes.filter((node) => node.status === 2).length,
    hiddenCount: view.hiddenCount,
  }));
  syncControls();
}

async function loadGraph({ keepViewport = false } = {}) {
  if (!projectName || !reservingClass) {
    showState("Project and reserving class are required.");
    setStatus("Project and reserving class are required.", "error");
    return;
  }
  const seq = ++view.requestSeq;
  view.loading = true;
  syncControls();
  if (!view.loaded) showState("Loading dependency graph...");
  setStatus("Loading dependency graph...");
  try {
    const query = new URLSearchParams({ project_name: projectName, reserving_class: reservingClass });
    const response = await fetch(`${GRAPH_ENDPOINT}?${query.toString()}`);
    const payload = await response.json().catch(() => ({}));
    if (seq !== view.requestSeq) return;
    if (!response.ok || payload?.ok === false) {
      const detail = payload?.detail;
      throw new Error(typeof detail === "string" && detail.trim() ? detail.trim() : `HTTP ${response.status}`);
    }
    view.fullGraph = buildDependencyGraph(payload);
    view.loading = false;
    view.loaded = true;
    applyGraph({ keepViewport });
  } catch (error) {
    if (seq !== view.requestSeq) return;
    view.loading = false;
    if (!view.loaded) showState("Dependency graph could not be loaded.");
    setStatus(`Could not load dependency graph: ${error.message}`, "error");
  } finally {
    if (seq === view.requestSeq) syncControls();
  }
}

function init() {
  installPanAndZoom();
  installScrollSurface();
  wireNodeMenu();
  els.zoomOut?.addEventListener("click", () => { view.userSteered = true; zoomAt(1 / ZOOM_STEP); });
  els.zoomIn?.addEventListener("click", () => { view.userSteered = true; zoomAt(ZOOM_STEP); });
  els.fit?.addEventListener("click", () => { view.userSteered = false; closePortPopover(); fitGraph(); });
  els.refresh?.addEventListener("click", () => void loadGraph({ keepViewport: true }));
  els.search?.addEventListener("input", () => {
    view.query = dependencyGraphKey(els.search.value);
    applyHighlight();
  });
  els.showAll?.addEventListener("change", () => {
    view.showAll = !!els.showAll.checked;
    // Showing or hiding boxes reshapes the whole diagram, so it is refitted.
    view.userSteered = false;
    applyGraph();
  });
  attachArcrhoTooltip(els.zoomOut, "Zoom out");
  attachArcrhoTooltip(els.zoomIn, "Zoom in");
  attachArcrhoTooltip(els.fit, "Fit to window");
  attachArcrhoTooltip(els.refresh, "Refresh");
  attachArcrhoTooltip(els.showAll?.closest("label") || els.showAll, "Also show the datasets nothing depends on");
  window.addEventListener("message", (event) => {
    if (event.data?.type === "arcrho:dependency-graph-refresh") void loadGraph({ keepViewport: true });
  });
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (nodeMenu.node) {
      closeNodeMenu();
      return;
    }
    if (popover.el && !popover.el.hidden) {
      closePortPopover();
      return;
    }
    if (view.selectedKey) setSelection("");
  });
  new ResizeObserver(() => {
    if (!view.userSteered) {
      fitGraph();
      return;
    }
    applyViewport();
    syncControls();
  }).observe(els.canvas);
  syncControls();
  void loadGraph();
}

init();
