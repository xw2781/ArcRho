// Owns the number format a temporary-view Dataset Viewer shows.
//
// A temporary view has no saved sidecar settings of its own and skips the boot
// chain that resolves formatting for every other open, so the Dataset Type
// default from `config/dataset_number_formats.json` is the only format it can
// show. This module is the single place that resolves it, applies it to the
// Number Format and Decimal Places controls, and keeps the already-painted grid
// in step, so boot and the post-run sidecar sync cannot drift apart.

export function createTemporaryDatasetFormat(deps) {
  const {
    isTemporaryDatasetView,
    state,
    getDatasetNumberFormatDefaults,
    getCurrentDatasetSettings,
    normalizeDatasetSettings,
    buildDatasetSidecarContextPayload,
    hasDatasetSidecarContext,
    getDatasetSyncedNumberFormatValue,
    setDatasetDecimalPlacesValue,
    setDatasetNumberFormatValue,
    renderTable,
    notifyDatasetUpdated,
    applyGridSelectionFromState,
  } = deps;
  let settingsPromise = null;
  let settingsKey = "";

  // One request per Dataset Type: boot and the post-run sidecar sync both ask,
  // and the answer is workspace-global configuration that cannot change while a
  // read-only temporary window is open.
  async function loadNumberFormatSettings(context) {
    const key = String(context?.dataset_type || "").trim();
    if (!key) return null;
    if (settingsKey !== key) {
      settingsKey = key;
      settingsPromise = getDatasetNumberFormatDefaults({
        datasetTypeName: context.dataset_type,
      }).then((response) => {
        if (!response.ok || response.data?.ok === false) return null;
        const numberFormat = String(response.data?.resolved_number_format || "").trim();
        if (!numberFormat) return null;
        return {
          number_format: numberFormat,
          decimal_places: response.data?.resolved_decimal_places,
        };
      }).catch(() => null);
    }
    return settingsPromise;
  }

  async function resolveSettings(context) {
    const settings = await loadNumberFormatSettings(context);
    return normalizeDatasetSettings({
      ...getCurrentDatasetSettings(),
      ...(settings || {}),
    });
  }

  // Called from boot, before the first run schedules a paint, because the grid
  // formats from these controls at render time.
  async function applyDefaults() {
    if (!isTemporaryDatasetView) return false;
    const context = buildDatasetSidecarContextPayload();
    if (!hasDatasetSidecarContext(context)) return false;
    const settings = await resolveSettings(context);
    setDatasetDecimalPlacesValue(settings.decimal_places);
    setDatasetNumberFormatValue(settings.number_format);
    return true;
  }

  // Called from the sidecar sync, which runs after the run controller already
  // painted, so a format resolved there reaches the grid only on a repaint.
  function applyResolvedSettings(settings) {
    if (!isTemporaryDatasetView) return false;
    const renderedNumberFormat = getDatasetSyncedNumberFormatValue();
    setDatasetDecimalPlacesValue(settings.decimal_places);
    setDatasetNumberFormatValue(settings.number_format);
    if (!state.model || getDatasetSyncedNumberFormatValue() === renderedNumberFormat) return false;
    renderTable();
    notifyDatasetUpdated();
    applyGridSelectionFromState();
    return true;
  }

  return {
    loadTemporaryNumberFormatSettings: loadNumberFormatSettings,
    resolveTemporaryDatasetSettings: resolveSettings,
    applyTemporaryNumberFormatDefaults: applyDefaults,
    applyTemporaryNumberFormatSettings: applyResolvedSettings,
  };
}
