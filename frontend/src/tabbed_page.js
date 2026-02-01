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
 * @returns {{setActive: Function, getCurrentTab: Function, getPageElement: Function, getAllPageElements: Function}}
 */
export function createTabbedPage(container, config) {
  const {
    tabs,
    cssPrefix = 'tabbed',
    initialTab,
    urlParamKey,
    onTabChange,
    injectTabBar = true
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
      pageElements[tab.id] = el;
    }
  });

  // Inject tab bar HTML if needed
  let tabBar;
  if (injectTabBar) {
    tabBar = document.createElement('div');
    tabBar.className = tabBarClass;
    tabs.forEach(tab => {
      const btn = document.createElement('button');
      btn.className = tabClass;
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
  }

  const tabButtons = tabBar ? Array.from(tabBar.querySelectorAll(`.${tabClass}`)) : [];

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
