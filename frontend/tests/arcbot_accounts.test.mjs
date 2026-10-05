import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tempRoot = path.join(repo, "test");
fs.mkdirSync(tempRoot, { recursive: true });
const require = createRequire(import.meta.url);
const { createArcBotAccounts, LOGIN_PENDING_MS } = require("../electron/arcbot_accounts.js");

function jwt(payload) {
  return `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
}

function setup(t) {
  const scratch = fs.mkdtempSync(path.join(tempRoot, "arcbot-accounts-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const home = path.join(scratch, "home");
  const prefs = path.join(scratch, "prefs");
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  return { home, prefs, accounts: createArcBotAccounts({ getRootDir: () => prefs, homeDir: home }) };
}

test("primary accounts are built in and active by default", (t) => {
  const { home, accounts } = setup(t);
  const codex = accounts.active("codex");
  assert.equal(codex.builtin, true);
  assert.equal(codex.configDir, path.join(home, ".codex"));
  assert.equal(accounts.active("claude").configDir, path.join(home, ".claude"));
  assert.deepEqual(accounts.views().map((a) => [a.provider, a.label, a.active]), [["codex", "Primary", true], ["claude", "Primary", true]]);
  assert.throws(() => accounts.remove(codex.id), /cannot be removed/);
});

test("an added account gets its own folder, shared settings, and no credentials", (t) => {
  const { home, prefs, accounts } = setup(t);
  fs.writeFileSync(path.join(home, ".codex", "config.toml"), "model = \"x\"\n");
  fs.writeFileSync(path.join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: "secret" } }));
  const work = accounts.create("codex", "Work Team!");
  assert.match(work.id, /^codex-work-team-[0-9a-f]{4}$/);
  assert.equal(path.dirname(work.configDir), path.join(prefs, "arcbot_accounts"));
  assert.ok(fs.existsSync(path.join(work.configDir, "config.toml")));
  assert.ok(!fs.existsSync(path.join(work.configDir, "auth.json")));
  assert.equal(accounts.identity(work).signedIn, false);
  const stored = JSON.parse(fs.readFileSync(path.join(prefs, "arcbot_accounts.json"), "utf8"));
  assert.deepEqual(stored.accounts.map((a) => a.id), [work.id]);
});

test("switching and removing change only the provider's active account", (t) => {
  const { accounts } = setup(t);
  const work = accounts.create("claude", "Work");
  accounts.setActive("claude", work.id);
  assert.equal(accounts.active("claude").id, work.id);
  assert.equal(accounts.active("codex").builtin, true);
  assert.throws(() => accounts.setActive("codex", work.id), /another provider/);
  accounts.remove(work.id);
  assert.ok(!fs.existsSync(work.configDir));
  assert.equal(accounts.active("claude").builtin, true);
});

test("removing an account never deletes a folder outside the accounts root", (t) => {
  const { home, prefs, accounts } = setup(t);
  const outside = path.join(home, "elsewhere");
  fs.mkdirSync(outside);
  const file = path.join(prefs, "arcbot_accounts.json");
  fs.mkdirSync(prefs, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ accounts: [{ id: "codex-x-0000", provider: "codex", label: "X", configDir: outside }] }));
  accounts.remove("codex-x-0000");
  assert.ok(fs.existsSync(outside));
  assert.equal(accounts.list().length, 2);
});

test("the primary runs with the override removed; others point it at their folder", (t) => {
  const { accounts } = setup(t);
  const base = { codex_home: "C:\\inherited", PATH: "p" };
  assert.deepEqual(accounts.envFor(accounts.active("codex"), base), { PATH: "p" });
  const work = accounts.create("codex", "Work");
  assert.deepEqual(accounts.envFor(work, base), { PATH: "p", CODEX_HOME: work.configDir });
  const claude = accounts.create("claude", "Work");
  assert.equal(accounts.envFor(claude, {}).CLAUDE_CONFIG_DIR, claude.configDir);
});

test("identity reads email and plan without exposing tokens", (t) => {
  const { home, accounts } = setup(t);
  fs.writeFileSync(path.join(home, ".codex", "auth.json"), JSON.stringify({
    tokens: {
      id_token: jwt({ email: "a@example.com", "https://api.openai.com/auth": { chatgpt_plan_type: "pro" } }),
      refresh_token: "secret-refresh",
    },
  }));
  const codex = accounts.identity(accounts.active("codex"));
  assert.deepEqual(codex, { signedIn: true, email: "a@example.com", plan: "Pro" });

  const apiKey = accounts.create("codex", "Key");
  fs.writeFileSync(path.join(apiKey.configDir, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-secret" }));
  assert.deepEqual(accounts.identity(apiKey), { signedIn: true, email: "", plan: "API key" });

  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "c@example.com" } }));
  fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "secret", subscriptionType: "max" } }));
  assert.deepEqual(accounts.identity(accounts.active("claude")), { signedIn: true, email: "c@example.com", plan: "Max" });

  const isolated = accounts.create("claude", "Other");
  fs.writeFileSync(path.join(isolated.configDir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "d@example.com" } }));
  assert.deepEqual(accounts.identity(isolated), { signedIn: false, email: "d@example.com", plan: "" });
  assert.doesNotMatch(JSON.stringify(accounts.views()), /secret/);
});

test("a sign-in stays pending until the credential file changes or the window is abandoned", (t) => {
  const { accounts } = setup(t);
  const work = accounts.create("codex", "Work");
  accounts.markLoginPending(work.id, 1000);
  assert.equal(accounts.isLoginPending(work, 2000), true);
  fs.writeFileSync(path.join(work.configDir, "auth.json"), "{}");
  assert.equal(accounts.isLoginPending(work, 2000), false);
  accounts.markLoginPending(work.id, 1000);
  assert.equal(accounts.isLoginPending(work, 1000 + LOGIN_PENDING_MS + 1), false);
});

test("the host runs Codex and reads Claude credentials under the active account", (t) => {
  const { prefs, home } = setup(t);
  const { registerArcBotIpc, testHooks } = require("../electron/arcbot_host.js");
  const handlers = new Map();
  const host = registerArcBotIpc({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    app: { isPackaged: false, getPath: () => prefs },
    APP_ROOT: path.join(repo, "frontend"), REPO_ROOT: repo,
    getPrefsDir: () => prefs, getWorkspacePathsPath: () => "", homeDir: home,
  });
  t.after(() => host.stop());
  assert.equal(testHooks.getArcBotCodexEnv({ CODEX_HOME: "x" }).CODEX_HOME, undefined);
  assert.equal(testHooks.getClaudeCredentialsPath(), path.join(home, ".claude", ".credentials.json"));
  const accounts = createArcBotAccounts({ getRootDir: () => prefs, homeDir: home });
  const codex = accounts.create("codex", "Work");
  const claude = accounts.create("claude", "Work");
  return (async () => {
    assert.equal((await handlers.get("codex-assistant-account-activate")(null, { provider: "openai", accountId: codex.id })).ok, true);
    assert.equal((await handlers.get("codex-assistant-account-activate")(null, { provider: "anthropic", accountId: claude.id })).ok, true);
    assert.equal(testHooks.getArcBotCodexEnv({}).CODEX_HOME, codex.configDir);
    assert.equal(testHooks.getClaudeCredentialsPath(), path.join(claude.configDir, ".credentials.json"));
    const list = await handlers.get("codex-assistant-accounts-list")();
    assert.deepEqual(list.accounts.filter((a) => a.active).map((a) => a.id), [codex.id, claude.id]);
    const removed = await handlers.get("codex-assistant-account-remove")(null, { accountId: claude.id });
    assert.equal(removed.ok, true);
    assert.equal(testHooks.getClaudeCredentialsPath(), path.join(home, ".claude", ".credentials.json"));
  })();
});
