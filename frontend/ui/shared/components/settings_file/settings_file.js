/*
 * Settings files: a panel writes some of its own state to a JSON file the user keeps, and
 * loads it back by dropping the file on that panel.
 *
 * Every such file is the panel's own payload under a `kind` that says which panel reads it,
 * so one panel can never be handed another's file. Saving goes through the desktop host's
 * save dialog; loading is a drag and drop onto the panel, which marks itself so the shell's
 * window-wide scripting-file drop leaves it alone.
 *
 * The desktop host remembers the paths of the last few files of each kind a panel saved or
 * loaded, so the panel's menu can offer them again. Only the paths are kept, never the files.
 */

import { attachArcrhoTooltip } from "/ui/shared/components/tooltip/tooltip.js?v=20260925a";
import { showPageMessageBox } from "/ui/shared/components/message_box/message_box.js?v=20260925a";

const STYLE_ID = "arcrhoSettingsFileStyles";
const HINT_CLASS = "arcrho-settings-drop-hint";
const HINT_INSET_PX = 6;
const RECENT_FILES_LIMIT = 3;

const HINT_STATE = new WeakMap();
let activeMenu = null;

function ensureStyles(doc) {
  if (!doc?.head || doc.getElementById(STYLE_ID)) return;
  const link = doc.createElement("link");
  link.id = STYLE_ID;
  link.rel = "stylesheet";
  link.href = "/ui/shared/components/settings_file/settings_file.css?v=20260925a";
  doc.head.appendChild(link);
}

function settingsHost() {
  return window.ADAHost || window.top?.ADAHost || null;
}

function fileNameOf(filePath) {
  return String(filePath || "").split(/[\\/]/).pop() || String(filePath || "");
}

/**
 * The paths of the settings files of this `kind` saved or loaded most recently, newest first.
 */
export async function loadRecentSettingsFiles(kind) {
  const load = settingsHost()?.loadRecentSettingsFilePreferences;
  if (typeof load !== "function") return [];
  try {
    const paths = (await load())?.preferences?.recent?.[String(kind)];
    return Array.isArray(paths) ? paths.map(String).filter(Boolean).slice(0, RECENT_FILES_LIMIT) : [];
  } catch {
    return [];
  }
}

/**
 * Puts a settings file first in its kind's recent list. `fileOrPath` is a path, or a file
 * dropped from File Explorer, whose path the host resolves.
 */
export async function rememberRecentSettingsFile(kind, fileOrPath) {
  const host = settingsHost();
  if (typeof host?.loadRecentSettingsFilePreferences !== "function") return;
  try {
    const filePath = typeof fileOrPath === "string"
      ? fileOrPath
      : String(host.getPathForFile?.(fileOrPath) || "");
    if (!filePath) return;
    const preferences = (await host.loadRecentSettingsFilePreferences())?.preferences || {};
    const recent = { ...(preferences.recent || {}) };
    const key = filePath.toLowerCase();
    const previous = Array.isArray(recent[kind]) ? recent[kind] : [];
    recent[kind] = [filePath, ...previous.filter((item) => String(item).toLowerCase() !== key)]
      .slice(0, RECENT_FILES_LIMIT);
    await host.saveRecentSettingsFilePreferences({ recent });
  } catch {
    // A host that cannot write only costs the menu its recent entries.
  }
}

/**
 * Asked before a panel loads a settings file over state it already has. When a recently used
 * file of this `kind` holds that state (`keyOf(fileData) === currentKey`) nothing is lost and
 * the load goes ahead; otherwise the user chooses Save, which runs `save` (resolving true once
 * written), or Discard. Resolves to true when the load may go ahead.
 */
export async function confirmSaveBeforeLoad({ kind, label = "settings", title = "Load Settings", currentKey, keyOf, save }) {
  const recentFiles = await loadRecentSettingsFiles(kind);
  const results = await Promise.all(recentFiles.map((filePath) => openSettingsFile({ kind, label, filePath })));
  if (results.some((result) => result.ok && keyOf(result.data) === currentKey)) return true;
  const answer = await showPageMessageBox({
    title,
    message: `Save the current ${label} first?`,
    actions: [{ id: "save", label: "Save" }, { id: "discard", label: "Discard" }],
    showOk: false,
  });
  if (answer === "save") return !!(await save());
  return answer === "discard";
}

function ensureHint(doc) {
  const cached = HINT_STATE.get(doc);
  if (cached?.element?.isConnected) return cached;

  const element = doc.createElement("div");
  element.className = HINT_CLASS;
  element.setAttribute("aria-hidden", "true");
  const label = doc.createElement("span");
  label.className = "arcrho-settings-drop-hint-label";
  element.appendChild(label);
  doc.body.appendChild(element);

  const state = { element, label, openTarget: null };
  HINT_STATE.set(doc, state);
  // A panel removed while a file is still over it would otherwise leave the hint
  // showing, because its own dragleave never arrives.
  doc.addEventListener("dragend", () => hideHint(doc), true);
  doc.addEventListener("drop", () => hideHint(doc), true);
  return state;
}

