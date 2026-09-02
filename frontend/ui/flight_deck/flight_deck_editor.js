// The one dialog for what a Flight Deck button looks like: its hover label, a glyph picked from the
// built-in set, or a drawing of the user's own - sketched with the mouse on the pad, or pasted in.
// Custom drawings are cleaned up before they are ever shown, so nothing that arrives here can carry
// script or reach out to a remote file.

import {
  BUILTIN_ICON_NAMES,
  DRAW_CANVAS_SIZE,
  DRAW_ERASER_RADIUS,
  DRAW_VIEWBOX,
  createIconElement,
  cutMarksNear,
  eraseMarksNear,
  iconToMarks,
  marksToIconMarkup,
  normalizeIcon,
  packMarks,
  sanitizeCustomIcon,
} from "./flight_deck_icons.js?v=20260901b";
import { hideDeckTooltip, showDeckTooltip } from "./flight_deck_tooltip.js?v=20260901a";

const SVG_NS = "http://www.w3.org/2000/svg";

// The pad's tools. The first four each add one piece to the drawing. The two erasers take away:
// Erase lifts whole pieces, Erase Area rubs out only what its ring covers. Each one's artwork is
// a file under draw-tool-icons/, keyed by its id.
const DRAW_TOOLS = [
  { id: "pen", label: "Pen", tip: "Pen" },
  { id: "line", label: "Line", tip: "Line - hold Shift to snap the angle" },
  { id: "box", label: "Box", tip: "Box - hold Shift for a square" },
  { id: "oval", label: "Oval", tip: "Oval - hold Shift for a circle" },
  { id: "erase", label: "Erase", tip: "Erase - lifts away whole lines and shapes. Press + or - to resize the ring" },
  { id: "cut", label: "Erase Area", tip: "Erase Area - rubs out only what the ring covers. Press + or - to resize the ring" },
];

// The eraser ring is resized from the keyboard, a step at a time, between these bounds.
const ERASER_RADIUS_STEP = 0.4;
const ERASER_RADIUS_MIN = 0.8;
const ERASER_RADIUS_MAX = 4;

function isEraser(tool) {
  return tool === "erase" || tool === "cut";
}

function isTextTarget(target) {
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName);
}

// The two actions at the end of the toolbar, which step back rather than draw.
const DRAW_ACTIONS = [
  { id: "undo", label: "Undo", tip: "Undo the last change" },
  { id: "clear", label: "Clear", tip: "Clear the pad" },
];

// How far the pointer has to travel before a dragged shape counts as drawn, in pad units.
const SHAPE_MIN_DRAG = 1;

let overlay = null;
let elements = null;
let session = null;
let stroke = null;
let eraserSpot = null;
// The tool and the eraser size stick between openings, the way a drawing program's do.
let activeTool = "pen";
let eraserRadius = DRAW_ERASER_RADIUS;

// One icon-only button of the pad's toolbar. A tool is a toggle that shows which one is in
// hand; an action just does its work when pressed.
function makeToolButton(entry, kind) {
  const button = document.createElement("button");
  button.className = "flightDeckDrawTool";
  button.type = "button";
  button.dataset[kind] = entry.id;
  button.dataset.arcrhoTip = entry.tip;
  button.setAttribute("aria-label", entry.label);
  if (kind === "tool") button.setAttribute("aria-pressed", entry.id === activeTool ? "true" : "false");
  const icon = document.createElement("span");
  icon.className = "flightDeckDrawToolIcon";
  icon.dataset.drawTool = entry.id;
  icon.setAttribute("aria-hidden", "true");
  button.appendChild(icon);
  return button;
}

function makeToolSeparator() {
  const separator = document.createElement("span");
  separator.className = "flightDeckDrawToolSep";
  separator.setAttribute("role", "separator");
  return separator;
}

