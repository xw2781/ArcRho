/* The Project Instance Preferences window.

   Two sections today, each with its own storage scope:

   - Number Formats is server-shared. It reads and writes
     `<workspace_root>/config/dataset_number_formats.json` through
     `/dataset/number-format-defaults`, with the same revision check the
     standalone editor used, so two open windows cannot overwrite each other.
   - Default Tabs is project-user-specific. It reads and writes
     `projects/<project>/users/<login>/preferences.json` through
     `/project-user-preferences`, under the key the shared window tab catalog
     owns.

   The tab lists and the app defaults come from the catalog, which the pages
   themselves read, so the window can never offer a tab a page does not have. */

import { attachArcrhoTooltip } from "/ui/shared/components/tooltip/tooltip.js?v=20260812a";
import {
  DEFAULT_WINDOW_TABS_PREFERENCE_KEY,
  WINDOW_TAB_KINDS,
  appDefaultWindowTabs,
  readDefaultWindowTabs,
} from "/ui/shared/tabs/window_tab_catalog.js?v=20260824e";

const NUMBER_FORMATS_ENDPOINT = "/dataset/number-format-defaults";

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
  const { api, els, projectName, state } = ctx;
  const {
    getProjectUserPreferencesPath,
    loadProjectUserPreferences,
    saveProjectUserPreferences,
  } = ctx;
  const editor = {
    section: "formats",
    busy: false,
    lastFocus: null,
    drag: null,
    formats: { revision: 0, rows: [], loaded: false, savedDefault: "", savedRows: [] },
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
    return editor.formats.rows.filter((row) => (
      `${row.dataset_type_name} ${row.number_format}`.toLocaleLowerCase().includes(query)
    ));
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
    els.piPrefsFormatsEmpty.hidden = rows.length > 0;
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
        input.addEventListener("input", () => updateFormatRow(row.id, field, input.value));
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
        editor.formats.rows = editor.formats.rows.filter((item) => item.id !== row.id);
        renderFormatRows();
      });
      action.appendChild(remove);
      tr.appendChild(action);
      body.appendChild(tr);
    }
  }

  function addOverride() {
    const row = {
      id: `row-${Date.now()}-${Math.random()}`,
      dataset_type_name: "",
      number_format: text(els.piPrefsFormatsDefault?.value) || "0,000",
    };
    editor.formats.rows.push(row);
    if (els.piPrefsFormatsFilter) els.piPrefsFormatsFilter.value = "";
    renderFormatRows();
    const lastRow = els.piPrefsFormatsBody?.lastElementChild;
    lastRow?.querySelector("input")?.focus();
    lastRow?.scrollIntoView({ block: "nearest" });
  }

  async function loadNumberFormats() {
    editor.formats.loaded = false;
    const response = await fetch(NUMBER_FORMATS_ENDPOINT, { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) throw new Error(detailMessage(payload, `HTTP ${response.status}`));
    editor.formats.revision = Number(payload.revision) || 0;
    editor.formats.rows = (Array.isArray(payload.overrides) ? payload.overrides : []).map((row, index) => ({
      id: `row-${Date.now()}-${index}`,
      dataset_type_name: text(row?.dataset_type_name),
      number_format: text(row?.number_format),
    }));
    editor.formats.savedRows = editor.formats.rows.map(({ dataset_type_name, number_format }) => (
      `${dataset_type_name}${number_format}`
    ));
    editor.formats.savedDefault = text(payload.default_number_format) || "0,000";
    editor.formats.loaded = true;
    els.piPrefsFormatsDefault.value = editor.formats.savedDefault;
    els.piPrefsFormatsPath.textContent = text(payload.path);
    els.piPrefsFormatsFilter.value = "";
    renderFormatRows();
  }

  function numberFormatsDirty() {
    if (!editor.formats.loaded) return false;
    if (text(els.piPrefsFormatsDefault?.value) !== editor.formats.savedDefault) return true;
    const current = editor.formats.rows.map((row) => `${text(row.dataset_type_name)}${text(row.number_format)}`);
    return current.length !== editor.formats.savedRows.length
      || current.some((value, index) => value !== editor.formats.savedRows[index]);
  }

  function numberFormatsPayload() {
    const fallback = text(els.piPrefsFormatsDefault?.value);
    if (!fallback) throw new Error("Fallback number format is required.");
    const overrides = editor.formats.rows.map((row, index) => {
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
    return { expected_revision: editor.formats.revision, default_number_format: fallback, overrides };
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
    editor.formats.savedRows = body.overrides.map((row) => `${row.dataset_type_name}${row.number_format}`);
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

  async function loadTabDefaults() {
    editor.tabs.loaded = false;
    if (!projectName) {
      editor.tabs.chosen = appDefaultWindowTabs();
      editor.tabs.saved = appDefaultWindowTabs();
      els.piPrefsTabsPath.textContent = "";
      renderTabDefaults();
      throw new Error("Project name is missing.");
    }
    const preferences = await loadProjectUserPreferences(projectName, { forceReload: true });
    editor.tabs.saved = readDefaultWindowTabs(preferences);
    editor.tabs.chosen = { ...editor.tabs.saved };
    editor.tabs.loaded = true;
    // Opening the window re-reads the file, so adopt what it says: another
    // machine may have changed these defaults since this page booted.
    state.defaultWindowTabs = editor.tabs.saved;
    els.piPrefsTabsPath.textContent = getProjectUserPreferencesPath(projectName);
    renderTabDefaults();
  }

  function tabDefaultsDirty() {
    return editor.tabs.loaded && !sameTabDefaults(editor.tabs.chosen, editor.tabs.saved);
  }

  async function saveTabDefaults() {
    // Every kind is written, never a partial map: the preferences file is
    // deep-merged on the server, so an omitted kind would keep its old value
    // instead of returning to the app default.
    const chosen = { ...editor.tabs.chosen };
    await saveProjectUserPreferences(projectName, { [DEFAULT_WINDOW_TABS_PREFERENCE_KEY]: chosen });
    editor.tabs.saved = chosen;
    state.defaultWindowTabs = chosen;
    els.piPrefsTabsPath.textContent = getProjectUserPreferencesPath(projectName);
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
    const failures = [];
    const results = await Promise.allSettled([loadNumberFormats(), loadTabDefaults()]);
    if (results[0].status === "rejected") failures.push(`number formats (${results[0].reason?.message || results[0].reason})`);
    if (results[1].status === "rejected") failures.push(`default tabs (${results[1].reason?.message || results[1].reason})`);
    if (failures.length) {
      if (!editor.formats.loaded) {
        editor.formats.rows = [];
        renderFormatRows();
      }
      setStatus(`Could not load ${failures.join(" and ")}.`, "error");
    } else {
      const count = editor.formats.rows.length;
      setStatus(`${count} number-format override${count === 1 ? "" : "s"} loaded.`);
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
        await saveTabDefaults();
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

  /* The window openers need the user's defaults the moment a window is opened,
     so Project Instance keeps a snapshot on its own state rather than awaiting
     a read per window. The preferences file is already cached by the shared
     client, so this costs no extra network round trip at boot. */
  async function loadDefaultWindowTabPreferences() {
    if (!projectName) return;
    try {
      const preferences = await loadProjectUserPreferences(projectName);
      state.defaultWindowTabs = readDefaultWindowTabs(preferences);
    } catch (err) {
      console.warn("Failed to load default window tabs:", err);
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
    els.piPrefsTabsReset?.addEventListener("click", resetTabDefaults);
    for (const item of els.piPrefsNav?.querySelectorAll(".pi-prefs-nav-item") || []) {
      item.addEventListener("click", () => showSection(item.dataset.section));
    }
    els.piPrefsHeader?.addEventListener("pointerdown", beginDrag);
    els.piPrefsHeader?.addEventListener("pointermove", moveDrag);
    els.piPrefsHeader?.addEventListener("pointerup", endDrag);
    els.piPrefsHeader?.addEventListener("pointercancel", endDrag);
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
    loadDefaultWindowTabPreferences,
    openProjectInstancePreferences: openEditor,
  });
}
