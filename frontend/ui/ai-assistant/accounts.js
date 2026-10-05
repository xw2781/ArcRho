const PROVIDERS = [
  { id: "codex", label: "OpenAI" },
  { id: "claude", label: "Anthropic" },
];
const AVATAR_COLORS = ["#2b6df6", "#0f766e", "#b45309", "#be123c", "#475569", "#15803d"];
const POLL_MS = 3000;
const ICONS = {
  check: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"></path></svg>',
  signIn: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 3h3.5v10H9"></path><path d="M2.5 8h7"></path><path d="M7 5.5L9.5 8 7 10.5"></path></svg>',
  signOut: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7 3H3.5v10H7"></path><path d="M6.5 8h7"></path><path d="M11 5.5L13.5 8 11 10.5"></path></svg>',
  remove: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7"></path><path d="M11.5 4.5l-7 7"></path></svg>',
  add: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9"></path><path d="M3.5 8h9"></path></svg>',
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function iconButton(className, icon, title) {
  const button = element("button", `aiAssistantAccountAction ${className}`);
  button.type = "button";
  button.title = title;
  button.setAttribute("aria-label", title);
  button.innerHTML = icon;
  return button;
}

function accountDetail(account) {
  if (account.pending) return "Signing in…";
  if (!account.signedIn) return "Not signed in";
  return account.email || account.plan || "Signed in";
}

/**
 * Account pickers for the Settings panel: one row per provider showing the
 * account new requests use, with a menu to switch, add, sign in or out, and
 * remove accounts. The host owns the list; this only renders and asks.
 */
export function installAssistantAccounts({ container, getHost, onChanged = () => {} }) {
  if (!container) return null;
  let accounts = [];
  let pollTimer = 0;
  let openProvider = "";
  let addingProvider = "";
  let confirmRemoveId = "";
  let error = "";
  const pickers = new Map();

  const status = element("div", "aiAssistantAccountStatus");
  status.setAttribute("role", "status");

  for (const provider of PROVIDERS) {
    const field = element("div", "aiAssistantSettingsField");
    const wrap = element("div", "aiAssistantMenuSelect aiAssistantAccountPicker");
    const trigger = element("button", "aiAssistantMenuSelectTrigger aiAssistantAccountTrigger");
    trigger.type = "button";
    trigger.setAttribute("aria-haspopup", "menu");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-label", `${provider.label} account`);
    const list = element("div", "aiAssistantMenuSelectList aiAssistantAccountList");
    list.setAttribute("role", "menu");
    list.setAttribute("aria-label", `${provider.label} accounts`);
    list.hidden = true;
    wrap.append(trigger, list);
    field.append(element("span", "", provider.label), wrap);
    container.appendChild(field);
    pickers.set(provider.id, { provider, wrap, trigger, list });

    trigger.addEventListener("click", () => (openProvider === provider.id ? close() : open(provider.id)));
    trigger.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        open(provider.id);
      }
    });
    list.addEventListener("keydown", (event) => onListKey(event, provider.id));
    wrap.addEventListener("focusout", (event) => {
      if (openProvider === provider.id && event.relatedTarget && !wrap.contains(event.relatedTarget)) close();
    });
  }
  container.appendChild(status);
  document.addEventListener("mousedown", (event) => {
    const picker = pickers.get(openProvider);
    if (picker && !picker.wrap.contains(event.target)) close();
  }, true);

  function avatar(account) {
    const siblings = accounts.filter((item) => item.provider === account.provider);
    const node = element("span", "aiAssistantAccountAvatar", (account.label || "?").trim().charAt(0).toUpperCase() || "?");
    node.style.background = AVATAR_COLORS[Math.max(0, siblings.findIndex((item) => item.id === account.id)) % AVATAR_COLORS.length];
    node.setAttribute("aria-hidden", "true");
    return node;
  }

  function renderTrigger(providerId) {
    const { trigger } = pickers.get(providerId);
    const active = accounts.find((item) => item.provider === providerId && item.active);
    trigger.replaceChildren();
    if (!active) {
      trigger.append(element("span", "aiAssistantMenuSelectValue", "Loading…"));
    } else {
      const value = element("span", "aiAssistantMenuSelectValue");
      value.append(element("span", "aiAssistantAccountName", active.label), element("span", "aiAssistantAccountDetail", accountDetail(active)));
      trigger.append(avatar(active), value);
      trigger.classList.toggle("signed-out", !active.signedIn && !active.pending);
      trigger.title = [active.label, active.email, active.plan].filter(Boolean).join(" · ");
    }
    const caret = element("span", "aiAssistantMenuSelectCaret");
    caret.setAttribute("aria-hidden", "true");
    trigger.appendChild(caret);
  }

  function renderRow(account) {
    const row = element("div", "aiAssistantAccountRow");
    row.dataset.accountId = account.id;
    const choose = element("button", "aiAssistantAccountChoose");
    choose.type = "button";
    choose.setAttribute("role", "menuitemradio");
    choose.setAttribute("aria-checked", String(account.active));
    choose.title = [account.label, account.email, account.plan].filter(Boolean).join(" · ");
    const check = element("span", "aiAssistantMenuSelectCheck");
    if (account.active) check.innerHTML = ICONS.check;
    choose.append(check, avatar(account), element("span", "aiAssistantAccountName", account.label), element("span", "aiAssistantAccountDetail", accountDetail(account)));
    choose.addEventListener("click", () => activate(account));
    row.appendChild(choose);
    const sign = account.signedIn
      ? iconButton("sign-out", ICONS.signOut, "Sign out")
      : iconButton("sign-in", ICONS.signIn, "Sign in");
    sign.disabled = account.pending;
    sign.addEventListener("click", () => (account.signedIn ? signOut(account) : signIn(account)));
    row.appendChild(sign);
    if (!account.builtin) {
      const confirming = confirmRemoveId === account.id;
      const remove = iconButton(`remove${confirming ? " confirm" : ""}`, ICONS.remove, confirming ? "Click again to remove" : "Remove account");
      if (confirming) remove.append(element("span", "", "Remove"));
      remove.addEventListener("click", () => {
        if (confirming) void removeAccount(account);
        else {
          confirmRemoveId = account.id;
          render(account.provider, `[data-account-id="${account.id}"] .remove`);
        }
      });
      row.appendChild(remove);
    } else {
      row.appendChild(element("span", "aiAssistantAccountActionSpacer"));
    }
    row.classList.toggle("active", account.active);
    return row;
  }

  function renderAddForm(providerId) {
    const form = element("form", "aiAssistantAccountForm");
    const input = element("input", "aiAssistantAccountInput");
    input.type = "text";
    input.placeholder = "Account name";
    input.maxLength = 40;
    input.setAttribute("aria-label", "Account name");
    const submit = element("button", "aiAssistantAccountSubmit", "Sign In");
    submit.type = "submit";
    form.append(input, submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void createAccount(providerId, input.value, submit);
    });
    return form;
  }

  function focusKey(node) {
    const part = ["sign-in", "sign-out", "remove", "aiAssistantAccountAdd", "aiAssistantAccountChoose"]
      .find((name) => node?.classList?.contains(name));
    if (!part) return "";
    const row = node.closest("[data-account-id]");
    return `${row ? `[data-account-id="${row.dataset.accountId}"] ` : ""}.${part}`;
  }

  // A re-render keeps focus on the same control, and leaves a name being typed alone.
  function render(providerId, focusSelector = "") {
    renderTrigger(providerId);
    const { list } = pickers.get(providerId);
    if (list.hidden) return;
    if (addingProvider === providerId && list.querySelector(".aiAssistantAccountForm") && !focusSelector) return;
    const restore = focusSelector || (list.contains(document.activeElement) ? focusKey(document.activeElement) : "");
    list.replaceChildren();
    for (const account of accounts.filter((item) => item.provider === providerId)) list.appendChild(renderRow(account));
    list.appendChild(element("div", "aiAssistantAccountSeparator"));
    if (addingProvider === providerId) {
      list.appendChild(renderAddForm(providerId));
    } else {
      const add = element("button", "aiAssistantAccountChoose aiAssistantAccountAdd");
      add.type = "button";
      add.setAttribute("role", "menuitem");
      const icon = element("span", "aiAssistantMenuSelectCheck");
      icon.innerHTML = ICONS.add;
      add.append(icon, element("span", "aiAssistantAccountName", "Add Account…"));
      add.addEventListener("click", () => {
        addingProvider = providerId;
        render(providerId);
        list.querySelector(".aiAssistantAccountInput")?.focus();
      });
      list.appendChild(add);
    }
    if (restore) (list.querySelector(restore) || list.querySelector('[aria-checked="true"]'))?.focus();
  }

  function renderAll() {
    for (const providerId of pickers.keys()) render(providerId);
    status.textContent = error;
    status.classList.toggle("error", !!error);
  }

  function open(providerId) {
    if (openProvider && openProvider !== providerId) close();
    const picker = pickers.get(providerId);
    openProvider = providerId;
    picker.list.hidden = false;
    picker.trigger.setAttribute("aria-expanded", "true");
    render(providerId);
    (picker.list.querySelector('[aria-checked="true"]') || picker.list.querySelector(".aiAssistantAccountChoose"))?.focus();
    void refresh();
  }

  function close({ focusTrigger = false } = {}) {
    const picker = pickers.get(openProvider);
    openProvider = "";
    addingProvider = "";
    confirmRemoveId = "";
    if (!picker) return;
    picker.list.hidden = true;
    picker.trigger.setAttribute("aria-expanded", "false");
    if (focusTrigger) picker.trigger.focus();
  }

  function onListKey(event, providerId) {
    const { list } = pickers.get(providerId);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (addingProvider) {
        addingProvider = "";
        render(providerId, ".aiAssistantAccountAdd");
      } else {
        close({ focusTrigger: true });
      }
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (event.target.closest(".aiAssistantAccountForm")) return;
    event.preventDefault();
    const items = [...list.querySelectorAll(".aiAssistantAccountChoose")];
    const index = items.indexOf(event.target.closest(".aiAssistantAccountRow")?.firstChild || event.target);
    const next = index + (event.key === "ArrowDown" ? 1 : -1);
    items[(next + items.length) % items.length]?.focus();
  }

  function apply(result, { notify = false } = {}) {
    if (!result?.ok) {
      error = result?.error || "The account could not be changed.";
      if (Array.isArray(result?.accounts)) accounts = result.accounts;
      renderAll();
      return false;
    }
    const before = new Map(accounts.map((item) => [item.id, item]));
    accounts = result.accounts;
    error = "";
    // A finished sign-in on an active account changes what ArcBot can do now.
    const finished = accounts.some((item) => item.active && before.get(item.id)?.pending && !item.pending);
    renderAll();
    clearTimeout(pollTimer);
    if (accounts.some((item) => item.pending)) pollTimer = setTimeout(() => void refresh(), POLL_MS);
    if (notify || finished) onChanged();
    return true;
  }

  async function call(method, ...args) {
    const host = getHost();
    if (!host?.[method]) return { ok: false, error: "Accounts are available in the desktop app only." };
    try {
      return await host[method](...args);
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  async function refresh() {
    return apply(await call("codexAssistantListAccounts"));
  }

  async function activate(account) {
    if (account.active) {
      close({ focusTrigger: true });
      return;
    }
    const ok = apply(await call("codexAssistantActivateAccount", account.provider, account.id), { notify: true });
    if (ok) close({ focusTrigger: true });
  }

  async function signIn(account) {
    const result = await call("codexAssistantLogin", { accountId: account.id });
    if (!result?.ok) apply(result);
    else await refresh();
  }

  async function signOut(account) {
    apply(await call("codexAssistantSignOutAccount", account.id), { notify: account.active });
  }

  async function removeAccount(account) {
    confirmRemoveId = "";
    apply(await call("codexAssistantRemoveAccount", account.id), { notify: account.active });
    pickers.get(account.provider).list.querySelector(".aiAssistantAccountChoose")?.focus();
  }

  async function createAccount(providerId, label, submit) {
    submit.disabled = true;
    const result = await call("codexAssistantCreateAccount", providerId, String(label || "").trim());
    // The account exists, and is active, even when its sign-in window failed to open.
    const created = Array.isArray(result?.accounts);
    if (created) {
      addingProvider = "";
      apply({ ok: true, accounts: result.accounts }, { notify: true });
      pickers.get(providerId).list.querySelector('[aria-checked="true"]')?.focus();
    }
    if (!result?.ok) {
      submit.disabled = false;
      error = result?.error || "The account could not be added.";
      renderAll();
    }
  }

  renderAll();
  return { refresh, close };
}
