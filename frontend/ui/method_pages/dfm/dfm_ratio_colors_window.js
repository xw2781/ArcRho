/*
===============================================================================
DFM Ratios Custom Colors window - a non-modal floating window inside the DFM
page, opened from either Ratios table context menu.

One row per recolourable part of the Ratios tables: a preview cell, a Font and
a Fill swatch, and a reset for that row. A swatch opens a picker inside the
window with the named colours, Default, the system colour dialog and a hex box.
Every change is painted at once and saved; there is no OK step. The preview
and swatches show what the tables show, read from stand-in cells built inside
the live tables, so they follow the theme and table style without a copy of
their colours here.
===============================================================================
*/
import {
  DFM_RATIO_COLOR_COMPONENTS,
  DFM_RATIO_COLOR_GROUPS,
  DFM_RATIO_COLOR_PRESETS,
  findDfmRatioColorPreset,
  getDfmRatioColorComponent,
  normalizeDfmRatioColorHex,
  normalizeDfmRatioColors,
  resetDfmRatioColorComponent,
  setDfmRatioColor,
} from "/ui/method_pages/dfm/dfm_ratio_colors_model.js?v=20260924a";
import {
  getDfmRatioColors,
  setDfmRatioColors,
  subscribeDfmRatioColors,
} from "/ui/method_pages/dfm/dfm_ratio_colors.js?v=20260924a";
import { attachArcrhoTooltip } from "/ui/shared/components/tooltip/tooltip.js?v=20260812a";

const SAMPLE_VALUE = "1.052";
const PRESET_COLUMNS = 12;
const PROPERTY_LABELS = { font: "Font", fill: "Fill" };
const CLOSE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
const RESET_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.5 8a4.5 4.5 0 1 0 1.4-3.3"/><path d="M3.2 2.6v2.6h2.6"/></svg>';

let activeWindow = null;

/* --- reading what the tables show ---------------------------------------- */

function isTransparent(color) {
  return !color || color === "transparent" || /^rgba\([^)]*,\s*0\)$/u.test(color);
}

function effectiveSurface(element) {
  for (let node = element; node; node = node.parentElement) {
    const color = getComputedStyle(node).backgroundColor;
    if (!isTransparent(color)) return color;
  }
  return "";
}

function buildProbeTable(probe) {
  const table = document.createElement("table");
  table.className = `arSpreadsheetTable ${probe.table}`;
  const section = document.createElement(probe.header === "column" ? "thead" : "tbody");
  const row = document.createElement("tr");
  const cell = document.createElement(probe.header ? "th" : "td");
  if (probe.classes) cell.className = probe.classes;
  if (probe.header === "row") {
    row.append(cell, document.createElement("td"));
  } else {
    row.append(document.createElement("th"), cell);
  }
  section.appendChild(row);
  table.appendChild(section);
  return { table, cell };
}

/**
 * The colours each component shows now, read from stand-in cells placed in the
 * live Ratios tables for as long as it takes to read them. They sit in a
 * hidden holder, so they are never laid out or painted.
 */
function measureComponentLooks() {
  const looks = new Map();
  const wrap = document.getElementById("ratioWrap");
  if (!wrap) return looks;
  const surface = effectiveSurface(wrap) || getComputedStyle(document.body).backgroundColor;
  const holder = document.createElement("div");
  holder.hidden = true;
  const probes = DFM_RATIO_COLOR_COMPONENTS.map((component) => {
    const { table, cell } = buildProbeTable(component.probe);
    holder.appendChild(table);
    return { component, cell };
  });
  wrap.appendChild(holder);
  for (const { component, cell } of probes) {
    const style = getComputedStyle(cell);
    looks.set(component.id, {
      font: style.color,
      fill: isTransparent(style.backgroundColor) ? "" : style.backgroundColor,
      surface,
      fontStyle: style.fontStyle,
      fontWeight: style.fontWeight,
      decoration: style.textDecorationLine,
      decorationColor: style.textDecorationColor,
    });
  }
  holder.remove();
  return looks;
}

function paintFill(element, look) {
  element.style.backgroundColor = look.surface || "";
  element.style.backgroundImage = look.fill ? `linear-gradient(${look.fill}, ${look.fill})` : "";
}

