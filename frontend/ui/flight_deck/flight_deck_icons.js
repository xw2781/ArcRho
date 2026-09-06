// One owner for Flight Deck button iconography. Every deck button draws either a built-in glyph
// from this catalog or a sanitized custom drawing, whether that drawing was pasted in or sketched
// with the mouse, so a deck button looks the same wherever it was created and a drawing can never
// carry script or remote references.

const BUILTIN_VIEWBOX = "0 0 24 24";

// Stroke-only 24x24 glyphs, drawn to the same weight as the rest of the shell chrome.
const BUILTIN_ICONS = {
  bolt: '<path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12z"></path>',
  play: '<path d="M8 5.5 18 12 8 18.5z"></path>',
  chart: '<path d="M4 18h16"></path><path d="M6 15l4-5 4 3 4-7"></path><circle cx="6" cy="15" r="1.2"></circle><circle cx="10" cy="10" r="1.2"></circle><circle cx="14" cy="13" r="1.2"></circle><circle cx="18" cy="6" r="1.2"></circle>',
  bars: '<path d="M4 20h16"></path><rect x="6" y="10" width="3.2" height="7"></rect><rect x="11.4" y="6" width="3.2" height="11"></rect><rect x="16.8" y="13" width="3.2" height="4"></rect>',
  table: '<rect x="3.5" y="4.5" width="17" height="15" rx="1.6"></rect><path d="M3.5 9.5h17"></path><path d="M9 9.5V19.5"></path><path d="M14.8 9.5V19.5"></path>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.2"></rect><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.2"></rect><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.2"></rect><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.2"></rect>',
  sigma: '<path d="M17.5 5H6.5l5.5 7-5.5 7h11"></path>',
  percent: '<circle cx="7.5" cy="7.5" r="2.6"></circle><circle cx="16.5" cy="16.5" r="2.6"></circle><path d="M18 6 6 18"></path>',
  calculator: '<rect x="5" y="3.5" width="14" height="17" rx="2"></rect><rect x="8" y="6.5" width="8" height="3"></rect><path d="M8.5 13h.01M12 13h.01M15.5 13h.01M8.5 16.5h.01M12 16.5h.01M15.5 16.5h.01"></path>',
  wand: '<path d="M5 19 15.5 8.5"></path><path d="M13.5 6.5 17.5 10.5"></path><path d="M18 3v3M21 5h-3M17.5 15.5v2.5M21 17h-2.5"></path>',
  spark: '<path d="M12 3.5 13.8 9l5.5 1.8-5.5 1.8L12 18l-1.8-5.4L4.7 10.8 10.2 9z"></path><path d="M18.5 16.5 19.3 19l2.2.8-2.2.8-.8 2.2"></path>',
  refresh: '<path d="M20 6v5h-5"></path><path d="M4 18v-5h5"></path><path d="M18 9a7 7 0 0 0-11-3"></path><path d="M6 15a7 7 0 0 0 11 3"></path>',
  sync: '<path d="M4 12a8 8 0 0 1 13.7-5.6L20 8.5"></path><path d="M20 4v4.5h-4.5"></path><path d="M20 12a8 8 0 0 1-13.7 5.6L4 15.5"></path><path d="M4 20v-4.5h4.5"></path>',
  clock: '<circle cx="12" cy="12" r="8"></circle><path d="M12 7.5V12l3 2"></path>',
  check: '<path d="M4.5 12.5 9.5 17.5 19.5 6.5"></path>',
  shield: '<path d="M12 3.5 19 6v6c0 4.2-2.9 7-7 8.5C7 19 4.5 16.2 4.5 12V6z"></path><path d="M9 12l2 2 4-4"></path>',
  flag: '<path d="M6 21V4"></path><path d="M6 5h10.5l-1.8 3.5L16.5 12H6z"></path>',
  target: '<circle cx="12" cy="12" r="8"></circle><circle cx="12" cy="12" r="4"></circle><circle cx="12" cy="12" r="1"></circle>',
  filter: '<path d="M4 5.5h16l-6.2 7.3V19l-3.6-2v-4.2z"></path>',
  layers: '<path d="M12 3.5 20.5 8 12 12.5 3.5 8z"></path><path d="M3.5 12.5 12 17l8.5-4.5"></path><path d="M3.5 16.5 12 21l8.5-4.5"></path>',
  link: '<path d="M10.5 13.5a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7l-1.2 1.2"></path><path d="M13.5 10.5a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 0 0 5.7 5.7l1.2-1.2"></path>',
  document: '<path d="M6 3.5h7.5L18.5 8.5V20.5H6z"></path><path d="M13.5 3.5V8.5h5"></path><path d="M9 13h6M9 16.5h4.5"></path>',
  clipboard: '<path d="M9 5H7a1.5 1.5 0 0 0-1.5 1.5v13A1.5 1.5 0 0 0 7 21h10a1.5 1.5 0 0 0 1.5-1.5v-13A1.5 1.5 0 0 0 17 5h-2"></path><rect x="9" y="3" width="6" height="3.5" rx="1"></rect><path d="M9 12h6M9 15.5h4"></path>',
  folder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z"></path>',
  database: '<ellipse cx="12" cy="5.5" rx="7" ry="3"></ellipse><path d="M5 5.5v13c0 1.7 3.1 3 7 3s7-1.3 7-3v-13"></path><path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"></path>',
  download: '<path d="M12 3.5v11"></path><path d="M7.5 10.5 12 15l4.5-4.5"></path><path d="M4.5 19.5h15"></path>',
  upload: '<path d="M12 20.5v-11"></path><path d="M7.5 13.5 12 9l4.5 4.5"></path><path d="M4.5 4.5h15"></path>',
  beaker: '<path d="M9.5 3.5v6L4.8 18a2 2 0 0 0 1.7 3h11a2 2 0 0 0 1.7-3l-4.7-8.5v-6"></path><path d="M8 3.5h8"></path><path d="M6.8 14h10.4"></path>',
  compass: '<circle cx="12" cy="12" r="8.5"></circle><path d="M15.5 8.5 13.5 13.5 8.5 15.5 10.5 10.5z"></path>',
  gear: '<circle cx="12" cy="12" r="3.2"></circle><path d="M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M18 6l-1.6 1.6M7.6 16.4 6 18M18 18l-1.6-1.6M7.6 7.6 6 6"></path>',
  star: '<path d="m12 4 2.5 5.2 5.5.8-4 3.9 1 5.6-5-2.7-5 2.7 1-5.6-4-3.9 5.5-.8z"></path>',
  pulse: '<path d="M3.5 12.5h4L10 6.5l4 11 2.5-5h4"></path>',
  shortcut: '<path d="M6 18 18 6"></path><path d="M10 6h8v8"></path>',
};

