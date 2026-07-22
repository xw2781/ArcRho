import { fetchProjectDatasetTypes } from "/ui/shared/dataset/dataset_types_source.js";
import {
  loadProjectUserPreferences,
  scheduleProjectUserPreferencesSave,
} from "/ui/shared/services/project_user_preferences.js";
import { openReservingClassPicker } from "/ui/shared/components/pickers/reserving_class_picker.js?v=20260715c";
import "/ui/shared/integrations/zoom_bridge.js?v=20260521a";

import { createProjectInstanceContext } from "./project_instance_context.js?v=20260720a";
import { installProjectInstanceUtils } from "./project_instance_utils.js?v=20260607d";
import { installProjectInstanceLoading } from "./project_instance_loading.js?v=20260704d";
import { installProjectInstanceDatasetCache } from "./project_instance_dataset_cache.js?v=20260715f";
import { installProjectInstanceNumberFormats } from "./project_instance_number_formats.js?v=20260720b";
import { installProjectInstanceDatasetTable } from "./project_instance_dataset_table.js?v=20260715c";
import { installProjectInstanceDatasetAddPicker } from "./project_instance_dataset_add_picker.js?v=20260611a";
import { installProjectInstancePathPanel } from "./project_instance_path_panel.js?v=20260712b";
import { installProjectInstanceWindows } from "./project_instance_windows.js?v=20260721a";
import { installProjectInstanceHiddenTabs } from "./project_instance_hidden_tabs.js?v=20260607d";
import { installProjectInstanceMessages } from "./project_instance_messages.js?v=20260721a";

export async function bootProjectInstance() {
  const ctx = createProjectInstanceContext({
    fetchProjectDatasetTypes,
    loadProjectUserPreferences,
    scheduleProjectUserPreferencesSave,
    openReservingClassPicker,
  });

  installProjectInstanceUtils(ctx);
  installProjectInstanceLoading(ctx);
  installProjectInstanceDatasetCache(ctx);
  installProjectInstanceNumberFormats(ctx);
  installProjectInstanceDatasetTable(ctx);
  installProjectInstanceDatasetAddPicker(ctx);
  installProjectInstancePathPanel(ctx);
  installProjectInstanceWindows(ctx);
  installProjectInstanceHiddenTabs(ctx);
  installProjectInstanceMessages(ctx);

  const { api, els, projectName, state } = ctx;
  await api.applyHostFrameCornerStyle();
  api.initHiddenTabsArea();
  api.initCachedDatasetToolbar();
  api.initDatasetNumberFormatsEditor();
  api.initLeftPanelResizer();
  api.initDatasetTableInteractions();
  api.initDatasetAddPickerInteractions();
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
