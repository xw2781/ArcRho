/* The Project Instance Preferences window.

   Two sections today, each with its own storage scope:

   - Number Formats is server-shared. It reads and writes
     `<workspace_root>/config/dataset_number_formats.json` through
     `/dataset/number-format-defaults`, with the same revision check the
     standalone editor used, so two open windows cannot overwrite each other.
     The table lists every Dataset Type of the open project beside the saved
     overrides, so a type added in Project Settings is there to pick a format
     for without typing its name. Listing never writes: a project type left on
     the fallback is not in the file, and only Save touches it.
   - Default Tabs is local-user state. It reads and writes browser storage
     under the key the shared window tab catalog owns, so one Windows account
     on this PC keeps one choice and every project it opens uses it.

   The tab lists and the app defaults come from the catalog, which the pages
   themselves read, so the window can never offer a tab a page does not have. */

import { attachArcrhoTooltip } from "/ui/shared/components/tooltip/tooltip.js?v=20260812a";
import {
  DEFAULT_WINDOW_TABS_STORAGE_KEY,
  WINDOW_TAB_KINDS,
  appDefaultWindowTabs,
  readDefaultWindowTabs,
  writeDefaultWindowTabs,
} from "/ui/shared/tabs/window_tab_catalog.js?v=20260902a";
import { extractDatasetTypeItems, fetchProjectDatasetTypes } from "/ui/shared/dataset/dataset_types_source.js";
import {
  effectiveNumberFormat,
  mergeNumberFormatRows,
  numberFormatOverridesFromRows,
  numberFormatOverridesKey,
} from "./project_instance_number_format_rows.js?v=20260824g";

const NUMBER_FORMATS_ENDPOINT = "/dataset/number-format-defaults";
const REMOVE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 4.5h9M6 4.5V3h4v1.5M5 6.5v6M8 6.5v6M11 6.5v6M4.5 4.5l.5 9h6l.5-9"></path></svg>';
const RESET_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8a4.5 4.5 0 1 0 1.4-3.3M3.5 3v2.5H6"></path></svg>';

function text(value) {
  return String(value ?? "").trim();
}

function detailMessage(payload, fallback) {
  const detail = payload?.detail;
  if (typeof detail === "string" && detail.trim()) return detail.trim();
  if (Array.isArray(detail) && detail.length) return detail.map((item) => item?.msg || String(item)).join("; ");
  return fallback;
}

function sameTabDefaults(left, right) {
  return WINDOW_TAB_KINDS.every((kind) => left?.[kind.key] === right?.[kind.key]);
}

