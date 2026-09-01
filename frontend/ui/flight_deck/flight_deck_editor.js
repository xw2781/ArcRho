// The one dialog for what a Flight Deck button looks like: its hover label, a glyph picked from the
// built-in set, or a drawing of the user's own - sketched with the mouse on the pad, or pasted in.
// Custom drawings are cleaned up before they are ever shown, so nothing that arrives here can carry
// script or reach out to a remote file.

import {
  BUILTIN_ICON_NAMES,
  DRAW_CANVAS_SIZE,
  DRAW_VIEWBOX,
  createIconElement,
  eraseMarksNear,
  iconToMarks,
  marksToIconMarkup,
  normalizeIcon,
  packMarks,
  sanitizeCustomIcon,
} from "./flight_deck_icons.js?v=20260831e";

const SVG_NS = "http://www.w3.org/2000/svg";

const PASTE_NOTE = "Anything pasted here is cleaned up before it is drawn.";
const DRAW_NOTE = "Drag on the pad to draw. Hold Shift for a straight line, a square, or a circle.";
const RESUME_NOTE = "The drawing on this button is back on the pad, ready to be worked on.";
const GLYPH_NOTE = "The glyph is on the pad. Draw on it, or rub parts of it out, to make it your own.";

// The pad's tools. Everything except the eraser adds one piece to the drawing; the eraser takes
// whole pieces away, which is the only thing that means anything for a drawing made of lines.
const DRAW_TOOLS = [
  { id: "pen", label: "Pen", glyph: '<path d="M4.5 19.5 5.5 15.5 16.2 4.8a2 2 0 0 1 2.8 2.8L8.3 18.3z"></path><path d="M14.8 6.2 17.8 9.2"></path>' },
  { id: "line", label: "Line", glyph: '<path d="M5 19 19 5"></path><circle cx="5" cy="19" r="1.4"></circle><circle cx="19" cy="5" r="1.4"></circle>' },
  { id: "box", label: "Box", glyph: '<rect x="4.5" y="6.5" width="15" height="11" rx="1"></rect>' },
  { id: "oval", label: "Oval", glyph: '<ellipse cx="12" cy="12" rx="8" ry="5.5"></ellipse>' },
  { id: "erase", label: "Erase", glyph: '<path d="M9 20.5 4 15.5a1.6 1.6 0 0 1 0-2.3l8.2-8.2a1.6 1.6 0 0 1 2.3 0l4.7 4.7a1.6 1.6 0 0 1 0 2.3l-8.5 8.5z"></path><path d="M20 20.5h-9"></path><path d="M9.2 8.3 15.7 14.8"></path>' },
];

// How far the pointer has to travel before a dragged shape counts as drawn, in pad units.
const SHAPE_MIN_DRAG = 1;

