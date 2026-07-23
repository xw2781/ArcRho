import { createExternalLinksTab } from "/ui/shared/tabs/links/links_tab.js?v=20260715b";
import {
  breakDfmExternalLinks,
  getDfmExternalLinkRecords,
  refreshAllExcelLinks,
} from "/ui/method_pages/dfm/dfm_ratios_summary_table.js?v=20260722a";

let dfmLinksController = null;
let linksChangedListener = null;

function postDfmLinksStatus(message, tone = "") {
  const text = String(message || "").trim();
  if (!text) return;
  window.parent?.postMessage?.({
    type: "arcrho:status",
    text,
    ...(tone ? { tone } : {}),
  }, "*");
}

export function refreshDfmLinks() {
  return dfmLinksController?.refresh?.() || Promise.resolve(false);
}

export function initDfmLinks() {
  if (dfmLinksController) return dfmLinksController;
  const container = document.getElementById("dfmLinksMount");
  if (!container) return null;
  dfmLinksController = createExternalLinksTab({
    container,
    ariaLabel: "DFM external links",
    emptyDescription: "Excel links used by User Entry cells in the Ratios tab will appear here.",
    getLinks: () => getDfmExternalLinkRecords(),
    onRefreshLinks: (records) => refreshAllExcelLinks({
      source: "links-tab",
      sourceIds: records.map((record) => record?.id).filter(Boolean),
    }),
    onBreakLinks: (records) => breakDfmExternalLinks(
      records.map((record) => record?.id).filter(Boolean),
    ),
    onStatus: postDfmLinksStatus,
  });
  linksChangedListener = () => {
    void refreshDfmLinks();
  };
  window.addEventListener("arcrho:dfm-links-changed", linksChangedListener);
  void refreshDfmLinks();
  return dfmLinksController;
}

export function destroyDfmLinks() {
  if (linksChangedListener) {
    window.removeEventListener("arcrho:dfm-links-changed", linksChangedListener);
    linksChangedListener = null;
  }
  dfmLinksController?.destroy?.();
  dfmLinksController = null;
}
