/*
===============================================================================
DFM Ratios Summary Runtime
Shared dependencies and lifecycle state for the ratios summary modules.
===============================================================================
*/
import * as dfmState from "/ui/method_pages/dfm/dfm_state.js";
import * as dfmStorage from "/ui/method_pages/dfm/dfm_storage.js";
import * as excelApi from "/ui/shared/integrations/excel_api.js";
import * as excelReference from "/ui/shared/integrations/excel_reference.js?v=20260715a";
import * as externalLinksModel from "/ui/method_pages/dfm/dfm_external_links_model.js?v=20260715a";
import * as formulaValidation from "/ui/method_pages/dfm/dfm_formula_validation.js?v=20260713b";
import {
  scrollSpreadsheetCellIntoView,
  wireSelectableTable,
} from "/ui/shared/components/spreadsheet/table_selection.js?v=20260726a";
import { openDfmSummaryPlotWindow } from "/ui/method_pages/dfm/dfm_summary_plot_window.js?v=20260722a";
import {
  hasDfmCellNote,
  showDfmCellNoteEditor,
} from "/ui/method_pages/dfm/dfm_cell_notes.js";
import {
  beginRatioHistoryAction,
  commitRatioHistoryAction,
} from "/ui/method_pages/dfm/dfm_ratio_history.js";

const noop = () => {};

export const summaryRuntime = {
  ...dfmState,
  ...dfmStorage,
  ...excelApi,
  ...formulaValidation,
  containsExcelRef: excelReference.containsExcelReference,
  excelColumnFromIndex: excelReference.excelColumnFromIndex,
  findExcelRefsInline: excelReference.findExcelReferences,
  formatExcelRef: excelReference.formatExcelReference,
  normalizeExcelReferenceAddressCase: excelReference.normalizeExcelReferenceAddressCase,
  parseStandaloneExcelRange: excelReference.parseStandaloneExcelRange,
  buildExcelRangeSourceCells: excelReference.buildExcelRangeSourceCells,
  collectDfmExternalLinkGroupsModel: externalLinksModel.collectDfmExternalLinkGroups,
  getDfmExternalLinkHardCodeTargets: externalLinksModel.getDfmExternalLinkHardCodeTargets,
  getDfmExternalLinkRangeTargets: externalLinksModel.getDfmExternalLinkRangeTargets,
  scrollSpreadsheetCellIntoView,
  wireSelectableTable,
  openDfmSummaryPlotWindow,
  hasDfmCellNote,
  showDfmCellNoteEditor,
  beginRatioHistoryAction,
  commitRatioHistoryAction,

  _xlCellValueCache: new Map(),
  _dfmExcelRefreshGeneration: 0,
  _dfmExcelRefreshAbortController: null,
  _applyingDfmExcelRefresh: false,
  _dfmExcelFreshnessGeneration: 0,
  _dfmExcelFreshnessAbortController: null,
  _renderRatioTable: noop,
  _onRatioStateMutated: noop,
  _toggleRatioInteractionMode: noop,
  summaryContextCellForNote: null,
  formulaBarResizeObserver: null,
  formulaBarScrollHost: null,
  formulaBarResizeWired: false,
  formulaBarResizeRaf: 0,
  formulaBarTooltipRaf: 0,
  SUMMARY_FORMULA_BAR_FRAME_INSET_PX: 14,
  SUMMARY_FORMULA_BAR_TOOLTIP_Z_INDEX: 1700,
  SUMMARY_FORMULA_BAR_TOOLTIP_MAX_Z_INDEX: 9998,
  avgMenuWired: false,
  summaryCopyHighlight: null,
  summaryActiveCellState: { rowId: "", col: -1 },
  summaryFormulaEditState: null,
  summaryFormulaBarState: { mode: "display", input: null, generation: 0 },
  summaryFormulaBarDisplayRaf: 0,
  summaryFormulaBarFocusRestoreHandler: null,
  summaryFormulaCommitGeneration: 0,
  summaryFormulaCommitLease: null,
  formulaValidationErrorInput: null,
  summaryReferenceDragState: null,
  _renameModalCallback: null,
  summarySelectionDestroy: null,
};

export function registerSummaryFunctions(functions) {
  Object.assign(summaryRuntime, functions);
}