// A macro's declared scope picks its starting glyph, so a dropped macro arrives looking like itself.
const SCOPE_ICONS = {
  dfm: "chart",
  "result selection": "check",
  result_selection: "check",
  "reserving class": "layers",
  reserving_class: "layers",
  project: "folder",
};

const ALLOWED_TAGS = new Set(["svg", "g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon"]);
const ALLOWED_ATTRIBUTES = new Set([
  "d", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2",
  "width", "height", "points", "transform", "opacity", "fill-rule", "clip-rule",
  "stroke-linecap", "stroke-linejoin", "stroke-width", "stroke-dasharray", "fill", "stroke",
]);
const VIEWBOX_PATTERN = /^-?[\d.]+\s+-?[\d.]+\s+-?[\d.]+\s+-?[\d.]+$/;
const PATH_DATA_PATTERN = /^[\sMmLlHhVvCcSsQqTtAaZz0-9,.\-+eE]+$/;

export const BUILTIN_ICON_NAMES = Object.keys(BUILTIN_ICONS);

export function defaultIconForScopes(scopes = []) {
  for (const scope of scopes) {
    const match = SCOPE_ICONS[String(scope || "").trim().toLowerCase()];
    if (match) return { kind: "builtin", name: match };
  }
  return { kind: "builtin", name: "bolt" };
}