function build() {
  overlay = document.createElement("div");
  overlay.id = "flightDeckEditorOverlay";
  overlay.className = "host-nodrag";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Edit Flight Deck Button");

  const box = document.createElement("div");
  box.className = "flightDeckEditor";
  overlay.appendChild(box);

  const title = document.createElement("div");
  title.className = "flightDeckEditorTitle";
  title.textContent = "Edit Flight Deck Button";
  box.appendChild(title);

  const body = document.createElement("div");
  body.className = "flightDeckEditorBody";
  box.appendChild(body);

  const macroCaption = document.createElement("label");
  macroCaption.className = "flightDeckEditorLabel";
  macroCaption.setAttribute("for", "flightDeckEditorMacroSelect");
  macroCaption.textContent = "Macro";
  body.appendChild(macroCaption);

  const macroSelect = document.createElement("select");
  macroSelect.id = "flightDeckEditorMacroSelect";
  macroSelect.className = "flightDeckEditorField";
  body.appendChild(macroSelect);

  const labelCaption = document.createElement("label");
  labelCaption.className = "flightDeckEditorLabel";
  labelCaption.setAttribute("for", "flightDeckEditorLabelInput");
  labelCaption.textContent = "Button Label";
  labelCaption.style.marginTop = "12px";
  body.appendChild(labelCaption);

  const labelInput = document.createElement("input");
  labelInput.id = "flightDeckEditorLabelInput";
  labelInput.className = "flightDeckEditorField";
  labelInput.type = "text";
  labelInput.autocomplete = "off";
  body.appendChild(labelInput);

  const iconSection = document.createElement("div");
  iconSection.className = "flightDeckEditorSection";
  body.appendChild(iconSection);

  const iconCaption = document.createElement("span");
  iconCaption.className = "flightDeckEditorLabel";
  iconCaption.textContent = "Icon";
  iconSection.appendChild(iconCaption);

  const grid = document.createElement("div");
  grid.className = "flightDeckIconGrid";
  BUILTIN_ICON_NAMES.forEach((name) => {
    const swatch = document.createElement("button");
    swatch.className = "flightDeckIconSwatch";
    swatch.type = "button";
    swatch.dataset.iconName = name;
    swatch.setAttribute("aria-pressed", "false");
    swatch.setAttribute("aria-label", name);
    swatch.appendChild(createIconElement({ kind: "builtin", name }));
    grid.appendChild(swatch);
  });
  iconSection.appendChild(grid);

  const customSection = document.createElement("div");
  customSection.className = "flightDeckEditorSection flightDeckEditorCustom";
  customSection.dataset.mode = "draw";
  body.appendChild(customSection);

  const customHead = document.createElement("div");
  customHead.className = "flightDeckEditorSectionHead";
  customSection.appendChild(customHead);

  const customCaption = document.createElement("span");
  customCaption.className = "flightDeckEditorLabel";
  customCaption.textContent = "Drawing";
  customHead.appendChild(customCaption);

  const modes = document.createElement("div");
  modes.className = "flightDeckDrawModes";
  modes.setAttribute("role", "group");
  modes.setAttribute("aria-label", "Drawing Method");
  [["draw", "Draw"], ["paste", "Paste"]].forEach(([mode, text]) => {
    const button = document.createElement("button");
    button.className = "flightDeckDrawMode";
    button.type = "button";
    button.dataset.mode = mode;
    button.textContent = text;
    button.setAttribute("aria-pressed", mode === "draw" ? "true" : "false");
    modes.appendChild(button);
  });
  customHead.appendChild(modes);

  const drawPanel = document.createElement("div");
  drawPanel.className = "flightDeckDrawPanel";
  customSection.appendChild(drawPanel);

  // One strip holds everything the pad answers to: the tools that draw, the eraser that takes
  // away, and at the far end the two actions that step back.
  const toolbar = document.createElement("div");
  toolbar.className = "flightDeckDrawToolbar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Drawing Tools");
  drawPanel.appendChild(toolbar);
  DRAW_TOOLS.forEach((tool) => {
    if (tool.id === "erase") toolbar.appendChild(makeToolSeparator());
    toolbar.appendChild(makeToolButton(tool, "tool"));
  });
  const spacer = document.createElement("span");
  spacer.className = "flightDeckDrawToolSpacer";
  toolbar.appendChild(spacer);
  const [undoBtn, clearBtn] = DRAW_ACTIONS.map((action) => makeToolButton(action, "action"));
  toolbar.append(undoBtn, clearBtn);

  // The pad sits as an artboard on its own workspace under the toolbar.
  const stage = document.createElement("div");
  stage.className = "flightDeckDrawStage";
  drawPanel.appendChild(stage);

  // The pad takes focus when it is drawn on, so the eraser-size keys reach it instead of typing
  // into the label box.
  const padWrap = document.createElement("div");
  padWrap.className = "flightDeckDrawPadWrap";
  padWrap.setAttribute("role", "group");
  padWrap.setAttribute("aria-label", "Drawing Pad");
  padWrap.tabIndex = -1;
  stage.appendChild(padWrap);

  // The pad is a mouse surface; what it produces is announced by the preview row below it.
  const pad = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  pad.setAttribute("viewBox", DRAW_VIEWBOX);
  pad.setAttribute("aria-hidden", "true");
  pad.setAttribute("focusable", "false");
  pad.classList.add("flightDeckDrawPad");
  padWrap.appendChild(pad);

  const padHint = document.createElement("span");
  padHint.className = "flightDeckDrawHint";
  padHint.textContent = "Draw Here";
  padWrap.appendChild(padHint);

  const pastePanel = document.createElement("div");
  pastePanel.className = "flightDeckPastePanel";
  customSection.appendChild(pastePanel);

  const customInput = document.createElement("textarea");
  customInput.id = "flightDeckEditorCustomInput";
  customInput.className = "flightDeckEditorField";
  customInput.spellcheck = false;
  customInput.setAttribute("aria-label", "Pasted drawing");
  customInput.placeholder = "Paste SVG markup or path data, then press Use Drawing.";
  pastePanel.appendChild(customInput);

  const useCustomBtn = document.createElement("button");
  useCustomBtn.className = "flightDeckEditorBtn";
  useCustomBtn.type = "button";
  useCustomBtn.textContent = "Use Drawing";
  pastePanel.appendChild(useCustomBtn);

  // Shown only when a pasted drawing is turned away, and gone again as soon as it is edited.
  const pasteError = document.createElement("div");
  pasteError.className = "flightDeckPasteError";
  pasteError.setAttribute("role", "alert");
  pasteError.hidden = true;
  pastePanel.appendChild(pasteError);

  const preview = document.createElement("div");
  preview.className = "flightDeckEditorPreview";
  const previewButton = document.createElement("span");
  previewButton.className = "flightDeckBtn";
  preview.appendChild(previewButton);
  const previewText = document.createElement("span");
  previewText.className = "flightDeckEditorPreviewText";
  preview.appendChild(previewText);
  body.appendChild(preview);

  const buttons = document.createElement("div");
  buttons.className = "flightDeckEditorButtons";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "flightDeckEditorBtn";
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel";
  const applyBtn = document.createElement("button");
  applyBtn.className = "flightDeckEditorBtn primary";
  applyBtn.type = "button";
  applyBtn.textContent = "Apply";
  buttons.append(cancelBtn, applyBtn);
  box.appendChild(buttons);

  document.body.appendChild(overlay);
  elements = {
    macroSelect, labelInput, grid, customSection, modes, padWrap, pad, padHint, toolbar, undoBtn, clearBtn, customInput,
    pasteError, useCustomBtn, previewButton, previewText, cancelBtn, applyBtn,
  };

  grid.addEventListener("click", (event) => {
    const swatch = event.target?.closest?.(".flightDeckIconSwatch");
    if (swatch) takeGlyphToPad(swatch.dataset.iconName);
  });

  useCustomBtn.addEventListener("click", () => {
    const result = sanitizeCustomIcon(customInput.value);
    if (!result.ok) {
      showPasteError(result.error);
      return;
    }
    setPastedIcon(result.icon);
  });
  customInput.addEventListener("input", () => {
    pasteError.hidden = true;
  });

  modes.addEventListener("click", (event) => {
    const button = event.target?.closest?.(".flightDeckDrawMode");
    if (button) setDrawMode(button.dataset.mode);
  });

  toolbar.addEventListener("click", (event) => {
    const button = event.target?.closest?.(".flightDeckDrawTool[data-tool]");
    if (button) setActiveTool(button.dataset.tool);
  });
  toolbar.addEventListener("pointerover", (event) => {
    const button = event.target?.closest?.(".flightDeckDrawTool");
    if (button) showDeckTooltip(button.dataset.arcrhoTip, event);
  });
  toolbar.addEventListener("pointerout", hideDeckTooltip);

  pad.addEventListener("pointerdown", (event) => {
    if (!session || event.button > 0) return;
    event.preventDefault();
    padWrap.focus({ preventScroll: true });
    pad.setPointerCapture(event.pointerId);
    const point = padPoint(event);
    stroke = { pointerId: event.pointerId, tool: activeTool, before: session.marks.slice(), mark: null };
    if (isEraser(activeTool)) {
      eraseAt(activeTool, point);
    } else if (activeTool === "pen") {
      stroke.mark = { tool: "pen", points: [point] };
    } else {
      stroke.mark = { tool: activeTool, points: [point, point] };
    }
    renderPad();
  });

  pad.addEventListener("pointermove", (event) => {
    if (!session) return;
    if (!stroke || event.pointerId !== stroke.pointerId) {
      // An eraser shows the ground it would clear as it is moved over the pad.
      if (isEraser(activeTool) && !stroke) {
        eraserSpot = padPoint(event);
        renderPad();
      }
      return;
    }
    const point = padPoint(event);
    if (isEraser(stroke.tool)) {
      eraseAt(stroke.tool, point);
    } else if (stroke.tool === "pen") {
      stroke.mark.points.push(point);
    } else {
      stroke.mark.points[1] = constrainShape(stroke.tool, stroke.mark.points[0], point, event.shiftKey);
    }
    renderPad();
  });

  const endStroke = (event) => {
    if (!stroke || event.pointerId !== stroke.pointerId) return;
    const finished = stroke;
    stroke = null;
    if (pad.hasPointerCapture(event.pointerId)) pad.releasePointerCapture(event.pointerId);
    if (!session) return;
    if (finished.mark && keepMark(finished.mark)) session.marks.push(finished.mark);
    if (session.marks.length !== finished.before.length) pushHistory(finished.before);
    commitDrawing();
  };
  pad.addEventListener("pointerup", endStroke);
  pad.addEventListener("pointercancel", endStroke);
  pad.addEventListener("pointerleave", () => {
    if (stroke || !eraserSpot) return;
    eraserSpot = null;
    renderPad();
  });

  undoBtn.addEventListener("click", () => {
    if (!session?.history.length) return;
    session.marks = session.history.pop();
    commitDrawing();
  });
  clearBtn.addEventListener("click", () => {
    if (!session?.marks.length) return;
    pushHistory(session.marks.slice());
    session.marks = [];
    commitDrawing();
  });

  macroSelect.addEventListener("change", () => {
    session.macroId = macroSelect.value;
    session.placeholder = macroNameFor(session.macroId);
    labelInput.placeholder = session.placeholder;
    syncPreview();
  });

  labelInput.addEventListener("input", syncPreview);
  cancelBtn.addEventListener("click", close);
  applyBtn.addEventListener("click", apply);
  overlay.addEventListener("pointerdown", (event) => {
    if (event.target === overlay) close();
  });
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    } else if (event.key === "Enter" && event.target !== customInput && event.target?.tagName !== "BUTTON") {
      event.preventDefault();
      apply();
    } else if ((event.key === "+" || event.key === "=" || event.key === "-") && isEraser(activeTool) && !isTextTarget(event.target)) {
      // Plus and minus, on the number pad or the main keys, grow and shrink the eraser ring.
      event.preventDefault();
      resizeEraser(event.key === "-" ? -ERASER_RADIUS_STEP : ERASER_RADIUS_STEP);
    }
  });
}