function showHint(doc, target, text) {
  const state = ensureHint(doc);
  if (state.openTarget === target) return;
  const rect = target.getBoundingClientRect();
  state.element.style.left = `${Math.round(rect.left + HINT_INSET_PX)}px`;
  state.element.style.top = `${Math.round(rect.top + HINT_INSET_PX)}px`;
  state.element.style.width = `${Math.max(0, Math.round(rect.width - (HINT_INSET_PX * 2)))}px`;
  state.element.style.height = `${Math.max(0, Math.round(rect.height - (HINT_INSET_PX * 2)))}px`;
  state.label.textContent = text;
  state.element.classList.add("open");
  state.openTarget = target;
}

function hideHint(doc) {
  const state = HINT_STATE.get(doc);
  if (!state) return;
  state.element.classList.remove("open");
  state.openTarget = null;
}

function hasDraggedFiles(event) {
  return Array.from(event?.dataTransfer?.types || []).includes("Files");
}

/**
 * Builds the document a panel saves: its own payload under the `kind` that identifies it.
 */
export function buildSettingsFile({ kind, version = 1, projectName = "", data = {} }) {
  return {
    kind: String(kind || ""),
    version: Number(version) || 1,
    project_name: String(projectName || ""),
    ...(data && typeof data === "object" ? data : {}),
  };
}

