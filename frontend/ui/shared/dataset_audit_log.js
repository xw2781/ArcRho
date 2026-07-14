const DATASET_AUDIT_LOG_LIMIT = 50;
const DATASET_AUDIT_LOG_STYLESHEET_ID = "arDatasetAuditLogStylesheet";
const DATASET_AUDIT_LOG_STYLESHEET_HREF = "/ui/shared/dataset_audit_log.css?v=20260714b";

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function normalizeDatasetAuditLog(value) {
  if (!Array.isArray(value)) return [];

  return value
    .map((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

      const hasDatasetSpecificField = hasOwn(raw, "event_date")
        || hasOwn(raw, "Event Date")
        || hasOwn(raw, "change_info")
        || hasOwn(raw, "Change Info");
      const hasProjectLogField = hasOwn(raw, "timestamp") || hasOwn(raw, "details");
      if (hasProjectLogField && !hasDatasetSpecificField) return null;

      const eventDate = String(raw.event_date ?? raw["Event Date"] ?? "").trim();
      const action = String(raw.action ?? raw.Action ?? "").trim();
      const changeInfo = String(raw.change_info ?? raw["Change Info"] ?? "").trim();
      const user = String(raw.user ?? raw.User ?? "").trim();
      if (!eventDate && !action && !changeInfo && !user) return null;

      return { eventDate, action, changeInfo, user };
    })
    .filter(Boolean)
    .slice(-DATASET_AUDIT_LOG_LIMIT);
}