// Erase lifts whole pieces; Erase Area rubs out only what the ring covers.
function eraseAt(tool, point) {
  eraserSpot = point;
  session.marks = tool === "cut"
    ? cutMarksNear(session.marks, point, eraserRadius)
    : eraseMarksNear(session.marks, point, eraserRadius);
}

// The new size is shown at once: the ring stays where the pointer was, or sits at the centre of
// the pad when the pointer is elsewhere.
function resizeEraser(delta) {
  eraserRadius = Math.min(ERASER_RADIUS_MAX, Math.max(ERASER_RADIUS_MIN, Math.round((eraserRadius + delta) * 10) / 10));
  if (!eraserSpot) eraserSpot = { x: DRAW_CANVAS_SIZE / 2, y: DRAW_CANVAS_SIZE / 2 };
  renderPad();
}

function showPasteError(text) {
  if (!elements) return;
  elements.pasteError.textContent = text;
  elements.pasteError.hidden = false;
}

function setDrawMode(mode) {
  if (!elements || (mode !== "draw" && mode !== "paste")) return;
  elements.customSection.dataset.mode = mode;
  elements.modes.querySelectorAll(".flightDeckDrawMode").forEach((button) => {
    button.setAttribute("aria-pressed", button.dataset.mode === mode ? "true" : "false");
  });
}

