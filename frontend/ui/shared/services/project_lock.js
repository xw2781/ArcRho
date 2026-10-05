/*
===============================================================================
Project lock - the client side of the project-wide data lock
===============================================================================
A locked project refuses every save of its data on the server. This module
lets a page ask before it starts a save, so the user gets one clear message
instead of a failed save. The server stays the authority: when the lock
cannot be read, the save goes ahead and the server answers for itself.
*/

import { showPageMessageBox } from "/ui/shared/components/message_box/message_box.js?v=20260925a";

/**
 * Reads the lock state of one project.
 *
 * @param {string} projectName
 * @param {{fetchImpl?: Function}} [options]
 * @returns {Promise<{locked: boolean, locked_by: string, locked_at: string, message: string}>}
 */
export async function readProjectLock(projectName, { fetchImpl } = {}) {
  const name = String(projectName || "").trim();
  const doFetch = fetchImpl || fetch;
  const resp = await doFetch(`/project_lock?project_name=${encodeURIComponent(name)}`);
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(String(payload?.detail || `HTTP ${resp.status}`));
  return {
    locked: payload?.locked === true,
    locked_by: String(payload?.locked_by || ""),
    locked_at: String(payload?.locked_at || ""),
    message: String(payload?.message || ""),
  };
}

/** Shows the locked-project message box. */
export function showProjectLockedMessage(message, { documentRef } = {}) {
  return showPageMessageBox({
    title: "Project Locked",
    message,
    tone: "warn",
    documentRef: documentRef || document,
  });
}

/**
 * Refuses a save on a locked project with a message box.
 *
 * @param {string} projectName
 * @param {{fetchImpl?: Function, documentRef?: Document}} [options]
 * @returns {Promise<string>} The message shown when the project is locked,
 *   an empty string when the save may go ahead.
 */
export async function refuseIfProjectLocked(projectName, { fetchImpl, documentRef } = {}) {
  if (!String(projectName || "").trim()) return "";
  let lock;
  try {
    lock = await readProjectLock(projectName, { fetchImpl });
  } catch {
    return "";
  }
  if (!lock.locked) return "";
  void showProjectLockedMessage(lock.message, { documentRef });
  return lock.message;
}
