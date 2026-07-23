import { wireTabPopoutWindows } from "/ui/shared/tabbed_page/tab_popout_window.js?v=20260722a";
import { DFM_TAB_DEFS } from "/ui/method_pages/dfm/dfm_tab_config.js?v=20260715a";

export function wireDfmTabPopoutWindows(options = {}) {
  return wireTabPopoutWindows({
    cssPrefix: "dfm",
    tabs: DFM_TAB_DEFS,
    tabSystem: () => window.dfmTabSystem,
    ...options,
  });
}
