// Owns the Data tab's dirty and save-eligibility rules.
//
// "Has unsaved changes" and "has something to save" are not the same question.
// A Project Instance draft opens fully prefilled from the picked Dataset Type,
// so nothing is changed relative to a saved sidecar and every dirty flag stays
// clear, yet the new instance still has to be created before it exists. Keeping
// both answers in one place stops the save bar, the Ctrl+S save command, the
// grid payload builder, and the close confirmation from drifting apart.

export function createDatasetDirtyState(deps) {
  const {
    state,
    isProjectInstanceDraft,
    isReadOnlyDatasetViewer,
    isTemporaryDatasetView,
    isDfmDataTabHost,
    getProjectInstanceDraftDataFormat,
    getDatasetInstanceNameValue,
    normalizeDatasetInstanceKey,
    getSavedProjectInstanceDraftName,
    getDatasetSidecarSourceKind,
    getDatasetSidecarDataFormat,
    getDatasetExternalLinks,
    getDatasetInternalLinks,
    getDatasetFormulaLinks,
    isSettingsDirty,
    isNotesDirty,
  } = deps;

  function normalizeDatasetModeText(value) {
    return String(value || "").trim().toLowerCase();
  }

  function sourceKindIsReadOnly(value) {
    const sourceKind = normalizeDatasetModeText(value);
    return !!sourceKind && sourceKind !== "input";
  }

  function currentDatasetIsManualTriangleOrVector() {
    const sourceKind = normalizeDatasetModeText(getDatasetSidecarSourceKind() || state.model?.source_kind || "");
    const format = normalizeDatasetModeText(
      getDatasetSidecarDataFormat()
        || state.model?.data_format
        || (isProjectInstanceDraft ? getProjectInstanceDraftDataFormat() : ""),
    );
    const isManualInput = isProjectInstanceDraft || sourceKind === "input";
    const isTriangleOrVector = !format || format === "triangle" || format === "vector";
    return isManualInput && isTriangleOrVector;
  }

  function hasManualInputGridChanges() {
    return state.dirty.size > 0 && currentDatasetIsManualTriangleOrVector();
  }

  function hasUnsavedDatasetChanges() {
    if (isTemporaryDatasetView) return false;
    // DFM imports the Dataset runtime for its Data tab, but DFM persistence owns
    // the method's dirty state and close confirmation for the combined page.
    if (isDfmDataTabHost()) return false;
    return isSettingsDirty()
      || isNotesDirty()
      || hasManualInputGridChanges()
      || getDatasetExternalLinks().isDirty()
      || getDatasetInternalLinks().isDirty()
      || getDatasetFormulaLinks().isDirty();
  }

  // The draft stays save-eligible until it is persisted under its current Name;
  // renaming an already saved draft makes it pending again.
  function isUnsavedProjectInstanceDraft() {
    if (!isProjectInstanceDraft || isTemporaryDatasetView || isReadOnlyDatasetViewer) return false;
    if (isDfmDataTabHost()) return false;
    const savedName = normalizeDatasetInstanceKey(getSavedProjectInstanceDraftName());
    if (!savedName) return true;
    return normalizeDatasetInstanceKey(getDatasetInstanceNameValue()) !== savedName;
  }

  // The first draft save writes the zero-filled placeholder grid, so the new
  // instance gets its CSV cache even when the user typed no values into it.
  function shouldPersistManualInputGridValues() {
    if (!currentDatasetIsManualTriangleOrVector()) return false;
    return state.dirty.size > 0 || isUnsavedProjectInstanceDraft();
  }

  function hasPendingDatasetSaveWork() {
    return hasUnsavedDatasetChanges() || isUnsavedProjectInstanceDraft();
  }

  // A draft whose placeholder grid never built (invalid project origin headers)
  // has no values to persist, so Save stays blocked until the grid exists.
  function isDraftGridUnavailable() {
    return isProjectInstanceDraft && !state.model;
  }

  return {
    normalizeDatasetModeText,
    sourceKindIsReadOnly,
    currentDatasetIsManualTriangleOrVector,
    hasManualInputGridChanges,
    hasUnsavedDatasetChanges,
    isUnsavedProjectInstanceDraft,
    shouldPersistManualInputGridValues,
    hasPendingDatasetSaveWork,
    isDraftGridUnavailable,
  };
}
