/*
===============================================================================
Number Format dialog - the Excel "Format Cells" number pane, as a small window
that floats inside the tab that opened it.

The pattern codes it writes are Excel's own, so a format chosen here reads the
same way in a spreadsheet as it does in the grid. Everything the categories can
produce is built by `buildNumberFormatCode`, and `detectNumberFormatState` reads
a stored pattern back by rebuilding candidates until one matches - which keeps
the two directions from drifting apart the way a parser would.
===============================================================================
*/
import {
  clampDatasetDecimalPlaces,
  datasetNumberValueColor,
  formatDatasetNumberValue,
  getDatasetNumberFormatDecimalPlaces,
  normalizeDatasetNumberFormat,
} from "/ui/shared/dataset/dataset_number_format.js";

export const NUMBER_FORMAT_CATEGORIES = [
  { key: "general", label: "General" },
  { key: "number", label: "Number" },
  { key: "currency", label: "Currency" },
  { key: "accounting", label: "Accounting" },
  { key: "percentage", label: "Percentage" },
  { key: "scientific", label: "Scientific" },
  { key: "custom", label: "Custom" },
];

export const NUMBER_FORMAT_SYMBOLS = [
  { label: "None", value: "" },
  { label: "$", value: "$" },
  { label: "£", value: "£" },
  { label: "€", value: "€" },
  { label: "¥", value: "¥" },
];

// Excel's four negative presentations, in Excel's order.
const NEGATIVE_STYLES = [0, 1, 2, 3];

// The codes the Custom list offers, over and above whatever the other
// categories can build.
const CUSTOM_CODE_SUGGESTIONS = [
  "General",
  "0",
  "0.00",
  "#,##0",
  "#,##0.00",
  "#,##0;[Red]-#,##0",
  "#,##0;(#,##0)",
  "#,##0.00;[Red](#,##0.00)",
  "0%",
  "0.00%",
  "0.00E+00",
  "#,##0,\"K\"",
  "#,##0,,\"M\"",
  "#,##0.0\"x\"",
  "0.0000",
];

const MAX_CODE_LENGTH = 64;
const SAMPLE_VALUE = 1234.5678;

function numberPattern(decimals, separator) {
  const head = separator ? "#,##0" : "0";
  return decimals > 0 ? `${head}.${"0".repeat(decimals)}` : head;
}

function withNegativeStyle(pattern, style) {
  if (style === 1) return `${pattern};[Red]${pattern}`;
  if (style === 2) return `${pattern};(${pattern})`;
  if (style === 3) return `${pattern};[Red](${pattern})`;
  return pattern;
}

function accountingCode(decimals, symbol) {
  const body = numberPattern(decimals, true);
  const lead = symbol ? `${symbol}* ` : "* ";
  return `_(${lead}${body}_);_(${lead}(${body});_(${lead}"-"??_);_(@_)`;
}

export function buildNumberFormatCode(state) {
  const decimals = clampDatasetDecimalPlaces(state.decimals);
  switch (state.category) {
    case "general":
      return "General";
    case "number":
      return withNegativeStyle(numberPattern(decimals, state.separator !== false), state.negative || 0);
    case "currency":
      return withNegativeStyle(`${state.symbol || ""}${numberPattern(decimals, true)}`, state.negative || 0);
    case "accounting":
      return accountingCode(decimals, state.symbol || "");
    case "percentage":
      return decimals > 0 ? `0.${"0".repeat(decimals)}%` : "0%";
    case "scientific":
      return decimals > 0 ? `0.${"0".repeat(decimals)}E+00` : "0E+00";
    default:
      return normalizeDatasetNumberFormat(state.code);
  }
}

function defaultState() {
  return { category: "number", decimals: 2, separator: true, negative: 0, symbol: "$", code: "" };
}

