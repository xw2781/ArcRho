import { mountDatasetViewer } from "/ui/dataset_viewer/dataset_viewer_view.js?v=20260720c";
import { configureDataTabHost } from "/ui/shared/tabs/data/data_tab_context.js";
import { configureDataTabChart } from "/ui/shared/tabs/data/data_tab_chart_port.js";
import { configureDataTabNotes } from "/ui/shared/tabs/data/data_tab_notes_port.js";
import { configureDataTabPageHost } from "/ui/shared/tabs/data/data_tab_page_host_port.js";
import { configureDataTabAudit } from "/ui/shared/tabs/data/data_tab_audit_port.js";
import { configureDataTabCloseConfirm } from "/ui/shared/tabs/data/data_tab_close_port.js";
import { createPageCloseConfirm } from "/ui/shared/components/close_confirm/close_confirm.js";
import { createAuditLogView } from "/ui/shared/tabs/audit_log/audit_log_view.js?v=20260714c";
import {
  formatSidecarAuditEventDate,
  normalizeSidecarAuditEntries,
} from "/ui/shared/tabs/audit_log/sidecar_audit_entries.js?v=20260714c";
import {
  applyTabbedPageSaveBar,
  createTabbedPage,
} from "/ui/shared/tabbed_page/tabbed_page.js?v=20260714a";
import { wireTabPopoutWindows } from "/ui/shared/tabbed_page/tab_popout_window.js?v=20260714a";
import {
  redrawDatasetChartSafely,
  renderDatasetChart,
} from "/ui/dataset_viewer/tabs/dataset_chart_tab.js?v=20260715b";
import { wireDatasetNotesEditor } from "/ui/dataset_viewer/tabs/dataset_notes_tab.js?v=20260715a";
import { createExternalLinksTab } from "/ui/shared/tabs/links/links_tab.js?v=20260715b";
import { configureDataTabLinks } from "/ui/shared/tabs/data/data_tab_links_port.js";

const DATASET_VIEWER_TABS = [
  { id: "details", label: "Details" },
  { id: "data", label: "Data" },
  { id: "chart", label: "Chart" },
  { id: "notes", label: "Notes" },
  { id: "links", label: "Links" },
  { id: "auditLog", label: "Audit Log" },
];

function mountDatasetViewerTabs({
  initialTab,
  onDetailsActivated,
  onChartActivated,
  wireDataTabTopBarToggle,
} = {}) {
  const handleChartLayout = (tabId) => {
    if (tabId === "chart") onChartActivated?.();
  };
  const tabSystem = createTabbedPage(document.body, {
    tabs: DATASET_VIEWER_TABS,
    cssPrefix: "ds",
    initialTab,
    injectTabBar: false,
    onTabChange: (tabId) => {
      if (tabId === "details") onDetailsActivated?.();
      if (tabId === "chart") onChartActivated?.();
    },
  });
  applyTabbedPageSaveBar(document.getElementById("datasetSaveBar"));
  window.dsTabSystem = tabSystem;
  wireDataTabTopBarToggle?.(tabSystem);
  wireTabPopoutWindows({
    cssPrefix: "ds",
    tabs: DATASET_VIEWER_TABS,
    tabSystem: () => window.dsTabSystem,
    onPopoutTab: handleChartLayout,
    onDockTab: handleChartLayout,
    onFocusTab: handleChartLayout,
    onLayout: handleChartLayout,
  });
  return tabSystem;
}

mountDatasetViewer(document.getElementById("datasetRoot"));
configureDataTabAudit(createAuditLogView({
  container: document.getElementById("datasetAuditLogMount"),
  ariaLabel: "Dataset audit log",
  emptyDescription: "Dataset changes will appear here after the first save.",
  normalizeEntries: normalizeSidecarAuditEntries,
  formatEventDate: formatSidecarAuditEventDate,
}));
configureDataTabCloseConfirm(createPageCloseConfirm({ subject: "dataset" }));
configureDataTabHost("dataset_viewer");
configureDataTabChart({
  renderChart: renderDatasetChart,
  redrawChartSafely: redrawDatasetChartSafely,
});
configureDataTabNotes({ mountNotes: wireDatasetNotesEditor });
configureDataTabPageHost(mountDatasetViewerTabs);

const datasetDataTab = await import(
  "/ui/shared/tabs/data/data_tab_controller.js?v=20260716a"
);

const datasetLinksTab = createExternalLinksTab({
  container: document.getElementById("datasetLinksMount"),
  ariaLabel: "Dataset external links",
  emptyDescription: "Excel links used by editable cells in the Data tab will appear here.",
  getLinks: () => datasetDataTab.getDatasetExternalLinkRecords(),
  onRefreshLinks: (records) => datasetDataTab.refreshDatasetExternalLinkRecords(
    records.map((record) => record?.id).filter(Boolean),
  ),
  onBreakLinks: (records) => datasetDataTab.breakDatasetExternalLinks(
    records.map((record) => record?.id).filter(Boolean),
  ),
  onStatus: (message, tone = "") => {
    if (!message) return;
    window.parent?.postMessage?.({
      type: "arcrho:status",
      text: message,
      ...(tone ? { tone } : {}),
    }, "*");
  },
});
configureDataTabLinks(datasetLinksTab);

window.ADA_DATASET_READY = datasetDataTab.bootDatasetDataTab();
