const STYLE_ID = "pageMessageBoxStyles";
let messageSequence = 0;

function ensureStyles(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const link = doc.createElement("link");
  link.id = STYLE_ID;
  link.rel = "stylesheet";
  link.href = "/ui/shared/components/message_box/message_box.css?v=20260728a";
  doc.head.appendChild(link);
}

export function showPageMessageBox({
  title = "Message",
  message = "",
  tone = "",
  links = [],
  onLinkClick = null,
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

  return new Promise((resolve) => {
    let open = true;
    function focusableElements() {
      return Array.from(overlay.querySelectorAll("button:not(:disabled), [href], [tabindex]:not([tabindex='-1'])"));
    }
    function finish() {
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
      resolve();
    }
    function handleKeydown(event) {
      event.stopImmediatePropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        finish();
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
      if (event.target === overlay) finish();
    });
    overlay.addEventListener("wheel", (event) => event.preventDefault(), { passive: false });
    doc.addEventListener("keydown", handleKeydown, true);
    requestAnimationFrame(() => okButton.focus());
  });
}