// The glyph a new button starts with. A macro can name one in its own metadata block, so a shared
// macro arrives looking the same on every PC that loads it; a name the catalog does not hold, or
// no name at all, falls back to the scope glyph. Whatever a button ends up with is stored with the
// button, so changing it afterwards is never undone by the macro.
export function iconForMacro(macro) {
  const declared = String(macro?.icon || "").trim().toLowerCase();
  if (BUILTIN_ICONS[declared]) return { kind: "builtin", name: declared };
  const scopes = macro?.scopes ?? macro?.scope ?? [];
  return defaultIconForScopes(Array.isArray(scopes) ? scopes : [scopes]);
}

export function normalizeIcon(icon) {
  if (icon?.kind === "custom" && typeof icon.markup === "string" && icon.markup.trim()) {
    const safe = {
      kind: "custom",
      viewBox: VIEWBOX_PATTERN.test(String(icon.viewBox || "").trim()) ? String(icon.viewBox).trim() : BUILTIN_VIEWBOX,
      markup: icon.markup,
    };
    // A drawing keeps the pieces it was made of, so reopening the button carries on from where it
    // was left instead of starting again. Round-tripping them here checks they are still drawable.
    // `strokes` is what the first version of the pad wrote, before it had shape tools.
    const marks = packMarks(unpackMarks(icon.marks ?? icon.strokes));
    if (marks.length) safe.marks = marks;
    return safe;
  }
  const name = String(icon?.name || "").trim();
  return { kind: "builtin", name: BUILTIN_ICONS[name] ? name : "bolt" };
}

// Build the <svg> for one icon. Custom markup has already passed through `sanitizeCustomIcon`
// before it is stored, so this only has to place it inside a fresh element.
export function createIconElement(icon) {
  const safe = normalizeIcon(icon);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", safe.kind === "custom" ? safe.viewBox : BUILTIN_VIEWBOX);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add("flightDeckGlyph");
  if (safe.kind === "custom") svg.classList.add("custom");
  svg.innerHTML = safe.kind === "custom" ? safe.markup : BUILTIN_ICONS[safe.name];
  return svg;
}

function stripUnsafeNodes(root) {
  Array.from(root.children).forEach((child) => {
    const tag = child.tagName?.toLowerCase?.() || "";
    if (!ALLOWED_TAGS.has(tag)) {
      child.remove();
      return;
    }
    Array.from(child.attributes).forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      if (!ALLOWED_ATTRIBUTES.has(name)) child.removeAttribute(attribute.name);
      else if (/url\s*\(/i.test(attribute.value)) child.removeAttribute(attribute.name);
    });
    stripUnsafeNodes(child);
  });
}

// Accepts a whole <svg> document, a bare fragment of shapes, or raw path data, and returns a
// stored-icon record or an error explaining what was rejected. Scripts, event handlers, external
// references, and unknown elements never survive.
export function sanitizeCustomIcon(input) {
  const raw = String(input || "").trim();
  if (!raw) return { ok: false, error: "Paste an SVG drawing or path data first." };

  if (!raw.includes("<")) {
    if (!PATH_DATA_PATTERN.test(raw)) {
      return { ok: false, error: "That does not look like SVG markup or path data." };
    }
    return { ok: true, icon: { kind: "custom", viewBox: BUILTIN_VIEWBOX, markup: `<path d="${raw}"></path>` } };
  }

  const source = /<svg[\s>]/i.test(raw) ? raw : `<svg viewBox="${BUILTIN_VIEWBOX}">${raw}</svg>`;
  let doc = null;
  try {
    doc = new DOMParser().parseFromString(source, "image/svg+xml");
  } catch {
    return { ok: false, error: "The drawing could not be read as SVG." };
  }
  const svg = doc?.querySelector("svg");
  if (!svg || doc.querySelector("parsererror")) return { ok: false, error: "The drawing could not be read as SVG." };

  const viewBox = String(svg.getAttribute("viewBox") || "").trim();
  stripUnsafeNodes(svg);
  const markup = svg.innerHTML.trim();
  if (!markup) return { ok: false, error: "Nothing drawable was left after the drawing was cleaned up." };

  return {
    ok: true,
    icon: {
      kind: "custom",
      viewBox: VIEWBOX_PATTERN.test(viewBox) ? viewBox : BUILTIN_VIEWBOX,
      markup,
    },
  };
}