// Where the pointer sits inside the pad, in the icon's own 24-unit coordinates. Drawing past the
// edge is clamped rather than dropped, so a line taken off the pad still finishes at the border.
function padPoint(event) {
  const rect = elements.pad.getBoundingClientRect();
  const size = DRAW_CANVAS_SIZE;
  const x = rect.width ? ((event.clientX - rect.left) / rect.width) * size : 0;
  const y = rect.height ? ((event.clientY - rect.top) / rect.height) * size : 0;
  return { x: Math.min(size, Math.max(0, x)), y: Math.min(size, Math.max(0, y)) };
}

function setActiveTool(tool) {
  if (!elements || !DRAW_TOOLS.some((entry) => entry.id === tool)) return;
  activeTool = tool;
  eraserSpot = null;
  elements.toolbar.querySelectorAll(".flightDeckDrawTool[data-tool]").forEach((button) => {
    button.setAttribute("aria-pressed", button.dataset.tool === tool ? "true" : "false");
  });
  elements.pad.dataset.tool = tool;
  renderPad();
}

// A dragged shape that went nowhere was a misfire rather than a drawing; a single click of the pen
// is kept, because that is how a dot is made.
function keepMark(mark) {
  if (mark.tool === "pen") return mark.points.length > 0;
  const [start, end] = mark.points;
  return Math.hypot(end.x - start.x, end.y - start.y) >= SHAPE_MIN_DRAG;
}