function parseSettingsPayload(name, rawText, kind, label) {
  let parsed = null;
  try {
    parsed = JSON.parse(String(rawText || ""));
  } catch {
    throw new Error(`${name} is not readable JSON.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || String(parsed.kind || "") !== String(kind)) {
    throw new Error(`${name} is not an ArcRho ${label} file.`);
  }
  return parsed;
}

/**
 * Reads a dropped file and returns its parsed payload, or throws a message meant for the
 * status bar: a file that is not JSON, or one written by a different panel, never reaches
 * the caller.
 */
export async function readSettingsFile(file, { kind, label = "settings" } = {}) {
  const name = String(file?.name || "").trim();
  if (!/\.json$/i.test(name) || typeof file?.text !== "function") {
    throw new Error(`Drop a ${label} .json file to load it.`);
  }
  return parseSettingsPayload(name, await file.text(), kind, label);
}

/**
 * Asks for a settings file through the desktop host's open dialog, or reads the one at
 * `filePath` when given, and returns its parsed payload. Resolves to `{ ok: true, data, path }`,
 * or `{ ok: false, reason }` where reason is `no-host`, `canceled`, or `error` with an `error`
 * message meant for the status bar.
 */
export async function openSettingsFile({ kind, label = "settings", filterName = "ArcRho Settings", startDir = "", filePath: givenPath = "" } = {}) {
  const host = settingsHost();
  if ((!givenPath && typeof host?.pickOpenFile !== "function") || typeof host?.readTextFile !== "function") {
    return { ok: false, reason: "no-host" };
  }
  let filePath = String(givenPath || "");
  if (!filePath) {
    try {
      filePath = String(await host.pickOpenFile({
        startDir,
        filters: [{ name: String(filterName), extensions: ["json"] }],
      }) || "");
    } catch (err) {
      return { ok: false, reason: "error", error: String(err?.message || err) };
    }
  }
  if (!filePath) return { ok: false, reason: "canceled" };

  const name = fileNameOf(filePath);
  let read = null;
  try {
    read = await host.readTextFile({ path: filePath });
  } catch (err) {
    return { ok: false, reason: "error", error: String(err?.message || err) };
  }
  if (!read?.ok) return { ok: false, reason: "error", error: String(read?.error || `${name} could not be read.`) };
  try {
    return { ok: true, data: parseSettingsPayload(name, read.text, kind, label), path: filePath };
  } catch (err) {
    return { ok: false, reason: "error", error: String(err?.message || err) };
  }
}

/**
 * Writes a settings file through the desktop host's save dialog. Resolves to
 * `{ ok: true, path }`, or `{ ok: false, reason }` where reason is `no-host` (running
 * outside the desktop app), `canceled`, or `error` with an `error` message.
 */
export async function saveSettingsFile({ data, suggestedName, filterName = "ArcRho Settings" } = {}) {
  const host = settingsHost();
  if (typeof host?.saveJsonFile !== "function") return { ok: false, reason: "no-host" };
  let result = null;
  try {
    result = await host.saveJsonFile({
      data,
      suggestedName: String(suggestedName || "settings.json"),
      filters: [{ name: String(filterName), extensions: ["json"] }],
    });
  } catch (err) {
    return { ok: false, reason: "error", error: String(err?.message || err) };
  }
  if (result?.canceled) return { ok: false, reason: "canceled" };
  if (result?.error) return { ok: false, reason: "error", error: String(result.error) };
  return { ok: true, path: String(result?.path || "") };
}

/**
 * Closes the settings menu if one is open. Safe to call when none is.
 */
export function closeSettingsFileMenu() {
  const active = activeMenu;
  if (!active) return;
  activeMenu = null;
  active.doc.removeEventListener("mousedown", active.onDismiss, true);
  active.doc.removeEventListener("contextmenu", active.onDismiss, true);
  active.doc.removeEventListener("keydown", active.onKeyDown, true);
  if (active.menu.parentNode) active.menu.parentNode.removeChild(active.menu);
}

/**
 * Opens the panel's settings menu at the pointer: "Save <label>" and "Load <label>", then
 * one `Load "<file name>"` per path in `recentFiles`, below a divider, which hands that path
 * to `onLoadRecent`. `label` names what the file holds, so one panel's menu can never be
 * mistaken for another's. Given an `anchorElement`, the menu opens below it instead.
 */
export function openSettingsFileMenu({ event, label = "Config", onSave, onLoad, recentFiles = [], onLoadRecent, anchorElement, documentRef } = {}) {
  const doc = documentRef || event?.target?.ownerDocument || document;
  closeSettingsFileMenu();
  ensureStyles(doc);

  const menu = doc.createElement("div");
  menu.className = "arcrho-settings-menu";
  menu.setAttribute("role", "menu");
  const addItem = (text, action) => {
    const button = doc.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.textContent = text;
    button.disabled = typeof action !== "function";
    button.addEventListener("click", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      closeSettingsFileMenu();
      try { action(); } catch {}
    });
    menu.appendChild(button);
    return button;
  };
  addItem(`Save ${label}`, onSave);
  addItem(`Load ${label}`, onLoad);
  const recentPaths = typeof onLoadRecent === "function" && Array.isArray(recentFiles) ? recentFiles : [];
  if (recentPaths.length) {
    const separator = doc.createElement("div");
    separator.className = "arcrho-settings-menu-separator";
    separator.setAttribute("role", "separator");
    menu.appendChild(separator);
    for (const filePath of recentPaths) {
      const button = addItem(`Load "${fileNameOf(filePath).replace(/\.json$/iu, "")}"`, () => onLoadRecent(filePath));
      attachArcrhoTooltip(button, filePath, { document: doc, placement: "right" });
    }
  }
  doc.body.appendChild(menu);

  const view = doc.defaultView || window;
  const viewportWidth = Number(view?.innerWidth || doc.documentElement.clientWidth || 0);
  const viewportHeight = Number(view?.innerHeight || doc.documentElement.clientHeight || 0);
  const rect = menu.getBoundingClientRect();
  const anchorRect = anchorElement?.getBoundingClientRect?.();
  let left = anchorRect ? anchorRect.left : Number(event?.clientX || 0);
  let top = anchorRect ? anchorRect.bottom + 2 : Number(event?.clientY || 0);
  if (left + rect.width > viewportWidth - 8) left = viewportWidth - rect.width - 8;
  if (top + rect.height > viewportHeight - 8) top = viewportHeight - rect.height - 8;
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;

  const onDismiss = (evt) => {
    if (menu.contains(evt.target)) return;
    closeSettingsFileMenu();
  };
  const onKeyDown = (evt) => {
    if (evt.key === "Escape") closeSettingsFileMenu();
  };
  doc.addEventListener("mousedown", onDismiss, true);
  doc.addEventListener("contextmenu", onDismiss, true);
  doc.addEventListener("keydown", onKeyDown, true);
  activeMenu = { doc, menu, onDismiss, onKeyDown };
  return menu;
}

/**
 * Makes one panel accept a dropped settings file. While a file is over the panel it shows
 * the shared drop hint, and `onFile` receives the first file dropped. Returns a function
 * that undoes the wiring.
 */
export function attachSettingsFileDropZone(target, options = {}) {
  const onFile = typeof options?.onFile === "function" ? options.onFile : null;
  if (!target || typeof target.addEventListener !== "function" || !onFile) return () => {};
  const doc = options?.documentRef || target.ownerDocument || document;
  ensureStyles(doc);
  const hint = String(options?.hint || "Drop a settings file to load it");
  target.dataset.fileDropZone = String(options?.name || "settings-file");

  const onDragEnter = (event) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    showHint(doc, target, hint);
  };
  const onDragOver = (event) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    showHint(doc, target, hint);
  };
  const onDragLeave = (event) => {
    const next = event?.relatedTarget;
    if (next && typeof target.contains === "function" && target.contains(next)) return;
    hideHint(doc);
  };
  const onDrop = (event) => {
    hideHint(doc);
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const file = Array.from(event.dataTransfer?.files || [])[0] || null;
    if (!file) return;
    try {
      onFile(file, { event, targetElement: target });
    } catch {
      // A panel's own failure is reported by that panel, never by the drop wiring.
    }
  };

  target.addEventListener("dragenter", onDragEnter, true);
  target.addEventListener("dragover", onDragOver, true);
  target.addEventListener("dragleave", onDragLeave, true);
  target.addEventListener("drop", onDrop, true);

  return () => {
    target.removeEventListener("dragenter", onDragEnter, true);
    target.removeEventListener("dragover", onDragOver, true);
    target.removeEventListener("dragleave", onDragLeave, true);
    target.removeEventListener("drop", onDrop, true);
    delete target.dataset.fileDropZone;
    hideHint(doc);
  };
}