/* --- the window ----------------------------------------------------------- */

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function buildRow(component) {
  const row = element("div", "dfmColorsRow");
  row.dataset.component = component.id;
  row.appendChild(element("span", "dfmColorsLabel", component.label));
  row.appendChild(element("span", "dfmColorsPreview", component.sample || SAMPLE_VALUE));
  for (const property of ["font", "fill"]) {
    if (!component.properties.includes(property)) {
      row.appendChild(element("span", "dfmColorsSwatchGap"));
      continue;
    }
    const button = element("button", "dfmColorsSwatchBtn");
    button.type = "button";
    button.dataset.property = property;
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-label", `${component.label} ${PROPERTY_LABELS[property].toLowerCase()} color`);
    button.appendChild(property === "font"
      ? element("span", "dfmColorsFontGlyph", "A")
      : element("span", "dfmColorsFillChip"));
    row.appendChild(button);
  }
  const reset = element("button", "dfmColorsRowReset");
  reset.type = "button";
  reset.innerHTML = RESET_ICON;
  reset.setAttribute("aria-label", `Reset ${component.label}`);
  attachArcrhoTooltip(reset, "Reset to default");
  row.appendChild(reset);
  return row;
}

function buildWindow() {
  const win = element("div", "dfmColorsWindow");
  win.setAttribute("role", "dialog");
  win.setAttribute("aria-label", "Custom Colors");
  win.innerHTML = `
    <div class="dfmColorsHeader">
      <span class="dfmColorsTitle">Custom Colors</span>
      <button type="button" class="dfmColorsClose" aria-label="Close">${CLOSE_ICON}</button>
    </div>
    <div class="dfmColorsBody">
      <div class="dfmColorsColumnLabels" aria-hidden="true">
        <span></span><span>Preview</span><span>Font</span><span>Fill</span><span></span>
      </div>
    </div>
    <div class="dfmColorsFooter">
      <button type="button" class="dfmColorsBtn" data-action="reset-all">Reset all</button>
      <button type="button" class="dfmColorsBtn" data-action="close">Close</button>
    </div>
    <div class="dfmColorsPicker" role="dialog" hidden>
      <div class="dfmColorsPresetGrid" role="group" aria-label="Named colors"></div>
      <div class="dfmColorsPickerName" aria-live="polite"></div>
      <div class="dfmColorsPickerCustom">
        <button type="button" class="dfmColorsBtn dfmColorsDefaultBtn">Default</button>
        <input type="color" class="dfmColorsNativeInput" aria-label="Any color" />
        <input type="text" class="dfmColorsHexInput" aria-label="Hex color" placeholder="#rrggbb" maxlength="9" autocomplete="off" spellcheck="false" />
      </div>
      <div class="dfmColorsHexError" role="alert" hidden>Use #rgb, #rrggbb or #rrggbbaa.</div>
    </div>`;
  const body = win.querySelector(".dfmColorsBody");
  for (const group of DFM_RATIO_COLOR_GROUPS) {
    const components = DFM_RATIO_COLOR_COMPONENTS.filter((component) => component.group === group.id);
    if (!components.length) continue;
    body.appendChild(element("div", "dfmColorsGroupLabel", group.label));
    for (const component of components) body.appendChild(buildRow(component));
  }
  const grid = win.querySelector(".dfmColorsPresetGrid");
  DFM_RATIO_COLOR_PRESETS.forEach((preset, index) => {
    const swatch = element("button", "dfmColorsPreset");
    swatch.type = "button";
    swatch.dataset.hex = preset.hex;
    swatch.dataset.index = String(index);
    swatch.style.backgroundColor = preset.hex;
    swatch.tabIndex = -1;
    swatch.setAttribute("aria-label", preset.name);
    swatch.setAttribute("aria-pressed", "false");
    attachArcrhoTooltip(swatch, preset.name);
    grid.appendChild(swatch);
  });
  return win;
}

function placeWindow(win) {
  const left = Math.max(8, window.innerWidth - win.offsetWidth - 16);
  const top = Math.max(8, Math.min(48, window.innerHeight - win.offsetHeight - 8));
  win.style.left = `${left}px`;
  win.style.top = `${top}px`;
}

function makeHeaderDraggable(header, win) {
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let frame = { left: 0, top: 0 };

  const onMove = (event) => {
    if (event.pointerId !== pointerId) return;
    // The header stays reachable: the window never leaves the page's viewport.
    const maxLeft = Math.max(0, window.innerWidth - win.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - win.offsetHeight);
    frame = {
      left: Math.max(0, Math.min(maxLeft, frame.left + (event.clientX - startX))),
      top: Math.max(0, Math.min(maxTop, frame.top + (event.clientY - startY))),
    };
    startX = event.clientX;
    startY = event.clientY;
    win.style.left = `${frame.left}px`;
    win.style.top = `${frame.top}px`;
  };
  const stop = (event) => {
    if (pointerId == null) return;
    if (event && event.pointerId != null && event.pointerId !== pointerId) return;
    try { header.releasePointerCapture(pointerId); } catch { /* already released */ }
    pointerId = null;
    header.removeEventListener("pointermove", onMove);
    header.removeEventListener("pointerup", stop);
    header.removeEventListener("pointercancel", stop);
    header.removeEventListener("lostpointercapture", stop);
  };

  header.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || pointerId != null || event.target.closest("button")) return;
    event.preventDefault();
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    const rect = win.getBoundingClientRect();
    frame = { left: rect.left, top: rect.top };
    try { header.setPointerCapture(event.pointerId); } catch { /* capture unsupported */ }
    header.addEventListener("pointermove", onMove);
    header.addEventListener("pointerup", stop);
    header.addEventListener("pointercancel", stop);
    header.addEventListener("lostpointercapture", stop);
  });

  return stop;
}

