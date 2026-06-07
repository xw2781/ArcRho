import { fetchProjectDatasetTypes } from "/ui/dataset/dataset_types_source.js";
import {
  loadProjectUserPreferences,
  scheduleProjectUserPreferencesSave,
} from "/ui/shared/project_user_preferences.js";
import { openLazyReservingClassPicker } from "/ui/shared/reserving_class_lazy_picker.js?v=20260517a";
import "/ui/shared/zoom_bridge.js?v=20260521a";

import { createProjectInstanceContext } from "./project_instance_context.js?v=20260607c";
import { installProjectInstanceUtils } from "./project_instance_utils.js?v=20260607c";
import { installProjectInstanceLoading } from "./project_instance_loading.js?v=20260607c";
import { installProjectInstanceDatasetCache } from "./project_instance_dataset_cache.js?v=20260607c";
import { installProjectInstanceDatasetTable } from "./project_instance_dataset_table.js?v=20260607c";
import { installProjectInstancePathPanel } from "./project_instance_path_panel.js?v=20260607c";
import { installProjectInstanceWindows } from "./project_instance_windows.js?v=20260607c";
import { installProjectInstanceHiddenTabs } from "./project_instance_hidden_tabs.js?v=20260607c";
import { installProjectInstanceMessages } from "./project_instance_messages.js?v=20260607c";

export async function bootProjectInstance() {
  const ctx = createProjectInstanceContext({
    fetchProjectDatasetTypes,
    loadProjectUserPreferences,
    scheduleProjectUserPreferencesSave,
    openLazyReservingClassPicker,
  });

  installProjectInstanceUtils(ctx);
  installProjectInstanceLoading(ctx);
  installProjectInstanceDatasetCache(ctx);
  installProjectInstanceDatasetTable(ctx);
  installProjectInstancePathPanel(ctx);
  installProjectInstanceWindows(ctx);
  installProjectInstanceHiddenTabs(ctx);
  installProjectInstanceMessages(ctx);

  const { api, els, projectName, state } = ctx;
  await api.applyHostFrameCornerStyle();
  api.initHiddenTabsArea();
  api.initCachedDatasetToolbar();
  api.initLeftPanelResizer();
  api.initDatasetTableInteractions();
  api.initDatasetWindowShortcuts();
  window.addEventListener("resize", api.syncMaximizedDatasetWindows);
  if (!projectName) {
    api.setStatus("Project name is missing.", true);
    api.setEmptyTable("Project name is missing.");
    if (els.pathTree) els.pathTree.innerHTML = '<div class="ptree-empty">Project name is missing.</div>';
    api.finishPageLoading();
    return;
  }
  await api.loadDatasetTablePreferences();
  await Promise.all([api.loadPathTree(), api.loadDatasets()]);
  state.projectInstanceBootComplete = true;
  if (state.pendingProjectInstanceRestoreState) {
    const restoreState = state.pendingProjectInstanceRestoreState;
    state.pendingProjectInstanceRestoreState = null;
    await api.applyProjectInstanceRestoreState(restoreState);
  } else {
    api.notifyProjectInstanceStateChanged();
  }
}
