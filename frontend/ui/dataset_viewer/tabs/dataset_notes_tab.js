import { mountNotesTab } from "/ui/shared/tabs/notes/notes_tab.js?v=20260714a";

export function wireDatasetNotesEditor(deps = {}) {
  const setNotesDirty = typeof deps.setNotesDirty === "function"
    ? deps.setNotesDirty
    : () => {};
  const updateNotesSaveUi = typeof deps.updateNotesSaveUi === "function"
    ? deps.updateNotesSaveUi
    : () => {};
  const setStatus = typeof deps.setStatus === "function"
    ? deps.setStatus
    : () => {};

  return mountNotesTab({
    container: deps.container || document.getElementById("datasetNotesMount"),
    ariaLabel: "Dataset notes",
    onChange: (_value, detail) => {
      setNotesDirty(!!detail?.dirty);
      updateNotesSaveUi();
    },
    onStatus: setStatus,
  });
}