/* --------------------------------------------------------------- drawing pad */

// The square the drawing pad works in. Sketching straight into the icon's own coordinates keeps a
// hand-drawn glyph the same size and weight as a built-in one.
export const DRAW_CANVAS_SIZE = 24;
export const DRAW_VIEWBOX = BUILTIN_VIEWBOX;

// What one piece of a drawing can be. "pen" is a freehand line and the next three are dragged
// shapes; "path" is a piece of a built-in glyph that was put on the pad to be drawn over, kept as
// it was drawn by hand rather than picked apart into points.
export const DRAW_MARK_TOOLS = ["pen", "line", "box", "oval"];

// How near the eraser has to pass a piece of the drawing to take it away, in pad units.
export const DRAW_ERASER_RADIUS = 1.6;

// Custom icons are filled by the stylesheet because pasted drawings are usually solid shapes, so a
// sketched line has to carry its own stroke. These attributes all survive the sanitizer.
const DRAW_STROKE_ATTRIBUTES = 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';

// Points closer together than this add nothing but file size, and dropping them is what stops a
// slow, jittery hand from turning into a furry line.
const DRAW_MIN_STEP = 0.3;

// The caps are what stop a wild scribble, or a hand-edited preferences file, from growing without
// end; a drawing past them simply stops being re-editable, it never breaks the button.
const DRAW_MAX_MARKS = 96;
const DRAW_MAX_POINTS = 600;
const DRAW_MAX_PATH_LENGTH = 2000;

// How finely a dragged oval is chopped up when the eraser asks where its outline runs.
const OVAL_SEGMENTS = 36;

function drawNumber(value) {
  const rounded = Math.round(Number(value) * 100) / 100;
  return String(Number.isFinite(rounded) ? rounded : 0);
}

function clampToCanvas(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(DRAW_CANVAS_SIZE, Math.max(0, Math.round(number * 100) / 100));
}

