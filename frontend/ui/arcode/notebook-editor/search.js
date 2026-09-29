// Command mode searches source models across the notebook; edit mode delegates
// to the active cell's Monaco find widget.
const notebookSearch = (() => {
  const byId = (id) => document.getElementById(id);
  const panel = byId("notebookSearch");
  const query = byId("notebookSearchQuery");
  const matchCase = byId("notebookSearchCase");
  const replacement = byId("notebookReplaceText");
  const replaceRow = byId("notebookReplaceRow");
  const toggleReplace = byId("notebookSearchToggleReplace");
  const count = byId("notebookSearchCount");
  const previous = byId("notebookSearchPrevious");
  const next = byId("notebookSearchNext");
  const replaceOne = byId("notebookReplaceOne");
  const replaceAll = byId("notebookReplaceAll");
  let matches = [];
  let current = -1;
  let subscriptions = [];
  let decorations = [];
  let refreshQueued = false;

  function clearDecorations() {
    decorations.forEach((collection) => collection.clear());
    decorations = [];
  }

  function paint() {
    clearDecorations();
    count.textContent = matches.length ? `${current + 1} of ${matches.length}` : "No results";
    [previous, next, replaceOne, replaceAll].forEach((button) => {
      button.disabled = matches.length === 0;
    });
    const grouped = new Map();
    matches.forEach((match, index) => {
      if (!grouped.has(match.cell)) grouped.set(match.cell, []);
      grouped.get(match.cell).push({
        range: match.range,
        options: { inlineClassName: index === current ? "sc-search-current" : "sc-search-match" },
      });
    });
    grouped.forEach((ranges, cell) => decorations.push(cell.editor.createDecorationsCollection(ranges)));
  }

  function refresh() {
    if (panel.hidden) return;
    const selected = matches[current];
    matches = query.value ? cells.flatMap((cell) => {
      const model = cell.editor?.getModel();
      return model ? model.findMatches(query.value, false, false, matchCase.checked, null, false)
        .map(({ range }) => ({ cell, range })) : [];
    }) : [];
    const retained = selected ? matches.findIndex((match) => match.cell === selected.cell
      && match.range.startLineNumber === selected.range.startLineNumber
      && match.range.startColumn === selected.range.startColumn) : -1;
    current = matches.length ? (retained >= 0 ? retained : Math.max(0, Math.min(current, matches.length - 1))) : -1;
    paint();
  }

  function queueRefresh() {
    if (refreshQueued) return;
    refreshQueued = true;
    queueMicrotask(() => {
      refreshQueued = false;
      refresh();
    });
  }

  function watchCells() {
    subscriptions.forEach((subscription) => subscription.dispose());
    subscriptions = cells.filter((cell) => cell.editor)
      .map((cell) => cell.editor.onDidChangeModelContent(queueRefresh));
    refresh();
  }

  const observer = new MutationObserver(watchCells);

  function reveal() {
    const match = matches[current];
    if (!match) return;
    const { cell, range } = match;
    cell.hiddenByControllers?.forEach((id) => collapsedSectionControllers.delete(id));
    refreshSectionCollapses({ animate: false });
    if (cell.markdownRendered) setMarkdownRenderedState(cell, false);
    focusCell(cell.id, { includeCollapsedDescendants: false });
    cell.editor.setSelection(range);
    cell.editor.revealRangeInCenter(range);
    cell.cellEl.scrollIntoView({ block: "nearest" });
    const overlap = panel.getBoundingClientRect().bottom - cell.editorEl.getBoundingClientRect().top;
    if (overlap > 0) cellsArea.scrollTop -= overlap + 8;
  }

  function navigate(direction) {
    refresh();
    if (!matches.length) return;
    current = (current + direction + matches.length) % matches.length;
    paint();
    reveal();
  }

  function replace(all) {
    refresh();
    const targets = all ? matches : matches.slice(current, current + 1);
    if (!targets.length) return;
    commitPendingEditUndoSnapshot();
    recordNotebookUndoSnapshot();
    const grouped = new Map();
    targets.forEach(({ cell, range }) => {
      if (!grouped.has(cell)) grouped.set(cell, []);
      grouped.get(cell).push({ range, text: replacement.value });
    });
    grouped.forEach((edits, cell) => {
      // Command-mode editors are read-only; model edits preserve Monaco undo.
      const model = cell.editor.getModel();
      model.pushStackElement();
      model.pushEditOperations(null, edits, () => null);
      model.pushStackElement();
      if (cell.markdownRendered) setMarkdownRenderedState(cell, false);
    });
    refreshToc();
    saveCellsToStorage();
    refresh();
    reveal();
    setStatus(`Replaced ${targets.length} occurrence${targets.length === 1 ? "" : "s"} in notebook`);
  }

  function showReplace(show) {
    replaceRow.hidden = !show;
    toggleReplace.textContent = show ? "Hide Replace" : "Show Replace";
    toggleReplace.setAttribute("aria-expanded", String(show));
  }

  function close(restoreFocus = false) {
    panel.hidden = true;
    observer.disconnect();
    subscriptions.forEach((subscription) => subscription.dispose());
    subscriptions = [];
    clearDecorations();
    if (restoreFocus) byId("notebookFindBtn").focus();
  }

  function open(withReplace = false) {
    const cell = editingCellId === null ? null : getCellById(editingCellId);
    if (cell?.editor) {
      close();
      cell.editor.focus();
      cell.editor.getAction(withReplace ? "editor.action.startFindReplaceAction" : "actions.find").run();
      return;
    }
    panel.hidden = false;
    showReplace(withReplace);
    watchCells();
    observer.observe(cellsArea, { childList: true });
    query.focus();
    query.select();
  }

  query.addEventListener("input", () => { current = -1; refresh(); reveal(); });
  matchCase.addEventListener("change", () => { refresh(); reveal(); });
  previous.addEventListener("click", () => navigate(-1));
  next.addEventListener("click", () => navigate(1));
  replaceOne.addEventListener("click", () => replace(false));
  replaceAll.addEventListener("click", () => replace(true));
  toggleReplace.addEventListener("click", () => showReplace(replaceRow.hidden));
  byId("notebookSearchClose").addEventListener("click", () => close(true));
  byId("notebookFindBtn").addEventListener("mousedown", (event) => event.preventDefault());
  byId("notebookFindBtn").addEventListener("click", () => open(true));
  document.addEventListener("mousedown", (event) => {
    if (event.target.closest?.(".sc-cell-editor")) close();
  }, true);

  return { open, close, navigate, panel };
})();

function handleNotebookSearchKeydown(event) {
  const key = String(event.key || "").toLowerCase();
  const searchShortcut = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey
    && (key === "f" || key === "h");
  if (searchShortcut) {
    notebookSearch.open(key === "h");
  } else if (key === "escape" && !notebookSearch.panel.hidden) {
    notebookSearch.close(true);
  } else if (key === "escape" && editingCellId !== null) {
    const editor = getCellById(editingCellId)?.editor;
    if (document.querySelector("#notebookEditorWidgets .suggest-widget.visible")) {
      editor.trigger("notebook", "hideSuggestWidget", null);
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    if (document.querySelector("#notebookEditorWidgets .parameter-hints-widget.visible")) {
      editor.trigger("notebook", "closeParameterHints", null);
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    const find = editor?.getContribution("editor.contrib.findController");
    if (!find?.getState().isRevealed) return false;
    find.closeFindWidget();
  } else if (key === "enter" && notebookSearch.panel.contains(event.target)
    && event.target.tagName === "INPUT" && event.target.type !== "checkbox") {
    notebookSearch.navigate(event.shiftKey ? -1 : 1);
  } else {
    return false;
  }
  event.preventDefault();
  event.stopPropagation();
  return true;
}
