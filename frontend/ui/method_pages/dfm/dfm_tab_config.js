/* The DFM tab list lives in the shared window tab catalog, which the Project
   Instance Preferences window also reads. This module stays as the DFM page's
   entry point onto it so existing importers keep one specifier. */
import {
  DFM_TAB_DEFS as CATALOG_DFM_TAB_DEFS,
  windowTabIds,
} from "/ui/shared/tabs/window_tab_catalog.js?v=20260824e";

export const DFM_TAB_DEFS = CATALOG_DFM_TAB_DEFS;
export const ALLOWED_DFM_TABS = windowTabIds("dfm");
