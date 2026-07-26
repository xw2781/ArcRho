import { attachArcrhoTooltip } from "/ui/shared/components/tooltip/tooltip.js?v=20260715a";

const ENDPOINT = "/dataset/number-format-defaults";

function text(value) {
  return String(value ?? "").trim();
}

function detailMessage(payload, fallback) {
  const detail = payload?.detail;
  if (typeof detail === "string" && detail.trim()) return detail.trim();
  if (Array.isArray(detail) && detail.length) return detail.map((item) => item?.msg || String(item)).join("; ");
  return fallback;
}

export function installProjectInstanceNumberFormats(ctx) {
  const { api, els } = ctx;
  const editor = { revision: 0, rows: [], lastFocus: null, busy: false, loaded: false, drag: null };

  function setStatus(message, tone = "") {
    if (!els.datasetNumberFormatsStatus) return;
    els.datasetNumberFormatsStatus.textContent = text(message);
    els.datasetNumberFormatsStatus.className = `pi-number-formats-status${tone ? ` ${tone}` : ""}`;
  }

  function setBusy(busy) {
    editor.busy = !!busy;
    for (const element of [
      els.datasetNumberFormatsDefault,
      els.datasetNumberFormatsFilter,
      els.datasetNumberFormatsAdd,
      els.datasetNumberFormatsCancel,
      els.datasetNumberFormatsClose,
    ]) {
      if (element) element.disabled = editor.busy;
    }
    if (els.datasetNumberFormatsSave) els.datasetNumberFormatsSave.disabled = editor.busy || !editor.loaded;
  }

  function visibleRows() {
    const query = text(els.datasetNumberFormatsFilter?.value).toLocaleLowerCase();
    if (!query) return editor.rows;
    return editor.rows.filter((row) => (
      `${row.dataset_type_name} ${row.number_format}`.toLocaleLowerCase().includes(query)
    ));
  }

  function updateRow(id, field, value) {
    const row = editor.rows.find((item) => item.id === id);
    if (row) row[field] = value;
  }

  function renderRows() {
    const body = els.datasetNumberFormatsBody;
    if (!body) return;
    body.replaceChildren();
    const rows = visibleRows();
    els.datasetNumberFormatsEmpty.hidden = rows.length > 0;
    for (const row of rows) {
      const tr = document.createElement("tr");
      const fields = ["dataset_type_name", "number_format"];
      for (const field of fields) {
        const td = document.createElement("td");
        const input = document.createElement("input");
        input.type = "text";
        input.value = row[field];
        input.maxLength = field === "dataset_type_name" ? 256 : 64;
        input.autocomplete = "off";
        input.spellcheck = false;
        input.setAttribute("aria-label", field === "dataset_type_name" ? "Dataset Type Name" : "Number Format");
        input.addEventListener("input", () => updateRow(row.id, field, input.value));
        td.appendChild(input);
        tr.appendChild(td);
      }
      const action = document.createElement("td");
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "pi-number-formats-remove";
      remove.setAttribute("aria-label", `Remove override for ${row.dataset_type_name || "new row"}`);
      remove.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 4.5h9M6 4.5V3h4v1.5M5 6.5v6M8 6.5v6M11 6.5v6M4.5 4.5l.5 9h6l.5-9"></path></svg>';
      remove.addEventListener("click", () => {
        editor.rows = editor.rows.filter((item) => item.id !== row.id);
        renderRows();
      });
      action.appendChild(remove);
      tr.appendChild(action);
      body.appendChild(tr);
    }
  }

  function closeEditor() {
    if (editor.busy || els.datasetNumberFormatsOverlay?.hidden) return;
    els.datasetNumberFormatsOverlay.hidden = true;
    editor.lastFocus?.focus?.();
    editor.lastFocus = null;
  }

  async function loadEditor() {
    editor.loaded = false;
    setBusy(true);
    setStatus("Loading global number-format preferences...");
    try {
      const response = await fetch(ENDPOINT, { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok === false) throw new Error(detailMessage(payload, `HTTP ${response.status}`));
      editor.revision = Number(payload.revision) || 0;
      editor.loaded = true;
      editor.rows = (Array.isArray(payload.overrides) ? payload.overrides : []).map((row, index) => ({
        id: `row-${Date.now()}-${index}`,
        dataset_type_name: text(row?.dataset_type_name),
        number_format: text(row?.number_format),
      }));
      els.datasetNumberFormatsDefault.value = text(payload.default_number_format) || "0,000";
      els.datasetNumberFormatsPath.textContent = text(payload.path);
      els.datasetNumberFormatsFilter.value = "";
      renderRows();
      setStatus(`${editor.rows.length} override${editor.rows.length === 1 ? "" : "s"} loaded.`);
    } catch (error) {
      editor.loaded = false;
      editor.rows = [];
      renderRows();
      setStatus(`Could not load preferences: ${error.message}`, "error");
    } finally {
      setBusy(false);
    }
  }

  async function openEditor() {
    if (!els.datasetNumberFormatsOverlay || editor.busy) return;
    editor.lastFocus = document.activeElement;
    els.datasetNumberFormatsOverlay.hidden = false;
    await loadEditor();
    els.datasetNumberFormatsDefault?.focus();
    els.datasetNumberFormatsDefault?.select();
  }

  function addOverride() {
    const row = { id: `row-${Date.now()}-${Math.random()}`, dataset_type_name: "", number_format: text(els.datasetNumberFormatsDefault?.value) || "0,000" };
    editor.rows.push(row);
    if (els.datasetNumberFormatsFilter) els.datasetNumberFormatsFilter.value = "";
    renderRows();
    const lastRow = els.datasetNumberFormatsBody?.lastElementChild;
    lastRow?.querySelector("input")?.focus();
    lastRow?.scrollIntoView({ block: "nearest" });
  }

  function normalizedPayload() {
    const fallback = text(els.datasetNumberFormatsDefault?.value);
    if (!fallback) throw new Error("Fallback number format is required.");
    const overrides = editor.rows.map((row, index) => {
      const dataset_type_name = text(row.dataset_type_name);
      const number_format = text(row.number_format);
      if (!dataset_type_name || !number_format) throw new Error(`Override row ${index + 1} is incomplete.`);
      return { dataset_type_name, number_format };
    });
    const seen = new Set();
    for (const row of overrides) {
      const key = row.dataset_type_name.toLocaleLowerCase();
      if (seen.has(key)) throw new Error(`Duplicate override: ${row.dataset_type_name}.`);
      seen.add(key);
    }
    return { expected_revision: editor.revision, default_number_format: fallback, overrides };
  }

  async function saveEditor() {
    let body;
    try {
      body = normalizedPayload();
    } catch (error) {
      setStatus(error.message, "error");
      return;
    }
    setBusy(true);
    setStatus("Saving global number-format preferences...");
    try {
      const response = await fetch(ENDPOINT, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok === false) throw new Error(detailMessage(payload, `HTTP ${response.status}`));
      editor.revision = Number(payload.revision) || editor.revision + 1;
      setStatus("Default number formats saved.", "success");
      api.postProjectInstanceStatus?.("Default dataset number formats saved.");
    } catch (error) {
      setStatus(`Could not save preferences: ${error.message}`, "error");
    } finally {
      setBusy(false);
    }
  }

  function beginDrag(event) {
    if (event.button !== 0 || event.target.closest("button")) return;
    const win = els.datasetNumberFormatsWindow;
    const rect = win?.getBoundingClientRect();
    if (!win || !rect) return;
    win.style.transform = "none";
    win.style.left = `${rect.left}px`;
    win.style.top = `${rect.top}px`;
    editor.drag = { offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
    event.preventDefault();
  }

  function moveDrag(event) {
    if (!editor.drag) return;
    const win = els.datasetNumberFormatsWindow;
    const maxLeft = Math.max(8, window.innerWidth - win.offsetWidth - 8);
    const maxTop = Math.max(8, window.innerHeight - 42);
    win.style.left = `${Math.max(8, Math.min(event.clientX - editor.drag.offsetX, maxLeft))}px`;
    win.style.top = `${Math.max(8, Math.min(event.clientY - editor.drag.offsetY, maxTop))}px`;
  }

  function initDatasetNumberFormatsEditor() {
    if (!els.datasetNumberFormatsBtn || els.datasetNumberFormatsBtn.dataset.wired === "1") return;
    els.datasetNumberFormatsBtn.dataset.wired = "1";
    attachArcrhoTooltip(els.datasetNumberFormatsBtn, "Edit Default Number Formats");
    els.datasetNumberFormatsBtn.addEventListener("click", () => void openEditor());
    els.datasetNumberFormatsClose?.addEventListener("click", closeEditor);
    els.datasetNumberFormatsCancel?.addEventListener("click", closeEditor);
    els.datasetNumberFormatsSave?.addEventListener("click", () => void saveEditor());
    els.datasetNumberFormatsAdd?.addEventListener("click", addOverride);
    els.datasetNumberFormatsFilter?.addEventListener("input", renderRows);
    els.datasetNumberFormatsHeader?.addEventListener("pointerdown", beginDrag);
    window.addEventListener("pointermove", moveDrag);
    window.addEventListener("pointerup", () => { editor.drag = null; });
    document.addEventListener("keydown", (event) => {
      if (els.datasetNumberFormatsOverlay?.hidden) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeEditor();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "s") {
        event.preventDefault();
        void saveEditor();
      }
    });
  }

  Object.assign(api, { initDatasetNumberFormatsEditor, openDatasetNumberFormatsEditor: openEditor });
}
