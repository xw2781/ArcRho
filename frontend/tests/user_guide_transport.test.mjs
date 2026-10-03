import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../ui/shell/user_guide.js", import.meta.url), "utf8");
const { openUserGuide } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
// Pin the browser adapter to the Gateway's canonical directory name.
const gatewaySource = await readFile(new URL("../../server-components/src/arcrho_gateway/user_guide.py", import.meta.url), "utf8");
const directoryDeclaration = gatewaySource.match(/^GUIDE_DIRECTORY = ("[^"\r\n]+")\r?$/m);
assert.ok(directoryDeclaration, "Read GUIDE_DIRECTORY from the canonical Gateway module");
const guidePath = `/${JSON.parse(directoryDeclaration[1])}/`;

function setup(address = "https://server.example:28767") {
  const calls = [];
  const statuses = [];
  const hostApi = { openExternalUrl: async (payload) => { calls.push(payload); return { ok: true }; } };
  const options = {
    hostApi, browserWindow: {},
    updateStatus: (...args) => statuses.push(args),
    fetchImpl: async (url) => {
      assert.equal(url, "/server_profiles");
      return { ok: true, json: async () => ({ current: { gateway_url: address }, profiles: [{ gateway_url: "http://wrong.example" }] }) };
    },
  };
  return { calls, statuses, options };
}

test("desktop opens the current Gateway's guide without exposing credentials", async () => {
  const { calls, statuses, options } = setup();
  assert.equal(await openUserGuide(options), true);
  assert.deepEqual(calls, [{ url: `https://server.example:28767${guidePath}` }]);
  assert.match(statuses[0][0], /opened/u);
});

test("guide path respects a configured Gateway base path and removes query parameters", async () => {
  const { calls, options } = setup("https://example.test/arco/?private=value#anchor");
  await openUserGuide(options);
  assert.equal(calls[0].url, `https://example.test/arco${guidePath}`);
});

test("missing or unsafe addresses report a visible error with no local file fallback", async () => {
  for (const address of ["", "file:///E:/ArcRho%20Server", "javascript:alert(1)", "https://user:secret@example.test"]) {
    const { calls, statuses, options } = setup(address);
    assert.equal(await openUserGuide(options), false);
    assert.deepEqual(calls, []);
    assert.equal(statuses[0][1].tone, "error");
  }
});

test("connection lookup and host-open failures remain visible", async () => {
  for (const kind of ["lookup", "host"]) {
    const { statuses, options } = setup();
    if (kind === "lookup") options.fetchImpl = async () => { throw new Error("Connection unavailable"); };
    else options.hostApi.openExternalUrl = async () => ({ ok: false, error: "Browser unavailable" });
    assert.equal(await openUserGuide(options), false);
    assert.equal(statuses[0][1].tone, "error");
    assert.match(statuses[0][0], /unavailable/u);
  }
});

test("browser mode preserves the click gesture and detaches the opener", async () => {
  const { options } = setup();
  const visited = [];
  const tab = { opener: "original", location: { replace: (url) => visited.push(url) } };
  options.hostApi = null;
  options.browserWindow = { open: (url, target) => { assert.equal(url, "about:blank"); assert.equal(target, "_blank"); return tab; } };
  assert.equal(await openUserGuide(options), true);
  assert.equal(tab.opener, null);
  assert.deepEqual(visited, [`https://server.example:28767${guidePath}`]);
});

test("browser lookup failure closes the blank tab; blocked popups report an error", async () => {
  let closed = false;
  const { options, statuses } = setup("");
  options.hostApi = null;
  options.browserWindow = { open: () => ({ close: () => { closed = true; } }) };
  assert.equal(await openUserGuide(options), false);
  assert.equal(closed, true);
  options.browserWindow.open = () => null;
  assert.equal(await openUserGuide(options), false);
  assert.match(statuses.at(-1)[0], /pop-ups/u);
});

test("Electron opener refuses non-web URLs before calling the OS", async () => {
  const main = await readFile(new URL("../electron/main.js", import.meta.url), "utf8");
  const start = main.indexOf('ipcMain.handle("open-external-url",');
  const end = main.indexOf("\n});", start) + 4;
  let handler;
  const opened = [];
  vm.runInNewContext(main.slice(start, end), {
    URL, ipcMain: { handle: (_name, fn) => { handler = fn; } },
    shell: { openExternal: async (url) => opened.push(url) },
  });
  for (const url of ["file:///E:/secret", "javascript:alert(1)", "https://user:secret@example.test", "invalid"]) {
    assert.equal((await handler(null, { url })).ok, false);
  }
  assert.deepEqual(opened, []);
  assert.equal((await handler(null, { url: `http://server.test${guidePath}` })).ok, true);
  assert.deepEqual(opened, [`http://server.test${guidePath}`]);
});