// A pattern is recognised by rebuilding every code a category can produce and
// comparing, so the dialog can never claim a category it would not write back.
export function detectNumberFormatState(value) {
  const code = normalizeDatasetNumberFormat(value);
  const state = { ...defaultState(), code };
  if (code.trim().toLowerCase() === "general") return { ...state, category: "general" };
  // The app's own long-standing patterns mean what Excel writes as `#,##0`.
  const target = code.replace(/0,000/g, "#,##0");
  for (let decimals = 0; decimals <= 6; decimals += 1) {
    const seed = { ...state, decimals };
    if (buildNumberFormatCode({ ...seed, category: "percentage" }) === target) {
      return { ...seed, category: "percentage" };
    }
    if (buildNumberFormatCode({ ...seed, category: "scientific" }) === target) {
      return { ...seed, category: "scientific" };
    }
    for (const separator of [true, false]) {
      for (const negative of NEGATIVE_STYLES) {
        if (buildNumberFormatCode({ ...seed, category: "number", separator, negative }) === target) {
          return { ...seed, category: "number", separator, negative };
        }
      }
    }
    for (const symbol of NUMBER_FORMAT_SYMBOLS) {
      if (buildNumberFormatCode({ ...seed, category: "accounting", symbol: symbol.value }) === target) {
        return { ...seed, category: "accounting", symbol: symbol.value };
      }
      for (const negative of NEGATIVE_STYLES) {
        const candidate = { ...seed, category: "currency", symbol: symbol.value, negative };
        if (symbol.value && buildNumberFormatCode(candidate) === target) return candidate;
      }
    }
  }
  return { ...state, category: "custom", decimals: getDatasetNumberFormatDecimalPlaces(code) };
}

/* --- the window ----------------------------------------------------------- */

const CLOSE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

function element(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html != null) node.innerHTML = html;
  return node;
}

function stepperMarkup(id, label) {
  return `
    <div class="decimalPlacesWrap">
      <input id="${id}" type="number" min="0" max="6" value="0" aria-label="${label}" />
      <div class="decimalPlacesStepper">
        <button class="decimalPlacesStepBtn" type="button" data-step="1" aria-label="Increase ${label}">
          <span class="datasetStepperCaret datasetStepperCaretUp" aria-hidden="true"></span>
        </button>
        <button class="decimalPlacesStepBtn" type="button" data-step="-1" aria-label="Decrease ${label}">
          <span class="datasetStepperCaret" aria-hidden="true"></span>
        </button>
      </div>
    </div>`;
}

function buildLayer() {
  const layer = element("div", "arFormatDialogLayer");
  layer.hidden = true;
  layer.innerHTML = `
    <div class="arFormatDialogBackdrop"></div>
    <div class="arFormatDialog" role="dialog" aria-modal="true" aria-label="Number Format">
      <div class="arFormatDialogHeader">
        <span class="arFormatDialogTitle">Number Format</span>
        <button type="button" class="arFormatDialogClose" aria-label="Close">${CLOSE_ICON}</button>
      </div>
      <div class="arFormatDialogBody">
        <div class="arFormatDialogCategoryPane">
          <div class="arFormatDialogPaneLabel">Category</div>
          <div class="arFormatDialogCategoryList" role="listbox" aria-label="Category"></div>
        </div>
        <div class="arFormatDialogOptionPane">
          <div class="arFormatDialogPaneLabel">Sample</div>
          <div class="arFormatDialogSample"></div>
          <div class="arFormatDialogOptions"></div>
        </div>
      </div>
      <div class="arFormatDialogFooter">
        <span class="arFormatDialogCodeLabel">Code</span>
        <span class="arFormatDialogCode"></span>
        <div class="arFormatDialogActions">
          <button type="button" class="arFormatDialogBtn" data-action="cancel">Cancel</button>
          <button type="button" class="arFormatDialogBtn arFormatDialogBtnPrimary" data-action="ok">OK</button>
        </div>
      </div>
    </div>`;
  return layer;
}

function makeHeaderDraggable(header, win) {
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let frame = { left: 0, top: 0 };

  const onMove = (event) => {
    if (event.pointerId !== pointerId) return;
    // The window is clipped by the tab that holds it, so a drag stops at the
    // tab's edges rather than pushing it somewhere it cannot be dragged back.
    const bounds = win.offsetParent?.getBoundingClientRect();
    const maxLeft = Math.max(0, (bounds?.width || 0) - win.offsetWidth);
    const maxTop = Math.max(0, (bounds?.height || 0) - win.offsetHeight);
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
    const parent = win.offsetParent?.getBoundingClientRect() || { left: 0, top: 0 };
    frame = { left: rect.left - parent.left, top: rect.top - parent.top };
    win.style.left = `${frame.left}px`;
    win.style.top = `${frame.top}px`;
    win.style.transform = "none";
    try { header.setPointerCapture(event.pointerId); } catch { /* capture unsupported */ }
    header.addEventListener("pointermove", onMove);
    header.addEventListener("pointerup", stop);
    header.addEventListener("pointercancel", stop);
    header.addEventListener("lostpointercapture", stop);
  });

  return stop;
}

/**
 * Opens the dialog inside `host`, seeded with `value`. `onApply` receives the
 * chosen pattern; cancelling calls nothing. One dialog is built per host and
 * reused, so reopening it costs nothing.
 */
