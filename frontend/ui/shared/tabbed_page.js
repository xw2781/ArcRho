/**
 * Reusable Tabbed Page System
 * Creates a tab bar and manages page visibility for any number of tabs.
 */

/**
 * Capitalizes the first letter of a string.
 * @param {string} str
 * @returns {string}
 */
function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function toCssLength(value) {
  if (typeof value === "number" && Number.isFinite(value)) return `${Math.max(0, value)}px`;
  const text = String(value ?? "").trim();
  return text || "0px";
}

const SAVE_BAR_STYLE_ID = "tabbed-page-save-bar-style";
export const TABBED_PAGE_CONTROL_RADIUS = "4px";
export const TABBED_PAGE_ACTION_FONT_FAMILY = '"Segoe UI", Arial, sans-serif';

function ensureSaveBarStyles() {
  if (document.getElementById(SAVE_BAR_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = SAVE_BAR_STYLE_ID;
  style.textContent = `
    .tabbedPageSaveBar {
      flex: 0 0 38px;
      width: 100%;
      min-height: 38px;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      padding: 6px 10px 4px;
      border: 0;
      box-sizing: border-box;
      background: #f5f7fa;
    }
    .tabbedPageSaveBar[hidden] {
      display: none;
    }
    .tabbedPageSaveBar button,
    .tabbedPageSaveButton,
    .tabbedPageCancelButton {
      font-family: var(--tabbed-page-action-font-family, "Segoe UI", Arial, sans-serif);
    }
  `;
  document.head.appendChild(style);
}

/**
 * Applies the shared tabbed-page save bar styling to an existing save bar.
 *
 * @param {HTMLElement|null|undefined} saveBar - Existing save bar element.
 * @returns {HTMLElement|null|undefined}
 */
export function applyTabbedPageSaveBar(saveBar) {
  if (!saveBar) return saveBar;
  ensureSaveBarStyles();
  saveBar.classList.add("tabbedPageSaveBar");
  return saveBar;
}

/**
 * Applies the common Save/Cancel button state for tabbed pages.
 * Cancel remains available while clean so users can click it without first
 * making a change, but true blocking states such as an in-flight save still win.
 *
 * @param {Object} options
 * @param {HTMLButtonElement|null|undefined} options.saveButton
 * @param {HTMLButtonElement|null|undefined} options.cancelButton
 * @param {boolean} [options.dirty=false]
 * @param {boolean} [options.saving=false]
 * @param {boolean} [options.saveBlocked=false]
 * @param {boolean} [options.cancelBlocked=false]
 */
export function updateTabbedPageSaveControls({
  saveButton,
  cancelButton,
  dirty = false,
  saving = false,
  saveBlocked = false,
  cancelBlocked = false,
} = {}) {
  const isDirty = !!dirty;
  const isSaving = !!saving;
  if (saveButton) {
    saveButton.classList.add("tabbedPageSaveButton");
    saveButton.disabled = isSaving || !!saveBlocked || !isDirty;
    saveButton.classList.toggle("is-clean", !isDirty);
  }
  if (cancelButton) {
    cancelButton.classList.add("tabbedPageCancelButton");
    cancelButton.disabled = isSaving || !!cancelBlocked;
  }
}

/**
 * Requests the host shell or Project Instance window to close this tabbed page.
 *
 * @param {Object} options
 * @param {string} [options.messageType='arcrho:close-active-tab']
 * @param {string} [options.inst]
 */
export function requestTabbedPageWindowClose({
  messageType = "arcrho:close-active-tab",
  inst = "",
} = {}) {
  const type = String(messageType || "arcrho:close-active-tab");
  const payload = { type };
  const instanceId = String(inst || "").trim();
  if (instanceId) payload.inst = instanceId;
  try {
    window.parent?.postMessage(payload, "*");
  } catch {}
}

/**
 * Creates a reusable tabbed page system.
 *
 * @param {HTMLElement} container - Container element (tab bar will be inserted at the start)
 * @param {Object} config - Configuration object
 * @param {Array<{id: string, label: string}>} config.tabs - Tab definitions
 * @param {string} [config.cssPrefix='tabbed'] - CSS class prefix (e.g., 'dfm' -> .dfmTabBar, .dfmTab)
 * @param {string} [config.initialTab] - Default active tab ID (defaults to first tab)
 * @param {string} [config.urlParamKey] - URL param to read initial tab from (e.g., 'tab')
 * @param {Function} [config.onTabChange] - Callback(tabId, prevTabId) called on tab switch
 * @param {boolean} [config.injectTabBar=true] - Whether to inject tab bar HTML (false if already in markup)
 * @param {number|string} [config.tabBarExtraVerticalSpace=0] - Extra vertical space added to the tab bar.
 * @param {number|string} [config.frameGutter=8] - Left/right gutter shared by the tab bar and page frame.
 * @returns {{setActive: Function, getCurrentTab: Function, getPageElement: Function, getAllPageElements: Function}}
 */
export function createTabbedPage(container, config) {
  const {
    tabs,
    cssPrefix = 'tabbed',
    initialTab,
    urlParamKey,
    onTabChange,
    injectTabBar = true,
    tabBarExtraVerticalSpace = 0,
    frameGutter = 8
  } = config;

  if (!tabs || tabs.length === 0) {
    throw new Error('createTabbedPage: tabs array is required and must not be empty');
  }

  let currentTab = null;
  const tabBarClass = `${cssPrefix}TabBar`;
  const tabClass = `${cssPrefix}Tab`;

  // Build page element ID from tab id: 'details' -> '#dfmDetailsPage'
  const getPageId = (tabId) => `${cssPrefix}${capitalize(tabId)}Page`;

  // Query all page elements
  const pageElements = {};
  tabs.forEach(tab => {
    const pageId = getPageId(tab.id);
    const el = document.getElementById(pageId);
    if (el) {
      el.classList.add("tabbedPagePanel");
      pageElements[tab.id] = el;
    }
  });

  // Inject tab bar HTML if needed
  let tabBar;
  if (injectTabBar) {
    tabBar = document.createElement('div');
    tabBar.className = `${tabBarClass} tabbedPageTabBar`;
    tabs.forEach(tab => {
      const btn = document.createElement('button');
      btn.className = `${tabClass} tabbedPageTab`;
      btn.type = 'button';
      btn.dataset.page = tab.id;
      btn.textContent = tab.label;
      tabBar.appendChild(btn);
    });
    // Insert at start of container
    container.insertBefore(tabBar, container.firstChild);
  } else {
    // Use existing tab bar
    tabBar = container.querySelector(`.${tabBarClass}`);
    if (tabBar) tabBar.classList.add("tabbedPageTabBar");
  }

  container.style.setProperty("--tabbed-page-gutter", toCssLength(frameGutter));
  container.style.setProperty("--tabbed-page-control-radius", TABBED_PAGE_CONTROL_RADIUS);
  container.style.setProperty("--tabbed-page-action-font-family", TABBED_PAGE_ACTION_FONT_FAMILY);
  if (tabBar) {
    tabBar.style.setProperty("--tabbed-tabbar-extra-y", toCssLength(tabBarExtraVerticalSpace));
  }

  const tabButtons = tabBar ? Array.from(tabBar.querySelectorAll(`.${tabClass}`)) : [];
  tabButtons.forEach((btn) => btn.classList.add("tabbedPageTab"));

  /**
   * Sets the active tab.
   * @param {string} tabId - The tab ID to activate
   */
  function setActive(tabId) {
    // Validate tab exists
    const tabDef = tabs.find(t => t.id === tabId);
    if (!tabDef) {
      console.warn(`createTabbedPage: unknown tab '${tabId}'`);
      return;
    }

    const prevTab = currentTab;
    currentTab = tabId;

    // Update page visibility
    tabs.forEach(tab => {
      const pageEl = pageElements[tab.id];
      if (pageEl) {
        pageEl.style.display = tab.id === tabId ? 'block' : 'none';
      }
    });

    // Update tab button active state
    tabButtons.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.page === tabId);
    });

    // Call change callback
    if (onTabChange && prevTab !== tabId) {
      onTabChange(tabId, prevTab);
    }
  }

  /**
   * Gets the current active tab ID.
   * @returns {string|null}
   */
  function getCurrentTab() {
    return currentTab;
  }

  /**
   * Gets a page element by tab ID.
   * @param {string} tabId
   * @returns {HTMLElement|undefined}
   */
  function getPageElement(tabId) {
    return pageElements[tabId];
  }

  /**
   * Gets all page elements as an object.
   * @returns {Object<string, HTMLElement>}
   */
  function getAllPageElements() {
    return { ...pageElements };
  }

  // Wire click handlers
  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.dataset.page;
      if (tabId) setActive(tabId);
    });
  });

  // Determine initial tab
  let startTab = initialTab || tabs[0].id;

  // Check URL param if specified
  if (urlParamKey) {
    const params = new URLSearchParams(window.location.search);
    const urlTab = params.get(urlParamKey);
    if (urlTab && tabs.some(t => t.id === urlTab)) {
      startTab = urlTab;
    }
  }

  // Set initial active tab
  setActive(startTab);

  return {
    setActive,
    getCurrentTab,
    getPageElement,
    getAllPageElements
  };
}