// Shift holds a line to a quarter turn and squares off a box or an oval.
function constrainShape(tool, start, end, shiftKey) {
  if (!shiftKey) return end;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (tool === "line") {
    const step = Math.PI / 4;
    const angle = Math.round(Math.atan2(dy, dx) / step) * step;
    const length = Math.hypot(dx, dy);
    return padBound({ x: start.x + Math.cos(angle) * length, y: start.y + Math.sin(angle) * length });
  }
  const size = Math.max(Math.abs(dx), Math.abs(dy));
  return padBound({ x: start.x + (dx < 0 ? -size : size), y: start.y + (dy < 0 ? -size : size) });
}

function padBound(point) {
  return {
    x: Math.min(DRAW_CANVAS_SIZE, Math.max(0, point.x)),
    y: Math.min(DRAW_CANVAS_SIZE, Math.max(0, point.y)),
  };
}

function pushHistory(marks) {
  if (!session) return;
  session.history.push(marks);
  if (session.history.length > 40) session.history.shift();
}

function renderPad() {
  if (!elements || !session) return;
  const drawn = stroke?.mark ? [...session.marks, stroke.mark] : session.marks;
  let markup = marksToIconMarkup(drawn);
  if (isEraser(activeTool) && eraserSpot) {
    markup += `<circle cx="${eraserSpot.x.toFixed(2)}" cy="${eraserSpot.y.toFixed(2)}" r="${eraserRadius}" class="flightDeckEraserRing"></circle>`;
  }
  elements.pad.innerHTML = markup;
  elements.padHint.hidden = drawn.length > 0;
  // The actions show whether there is anything for them to do.
  elements.undoBtn.disabled = session.history.length === 0;
  elements.clearBtn.disabled = drawn.length === 0;
}

// The pad is the button's icon whenever it holds anything at all; empty it and the button falls
// back to the glyph that was in force before the drawing started.
function commitDrawing() {
  if (!session) return;
  const markup = marksToIconMarkup(session.marks);
  if (!markup) {
    session.icon = normalizeIcon(session.baseIcon);
  } else {
    const result = sanitizeCustomIcon(`<svg viewBox="${DRAW_VIEWBOX}">${markup}</svg>`);
    // The pieces travel with the drawing, so opening this button again reopens the work itself.
    session.icon = result.ok
      ? normalizeIcon({ ...result.icon, marks: packMarks(session.marks) })
      : normalizeIcon(session.baseIcon);
  }
  renderPad();
  syncPreview();
}

// Picking a glyph lays it out on the pad rather than replacing everything with it, so a built-in
// icon can be the starting point of a drawing instead of the end of one. It stays the plain
// built-in icon until the pad is actually worked on.
function takeGlyphToPad(name) {
  if (!session) return;
  const icon = normalizeIcon({ kind: "builtin", name });
  pushHistory(session.marks.slice());
  session.marks = measureMarks(iconToMarks(icon));
  session.icon = icon;
  session.baseIcon = normalizeIcon(null);
  setDrawMode("draw");
  renderPad();
  syncPreview();
}