export function openNumberFormatDialog({ host, value, sampleValue, onApply } = {}) {
  if (!host) return null;
  let layer = host.querySelector(":scope > .arFormatDialogLayer");
  if (!layer) {
    layer = buildLayer();
    host.appendChild(layer);
    makeHeaderDraggable(layer.querySelector(".arFormatDialogHeader"), layer.querySelector(".arFormatDialog"));
  }

  const win = layer.querySelector(".arFormatDialog");
  const categoryList = layer.querySelector(".arFormatDialogCategoryList");
  const optionsHost = layer.querySelector(".arFormatDialogOptions");
  const sampleEl = layer.querySelector(".arFormatDialogSample");
  const codeEl = layer.querySelector(".arFormatDialogCode");
  const sample = Number.isFinite(Number(sampleValue)) && Number(sampleValue) !== 0
    ? Number(sampleValue)
    : SAMPLE_VALUE;

  const state = detectNumberFormatState(value);
  let disposed = false;

  function currentCode() {
    return buildNumberFormatCode(state).slice(0, MAX_CODE_LENGTH);
  }

  function renderSample() {
    const code = currentCode();
    sampleEl.textContent = formatDatasetNumberValue(sample, code);
    sampleEl.style.color = datasetNumberValueColor(sample, code) || "";
    codeEl.textContent = code;
  }

  function renderCategories() {
    categoryList.innerHTML = "";
    for (const category of NUMBER_FORMAT_CATEGORIES) {
      const row = element("div", "arFormatDialogCategory");
      row.setAttribute("role", "option");
      row.dataset.category = category.key;
      row.textContent = category.label;
      row.setAttribute("aria-selected", String(category.key === state.category));
      if (category.key === state.category) row.classList.add("selected");
      categoryList.appendChild(row);
    }
  }

  function decimalsRow(label = "Decimal Places") {
    const row = element("div", "arFormatDialogRow");
    row.appendChild(element("span", "arFormatDialogRowLabel", `${label} : `));
    const wrap = element("div", "arFormatDialogRowField", stepperMarkup("arFormatDialogDecimals", label));
    row.appendChild(wrap);
    const input = wrap.querySelector("input");
    input.value = String(clampDatasetDecimalPlaces(state.decimals));
    const commit = (next) => {
      state.decimals = clampDatasetDecimalPlaces(next);
      input.value = String(state.decimals);
      renderOptions();
      renderSample();
    };
    input.addEventListener("input", () => commit(input.value));
    for (const button of wrap.querySelectorAll(".decimalPlacesStepBtn")) {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        commit(clampDatasetDecimalPlaces(state.decimals) + Number(button.dataset.step));
      });
    }
    return row;
  }

  function separatorRow() {
    const row = element("div", "arFormatDialogRow");
    row.appendChild(element("span", "arFormatDialogRowLabel", ""));
    const field = element("label", "arFormatDialogCheck");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = state.separator !== false;
    box.addEventListener("change", () => {
      state.separator = box.checked;
      renderSample();
    });
    field.appendChild(box);
    field.appendChild(element("span", null, "Use 1000 Separator (,)"));
    row.appendChild(field);
    return row;
  }

  function symbolRow() {
    const row = element("div", "arFormatDialogRow");
    row.appendChild(element("span", "arFormatDialogRowLabel", "Symbol : "));
    const field = element("div", "arFormatDialogRowField");
    const select = document.createElement("select");
    select.className = "arFormatDialogSelect";
    select.setAttribute("aria-label", "Symbol");
    for (const symbol of NUMBER_FORMAT_SYMBOLS) {
      const option = document.createElement("option");
      option.value = symbol.value;
      option.textContent = symbol.label;
      if (symbol.value === (state.symbol || "")) option.selected = true;
      select.appendChild(option);
    }
    select.addEventListener("change", () => {
      state.symbol = select.value;
      renderOptions();
      renderSample();
    });
    field.appendChild(select);
    row.appendChild(field);
    return row;
  }

  function negativeRow(category) {
    const row = element("div", "arFormatDialogRow arFormatDialogRowStacked");
    row.appendChild(element("span", "arFormatDialogRowLabel", "Negative Numbers : "));
    const list = element("div", "arFormatDialogNegativeList");
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Negative Numbers");
    for (const style of NEGATIVE_STYLES) {
      const code = buildNumberFormatCode({ ...state, category, negative: style });
      const option = element("div", "arFormatDialogNegative");
      option.setAttribute("role", "option");
      option.textContent = formatDatasetNumberValue(-Math.abs(sample), code);
      option.style.color = datasetNumberValueColor(-1, code) || "";
      option.setAttribute("aria-selected", String(style === (state.negative || 0)));
      if (style === (state.negative || 0)) option.classList.add("selected");
      option.addEventListener("click", () => {
        state.negative = style;
        renderOptions();
        renderSample();
      });
      list.appendChild(option);
    }
    row.appendChild(list);
    return row;
  }

  function customRows() {
    const rows = [];
    const typeRow = element("div", "arFormatDialogRow");
    typeRow.appendChild(element("span", "arFormatDialogRowLabel", "Type : "));
    const field = element("div", "arFormatDialogRowField");
    const input = document.createElement("input");
    input.type = "text";
    input.className = "arFormatDialogCodeInput";
    input.maxLength = MAX_CODE_LENGTH;
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("aria-label", "Format code");
    input.value = state.code || buildNumberFormatCode({ ...state, category: "number" });
    state.code = input.value;
    input.addEventListener("input", () => {
      state.code = input.value;
      renderSample();
    });
    field.appendChild(input);
    typeRow.appendChild(field);
    rows.push(typeRow);

    const listRow = element("div", "arFormatDialogRow arFormatDialogRowStacked");
    listRow.appendChild(element("span", "arFormatDialogRowLabel", ""));
    const list = element("div", "arFormatDialogCodeList");
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Format codes");
    for (const code of CUSTOM_CODE_SUGGESTIONS) {
      const option = element("div", "arFormatDialogCodeOption");
      option.setAttribute("role", "option");
      option.textContent = code;
      option.title = code;
      option.addEventListener("click", () => {
        state.code = code;
        input.value = code;
        renderSample();
      });
      list.appendChild(option);
    }
    listRow.appendChild(list);
    rows.push(listRow);
    return rows;
  }

  function renderOptions() {
    optionsHost.innerHTML = "";
    if (state.category === "general") {
      optionsHost.appendChild(element(
        "p",
        "arFormatDialogNote",
        "General cells have no specific number format: a value is shown as it was entered.",
      ));
      return;
    }
    if (state.category === "custom") {
      for (const row of customRows()) optionsHost.appendChild(row);
      return;
    }
    optionsHost.appendChild(decimalsRow());
    if (state.category === "number") {
      optionsHost.appendChild(separatorRow());
      optionsHost.appendChild(negativeRow("number"));
    } else if (state.category === "currency") {
      optionsHost.appendChild(symbolRow());
      optionsHost.appendChild(negativeRow("currency"));
    } else if (state.category === "accounting") {
      optionsHost.appendChild(symbolRow());
      optionsHost.appendChild(element(
        "p",
        "arFormatDialogNote",
        "Accounting lines up currency symbols and decimal points in a column.",
      ));
    }
  }

  function close() {
    if (disposed) return;
    disposed = true;
    layer.hidden = true;
    document.removeEventListener("keydown", onKeyDown, true);
  }

  function commit() {
    const code = currentCode();
    close();
    onApply?.(normalizeDatasetNumberFormat(code));
  }

  function onKeyDown(event) {
    if (layer.hidden) return;
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    } else if (event.key === "Enter" && !event.target.closest(".arFormatDialogCodeList")) {
      event.preventDefault();
      commit();
    }
  }

  categoryList.onclick = (event) => {
    const row = event.target.closest(".arFormatDialogCategory");
    if (!row) return;
    // Custom opens on the code the category being left would have written, the
    // way Excel hands the built code over for editing.
    const leaving = currentCode();
    state.category = row.dataset.category;
    if (state.category === "custom") state.code = leaving;
    renderCategories();
    renderOptions();
    renderSample();
  };
  layer.querySelector(".arFormatDialogBackdrop").onclick = () => close();
  layer.querySelector(".arFormatDialogClose").onclick = () => close();
  layer.querySelector('[data-action="cancel"]').onclick = () => close();
  layer.querySelector('[data-action="ok"]').onclick = () => commit();

  renderCategories();
  renderOptions();
  renderSample();
  layer.hidden = false;
  // Reopening always starts centred: a window left at the edge of a narrower
  // tab would otherwise open out of reach.
  win.style.left = "";
  win.style.top = "";
  win.style.transform = "";
  document.addEventListener("keydown", onKeyDown, true);
  (optionsHost.querySelector("input, select") || win.querySelector('[data-action="ok"]'))?.focus();

  return { close };
}