function thinPoints(points) {
  const kept = [];
  (Array.isArray(points) ? points : []).forEach((point) => {
    const x = Number(point?.x);
    const y = Number(point?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const last = kept[kept.length - 1];
    if (last && Math.hypot(x - last.x, y - last.y) < DRAW_MIN_STEP) return;
    kept.push({ x, y });
  });
  return kept;
}

function at(point) {
  return `${drawNumber(point.x)} ${drawNumber(point.y)}`;
}

function corners(points) {
  const [a, b] = Array.isArray(points) ? points : [];
  if (!a || !b) return null;
  return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
}

// A freehand line of three points or more is drawn as quadratic curves through the midpoints,
// which is what turns a chain of pointer samples into a smooth line.
function penSubpath(points) {
  const pts = thinPoints(points);
  if (!pts.length) return "";
  const start = `M${at(pts[0])}`;
  if (pts.length === 1) return `${start}L${at(pts[0])}`;
  if (pts.length === 2) return `${start}L${at(pts[1])}`;

  let d = start;
  for (let i = 1; i < pts.length - 1; i += 1) {
    const mid = { x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 };
    d += `Q${at(pts[i])} ${at(mid)}`;
  }
  return `${d}L${at(pts[pts.length - 1])}`;
}

// Every piece of a drawing, shapes included, ends up as one subpath, so a whole icon stays a
// single element however many tools went into it.
function markToSubpath(mark) {
  if (mark?.tool === "path") return String(mark.d || "").trim();
  if (mark?.tool === "pen") return penSubpath(mark.points);

  const box = corners(mark?.points);
  if (!box) return "";
  const { x0, y0, x1, y1 } = box;
  if (mark.tool === "line") {
    const [a, b] = mark.points;
    return `M${at(a)}L${at(b)}`;
  }
  if (mark.tool === "box") {
    return `M${drawNumber(x0)} ${drawNumber(y0)}H${drawNumber(x1)}V${drawNumber(y1)}H${drawNumber(x0)}Z`;
  }
  if (mark.tool === "oval") {
    const rx = (x1 - x0) / 2;
    const ry = (y1 - y0) / 2;
    if (rx <= 0 || ry <= 0) return "";
    const cy = drawNumber((y0 + y1) / 2);
    const left = `${drawNumber(x0)} ${cy}`;
    const right = `${drawNumber(x1)} ${cy}`;
    const arc = `A${drawNumber(rx)} ${drawNumber(ry)} 0 1 0`;
    return `M${left}${arc} ${right}${arc} ${left}Z`;
  }
  return "";
}

export function marksToIconMarkup(marks) {
  const subpaths = (Array.isArray(marks) ? marks : []).map(markToSubpath).filter(Boolean);
  if (!subpaths.length) return "";
  return `<path d="${subpaths.join("")}" ${DRAW_STROKE_ATTRIBUTES}></path>`;
}

/* ------------------------------------------------------- storing a drawing */

// A drawing is kept beside its markup as one small record per piece - a tool name and either a
// flat `[x, y, x, y, ...]` list or a run of path data. That is small enough to sit in the
// preferences file and is all the pad needs to lay the drawing out again.

function flatToPoints(flat) {
  const points = [];
  if (!Array.isArray(flat)) return points;
  for (let i = 0; i + 1 < flat.length && points.length < DRAW_MAX_POINTS; i += 2) {
    const x = clampToCanvas(flat[i]);
    const y = clampToCanvas(flat[i + 1]);
    if (x !== null && y !== null) points.push({ x, y });
  }
  return points;
}

function safePathData(value) {
  const d = String(value || "").trim();
  if (!d || d.length > DRAW_MAX_PATH_LENGTH || !PATH_DATA_PATTERN.test(d)) return "";
  return d;
}

export function packMarks(marks) {
  const packed = [];
  (Array.isArray(marks) ? marks : []).slice(0, DRAW_MAX_MARKS).forEach((mark) => {
    if (mark?.tool === "path") {
      const d = safePathData(mark.d);
      if (d) packed.push({ t: "path", d });
      return;
    }
    if (!DRAW_MARK_TOOLS.includes(mark?.tool)) return;
    const points = mark.tool === "pen" ? thinPoints(mark.points) : (Array.isArray(mark.points) ? mark.points.slice(0, 2) : []);
    const flat = [];
    points.slice(0, DRAW_MAX_POINTS).forEach((point) => {
      const x = clampToCanvas(point.x);
      const y = clampToCanvas(point.y);
      if (x !== null && y !== null) flat.push(x, y);
    });
    if (mark.tool === "pen" ? flat.length >= 2 : flat.length === 4) packed.push({ t: mark.tool, p: flat });
  });
  return packed;
}

export function unpackMarks(packed) {
  const marks = [];
  (Array.isArray(packed) ? packed : []).slice(0, DRAW_MAX_MARKS).forEach((entry) => {
    // A drawing saved before the shape tools arrived is a bare list of points: a freehand line.
    if (Array.isArray(entry)) {
      const points = flatToPoints(entry);
      if (points.length) marks.push({ tool: "pen", points });
      return;
    }
    if (entry?.t === "path") {
      const d = safePathData(entry.d);
      if (d) marks.push({ tool: "path", d });
      return;
    }
    if (!DRAW_MARK_TOOLS.includes(entry?.t)) return;
    const points = flatToPoints(entry.p);
    if (entry.t === "pen" ? points.length : points.length >= 2) {
      marks.push({ tool: entry.t, points: entry.t === "pen" ? points : points.slice(0, 2) });
    }
  });
  return marks;
}

/* ------------------------------------------------------------- the eraser */

// Where a piece of the drawing runs, as a chain of points. A built-in glyph's own path data is too
// varied to walk here, so the pad measures those in the browser and hands the outline back.
function markOutline(mark) {
  if (mark?.tool === "path") return Array.isArray(mark.outline) ? mark.outline : [];
  if (mark?.tool === "pen") return thinPoints(mark.points);

  const box = corners(mark?.points);
  if (!box) return [];
  const { x0, y0, x1, y1 } = box;
  if (mark.tool === "line") return [mark.points[0], mark.points[1]];
  if (mark.tool === "box") return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }, { x: x0, y: y0 }];
  if (mark.tool === "oval") {
    const rx = (x1 - x0) / 2;
    const ry = (y1 - y0) / 2;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const outline = [];
    for (let i = 0; i <= OVAL_SEGMENTS; i += 1) {
      const angle = (i / OVAL_SEGMENTS) * Math.PI * 2;
      outline.push({ x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) });
    }
    return outline;
  }
  return [];
}

function distanceToSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return Math.hypot(point.x - a.x, point.y - a.y);
  let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared;
  t = Math.min(1, Math.max(0, t));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

export function markIsNear(mark, point, radius = DRAW_ERASER_RADIUS) {
  const outline = markOutline(mark);
  if (!outline.length) return false;
  if (outline.length === 1) return Math.hypot(point.x - outline[0].x, point.y - outline[0].y) <= radius;
  return outline.some((current, index) => index > 0 && distanceToSegment(point, outline[index - 1], current) <= radius);
}

// The eraser works by the piece, not by the pixel: whatever it is dragged across leaves the pad
// whole, which is the only thing that means anything for a drawing made of lines and shapes.
export function eraseMarksNear(marks, point, radius = DRAW_ERASER_RADIUS) {
  return (Array.isArray(marks) ? marks : []).filter((mark) => !markIsNear(mark, point, radius));
}

// A cut-off end shorter than this is a sliver the area eraser leaves behind, not a line worth
// keeping.
const DRAW_CUT_MIN_LENGTH = 0.5;

function lerp(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function chainLength(points) {
  return points.reduce((total, current, index) => (index ? total + Math.hypot(current.x - points[index - 1].x, current.y - points[index - 1].y) : 0), 0);
}

// The stretch of the segment a-b that lies inside the circle, as a pair of fractions along it,
// or null when the segment stays clear.
function segmentInsideCircle(a, b, center, radius) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const fx = a.x - center.x;
  const fy = a.y - center.y;
  const A = dx * dx + dy * dy;
  const B = 2 * (fx * dx + fy * dy);
  const C = fx * fx + fy * fy - radius * radius;
  if (!A) return C <= 0 ? [0, 1] : null;
  const discriminant = B * B - 4 * A * C;
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  const t0 = Math.max(0, (-B - root) / (2 * A));
  const t1 = Math.min(1, (-B + root) / (2 * A));
  return t0 < t1 ? [t0, t1] : null;
}

// The runs of a chain of points that lie outside the circle, cut exactly at its edge.
function chainOutsideCircle(outline, center, radius) {
  if (outline.length === 1) {
    return Math.hypot(outline[0].x - center.x, outline[0].y - center.y) <= radius ? [] : [outline.slice()];
  }
  const runs = [];
  let run = [];
  const flush = () => {
    if (run.length > 1) runs.push(run);
    run = [];
  };
  for (let i = 1; i < outline.length; i += 1) {
    const a = outline[i - 1];
    const b = outline[i];
    if (!run.length) run.push(a);
    const inside = segmentInsideCircle(a, b, center, radius);
    if (!inside) {
      run.push(b);
      continue;
    }
    const [t0, t1] = inside;
    if (t0 > 0) run.push(lerp(a, b, t0));
    flush();
    if (t1 < 1) run = [lerp(a, b, t1), b];
  }
  flush();
  return runs.filter((points) => chainLength(points) >= DRAW_CUT_MIN_LENGTH);
}