let overlay = null;
let elements = null;
let session = null;
let stroke = null;
let eraserSpot = null;
// The tool sticks between openings, the way a drawing program's does.
let activeTool = "pen";

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

  const padWrap = document.createElement("div");
  padWrap.className = "flightDeckDrawPadWrap";
  padWrap.setAttribute("role", "group");
  padWrap.setAttribute("aria-label", "Drawing Pad");
  drawPanel.appendChild(padWrap);

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

  const drawTools = document.createElement("div");
  drawTools.className = "flightDeckDrawTools";
  drawPanel.appendChild(drawTools);

  const toolGrid = document.createElement("div");
  toolGrid.className = "flightDeckDrawToolGrid";
  toolGrid.setAttribute("role", "group");
  toolGrid.setAttribute("aria-label", "Drawing Tools");
  DRAW_TOOLS.forEach((tool) => {
    const button = document.createElement("button");
    button.className = "flightDeckDrawTool";
    button.type = "button";
    button.dataset.tool = tool.id;
    button.setAttribute("aria-pressed", tool.id === activeTool ? "true" : "false");
    const glyph = document.createElementNS(SVG_NS, "svg");
    glyph.setAttribute("viewBox", DRAW_VIEWBOX);
    glyph.setAttribute("aria-hidden", "true");
    glyph.setAttribute("focusable", "false");
    glyph.classList.add("flightDeckGlyph");
    glyph.innerHTML = tool.glyph;
    button.appendChild(glyph);
    const caption = document.createElement("span");
    caption.textContent = tool.label;
    button.appendChild(caption);
    toolGrid.appendChild(button);
  });
  drawTools.appendChild(toolGrid);

  const drawActions = document.createElement("div");
  drawActions.className = "flightDeckDrawActions";
  const undoBtn = document.createElement("button");
  undoBtn.className = "flightDeckEditorBtn slim";
  undoBtn.type = "button";
  undoBtn.textContent = "Undo";
  const clearBtn = document.createElement("button");
  clearBtn.className = "flightDeckEditorBtn slim";
  clearBtn.type = "button";
  clearBtn.textContent = "Clear";
  drawActions.append(undoBtn, clearBtn);
  drawTools.appendChild(drawActions);

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
  useCustomBtn.style.marginTop = "8px";
  pastePanel.appendChild(useCustomBtn);

  const note = document.createElement("div");
  note.className = "flightDeckEditorNote";
  note.textContent = DRAW_NOTE;
  customSection.appendChild(note);

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
    macroSelect, labelInput, grid, customSection, modes, pad, padHint, toolGrid, customInput, note, useCustomBtn,
    previewButton, previewText, cancelBtn, applyBtn,
  };

  grid.addEventListener("click", (event) => {
    const swatch = event.target?.closest?.(".flightDeckIconSwatch");
    if (swatch) takeGlyphToPad(swatch.dataset.iconName);
  });

  useCustomBtn.addEventListener("click", () => {
    const result = sanitizeCustomIcon(customInput.value);
    if (!result.ok) {
      setNote(result.error, "error");
      return;
    }
    setPastedIcon(result.icon);
  });

  modes.addEventListener("click", (event) => {
    const button = event.target?.closest?.(".flightDeckDrawMode");
    if (button) setDrawMode(button.dataset.mode);
  });

  toolGrid.addEventListener("click", (event) => {
    const button = event.target?.closest?.(".flightDeckDrawTool");
    if (button) setActiveTool(button.dataset.tool);
  });

  pad.addEventListener("pointerdown", (event) => {
    if (!session || event.button > 0) return;
    event.preventDefault();
    pad.setPointerCapture(event.pointerId);
    const point = padPoint(event);
    stroke = { pointerId: event.pointerId, tool: activeTool, before: session.marks.slice(), mark: null };
    if (activeTool === "erase") {
      eraserSpot = point;
      session.marks = eraseMarksNear(session.marks, point);
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
      // The eraser shows the ground it would clear as it is moved over the pad.
      if (activeTool === "erase" && !stroke) {
        eraserSpot = padPoint(event);
        renderPad();
      }
      return;
    }
    const point = padPoint(event);
    if (stroke.tool === "erase") {
      eraserSpot = point;
      session.marks = eraseMarksNear(session.marks, point);
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
    }
  });
}

function setNote(text, tone) {
  if (!elements) return;
  elements.note.textContent = text;
  elements.note.dataset.tone = tone || "";
}

function noteForMode() {
  return elements?.customSection.dataset.mode === "paste" ? PASTE_NOTE : DRAW_NOTE;
}

function setDrawMode(mode) {
  if (!elements || (mode !== "draw" && mode !== "paste")) return;
  elements.customSection.dataset.mode = mode;
  elements.modes.querySelectorAll(".flightDeckDrawMode").forEach((button) => {
    button.setAttribute("aria-pressed", button.dataset.mode === mode ? "true" : "false");
  });
  setNote(noteForMode(), "");
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
  elements.toolGrid.querySelectorAll(".flightDeckDrawTool").forEach((button) => {
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
  if (activeTool === "erase" && eraserSpot) {
    markup += `<circle cx="${eraserSpot.x.toFixed(2)}" cy="${eraserSpot.y.toFixed(2)}" r="1.6" class="flightDeckEraserRing"></circle>`;
  }
  elements.pad.innerHTML = markup;
  elements.padHint.hidden = drawn.length > 0;
}

// The pad is the button's icon whenever it holds anything at all; empty it and the button falls
// back to the glyph that was in force before the drawing started.
function commitDrawing() {
  if (!session) return;
  const markup = marksToIconMarkup(session.marks);
  if (!markup) {
    session.icon = normalizeIcon(session.baseIcon);
    setNote(noteForMode(), "");
  } else {
    const result = sanitizeCustomIcon(`<svg viewBox="${DRAW_VIEWBOX}">${markup}</svg>`);
    // The pieces travel with the drawing, so opening this button again reopens the work itself.
    session.icon = result.ok
      ? normalizeIcon({ ...result.icon, marks: packMarks(session.marks) })
      : normalizeIcon(session.baseIcon);
    setNote(result.ok ? "Your drawing is on the button." : result.error, result.ok ? "" : "error");
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
  setNote(GLYPH_NOTE, "");
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
  setNote("Pasted drawing accepted. The pad is cleared, since it cannot be taken apart.", "");
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
  setDrawMode("draw");
  setActiveTool(activeTool);
  if (session.marks.length) setNote(RESUME_NOTE, "");
  syncPreview();
  overlay.classList.add("open");
  // Measured once the dialog is on screen, where the browser can walk the glyph's own curves.
  measureMarks(session.marks);
  elements.labelInput.focus();
  elements.labelInput.select();
}
