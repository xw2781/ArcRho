import { normalizeReviewTableOptions } from "/ui/shared/components/review_table/review_table.js?v=20260821b";

export function installProjectInstanceReviewTable(ctx) {
  const { api, state } = ctx;
  const closeDatasetWindow = (...args) => api.closeDatasetWindow(...args);
  const createFloatingContentWindow = (...args) => api.createFloatingContentWindow(...args);
  const getWindowIframe = (...args) => api.getWindowIframe(...args);
  const replyAutomationResult = (...args) => api.replyAutomationResult(...args);
  const setStatus = (...args) => api.setStatus(...args);
  const toText = (...args) => api.toText(...args);

  // dialogId -> { dialogId, inst, frame, options, status, result, error }.
  // Entries live until the automation caller closes them, mirroring the shell
  // review-table dialog contract, while the visible surface is a normal
  // pi-window that can be minimized to the toolbar or closed like any other
  // nested window.
  const reviewTableWindows = new Map();

  function reviewTableIdFromArgs(args = {}) {
    return toText(args.dialogId || args.dialog_id || args.id);
  }

  function findReviewTableEntryByInst(inst) {
    const id = toText(inst);
    if (!id) return null;
    for (const entry of reviewTableWindows.values()) {
      if (entry.inst === id) return entry;
    }
    return null;
  }

  function settleEntryIfWindowClosed(entry) {
    if (entry.status === "pending" && !entry.frame?.isConnected) {
      entry.status = "completed";
      entry.result = { accepted: false, selectedRowIds: [], optionStates: {} };
    }
  }

  function handleAutomationReviewTableOpen(message, sourceWindow) {
    const requestId = toText(message?.requestId);
    const args = message?.args && typeof message.args === "object" ? message.args : {};
    const reply = (payload) => replyAutomationResult(sourceWindow, requestId, payload);
    if (!requestId) return true;
    for (const entry of reviewTableWindows.values()) {
      settleEntryIfWindowClosed(entry);
      if (entry.status === "pending") {
        reply({ ok: false, error: "Finish the open review table before opening another one." });
        return true;
      }
    }
    let model = null;
    try {
      model = normalizeReviewTableOptions(args);
    } catch (err) {
      reply({ ok: false, error: toText(err?.message) || "Review table payload is invalid." });
      return true;
    }
    const dialogId = reviewTableIdFromArgs(args)
      || `review_pi_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    if (reviewTableWindows.has(dialogId)) {
      reply({ ok: false, error: `Review table already exists: ${dialogId}` });
      return true;
    }
    const inst = `pi_review_${Date.now()}_${state.windowSeq++}`;
    const title = state.selectedPath ? `${state.selectedPath}\\${model.title}` : model.title;
    const frame = createFloatingContentWindow({
      kind: "review_table",
      name: model.title,
      itemName: model.title,
      title,
      windowKey: `review\u0001${dialogId}`,
      inst,
      iframeSrc: `/ui/shared/components/review_table/review_table_window.html?inst=${encodeURIComponent(inst)}&v=${Date.now()}`,
      path: state.selectedPath,
    });
    if (!frame) {
      reply({ ok: false, error: "Could not open the review table window." });
      return true;
    }
    reviewTableWindows.set(dialogId, {
      dialogId,
      inst,
      frame,
      options: args,
      status: "pending",
      result: null,
      error: "",
    });
    reply({ ok: true, result: { dialogId } });
    return true;
  }

  function handleAutomationReviewTableStatus(message, sourceWindow) {
    const requestId = toText(message?.requestId);
    const args = message?.args && typeof message.args === "object" ? message.args : {};
    const reply = (payload) => replyAutomationResult(sourceWindow, requestId, payload);
    if (!requestId) return true;
    const dialogId = reviewTableIdFromArgs(args);
    if (!dialogId) {
      reply({ ok: false, error: "Review table status requires dialogId." });
      return true;
    }
    const entry = reviewTableWindows.get(dialogId);
    if (!entry) {
      reply({ ok: false, error: `Review table is not available: ${dialogId}` });
      return true;
    }
    settleEntryIfWindowClosed(entry);
    if (entry.status === "error") {
      reply({ ok: true, result: { dialogId, status: "error", pending: false, error: entry.error } });
      return true;
    }
    if (entry.status === "pending") {
      reply({ ok: true, result: { dialogId, status: "pending", pending: true } });
      return true;
    }
    reply({
      ok: true,
      result: {
        dialogId,
        status: "completed",
        pending: false,
        accepted: !!entry.result?.accepted,
        selectedRowIds: Array.isArray(entry.result?.selectedRowIds) ? [...entry.result.selectedRowIds] : [],
        optionStates: entry.result?.optionStates && typeof entry.result.optionStates === "object"
          ? { ...entry.result.optionStates }
          : {},
      },
    });
    return true;
  }

  function handleAutomationReviewTableClose(message, sourceWindow) {
    const requestId = toText(message?.requestId);
    const args = message?.args && typeof message.args === "object" ? message.args : {};
    const reply = (payload) => replyAutomationResult(sourceWindow, requestId, payload);
    if (!requestId) return true;
    const dialogId = reviewTableIdFromArgs(args);
    if (!dialogId) {
      reply({ ok: false, error: "Closing a review table requires dialogId." });
      return true;
    }
    const entry = reviewTableWindows.get(dialogId);
    if (!entry) {
      reply({ ok: true, result: { dialogId, closed: false, cancelled: false } });
      return true;
    }
    settleEntryIfWindowClosed(entry);
    const cancelled = entry.status === "pending";
    if (entry.frame?.isConnected) {
      closeDatasetWindow(entry.frame, { status: false, skipChildCloseRequest: true });
    }
    reviewTableWindows.delete(dialogId);
    reply({ ok: true, result: { dialogId, closed: true, cancelled } });
    return true;
  }

  function handleReviewTableWindowMessage(message, sourceWindow) {
    const entry = findReviewTableEntryByInst(message?.inst);
    if (!entry) return true;
    const iframe = getWindowIframe(entry.frame);
    if (!iframe?.contentWindow || iframe.contentWindow !== sourceWindow) return true;
    if (message.type === "arcrho:review-table-window-ready") {
      try {
        iframe.contentWindow.postMessage({
          type: "arcrho:review-table-window-init",
          inst: entry.inst,
          options: entry.options,
        }, "*");
      } catch {}
      return true;
    }
    if (entry.status !== "pending") return true;
    if (message.type === "arcrho:review-table-window-complete") {
      entry.status = "completed";
      entry.result = {
        accepted: !!message.accepted,
        selectedRowIds: Array.isArray(message.selectedRowIds)
          ? message.selectedRowIds.map((value) => toText(value)).filter(Boolean)
          : [],
        optionStates: message.optionStates && typeof message.optionStates === "object"
          ? Object.fromEntries(
            Object.entries(message.optionStates).map(([key, value]) => [toText(key), !!value]),
          )
          : {},
      };
      if (entry.frame?.isConnected) {
        closeDatasetWindow(entry.frame, { status: false, skipChildCloseRequest: true });
      }
      setStatus(entry.result.accepted
        ? `Accepted ${entry.result.selectedRowIds.length} review action(s).`
        : "Review cancelled.");
      return true;
    }
    if (message.type === "arcrho:review-table-window-error") {
      entry.status = "error";
      entry.error = toText(message.error) || "Review table failed to render.";
      if (entry.frame?.isConnected) {
        closeDatasetWindow(entry.frame, { status: false, skipChildCloseRequest: true });
      }
      setStatus(`Review table failed: ${entry.error}`, true);
      return true;
    }
    return true;
  }

  Object.assign(api, {
    handleAutomationReviewTableOpen,
    handleAutomationReviewTableStatus,
    handleAutomationReviewTableClose,
    handleReviewTableWindowMessage,
  });
}
