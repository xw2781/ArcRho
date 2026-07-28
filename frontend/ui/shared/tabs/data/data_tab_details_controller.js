// Owns formula/dependency details, audit presentation, and Data-tab chrome.

export function registerDataTabDetailsController(runtime) {
  const { DATASET_VIEWER_TAB_IDS, instanceId, isProjectInstanceHost, qs } = runtime;
  const defer = (name) => (...args) => runtime[name](...args);
  const { getDataTabAuditController, normalizeProjectText, getDatasetTypeFormulaByName, getBerquistShermanContract, setStatus, buildDatasetSidecarContextPayload, renderTable } = new Proxy({}, { get: (_target, name) => defer(name) });
  let datasetAuditLog = null;

  function getDatasetAuditLog() {
    if (!datasetAuditLog) datasetAuditLog = getDataTabAuditController();
    return datasetAuditLog;
  }

  function renderDatasetAuditLog(entries = []) {
    getDatasetAuditLog()?.render(entries);
  }

  function normalizeDatasetDependencyEntries(entries = []) {
    if (!Array.isArray(entries)) return [];
    const seen = new Set();
    return entries
      .map((entry) => {
        const source = entry && typeof entry === "object" ? entry : { dataset_type_name: entry };
        const datasetName = String(
          source.dataset_name
            ?? source.datasetName
            ?? source.dataset_type_name
            ?? source.datasetTypeName
            ?? source.name
            ?? "",
        ).trim();
        const datasetTypeName = String(
          source.dataset_type_name
            ?? source.datasetTypeName
            ?? source.dataset_type
            ?? source.datasetType
            ?? datasetName,
        ).trim();
        const name = datasetName || datasetTypeName;
        if (!name) return null;
        const key = normalizeProjectText(name);
        if (seen.has(key)) return null;
        seen.add(key);
        return {
          datasetName: name,
          datasetTypeName: datasetTypeName || name,
          formula: String(source.formula ?? source.Formula ?? "").trim(),
          methodType: String(source.method_type ?? source.methodType ?? "").trim(),
        };
      })
      .filter(Boolean);
  }

  function escapeFormulaRegExp(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function getFormulaComponentNames(precedents = []) {
    const names = [];
    const seen = new Set();
    const add = (value) => {
      const text = String(value || "").trim();
      const key = normalizeProjectText(text);
      if (!text || !key || seen.has(key)) return;
      seen.add(key);
      names.push(text);
    };
    for (const entry of normalizeDatasetDependencyEntries(precedents)) {
      add(entry.datasetName);
      add(entry.datasetTypeName);
    }
    for (const name of runtime.allDatasetTypes) add(name);
    return names.sort((a, b) => b.length - a.length);
  }

  function findFormulaComponentMatches(formula, precedents = []) {
    const text = String(formula || "");
    if (!text.trim()) return [];
    const names = getFormulaComponentNames(precedents);
    const matches = [];

    const quotedRe = /"([^"]+)"/g;
    let quotedMatch;
    while ((quotedMatch = quotedRe.exec(text)) !== null) {
      const token = String(quotedMatch[1] || "").trim();
      if (!token) continue;
      matches.push({
        start: quotedMatch.index,
        end: quotedMatch.index + String(quotedMatch[0] || "").length,
        token,
      });
    }

    for (const name of names) {
      const re = new RegExp(`(^|[^A-Za-z0-9_])(${escapeFormulaRegExp(name)})(?=$|[^A-Za-z0-9_])`, "gi");
      let match;
      while ((match = re.exec(text)) !== null) {
        const prefixLen = String(match[1] || "").length;
        const token = String(match[2] || "").trim();
        const start = match.index + prefixLen;
        if (token) matches.push({ start, end: start + token.length, token });
        if (re.lastIndex === match.index) re.lastIndex += 1;
      }
    }

    matches.sort((a, b) => (a.start - b.start) || ((b.end - b.start) - (a.end - a.start)));
    const used = [];
    const out = [];
    for (const hit of matches) {
      const overlaps = used.some((range) => hit.start < range.end && hit.end > range.start);
      if (overlaps) continue;
      const key = normalizeProjectText(hit.token);
      if (!key) continue;
      used.push({ start: hit.start, end: hit.end });
      out.push(hit);
    }
    return out.sort((a, b) => a.start - b.start);
  }

  function findFormulaDependencyEntry(token, precedents = []) {
    const tokenKey = normalizeProjectText(token);
    if (!tokenKey) return { datasetName: String(token || "").trim(), datasetTypeName: String(token || "").trim() };
    const entries = normalizeDatasetDependencyEntries(precedents);
    const match = entries.find((entry) => (
      normalizeProjectText(entry.datasetName) === tokenKey
      || normalizeProjectText(entry.datasetTypeName) === tokenKey
    ));
    return match || { datasetName: String(token || "").trim(), datasetTypeName: String(token || "").trim() };
  }

  function createFormulaSvgIcon(paths) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    for (const d of paths) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    }
    return svg;
  }

  function createFormulaOperatorIcon(value) {
    const op = String(value || "").trim();
    if (op === "+") return createFormulaSvgIcon(["M12 5v14", "M5 12h14"]);
    if (op === "-") return createFormulaSvgIcon(["M5 12h14"]);
    if (op === "*") return createFormulaSvgIcon(["M6 6l12 12", "M18 6L6 18"]);
    if (op === "/") return createFormulaSvgIcon(["M16 5L8 19"]);
    if (op === "=") return createFormulaSvgIcon(["M6 9h12", "M6 15h12"]);
    return document.createTextNode(op);
  }

  function createFormulaCalculatedIcon() {
    const icon = document.createElement("span");
    icon.className = "dsFormulaCalculatedIcon";
    icon.appendChild(createFormulaSvgIcon(["M4 7h8v6H4zM12 11h8v6h-8zM12 3h8v6h-8z"]));
    return icon;
  }

  function datasetFormulaEntryHasFormula(entry) {
    const datasetTypeName = String(entry?.datasetTypeName || entry?.datasetName || "").trim();
    return !!String(entry?.formula || getDatasetTypeFormulaByName(datasetTypeName) || "").trim();
  }

  function normalizeDatasetMethodType(value) {
    const text = String(value || "").trim().toLowerCase();
    if (text === "dfm") return "DFM";
    if (text === "result selection") return "Result Selection";
    if (text === "bornhuetter ferguson") return "Bornhuetter Ferguson";
    const berquistShermanContract = getBerquistShermanContract(text);
    if (berquistShermanContract) return berquistShermanContract.methodType;
    return "";
  }

  function appendDatasetChipLabel(parent, text) {
    const label = document.createElement("span");
    label.className = "dsFormulaTokenText";
    label.textContent = text;
    parent.appendChild(label);
  }

  function appendFormulaRawText(parent, text) {
    const value = String(text || "").trim();
    if (!value || !parent) return;
    const span = document.createElement("span");
    span.className = "dsFormulaRawText";
    span.textContent = value;
    parent.appendChild(span);
  }

  function appendRichFormulaText(parent, text) {
    const segment = String(text || "");
    if (!segment || !parent) return;
    const operatorRe = /[+\-*/()]/g;
    let cursor = 0;
    let match;
    while ((match = operatorRe.exec(segment)) !== null) {
      if (match.index > cursor) {
        appendFormulaRawText(parent, segment.slice(cursor, match.index));
      }
      const op = document.createElement("span");
      const opClass = match[0] === "+" ? " plus" : (match[0] === "-" ? " minus" : "");
      op.className = `dsFormulaOperatorToken${opClass}`;
      op.appendChild(createFormulaOperatorIcon(match[0]));
      parent.appendChild(op);
      cursor = match.index + match[0].length;
    }
    if (cursor < segment.length) {
      appendFormulaRawText(parent, segment.slice(cursor));
    }
  }

  function appendFormulaComponentChip(parent, entry, label, options = {}) {
    const interactive = !!options.interactive;
    const methodType = normalizeDatasetMethodType(entry?.methodType);
    const openMethod = !!options.openMethod;
    const chip = document.createElement(interactive ? "button" : "span");
    if (interactive) chip.type = "button";
    chip.className = "dsFormulaComponentChip";
    if (datasetFormulaEntryHasFormula(entry)) chip.appendChild(createFormulaCalculatedIcon());
    appendDatasetChipLabel(chip, label);
    if (interactive) {
      chip.setAttribute("aria-label", openMethod && methodType
        ? `Open ${methodType} method ${entry.datasetName || label}`
        : `Open ${entry.datasetName || label}`);
      chip.addEventListener("click", () => openRelatedDataset(entry, { openMethod }));
    }
    parent.appendChild(chip);
  }

  function renderRichFormulaTokens(parent, formula, precedents = [], options = {}) {
    const formulaText = String(formula || "").trim();
    if (!parent || !formulaText) return;
    const matches = findFormulaComponentMatches(formulaText, precedents);
    if (!matches.length) {
      appendRichFormulaText(parent, formulaText);
      return;
    }

    let cursor = 0;
    for (const hit of matches) {
      if (hit.start > cursor) {
        appendRichFormulaText(parent, formulaText.slice(cursor, hit.start));
      }
      const entry = findFormulaDependencyEntry(hit.token, precedents);
      appendFormulaComponentChip(parent, entry, hit.token, options);
      cursor = hit.end;
    }
    if (cursor < formulaText.length) {
      appendRichFormulaText(parent, formulaText.slice(cursor));
    }
  }

  function renderDetailFormula(formula, precedents = []) {
    const formulaText = String(formula || "").trim();
    const formulaInput = document.getElementById("dsDetailFormula");
    const formulaBox = document.getElementById("dsDetailFormulaBox");
    if (formulaInput) {
      formulaInput.value = formulaText;
      formulaInput.removeAttribute("title");
    }
    if (!formulaBox) return;
    formulaBox.replaceChildren();
    formulaBox.removeAttribute("title");
    formulaBox.classList.toggle("empty", !formulaText);
    if (!formulaText) {
      return;
    }

    renderRichFormulaTokens(formulaBox, formulaText, precedents, { interactive: true, openMethod: true });
  }

  function ensureDependentFormulaTooltip() {
    let tooltip = document.getElementById("dsDependentFormulaTooltip");
    if (tooltip) return tooltip;
    tooltip = document.createElement("div");
    tooltip.id = "dsDependentFormulaTooltip";
    tooltip.className = "dsDependentFormulaTooltip";
    tooltip.hidden = true;
    document.body.appendChild(tooltip);
    return tooltip;
  }

  function positionDependentFormulaTooltip(tooltip, event) {
    if (!tooltip || tooltip.hidden) return;
    const margin = 12;
    const rect = tooltip.getBoundingClientRect();
    let left = event.clientX + margin;
    let top = event.clientY + margin;
    if (left + rect.width > window.innerWidth - margin) {
      left = Math.max(margin, event.clientX - rect.width - margin);
    }
    if (top + rect.height > window.innerHeight - margin) {
      top = Math.max(margin, event.clientY - rect.height - margin);
    }
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  function fitDependentFormulaTooltipWidth(tooltip) {
    if (!tooltip || tooltip.hidden) return;
    const body = tooltip.querySelector(".dsDependentFormulaTooltipBody");
    const items = Array.from(body?.children || []);
    if (!body || !items.length) return;

    const tooltipStyle = window.getComputedStyle(tooltip);
    const padBorderX = [
      tooltipStyle.paddingLeft,
      tooltipStyle.paddingRight,
      tooltipStyle.borderLeftWidth,
      tooltipStyle.borderRightWidth,
    ].reduce((sum, value) => sum + (Number.parseFloat(value) || 0), 0);
    const maxWidth = Number.parseFloat(tooltipStyle.maxWidth) || (window.innerWidth - 24);
    const currentWidth = tooltip.getBoundingClientRect().width;
    const lineExtents = new Map();
    for (const item of items) {
      const rect = item.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const key = String(Math.round(rect.top * 2) / 2);
      const line = lineExtents.get(key) || { left: rect.left, right: rect.right };
      line.left = Math.min(line.left, rect.left);
      line.right = Math.max(line.right, rect.right);
      lineExtents.set(key, line);
    }
    let widestLine = 0;
    for (const line of lineExtents.values()) {
      widestLine = Math.max(widestLine, line.right - line.left);
    }
    if (!widestLine) return;
    const targetWidth = Math.ceil(Math.min(maxWidth, widestLine + padBorderX + 2));
    if (targetWidth > 80 && targetWidth < currentWidth - 1) {
      tooltip.style.width = `${targetWidth}px`;
    }
  }

  function showDependentFormulaTooltip(dependency, event) {
    const formula = String(dependency?.formula || "").trim();
    if (!formula) return;
    const tooltip = ensureDependentFormulaTooltip();
    tooltip.style.width = "";
    tooltip.replaceChildren();
    const body = document.createElement("div");
    body.className = "dsDependentFormulaTooltipBody";
    const equals = document.createElement("span");
    equals.className = "dsFormulaOperatorToken equals";
    equals.appendChild(createFormulaOperatorIcon("="));
    body.appendChild(equals);
    renderRichFormulaTokens(body, formula);
    tooltip.appendChild(body);
    tooltip.hidden = false;
    fitDependentFormulaTooltipWidth(tooltip);
    positionDependentFormulaTooltip(tooltip, event);
  }

  function hideDependentFormulaTooltip() {
    const tooltip = document.getElementById("dsDependentFormulaTooltip");
    if (tooltip) tooltip.hidden = true;
  }

  function openRelatedDataset(entry, options = {}) {
    const datasetName = String(entry?.datasetName || "").trim();
    if (!datasetName) return;
    if (!isProjectInstanceHost) {
      setStatus("Dataset links open from Project Instance dataset windows.");
      return;
    }
    const methodType = normalizeDatasetMethodType(entry?.methodType);
    const payload = buildDatasetSidecarContextPayload();
    try {
      window.parent?.postMessage({
        type: "arcrho:project-instance-open-dependent-dataset",
        inst: instanceId,
        datasetName,
        datasetTypeName: String(entry?.datasetTypeName || datasetName).trim(),
        methodType,
        openMethod: !!options.openMethod,
        projectName: payload.project_name,
        reservingClass: payload.reserving_class,
      }, "*");
      setStatus(options.openMethod
        ? `Opening related item: ${datasetName}`
        : `Opening dataset: ${datasetName}`);
    } catch {
      setStatus("Could not open dataset from this window.");
    }
  }

  function renderDatasetDependents(entries = []) {
    const list = document.getElementById("dsDependentsList");
    if (!list) return;
    hideDependentFormulaTooltip();
    const dependents = normalizeDatasetDependencyEntries(entries);
    list.replaceChildren();
    if (!dependents.length) {
      return;
    }
    for (const dependent of dependents) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "dsDependentLink";
      if (datasetFormulaEntryHasFormula(dependent)) button.appendChild(createFormulaCalculatedIcon());
      appendDatasetChipLabel(button, dependent.datasetName);
      button.setAttribute("aria-label", dependent.formula
        ? `Open ${dependent.datasetName}. Formula: ${dependent.formula}`
        : `Open ${dependent.datasetName}`);
      button.addEventListener("mouseenter", (event) => showDependentFormulaTooltip(dependent, event));
      button.addEventListener("mousemove", (event) => {
        const tooltip = document.getElementById("dsDependentFormulaTooltip");
        positionDependentFormulaTooltip(tooltip, event);
      });
      button.addEventListener("mouseleave", hideDependentFormulaTooltip);
      button.addEventListener("blur", hideDependentFormulaTooltip);
      button.addEventListener("click", () => openRelatedDataset(dependent));
      list.appendChild(button);
    }
  }

  function renderDatasetPrecedents(entries = []) {
    const list = document.getElementById("dsPrecedentsList");
    if (!list) return;
    hideDependentFormulaTooltip();
    const precedents = normalizeDatasetDependencyEntries(entries);
    list.replaceChildren();
    if (!precedents.length) {
      return;
    }
    for (const precedent of precedents) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "dsDependentLink";
      if (datasetFormulaEntryHasFormula(precedent)) button.appendChild(createFormulaCalculatedIcon());
      appendDatasetChipLabel(button, precedent.datasetName);
      const methodType = normalizeDatasetMethodType(precedent.methodType);
      button.setAttribute("aria-label", methodType
        ? `Open ${methodType} method ${precedent.datasetName}`
        : `Open related item ${precedent.datasetName}`);
      button.addEventListener("mouseenter", (event) => showDependentFormulaTooltip(precedent, event));
      button.addEventListener("mousemove", (event) => {
        const tooltip = document.getElementById("dsDependentFormulaTooltip");
        positionDependentFormulaTooltip(tooltip, event);
      });
      button.addEventListener("mouseleave", hideDependentFormulaTooltip);
      button.addEventListener("blur", hideDependentFormulaTooltip);
      button.addEventListener("click", () => openRelatedDataset(precedent, { openMethod: true }));
      list.appendChild(button);
    }
  }

  function getDatasetInitialTab() {
    const requested = String(qs.get("tab") || qs.get("initial_tab") || "").trim();
    return DATASET_VIEWER_TAB_IDS.has(requested) ? requested : "data";
  }

  function setDatasetTopBarCollapsed(collapsed) {
    const dataPage = document.getElementById("dsDataPage");
    const topRow = dataPage?.querySelector(".topRow");
    const dataTab = document.querySelector('.dsTab[data-page="data"]');
    if (!dataPage || !topRow) return;

    const isCollapsed = !!collapsed;
    dataPage.classList.toggle("datasetTopBarCollapsed", isCollapsed);
    topRow.hidden = isCollapsed;
    if (dataTab) {
      dataTab.removeAttribute("title");
      if (isCollapsed) {
        dataTab.dataset.datasetTopBarCollapsed = "1";
        dataTab.dataset.tooltip = "Double-click to show Data controls";
        if (dataTab.matches(":hover") || document.activeElement === dataTab) {
          showDatasetDataTabTooltip(dataTab);
        }
      } else {
        hideDatasetDataTabTooltip();
        delete dataTab.dataset.datasetTopBarCollapsed;
        delete dataTab.dataset.tooltip;
      }
    }

    requestAnimationFrame(() => {
      renderTable();
    });
  }

  function isDatasetTopBarCollapsed() {
    return document.getElementById("dsDataPage")?.classList.contains("datasetTopBarCollapsed") === true;
  }

  function getDatasetDataTabTooltip() {
    let tooltip = document.getElementById("dsDataTabTooltip");
    if (tooltip) return tooltip;
    tooltip = document.createElement("div");
    tooltip.id = "dsDataTabTooltip";
    tooltip.className = "dsDataTabTooltip";
    tooltip.setAttribute("role", "tooltip");
    tooltip.hidden = true;
    document.body.appendChild(tooltip);
    return tooltip;
  }

  function positionDatasetDataTabTooltip(tab, tooltip) {
    const rect = tab.getBoundingClientRect();
    const margin = 6;
    tooltip.style.left = "0px";
    tooltip.style.top = "0px";
    tooltip.hidden = false;
    const width = tooltip.offsetWidth || 0;
    const height = tooltip.offsetHeight || 0;
    const belowTop = rect.bottom + margin;
    const aboveTop = rect.top - height - margin;
    const useAbove = belowTop + height > window.innerHeight - margin && aboveTop >= margin;
    const top = useAbove ? aboveTop : belowTop;
    const centeredLeft = rect.left + (rect.width / 2) - (width / 2);
    const left = Math.max(margin, Math.min(centeredLeft, window.innerWidth - width - margin));
    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(Math.max(margin, top))}px`;
  }

  function showDatasetDataTabTooltip(tab) {
    if (!tab || !isDatasetTopBarCollapsed()) return;
    const text = tab.dataset.tooltip || "";
    if (!text) return;
    const tooltip = getDatasetDataTabTooltip();
    tooltip.textContent = text;
    tooltip.hidden = false;
    positionDatasetDataTabTooltip(tab, tooltip);
    tooltip.classList.add("open");
  }

  function hideDatasetDataTabTooltip() {
    const tooltip = document.getElementById("dsDataTabTooltip");
    if (!tooltip) return;
    tooltip.classList.remove("open");
    tooltip.hidden = true;
  }

  function toggleDatasetTopBarCollapsed() {
    const dataPage = document.getElementById("dsDataPage");
    const collapsed = !dataPage?.classList.contains("datasetTopBarCollapsed");
    setDatasetTopBarCollapsed(collapsed);
    setStatus(collapsed ? "Dataset Data controls hidden." : "Dataset Data controls shown.");
  }

  function wireDatasetDataTabTopBarToggle(tabSystem) {
    const dataTab = document.querySelector('.dsTab[data-page="data"]');
    if (!dataTab || dataTab.dataset.datasetTopBarToggleWired === "1") return;
    dataTab.dataset.datasetTopBarToggleWired = "1";
    setDatasetTopBarCollapsed(false);
    dataTab.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (tabSystem?.getCurrentTab?.() !== "data") tabSystem?.setActive?.("data");
      toggleDatasetTopBarCollapsed();
    });
    dataTab.addEventListener("mouseenter", () => showDatasetDataTabTooltip(dataTab));
    dataTab.addEventListener("mouseleave", hideDatasetDataTabTooltip);
    dataTab.addEventListener("focus", () => showDatasetDataTabTooltip(dataTab));
    dataTab.addEventListener("blur", hideDatasetDataTabTooltip);
    window.addEventListener("resize", hideDatasetDataTabTooltip);
    window.addEventListener("scroll", hideDatasetDataTabTooltip, true);
  }


  Object.assign(runtime, {
    getDatasetAuditLog,
    renderDatasetAuditLog,
    normalizeDatasetDependencyEntries,
    escapeFormulaRegExp,
    getFormulaComponentNames,
    findFormulaComponentMatches,
    findFormulaDependencyEntry,
    createFormulaSvgIcon,
    createFormulaOperatorIcon,
    createFormulaCalculatedIcon,
    datasetFormulaEntryHasFormula,
    normalizeDatasetMethodType,
    appendDatasetChipLabel,
    appendFormulaRawText,
    appendRichFormulaText,
    appendFormulaComponentChip,
    renderRichFormulaTokens,
    renderDetailFormula,
    ensureDependentFormulaTooltip,
    positionDependentFormulaTooltip,
    fitDependentFormulaTooltipWidth,
    showDependentFormulaTooltip,
    hideDependentFormulaTooltip,
    openRelatedDataset,
    renderDatasetDependents,
    renderDatasetPrecedents,
    getDatasetInitialTab,
    setDatasetTopBarCollapsed,
    isDatasetTopBarCollapsed,
    getDatasetDataTabTooltip,
    positionDatasetDataTabTooltip,
    showDatasetDataTabTooltip,
    hideDatasetDataTabTooltip,
    toggleDatasetTopBarCollapsed,
    wireDatasetDataTabTopBarToggle,
  });
}