export function formatDatasetAuditEventDate(value) {
  const text = String(value || "").trim();
  if (!text) return "";

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;

  const hours = date.getHours();
  const hour12 = hours % 12 || 12;
  const ampm = hours >= 12 ? "PM" : "AM";
  const pad2 = (number) => String(number).padStart(2, "0");
  return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()} ${hour12}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())} ${ampm}`;
}

function ensureDatasetAuditLogStylesheet(documentRef) {
  const existingById = documentRef.getElementById?.(DATASET_AUDIT_LOG_STYLESHEET_ID);
  if (existingById) return existingById;

  const matchingLink = Array.from(documentRef.querySelectorAll?.('link[rel="stylesheet"]') || [])
    .find((link) => link.getAttribute("href") === DATASET_AUDIT_LOG_STYLESHEET_HREF);
  if (matchingLink) return matchingLink;

  const link = documentRef.createElement("link");
  link.id = DATASET_AUDIT_LOG_STYLESHEET_ID;
  link.rel = "stylesheet";
  link.href = DATASET_AUDIT_LOG_STYLESHEET_HREF;
  const stylesheetHost = documentRef.head || documentRef.documentElement;
  stylesheetHost?.appendChild(link);
  return link;
}

function appendTextElement(documentRef, parent, tagName, className, text) {
  const element = documentRef.createElement(tagName);
  element.className = className;
  element.textContent = text;
  parent.appendChild(element);
  return element;
}

export function createDatasetAuditLog({
  container,
  ariaLabel = "Dataset audit log",
  emptyTitle = "No audit entries yet",
  emptyDescription = "Dataset changes will appear here after the first save.",
  documentRef = document,
} = {}) {
  if (!documentRef || typeof documentRef.createElement !== "function") {
    throw new TypeError("createDatasetAuditLog requires a document.");
  }
  if (!container || typeof container.appendChild !== "function") {
    throw new TypeError("createDatasetAuditLog requires a container element.");
  }

  ensureDatasetAuditLogStylesheet(documentRef);

  const root = documentRef.createElement("div");
  root.className = "arDatasetAuditLog";

  const scrollHost = documentRef.createElement("div");
  scrollHost.className = "arDatasetAuditLogScroll";
  scrollHost.tabIndex = 0;
  scrollHost.setAttribute("role", "region");
  scrollHost.setAttribute("aria-label", `${String(ariaLabel || "Dataset audit log")} scroll area`);
  root.appendChild(scrollHost);

  const table = documentRef.createElement("table");
  table.className = "arDatasetAuditLogTable";
  table.setAttribute("aria-label", String(ariaLabel || "Dataset audit log"));
  scrollHost.appendChild(table);

  const colgroup = documentRef.createElement("colgroup");
  for (let index = 0; index < 4; index += 1) {
    colgroup.appendChild(documentRef.createElement("col"));
  }
  table.appendChild(colgroup);

  const head = documentRef.createElement("thead");
  const headerRow = documentRef.createElement("tr");
  for (const label of ["Event Date", "Action", "Change Info", "User"]) {
    const header = documentRef.createElement("th");
    header.scope = "col";
    header.textContent = label;
    headerRow.appendChild(header);
  }
  head.appendChild(headerRow);
  table.appendChild(head);

  const body = documentRef.createElement("tbody");
  table.appendChild(body);

  const state = documentRef.createElement("div");
  state.className = "arDatasetAuditLogState isEmpty";
  state.setAttribute("role", "status");
  state.setAttribute("aria-live", "polite");
  state.setAttribute("aria-atomic", "true");
  const stateTitle = appendTextElement(
    documentRef,
    state,
    "strong",
    "arDatasetAuditLogStateTitle",
    String(emptyTitle || "No audit entries yet"),
  );
  const stateDescription = appendTextElement(
    documentRef,
    state,
    "span",
    "arDatasetAuditLogStateDescription",
    String(emptyDescription || ""),
  );
  stateDescription.hidden = !stateDescription.textContent;
  scrollHost.appendChild(state);

  container.classList?.add("arDatasetAuditLogMount");
  container.appendChild(root);

  let destroyed = false;
  let scrollIdleTimer = null;
  const timerHost = documentRef.defaultView || globalThis;

  const clearScrollIdleTimer = () => {
    if (scrollIdleTimer === null) return;
    timerHost.clearTimeout(scrollIdleTimer);
    scrollIdleTimer = null;
  };

  const handleScroll = () => {
    scrollHost.classList.add("isScrolling");
    clearScrollIdleTimer();
    scrollIdleTimer = timerHost.setTimeout(() => {
      scrollIdleTimer = null;
      scrollHost.classList.remove("isScrolling");
    }, 550);
  };

  const handlePointerMove = (event) => {
    const rect = scrollHost.getBoundingClientRect();
    const verticalScrollbarWidth = Math.max(0, scrollHost.offsetWidth - scrollHost.clientWidth);
    const horizontalScrollbarHeight = Math.max(0, scrollHost.offsetHeight - scrollHost.clientHeight);
    const nearVerticalScrollbar = scrollHost.scrollHeight > scrollHost.clientHeight
      && verticalScrollbarWidth > 0
      && event.clientX >= rect.right - Math.max(verticalScrollbarWidth, 16);
    const nearHorizontalScrollbar = scrollHost.scrollWidth > scrollHost.clientWidth
      && horizontalScrollbarHeight > 0
      && event.clientY >= rect.bottom - Math.max(horizontalScrollbarHeight, 16);
    scrollHost.classList.toggle(
      "isScrollbarHover",
      nearVerticalScrollbar || nearHorizontalScrollbar,
    );
  };

  const handlePointerLeave = () => {
    scrollHost.classList.remove("isScrollbarHover");
  };

  scrollHost.addEventListener("scroll", handleScroll, { passive: true });
  scrollHost.addEventListener("pointermove", handlePointerMove, { passive: true });
  scrollHost.addEventListener("pointerleave", handlePointerLeave, { passive: true });

  const clearRows = () => {
    body.replaceChildren();
  };

  const showState = (kind, title, description = "") => {
    state.className = `arDatasetAuditLogState is${kind}`;
    state.setAttribute("role", kind === "Error" ? "alert" : "status");
    state.setAttribute("aria-live", kind === "Error" ? "assertive" : "polite");
    stateTitle.textContent = String(title || "");
    stateDescription.textContent = String(description || "");
    stateDescription.hidden = !stateDescription.textContent;
    root.setAttribute("aria-busy", kind === "Loading" ? "true" : "false");
    state.hidden = false;
  };

  const hideState = () => {
    state.hidden = true;
    stateDescription.hidden = false;
    root.setAttribute("aria-busy", "false");
  };

  const render = (entries = []) => {
    if (destroyed) return;

    const rows = normalizeDatasetAuditLog(entries).slice().reverse();
    clearRows();
    for (const entry of rows) {
      const row = documentRef.createElement("tr");
      const cells = [
        ["Date", formatDatasetAuditEventDate(entry.eventDate)],
        ["Action", entry.action],
        ["ChangeInfo", entry.changeInfo],
        ["User", entry.user],
      ];

      for (const [cellKind, value] of cells) {
        const cell = documentRef.createElement("td");
        cell.className = `arDatasetAuditLog${cellKind}Cell`;
        cell.textContent = value;
        cell.title = value;
        row.appendChild(cell);
      }
      body.appendChild(row);
    }

    if (rows.length) {
      hideState();
    } else {
      showState("Empty", emptyTitle, emptyDescription);
    }
  };

  const setLoading = (message = "Loading audit log...") => {
    if (destroyed) return;
    clearRows();
    showState("Loading", message || "Loading audit log...");
  };

  const setError = (message) => {
    if (destroyed) return;
    clearRows();
    showState(
      "Error",
      "Unable to load audit log",
      message || "The audit log could not be loaded.",
    );
  };

  const clear = () => {
    if (destroyed) return;
    clearRows();
    showState("Empty", emptyTitle, emptyDescription);
  };

  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    clearScrollIdleTimer();
    scrollHost.removeEventListener("scroll", handleScroll);
    scrollHost.removeEventListener("pointermove", handlePointerMove);
    scrollHost.removeEventListener("pointerleave", handlePointerLeave);
    scrollHost.classList.remove("isScrolling", "isScrollbarHover");
    root.remove();
    container.classList?.remove("arDatasetAuditLogMount");
  };

  return {
    render,
    setLoading,
    setError,
    clear,
    destroy,
    elements: {
      root,
      scrollHost,
      table,
      body,
      state,
      stateTitle,
      stateDescription,
    },
  };
}