// The area eraser works by the pixel instead: only what the ring covers goes, and the rest of the
// piece stays. A cut line or box is left as straight lines, so its corners stay sharp; a pen
// stroke, an oval, or a glyph curve is left as freehand runs. A glyph curve the pad could not
// measure stays put, as it does under the other eraser.
export function cutMarksNear(marks, point, radius = DRAW_ERASER_RADIUS) {
  const out = [];
  (Array.isArray(marks) ? marks : []).forEach((mark) => {
    if (!markIsNear(mark, point, radius)) {
      out.push(mark);
      return;
    }
    const straight = mark.tool === "line" || mark.tool === "box";
    chainOutsideCircle(markOutline(mark), point, radius).forEach((points) => {
      if (!straight) {
        out.push({ tool: "pen", points });
        return;
      }
      for (let i = 1; i < points.length; i += 1) out.push({ tool: "line", points: [points[i - 1], points[i]] });
    });
  });
  return out.slice(0, DRAW_MAX_MARKS);
}

/* --------------------------------------------- a built-in glyph on the pad */

const GLYPH_SHAPE_PATTERN = /<(path|circle|ellipse|rect)\b([^>]*)>/g;

function shapeAttribute(source, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(source);
  return match ? Number(match[1]) : NaN;
}

// Take a built-in glyph apart into pieces the pad can hold, so a picked icon can be drawn over,
// added to, or partly erased instead of only replaced. Its own curves stay as path data; the
// plain shapes come back as the same boxes and ovals the shape tools produce.
export function builtinIconMarks(name) {
  const markup = BUILTIN_ICONS[String(name || "").trim()];
  if (!markup) return [];
  const marks = [];
  let match = null;
  GLYPH_SHAPE_PATTERN.lastIndex = 0;
  while ((match = GLYPH_SHAPE_PATTERN.exec(markup)) !== null) {
    const [, tag, attributes] = match;
    if (tag === "path") {
      const d = safePathData(/\bd\s*=\s*"([^"]*)"/.exec(attributes)?.[1]);
      // Each move-to starts a run of its own, so the eraser can take one line of a glyph without
      // taking the rest of it.
      d.split(/(?=M)/).map((piece) => piece.trim()).filter(Boolean).forEach((piece) => {
        marks.push({ tool: "path", d: piece });
      });
      continue;
    }
    if (tag === "rect") {
      const x = shapeAttribute(attributes, "x");
      const y = shapeAttribute(attributes, "y");
      const width = shapeAttribute(attributes, "width");
      const height = shapeAttribute(attributes, "height");
      if ([x, y, width, height].every(Number.isFinite)) {
        marks.push({ tool: "box", points: [{ x, y }, { x: x + width, y: y + height }] });
      }
      continue;
    }
    const cx = shapeAttribute(attributes, "cx");
    const cy = shapeAttribute(attributes, "cy");
    const rx = tag === "circle" ? shapeAttribute(attributes, "r") : shapeAttribute(attributes, "rx");
    const ry = tag === "circle" ? shapeAttribute(attributes, "r") : shapeAttribute(attributes, "ry");
    if ([cx, cy, rx, ry].every(Number.isFinite)) {
      marks.push({ tool: "oval", points: [{ x: cx - rx, y: cy - ry }, { x: cx + rx, y: cy + ry }] });
    }
  }
  return marks;
}

// Whatever the button shows now, laid out as pieces the pad can work on. A pasted drawing is the
// one thing that cannot be taken apart, so it comes back empty and the pad stays clear.
export function iconToMarks(icon) {
  const safe = normalizeIcon(icon);
  return safe.kind === "builtin" ? builtinIconMarks(safe.name) : unpackMarks(safe.marks);
}