export function installProjectInstancePreferences(ctx) {
  const { api, els, state, projectName } = ctx;
  const editor = {
    section: "formats",
    busy: false,
    lastFocus: null,
    drag: null,
    formats: { revision: 0, rows: [], loaded: false, savedDefault: "", savedKey: "", typeCount: 0, typesError: "" },
    tabs: { loaded: false, chosen: appDefaultWindowTabs(), saved: appDefaultWindowTabs() },
  };

  function setStatus(message, tone = "") {
    if (!els.piPrefsStatus) return;
    els.piPrefsStatus.textContent = text(message);
    els.piPrefsStatus.className = `pi-prefs-status${tone ? ` ${tone}` : ""}`;
  }

  function setBusy(busy) {
    editor.busy = !!busy;
    for (const element of [
      els.piPrefsFormatsDefault,
      els.piPrefsFormatsFilter,
      els.piPrefsFormatsAdd,
      els.piPrefsTabsReset,
      els.piPrefsCancel,
      els.piPrefsClose,
    ]) {
      if (element) element.disabled = editor.busy;
    }
    for (const chip of els.piPrefsTabsList?.querySelectorAll(".pi-prefs-tabchip") || []) {
      chip.disabled = editor.busy;
    }
    if (els.piPrefsSave) {
      els.piPrefsSave.disabled = editor.busy || !(editor.formats.loaded || editor.tabs.loaded);
    }
  }

  /* ---- Section rail ---- */

  function showSection(section) {
    const next = section === "tabs" ? "tabs" : "formats";
    editor.section = next;
    for (const item of els.piPrefsNav?.querySelectorAll(".pi-prefs-nav-item") || []) {
      const active = item.dataset.section === next;
      item.classList.toggle("is-active", active);
      item.setAttribute("aria-selected", active ? "true" : "false");
    }
    if (els.piPrefsPanelFormats) els.piPrefsPanelFormats.hidden = next !== "formats";
    if (els.piPrefsPanelTabs) els.piPrefsPanelTabs.hidden = next !== "tabs";
  }

  /* ---- Number formats section ---- */

  function visibleFormatRows() {
    const query = text(els.piPrefsFormatsFilter?.value).toLocaleLowerCase();
    if (!query) return editor.formats.rows;
    const fallback = fallbackNumberFormat();
    return editor.formats.rows.filter((row) => (
      `${row.dataset_type_name} ${effectiveNumberFormat(row, fallback)}`.toLocaleLowerCase().includes(query)
    ));
  }

  function fallbackNumberFormat() {
    return text(els.piPrefsFormatsDefault?.value) || "0,000";
  }

  function updateFormatRow(id, field, value) {
    const row = editor.formats.rows.find((item) => item.id === id);
    if (row) row[field] = value;
  }

  function renderFormatRows() {
    const body = els.piPrefsFormatsBody;
    if (!body) return;
    body.replaceChildren();
    const rows = visibleFormatRows();
    const fallback = fallbackNumberFormat();
    els.piPrefsFormatsEmpty.hidden = rows.length > 0;
    for (const row of rows) {
      const tr = document.createElement("tr");
      const inherited = () => !!row.in_project && !text(row.number_format);
      tr.classList.toggle("is-inherited", inherited());

      // A project type is named in Project Settings; only a row added here,
      // for a type this project does not define, has a free-text name.
      const nameCell = document.createElement("td");
      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.value = row.dataset_type_name;
      nameInput.maxLength = 256;
      nameInput.autocomplete = "off";
      nameInput.spellcheck = false;
      nameInput.readOnly = !!row.in_project;
      nameInput.setAttribute("aria-label", "Dataset Type Name");
      nameInput.addEventListener("input", () => updateFormatRow(row.id, "dataset_type_name", nameInput.value));
      nameCell.appendChild(nameInput);
      tr.appendChild(nameCell);

      // A blank format on a project type shows the fallback it inherits and
      // writes nothing; typing one turns the row into an override.
      const formatCell = document.createElement("td");
      const formatInput = document.createElement("input");
      formatInput.type = "text";
      formatInput.value = row.number_format;
      formatInput.maxLength = 64;
      formatInput.autocomplete = "off";
      formatInput.spellcheck = false;
      formatInput.placeholder = row.in_project ? fallback : "";
      formatInput.setAttribute("aria-label", "Number Format");
      formatCell.appendChild(formatInput);
      tr.appendChild(formatCell);

      const action = document.createElement("td");
      const button = document.createElement("button");
      button.type = "button";
      if (row.in_project) {
        button.className = "pi-number-formats-remove is-reset";
        button.setAttribute("aria-label", `Use the fallback for ${row.dataset_type_name}`);
        button.innerHTML = RESET_ICON;
        button.hidden = inherited();
        button.addEventListener("click", () => {
          updateFormatRow(row.id, "number_format", "");
          renderFormatRows();
        });
      } else {
        button.className = "pi-number-formats-remove";
        button.setAttribute("aria-label", `Remove override for ${row.dataset_type_name || "new row"}`);
        button.innerHTML = REMOVE_ICON;
        button.addEventListener("click", () => {
          editor.formats.rows = editor.formats.rows.filter((item) => item.id !== row.id);
          renderFormatRows();
        });
      }
      formatInput.addEventListener("input", () => {
        updateFormatRow(row.id, "number_format", formatInput.value);
        tr.classList.toggle("is-inherited", inherited());
        if (row.in_project) button.hidden = inherited();
      });
      action.appendChild(button);
      tr.appendChild(action);
      body.appendChild(tr);
    }
  }

  function renderFormatScope() {
    if (!els.piPrefsFormatsScope) return;
    const { typeCount, typesError } = editor.formats;
    if (typesError) {
      els.piPrefsFormatsScope.textContent = `Could not list the Dataset Types of ${projectName || "this project"}; showing saved overrides only.`;
    } else if (projectName) {
      els.piPrefsFormatsScope.textContent = `Lists the ${typeCount} Dataset Type${typeCount === 1 ? "" : "s"} of ${projectName}. A blank format means the fallback, and a dataset keeps any format saved on it.`;
    } else {
      els.piPrefsFormatsScope.textContent = "";
    }
  }

  function addOverride() {
    const row = {
      id: `row-${Date.now()}-${Math.random()}`,
      dataset_type_name: "",
      number_format: fallbackNumberFormat(),
      in_project: false,
    };
    editor.formats.rows.push(row);
    if (els.piPrefsFormatsFilter) els.piPrefsFormatsFilter.value = "";
    renderFormatRows();
    const lastRow = els.piPrefsFormatsBody?.lastElementChild;
    lastRow?.querySelector("input")?.focus();
    lastRow?.scrollIntoView({ block: "nearest" });
  }

  async function fetchNumberFormatsDocument() {
    const response = await fetch(NUMBER_FORMATS_ENDPOINT, { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) throw new Error(detailMessage(payload, `HTTP ${response.status}`));
    return payload;
  }

  // Read fresh rather than from the page state: a type added in Project
  // Settings after this page opened is exactly the one the user came to set.
  async function fetchProjectDatasetTypeNames() {
    if (!projectName) return [];
    const fetched = await fetchProjectDatasetTypes(projectName);
    return extractDatasetTypeItems(fetched.data?.columns, fetched.data?.rows).map((item) => item.name);
  }

  async function loadNumberFormats() {
    editor.formats.loaded = false;
    editor.formats.typesError = "";
    // The shared file is the one read that has to succeed; a project whose
    // Dataset Types cannot be listed still gets its saved overrides.
    const [formats, types] = await Promise.allSettled([fetchNumberFormatsDocument(), fetchProjectDatasetTypeNames()]);
    if (formats.status === "rejected") throw formats.reason;
    const payload = formats.value;
    const datasetTypeNames = types.status === "fulfilled" ? types.value : [];
    if (types.status === "rejected") editor.formats.typesError = types.reason?.message || String(types.reason);
    const overrides = Array.isArray(payload.overrides) ? payload.overrides : [];
    editor.formats.revision = Number(payload.revision) || 0;
    editor.formats.rows = mergeNumberFormatRows({ overrides, datasetTypeNames }).map((row, index) => ({
      id: `row-${Date.now()}-${index}`,
      ...row,
    }));
    editor.formats.typeCount = datasetTypeNames.length;
    editor.formats.savedKey = numberFormatOverridesKey(overrides);
    editor.formats.savedDefault = text(payload.default_number_format) || "0,000";
    editor.formats.loaded = true;
    els.piPrefsFormatsDefault.value = editor.formats.savedDefault;
    els.piPrefsFormatsPath.textContent = text(payload.path);
    els.piPrefsFormatsFilter.value = "";
    renderFormatScope();
    renderFormatRows();
  }

  function numberFormatsDirty() {
    if (!editor.formats.loaded) return false;
    if (text(els.piPrefsFormatsDefault?.value) !== editor.formats.savedDefault) return true;
    try {
      return numberFormatOverridesKey(numberFormatOverridesFromRows(editor.formats.rows)) !== editor.formats.savedKey;
    } catch {
      // An incomplete row is an edit; Save reports what is missing.
      return true;
    }
  }

  function numberFormatsPayload() {
    const fallback = text(els.piPrefsFormatsDefault?.value);
    if (!fallback) throw new Error("Fallback number format is required.");
    return {
      expected_revision: editor.formats.revision,
      default_number_format: fallback,
      overrides: numberFormatOverridesFromRows(editor.formats.rows),
    };
  }

  async function saveNumberFormats() {
    const body = numberFormatsPayload();
    const response = await fetch(NUMBER_FORMATS_ENDPOINT, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) throw new Error(detailMessage(payload, `HTTP ${response.status}`));
    editor.formats.revision = Number(payload.revision) || editor.formats.revision + 1;
    editor.formats.savedDefault = body.default_number_format;
    editor.formats.savedKey = numberFormatOverridesKey(body.overrides);
  }

  /* ---- Default tabs section ---- */

  function renderTabDefaults() {
    const host = els.piPrefsTabsList;
    if (!host) return;
    host.replaceChildren();
    for (const kind of WINDOW_TAB_KINDS) {
      const row = document.createElement("div");
      row.className = "pi-prefs-tab-row";

      const label = document.createElement("div");
      label.className = "pi-prefs-tab-kind";
      const name = document.createElement("span");
      name.className = "pi-prefs-tab-kind-name";
      name.textContent = kind.label;
      label.appendChild(name);
      if (kind.hint) {
        const hint = document.createElement("span");
        hint.className = "pi-prefs-tab-kind-hint";
        hint.textContent = kind.hint;
        label.appendChild(hint);
      }
      row.appendChild(label);

      const strip = document.createElement("div");
      strip.className = "pi-prefs-tabstrip";
      strip.setAttribute("role", "radiogroup");
      strip.setAttribute("aria-label", `Default tab for ${kind.label}`);
      for (const tab of kind.tabs) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "pi-prefs-tabchip";
        chip.setAttribute("role", "radio");
        chip.dataset.kind = kind.key;
        chip.dataset.tab = tab.id;
        chip.textContent = tab.label;
        const chosen = editor.tabs.chosen[kind.key] === tab.id;
        chip.setAttribute("aria-checked", chosen ? "true" : "false");
        chip.disabled = editor.busy;
        chip.addEventListener("click", () => {
          editor.tabs.chosen = { ...editor.tabs.chosen, [kind.key]: tab.id };
          renderTabDefaults();
        });
        strip.appendChild(chip);
      }
      row.appendChild(strip);
      host.appendChild(row);
    }
  }

  function loadTabDefaults() {
    // Opening the window re-reads storage, so adopt what it says: a window on
    // another project may have changed these defaults since this page booted.
    editor.tabs.saved = readDefaultWindowTabs();
    editor.tabs.chosen = { ...editor.tabs.saved };
    editor.tabs.loaded = true;
    state.defaultWindowTabs = editor.tabs.saved;
    renderTabDefaults();
  }

  function tabDefaultsDirty() {
    return editor.tabs.loaded && !sameTabDefaults(editor.tabs.chosen, editor.tabs.saved);
  }

  function saveTabDefaults() {
    const chosen = writeDefaultWindowTabs(editor.tabs.chosen);
    editor.tabs.saved = chosen;
    state.defaultWindowTabs = chosen;
  }

  /* Every open window shares these defaults, so a save in one of them reaches
     the others through the storage event rather than waiting for a reopen. */
  function adoptTabDefaultsFromAnotherWindow(event) {
    if (event.key !== DEFAULT_WINDOW_TABS_STORAGE_KEY) return;
    const hasUnsavedEdits = tabDefaultsDirty();
    state.defaultWindowTabs = readDefaultWindowTabs();
    editor.tabs.saved = state.defaultWindowTabs;
    if (hasUnsavedEdits) return;
    editor.tabs.chosen = { ...editor.tabs.saved };
    renderTabDefaults();
  }

  function resetTabDefaults() {
    editor.tabs.chosen = appDefaultWindowTabs();
    renderTabDefaults();
    setStatus("Default tabs reset to the app defaults. Save to keep them.");
  }

  /* ---- Window ---- */

  async function loadEditor() {
    setBusy(true);
    setStatus("Loading preferences...");
    loadTabDefaults();
    try {
      await loadNumberFormats();
      const overrides = editor.formats.rows.filter((row) => text(row.number_format)).length;
      const types = editor.formats.typeCount;
      if (editor.formats.typesError) {
        setStatus(`Could not list this project's dataset types (${editor.formats.typesError}).`, "error");
      } else {
        setStatus(`${types} dataset type${types === 1 ? "" : "s"} listed, ${overrides} with a format of ${overrides === 1 ? "its" : "their"} own.`);
      }
    } catch (error) {
      if (!editor.formats.loaded) {
        editor.formats.rows = [];
        renderFormatRows();
      }
      setStatus(`Could not load number formats (${error.message}).`, "error");
    }
    setBusy(false);
  }

  async function saveEditor() {
    const saveFormats = numberFormatsDirty();
    const saveTabs = tabDefaultsDirty();
    if (!saveFormats && !saveTabs) {
      setStatus("Nothing to save.");
      return;
    }
    setBusy(true);
    setStatus("Saving preferences...");
    const saved = [];
    try {
      if (saveFormats) {
        await saveNumberFormats();
        saved.push("Default number formats");
      }
      if (saveTabs) {
        saveTabDefaults();
        saved.push("Default tabs");
      }
      setStatus(`${saved.join(" and ")} saved.`, "success");
      api.postProjectInstanceStatus?.(`${saved.join(" and ")} saved.`);
    } catch (error) {
      setStatus(`Could not save preferences: ${error.message}`, "error");
    } finally {
      setBusy(false);
    }
  }

  function closeEditor() {
    if (editor.busy || els.piPrefsOverlay?.hidden) return;
    els.piPrefsOverlay.hidden = true;
    editor.lastFocus?.focus?.();
    editor.lastFocus = null;
  }

  async function openEditor(section = "") {
    if (!els.piPrefsOverlay || editor.busy) return;
    editor.lastFocus = document.activeElement;
    els.piPrefsOverlay.hidden = false;
    showSection(section || editor.section);
    await loadEditor();
    if (editor.section === "formats") {
      els.piPrefsFormatsDefault?.focus();
      els.piPrefsFormatsDefault?.select();
    } else {
      els.piPrefsTabsList?.querySelector('.pi-prefs-tabchip[aria-checked="true"]')?.focus();
    }
  }

  function beginDrag(event) {
    if (event.button !== 0 || event.target.closest("button")) return;
    const win = els.piPrefsWindow;
    const rect = win?.getBoundingClientRect();
    if (!win || !rect) return;
    win.style.transform = "none";
    win.style.left = `${rect.left}px`;
    win.style.top = `${rect.top}px`;
    editor.drag = { offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
    els.piPrefsHeader?.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  function moveDrag(event) {
    if (!editor.drag) return;
    const win = els.piPrefsWindow;
    const maxLeft = Math.max(8, window.innerWidth - win.offsetWidth - 8);
    const maxTop = Math.max(8, window.innerHeight - 42);
    win.style.left = `${Math.max(8, Math.min(event.clientX - editor.drag.offsetX, maxLeft))}px`;
    win.style.top = `${Math.max(8, Math.min(event.clientY - editor.drag.offsetY, maxTop))}px`;
  }

  function endDrag(event) {
    if (!editor.drag) return;
    editor.drag = null;
    els.piPrefsHeader?.releasePointerCapture?.(event.pointerId);
  }

  function initPreferencesWindow() {
    if (!els.piPrefsBtn || els.piPrefsBtn.dataset.wired === "1") return;
    els.piPrefsBtn.dataset.wired = "1";
    attachArcrhoTooltip(els.piPrefsBtn, "Preferences");
    els.piPrefsBtn.addEventListener("click", () => void openEditor());
    els.piPrefsClose?.addEventListener("click", closeEditor);
    els.piPrefsCancel?.addEventListener("click", closeEditor);
    els.piPrefsSave?.addEventListener("click", () => void saveEditor());
    els.piPrefsFormatsAdd?.addEventListener("click", addOverride);
    els.piPrefsFormatsFilter?.addEventListener("input", renderFormatRows);
    // Inherited rows show the fallback as their placeholder, so retyping it
    // has to repaint them; the table lives outside that input, so focus stays.
    els.piPrefsFormatsDefault?.addEventListener("input", renderFormatRows);
    els.piPrefsTabsReset?.addEventListener("click", resetTabDefaults);
    for (const item of els.piPrefsNav?.querySelectorAll(".pi-prefs-nav-item") || []) {
      item.addEventListener("click", () => showSection(item.dataset.section));
    }
    els.piPrefsHeader?.addEventListener("pointerdown", beginDrag);
    els.piPrefsHeader?.addEventListener("pointermove", moveDrag);
    els.piPrefsHeader?.addEventListener("pointerup", endDrag);
    els.piPrefsHeader?.addEventListener("pointercancel", endDrag);
    window.addEventListener("storage", adoptTabDefaultsFromAnotherWindow);
    document.addEventListener("keydown", (event) => {
      if (els.piPrefsOverlay?.hidden) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeEditor();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "s") {
        event.preventDefault();
        void saveEditor();
      }
    });
    renderTabDefaults();
  }

  Object.assign(api, {
    initProjectInstancePreferences: initPreferencesWindow,
    openProjectInstancePreferences: openEditor,
  });
}
