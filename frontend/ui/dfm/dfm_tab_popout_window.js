import { wireTabPopoutWindows } from "/ui/shared/tab_popout_window.js";
import { DFM_TAB_DEFS } from "/ui/dfm/dfm_tab_config.js";

export function wireDfmTabPopoutWindows(options = {}) {
  return wireTabPopoutWindows({
    cssPrefix: "dfm",
    tabs: DFM_TAB_DEFS,
    tabSystem: () => window.dfmTabSystem,
    ...options,
  });
}