/** Opens the window, or brings the open one forward. */
export function openDfmRatioColorsWindow() {
  if (activeWindow) {
    activeWindow.focus();
    return;
  }
  const win = buildWindow();
  document.body.appendChild(win);
  placeWindow(win);
  const stopDrag = makeHeaderDraggable(win.querySelector(".dfmColorsHeader"), win);

  const picker = win.querySelector(".dfmColorsPicker");
  const grid = picker.querySelector(".dfmColorsPresetGrid");
  const presets = Array.from(grid.querySelectorAll(".dfmColorsPreset"));
  const nameEl = picker.querySelector(".dfmColorsPickerName");
  const nativeInput = picker.querySelector(".dfmColorsNativeInput");
  const hexInput = picker.querySelector(".dfmColorsHexInput");
  const hexError = picker.querySelector(".dfmColorsHexError");
  let target = null; // { id, property, button } while the picker is open
  let hoveredPreset = null;

  function currentHex(id, property) {
    return getDfmRatioColors().components[id]?.[property] || "";
  }

  function render() {
    const prefs = getDfmRatioColors();
    const looks = measureComponentLooks();
    win.querySelectorAll(".dfmColorsRow").forEach((row) => {
      const id = row.dataset.component;
      const look = looks.get(id);
      const preview = row.querySelector(".dfmColorsPreview");
      if (look) {
        preview.style.color = look.font;
        preview.style.fontStyle = look.fontStyle;
        preview.style.fontWeight = look.fontWeight;
        preview.style.textDecorationLine = look.decoration;
        preview.style.textDecorationColor = look.decorationColor;
        paintFill(preview, look);
        const fontBtn = row.querySelector('.dfmColorsSwatchBtn[data-property="font"]');
        if (fontBtn) fontBtn.style.setProperty("--dfm-colors-swatch", look.font);
        const fillChip = row.querySelector(".dfmColorsFillChip");
        if (fillChip) paintFill(fillChip, look);
      }
      row.querySelector(".dfmColorsRowReset").disabled = !prefs.components[id];
      row.querySelectorAll(".dfmColorsSwatchBtn").forEach((button) => {
        button.classList.toggle("isCustom", !!prefs.components[id]?.[button.dataset.property]);
      });
    });
    win.querySelector('[data-action="reset-all"]').disabled = !Object.keys(prefs.components).length;
    if (target) renderPicker();
  }

  function renderPicker() {
    const hex = currentHex(target.id, target.property);
    const selected = findDfmRatioColorPreset(hex);
    presets.forEach((swatch) => {
      swatch.setAttribute("aria-pressed", String(swatch.dataset.hex === hex));
    });
    const shown = hoveredPreset
      ? DFM_RATIO_COLOR_PRESETS[Number(hoveredPreset.dataset.index)]
      : selected;
    nameEl.textContent = shown
      ? `${shown.name}  ${shown.hex}`
      : (hex ? `Custom  ${hex}` : "Default");
    nativeInput.value = (hex || "#000000").slice(0, 7);
    if (document.activeElement !== hexInput) {
      hexInput.value = hex;
      hexError.hidden = true;
    }
  }

  function apply(hex) {
    if (!target) return;
    setDfmRatioColors(setDfmRatioColor(getDfmRatioColors(), target.id, target.property, hex));
  }

  function openPicker(button) {
    const row = button.closest(".dfmColorsRow");
    if (target?.button === button) {
      closePicker({ restoreFocus: true });
      return;
    }
    closePicker();
    target = { id: row.dataset.component, property: button.dataset.property, button };
    const component = getDfmRatioColorComponent(target.id);
    picker.setAttribute("aria-label", `${component.label} ${PROPERTY_LABELS[target.property].toLowerCase()} color`);
    button.setAttribute("aria-expanded", "true");
    hoveredPreset = null;
    hexInput.value = "";
    picker.hidden = false;
    renderPicker();
    // Below the swatch, or above it when the page ends first; kept inside the
    // window's width either way.
    const winRect = win.getBoundingClientRect();
    const anchor = button.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.right - winRect.left - picker.offsetWidth, win.clientWidth - picker.offsetWidth - 8));
    const below = anchor.bottom + 4 + picker.offsetHeight <= window.innerHeight;
    picker.style.left = `${left}px`;
    picker.style.top = `${(below ? anchor.bottom + 4 : anchor.top - 4 - picker.offsetHeight) - winRect.top}px`;
    const selected = presets.find((swatch) => swatch.getAttribute("aria-pressed") === "true") || presets[0];
    focusPreset(selected);
  }

  function closePicker({ restoreFocus = false } = {}) {
    if (!target) return;
    const { button } = target;
    button.setAttribute("aria-expanded", "false");
    picker.hidden = true;
    target = null;
    hoveredPreset = null;
    if (restoreFocus) button.focus();
  }

  function focusPreset(swatch) {
    presets.forEach((item) => { item.tabIndex = item === swatch ? 0 : -1; });
    swatch.focus();
  }

  function commitHexText({ closeWhenValid }) {
    const text = hexInput.value.trim();
    const hex = normalizeDfmRatioColorHex(text);
    hexError.hidden = !text || !!hex;
    if (!hex) return;
    apply(hex);
    if (closeWhenValid) closePicker({ restoreFocus: true });
  }

  const unsubscribe = subscribeDfmRatioColors(render);
  const onThemeChanged = () => render();
  window.addEventListener("arcrho:color-theme-changed", onThemeChanged);
  window.addEventListener("arcrho:table-style-changed", onThemeChanged);

  const onDocumentPointerDown = (event) => {
    if (!target || picker.contains(event.target) || target.button.contains(event.target)) return;
    closePicker();
  };
  document.addEventListener("pointerdown", onDocumentPointerDown, true);

  function close() {
    closePicker();
    stopDrag();
    unsubscribe();
    window.removeEventListener("arcrho:color-theme-changed", onThemeChanged);
    window.removeEventListener("arcrho:table-style-changed", onThemeChanged);
    document.removeEventListener("pointerdown", onDocumentPointerDown, true);
    win.remove();
    activeWindow = null;
  }

  win.addEventListener("click", (event) => {
    const swatchBtn = event.target.closest(".dfmColorsSwatchBtn");
    if (swatchBtn) {
      openPicker(swatchBtn);
      return;
    }
    const reset = event.target.closest(".dfmColorsRowReset");
    if (reset) {
      const id = reset.closest(".dfmColorsRow").dataset.component;
      setDfmRatioColors(resetDfmRatioColorComponent(getDfmRatioColors(), id));
      return;
    }
    const preset = event.target.closest(".dfmColorsPreset");
    if (preset) {
      apply(preset.dataset.hex);
      closePicker({ restoreFocus: true });
      return;
    }
    if (event.target.closest(".dfmColorsDefaultBtn")) {
      apply("");
      closePicker({ restoreFocus: true });
      return;
    }
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "reset-all") {
      closePicker();
      setDfmRatioColors(normalizeDfmRatioColors(null));
    } else if (action === "close" || event.target.closest(".dfmColorsClose")) {
      close();
    }
  });

  grid.addEventListener("pointerover", (event) => {
    hoveredPreset = event.target.closest(".dfmColorsPreset");
    renderPicker();
  });
  grid.addEventListener("pointerleave", () => {
    hoveredPreset = grid.contains(document.activeElement) ? document.activeElement : null;
    renderPicker();
  });
  grid.addEventListener("focusin", (event) => {
    hoveredPreset = event.target.closest(".dfmColorsPreset");
    renderPicker();
  });
  grid.addEventListener("keydown", (event) => {
    const index = presets.indexOf(document.activeElement);
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -PRESET_COLUMNS, ArrowDown: PRESET_COLUMNS }[event.key];
    if (index < 0 || !step) return;
    event.preventDefault();
    const next = presets[index + step];
    if (next) focusPreset(next);
  });

  nativeInput.addEventListener("input", () => apply(nativeInput.value));
  hexInput.addEventListener("input", () => {
    const hex = normalizeDfmRatioColorHex(hexInput.value);
    if (!hex) return;
    hexError.hidden = true;
    apply(hex);
  });
  hexInput.addEventListener("change", () => commitHexText({ closeWhenValid: false }));
  hexInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    commitHexText({ closeWhenValid: true });
  });

  picker.addEventListener("focusout", (event) => {
    if (target && event.relatedTarget && !picker.contains(event.relatedTarget)) closePicker();
  });

  // The window answers its own keys; none reach the Ratios tables behind it.
  win.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key !== "Escape") return;
    event.preventDefault();
    if (target) closePicker({ restoreFocus: true });
    else close();
  });

  activeWindow = {
    focus() {
      win.parentElement?.appendChild(win);
      win.querySelector(".dfmColorsSwatchBtn")?.focus();
    },
  };
  render();
  win.querySelector(".dfmColorsSwatchBtn")?.focus();
}
