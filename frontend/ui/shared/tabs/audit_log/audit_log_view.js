const AUDIT_LOG_STYLESHEET_ID = "arAuditLogStylesheet";
const AUDIT_LOG_STYLESHEET_HREF = "/ui/shared/tabs/audit_log/audit_log.css?v=20260714c";

function identityEntries(value) {
  return Array.isArray(value) ? value : [];
}

function formatEventDateAsText(value) {
  return String(value ?? "").trim();
}

function ensureAuditLogStylesheet(documentRef) {
  const existingById = documentRef.getElementById?.(AUDIT_LOG_STYLESHEET_ID);
  if (existingById) return existingById;

  const matchingLink = Array.from(documentRef.querySelectorAll?.('link[rel="stylesheet"]') || [])
    .find((link) => link.getAttribute("href") === AUDIT_LOG_STYLESHEET_HREF);
  if (matchingLink) return matchingLink;

  const link = documentRef.createElement("link");
  link.id = AUDIT_LOG_STYLESHEET_ID;
  link.rel = "stylesheet";
  link.href = AUDIT_LOG_STYLESHEET_HREF;
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

export function createAuditLogView({
  container,
  ariaLabel = "Audit log",
  emptyTitle = "No audit entries yet",
  emptyDescription = "Changes will appear here after the first save.",
  normalizeEntries = identityEntries,
  formatEventDate = formatEventDateAsText,
  documentRef = document,
} = {}) {
  if (!documentRef || typeof documentRef.createElement !== "function") {
    throw new TypeError("createAuditLogView requires a document.");
  }
  if (!container || typeof container.appendChild !== "function") {
    throw new TypeError("createAuditLogView requires a container element.");
  }
  if (typeof normalizeEntries !== "function") {
    throw new TypeError("createAuditLogView requires normalizeEntries to be a function.");
  }
  if (typeof formatEventDate !== "function") {
    throw new TypeError("createAuditLogView requires formatEventDate to be a function.");
  }

  ensureAuditLogStylesheet(documentRef);

  const root = documentRef.createElement("div");
  root.className = "arAuditLog";

  const scrollHost = documentRef.createElement("div");
  scrollHost.className = "arAuditLogScroll";
  scrollHost.tabIndex = 0;
  scrollHost.setAttribute("role", "region");
  scrollHost.setAttribute("aria-label", `${String(ariaLabel || "Audit log")} scroll area`);
  root.appendChild(scrollHost);

  const table = documentRef.createElement("table");
  table.className = "arAuditLogTable";
  table.setAttribute("aria-label", String(ariaLabel || "Audit log"));
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
  state.className = "arAuditLogState isEmpty";
  state.setAttribute("role", "status");
  state.setAttribute("aria-live", "polite");
  state.setAttribute("aria-atomic", "true");
  const stateTitle = appendTextElement(
    documentRef,
    state,
    "strong",
    "arAuditLogStateTitle",
    String(emptyTitle || "No audit entries yet"),
  );
  const stateDescription = appendTextElement(
    documentRef,
    state,
    "span",
    "arAuditLogStateDescription",
    String(emptyDescription || ""),
  );
  stateDescription.hidden = !stateDescription.textContent;
  scrollHost.appendChild(state);

  container.classList?.add("arAuditLogMount");
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
    state.className = `arAuditLogState is${kind}`;
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

    const normalizedEntries = normalizeEntries(entries);
    const rows = (Array.isArray(normalizedEntries) ? normalizedEntries : []).slice().reverse();
    clearRows();
    for (const entry of rows) {
      const row = documentRef.createElement("tr");
      const formattedDate = formatEventDate(entry?.eventDate);
      const cells = [
        ["Date", formattedDate],
        ["Action", entry?.action],
        ["ChangeInfo", entry?.changeInfo],
        ["User", entry?.user],
      ];

      for (const [cellKind, rawValue] of cells) {
        const value = String(rawValue ?? "");
        const cell = documentRef.createElement("td");
        cell.className = `arAuditLog${cellKind}Cell`;
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
    container.classList?.remove("arAuditLogMount");
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
