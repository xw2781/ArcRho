const STYLE_ID = "pageMessageBoxStyles";
let messageSequence = 0;

function ensureStyles(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const link = doc.createElement("link");
  link.id = STYLE_ID;
  link.rel = "stylesheet";
  link.href = "/ui/shared/components/message_box/message_box.css?v=20260811a";
  doc.head.appendChild(link);
}

/**
 * Shows a page-local modal message box.
 *
 * Resolves with the clicked action's `id` when `actions` are provided
 * ([{id, label}] rendered before OK), or `undefined` for OK/Esc/close.
 *
 * `showOk: false` drops the OK button so the only way out is one of the
 * `actions`; `dismissible: false` additionally removes the close button and
 * ignores Esc and overlay clicks, for advisories the user must act on.
 */
export function showPageMessageBox({
  title = "Message",
  message = "",
  tone = "",
  links = [],
  onLinkClick = null,
  actions = [],
  okLabel = "OK",
  showOk = true,
  dismissible = true,
  balancedActions = false,
  autoCloseMs = 0,
  documentRef = document,
} = {}) {
  const doc = documentRef;
  ensureStyles(doc);
  const id = `pageMessageBox${++messageSequence}`;
  const overlay = doc.createElement("div");
  overlay.className = "pageMessageBoxOverlay";
  overlay.setAttribute("aria-hidden", "false");
  overlay.innerHTML = `
    <div class="pageMessageBox" role="alertdialog" aria-modal="true" aria-labelledby="${id}Title" aria-describedby="${id}Message">
      <button class="pageMessageBoxClose" type="button" aria-label="Close message">
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path d="M4 4l8 8M12 4l-8 8"></path>
        </svg>
      </button>
      <div class="pageMessageBoxTitle" id="${id}Title"></div>
      <div class="pageMessageBoxMessage" id="${id}Message"></div>
      <ul class="pageMessageBoxLinks" aria-label="Related datasets"></ul>
      <div class="pageMessageBoxActions">
        <button class="pageMessageBoxButton" type="button">OK</button>
      </div>
    </div>
  `;
  doc.body.appendChild(overlay);

  const titleEl = overlay.querySelector(".pageMessageBoxTitle");
  const messageEl = overlay.querySelector(".pageMessageBoxMessage");
  const linksEl = overlay.querySelector(".pageMessageBoxLinks");
  const okButton = overlay.querySelector(".pageMessageBoxButton");
  const closeButton = overlay.querySelector(".pageMessageBoxClose");
  titleEl.textContent = String(title || "Message");
  okButton.textContent = String(okLabel || "OK");
  if (!showOk) okButton.remove();
  if (!dismissible) closeButton.remove();
  titleEl.dataset.tone = String(tone || "");
  messageEl.textContent = String(message || "");
  const linkItems = Array.isArray(links) ? links : [];
  linksEl.hidden = linkItems.length === 0;
  for (const item of linkItems) {
    const label = String(item?.label ?? item ?? "").trim();
    if (!label) continue;
    const row = doc.createElement("li");
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "pageMessageBoxLink";
    button.textContent = label;
    button.setAttribute("aria-label", String(item?.ariaLabel || `Open dataset ${label}`));
    button.addEventListener("click", () => onLinkClick?.(item));
    row.appendChild(button);
    linksEl.appendChild(row);
  }
  linksEl.hidden = !linksEl.children.length;

  const returnFocus = doc.activeElement;
  const inertSiblings = Array.from(doc.body.children)
    .filter((element) => element !== overlay)
    .map((element) => ({ element, inert: !!element.inert }));
  for (const item of inertSiblings) item.element.inert = true;

  const actionsEl = overlay.querySelector(".pageMessageBoxActions");
  const actionItems = (Array.isArray(actions) ? actions : []).filter(
    (item) => String(item?.id ?? "").trim() && String(item?.label ?? "").trim(),
  );
  actionsEl.classList.toggle("pageMessageBoxActionsBalanced", balancedActions && actionItems.length > 0);

  return new Promise((resolve) => {
    let open = true;
    function focusableElements() {
      return Array.from(overlay.querySelectorAll("button:not(:disabled), [href], [tabindex]:not([tabindex='-1'])"));
    }
    function finish(actionId) {
      if (!open) return;
      open = false;
      doc.removeEventListener("keydown", handleKeydown, true);
      for (const item of inertSiblings) {
        if (item.element?.isConnected) item.element.inert = item.inert;
      }
      overlay.remove();
      if (returnFocus?.isConnected && typeof returnFocus.focus === "function") {
        requestAnimationFrame(() => returnFocus.focus());
      }
      resolve(typeof actionId === "string" ? actionId : undefined);
    }
    for (const item of actionItems) {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "pageMessageBoxButton pageMessageBoxActionButton";
      button.textContent = String(item.label).trim();
      button.addEventListener("click", () => finish(String(item.id).trim()));
      actionsEl.insertBefore(button, okButton.isConnected ? okButton : null);
    }
    function handleKeydown(event) {
      event.stopImmediatePropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        if (dismissible) finish();
      } else if (event.key === "Tab") {
        const focusable = focusableElements();
        if (!focusable.length) {
          event.preventDefault();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && doc.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && doc.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    okButton.addEventListener("click", finish);
    closeButton.addEventListener("click", finish);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay && dismissible) finish();
    });
    // Transient notices (post-save confirmations) dismiss themselves; the
    // user can still close sooner through any normal path above.
    if (Number(autoCloseMs) > 0) {
      setTimeout(() => finish(), Number(autoCloseMs));
    }
    overlay.addEventListener("wheel", (event) => event.preventDefault(), { passive: false });
    doc.addEventListener("keydown", handleKeydown, true);
    requestAnimationFrame(() => {
      const initial = okButton.isConnected ? okButton : focusableElements()[0];
      initial?.focus();
    });
  });
}
