const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

// ArcBot sign-in accounts. The built-in "Primary" account of each provider is
// the CLI's own home folder and runs with the override variable removed; every
// other account is an isolated folder the variable points at, so credentials
// never move between accounts. Only the account list and the active choice are
// stored here; identities are read from each account's own files on demand.
const ACCOUNTS_FILE = "arcbot_accounts.json";
const ACCOUNTS_DIR = "arcbot_accounts";
const PROVIDERS = {
  codex: { envVar: "CODEX_HOME", homeDir: ".codex", shared: ["config.toml", "AGENTS.md"], authFile: "auth.json" },
  claude: { envVar: "CLAUDE_CONFIG_DIR", homeDir: ".claude", shared: ["settings.json", "CLAUDE.md"], authFile: ".credentials.json" },
};
// A sign-in window left open longer than this stops showing as pending.
const LOGIN_PENDING_MS = 5 * 60 * 1000;

function decodeJwtPayload(token) {
  const part = String(token || "").split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function fileMtime(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function slug(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "account";
}

function planLabel(plan) {
  const text = String(plan || "").trim().replace(/^claude_/u, "");
  if (!text) return "";
  return text.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function isWithin(filePath, rootPath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(filePath));
  return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function createArcBotAccounts({ getRootDir, homeDir = os.homedir() }) {
  const pending = new Map();

  const storePath = () => path.join(getRootDir(), ACCOUNTS_FILE);
  const accountsRoot = () => path.join(getRootDir(), ACCOUNTS_DIR);
  const builtin = (provider) => ({
    id: `${provider}-primary`,
    provider,
    label: "Primary",
    configDir: path.join(homeDir, PROVIDERS[provider].homeDir),
    builtin: true,
  });

  function readStore() {
    const raw = readJson(storePath()) || {};
    const accounts = (Array.isArray(raw.accounts) ? raw.accounts : []).filter((account) => (
      account && PROVIDERS[account.provider] && account.id && account.configDir
    ));
    return {
      accounts,
      active: raw.active && typeof raw.active === "object" ? raw.active : {},
      provider: raw.provider === "claude" ? "claude" : "codex",
    };
  }

  function writeStore(store) {
    const filePath = storePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify({ version: 1, ...store }, null, 2), "utf8");
    fs.renameSync(tmpPath, filePath);
  }

  function list() {
    const { accounts } = readStore();
    return [builtin("codex"), ...accounts.filter((a) => a.provider === "codex"),
      builtin("claude"), ...accounts.filter((a) => a.provider === "claude")];
  }

  function get(id) {
    const account = list().find((a) => a.id === id);
    if (!account) throw new Error("That account no longer exists.");
    return account;
  }

  function active(provider) {
    const id = readStore().active[provider];
    return list().find((a) => a.provider === provider && a.id === id) || builtin(provider);
  }

  // The one account ArcBot uses for every chat; its provider decides which models run.
  function current() {
    return active(readStore().provider);
  }

  function setActive(provider, id) {
    const account = get(id);
    if (account.provider !== provider) throw new Error("That account belongs to another provider.");
    const store = readStore();
    store.active = { ...store.active, [provider]: account.id };
    store.provider = provider;
    writeStore(store);
    return account;
  }

  function create(provider, label) {
    if (!PROVIDERS[provider]) throw new Error("Unknown provider.");
    const name = String(label || "").trim().slice(0, 40) || "Account";
    const id = `${provider}-${slug(name)}-${crypto.randomBytes(2).toString("hex")}`;
    const configDir = path.join(accountsRoot(), id);
    fs.mkdirSync(configDir, { recursive: true });
    const source = builtin(provider).configDir;
    for (const file of PROVIDERS[provider].shared) {
      try {
        fs.copyFileSync(path.join(source, file), path.join(configDir, file));
      } catch {
        // The primary account has no such file; nothing to share.
      }
    }
    const account = { id, provider, label: name, configDir, builtin: false, createdAt: new Date().toISOString() };
    const store = readStore();
    store.accounts = [...store.accounts, account];
    writeStore(store);
    return account;
  }

  function remove(id) {
    const account = get(id);
    if (account.builtin) throw new Error("The primary account cannot be removed.");
    if (isWithin(account.configDir, accountsRoot())) fs.rmSync(account.configDir, { recursive: true, force: true });
    const store = readStore();
    store.accounts = store.accounts.filter((a) => a.id !== id);
    if (store.active[account.provider] === id) delete store.active[account.provider];
    writeStore(store);
    pending.delete(id);
    return account;
  }

  // The built-in account must run with the override removed: Claude Code keeps
  // .claude.json in the home folder only when CLAUDE_CONFIG_DIR is unset.
  function envFor(account, base = process.env) {
    const env = { ...base };
    const name = PROVIDERS[account.provider].envVar;
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === name) delete env[key];
    }
    if (!account.builtin) env[name] = account.configDir;
    return env;
  }

  const authFilePath = (account) => path.join(account.configDir, PROVIDERS[account.provider].authFile);

  // Email and plan only; token values never leave this function.
  function identity(account) {
    if (account.provider === "claude") {
      const config = readJson(account.builtin ? path.join(homeDir, ".claude.json") : path.join(account.configDir, ".claude.json")) || {};
      const oauth = readJson(authFilePath(account))?.claudeAiOauth || null;
      return {
        signedIn: !!(oauth?.accessToken || oauth?.refreshToken),
        email: String(config.oauthAccount?.emailAddress || ""),
        plan: planLabel(oauth?.subscriptionType),
      };
    }
    const auth = readJson(authFilePath(account));
    if (!auth) return { signedIn: false, email: "", plan: "" };
    if (auth.OPENAI_API_KEY && !auth.tokens) return { signedIn: true, email: "", plan: "API key" };
    const claims = decodeJwtPayload(auth.tokens?.id_token) || {};
    return {
      signedIn: !!(auth.tokens?.refresh_token || auth.tokens?.access_token),
      email: String(claims.email || ""),
      plan: planLabel(claims["https://api.openai.com/auth"]?.chatgpt_plan_type),
    };
  }

  // A sign-in runs in its own window, so it is finished when the account's
  // credential file changes; it is abandoned once the window has been open too long.
  function markLoginPending(id, now = Date.now()) {
    const account = get(id);
    pending.set(id, { since: now, baseline: fileMtime(authFilePath(account)) });
  }

  function isLoginPending(account, now = Date.now()) {
    const entry = pending.get(account.id);
    if (!entry) return false;
    if (now - entry.since > LOGIN_PENDING_MS || fileMtime(authFilePath(account)) !== entry.baseline) {
      pending.delete(account.id);
      return false;
    }
    return true;
  }

  function views(now = Date.now()) {
    const currentId = current().id;
    return list().map((account) => ({
      id: account.id,
      provider: account.provider,
      label: account.label,
      builtin: account.builtin,
      active: currentId === account.id,
      pending: isLoginPending(account, now),
      ...identity(account),
    }));
  }

  return {
    list, get, active, current, setActive, create, remove, envFor, identity, authFilePath,
    markLoginPending, isLoginPending, views,
  };
}

module.exports = { createArcBotAccounts, decodeJwtPayload, ACCOUNTS_DIR, ACCOUNTS_FILE, LOGIN_PENDING_MS };