// A pasted drawing cannot be taken apart into pieces, so it clears the pad and stands on its own.
function setPastedIcon(icon) {
  if (!session) return;
  session.icon = normalizeIcon(icon);
  session.baseIcon = session.icon;
  if (session.marks.length) pushHistory(session.marks.slice());
  session.marks = [];
  renderPad();
  syncPreview();
}

// A built-in glyph's own curves are handed to the browser to measure, so the eraser knows where
// they run. Anything it cannot measure simply stays put when the eraser passes over it.
function measureMarks(marks) {
  marks.forEach((mark) => {
    if (mark.tool !== "path" || mark.outline) return;
    const probe = document.createElementNS(SVG_NS, "path");
    probe.setAttribute("d", mark.d);
    elements.pad.appendChild(probe);
    const outline = [];
    try {
      const total = probe.getTotalLength();
      const steps = Math.max(2, Math.min(120, Math.ceil(total / 0.5)));
      for (let i = 0; i <= steps; i += 1) {
        const point = probe.getPointAtLength((i / steps) * total);
        outline.push({ x: point.x, y: point.y });
      }
    } catch {
      outline.length = 0;
    }
    probe.remove();
    mark.outline = outline;
  });
  return marks;
}

function syncPreview() {
  if (!elements || !session) return;
  const icon = normalizeIcon(session.icon);
  elements.previewButton.textContent = "";
  elements.previewButton.appendChild(createIconElement(icon));
  elements.previewText.textContent = elements.labelInput.value.trim() || session.placeholder;
  elements.grid.querySelectorAll(".flightDeckIconSwatch").forEach((swatch) => {
    const selected = icon.kind === "builtin" && swatch.dataset.iconName === icon.name;
    swatch.setAttribute("aria-pressed", selected ? "true" : "false");
  });
}

function close() {
  hideDeckTooltip();
  overlay?.classList.remove("open");
  session = null;
  stroke = null;
  eraserSpot = null;
}

function macroNameFor(macroId) {
  const match = session?.macros.find((macro) => macro.id === macroId);
  return match?.name || macroId || "Macro";
}

function apply() {
  if (!session) return;
  const onApply = session.onApply;
  const payload = {
    macroId: session.macroId,
    label: elements.labelInput.value.trim() || session.placeholder,
    icon: normalizeIcon(session.icon),
  };
  close();
  onApply?.(payload);
}

export function openFlightDeckButtonEditor({ title = "Edit Flight Deck Button", macroId = "", macros = [], label = "", icon = null, onApply = null } = {}) {
  if (!overlay) build();
  const known = Array.isArray(macros) ? macros : [];
  session = { icon: normalizeIcon(icon), macros: known, macroId: macroId || known[0]?.id || "", placeholder: "", onApply };
  // A button reopens with its icon back on the pad, whether it was drawn here or picked from the
  // built-in set. Emptying the pad then means starting over, so the fall-back behind a drawing is
  // a plain glyph rather than the drawing itself.
  session.history = [];
  session.marks = iconToMarks(session.icon);
  session.baseIcon = session.marks.length ? normalizeIcon(null) : session.icon;
  session.placeholder = macroNameFor(session.macroId);
  stroke = null;
  eraserSpot = null;
  overlay.querySelector(".flightDeckEditorTitle").textContent = title;
  elements.macroSelect.textContent = "";
  if (!known.length) {
    const option = document.createElement("option");
    option.value = session.macroId;
    option.textContent = session.placeholder;
    elements.macroSelect.appendChild(option);
    elements.macroSelect.disabled = true;
  } else {
    elements.macroSelect.disabled = false;
    known.forEach((macro) => {
      const option = document.createElement("option");
      option.value = macro.id;
      option.textContent = macro.name || macro.id;
      elements.macroSelect.appendChild(option);
    });
  }
  elements.macroSelect.value = session.macroId;
  elements.labelInput.value = label;
  elements.labelInput.placeholder = session.placeholder;
  elements.customInput.value = icon?.kind === "custom" ? `<svg viewBox="${icon.viewBox}">${icon.markup}</svg>` : "";
  elements.pasteError.hidden = true;
  setDrawMode("draw");
  setActiveTool(activeTool);
  syncPreview();
  overlay.classList.add("open");
  // Measured once the dialog is on screen, where the browser can walk the glyph's own curves.
  measureMarks(session.marks);
  elements.labelInput.focus();
  elements.labelInput.select();
}
