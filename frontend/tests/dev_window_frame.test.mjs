import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const DEV_FRAME_BLUE = "#528bff";
const WINDOWS_10_FRAME = "#aeb8ff";

test("a development launch recolors the Windows 10 shell frame to the dev blue", async () => {
  const css = await read("../ui/shell/shell.css");
  const rule = /body\.win10-borders\.dev-frame\s*\{([^}]*)\}/.exec(css);

  assert.ok(rule, "shell.css must style the dev frame through the win10-borders frame");
  assert.match(rule[1], new RegExp(`--shell-frame-border:\\s*${DEV_FRAME_BLUE}`, "i"));
});

test("the dev frame overrides the installed Windows 10 color rather than replacing the mechanism", async () => {
  const css = await read("../ui/shell/shell.css");
  const installed = css.indexOf("body.win10-borders {");
  const dev = css.indexOf("body.win10-borders.dev-frame {");

  assert.ok(installed >= 0 && dev > installed, "the dev override must follow the installed rule");
  // The frame itself stays owned by body::after and --shell-frame-border; the dev rule
  // must only retint it, never add a second border of its own.
  const rule = /body\.win10-borders\.dev-frame\s*\{([^}]*)\}/.exec(css)[1];
  assert.doesNotMatch(rule, /box-shadow\s*:|(?<![-\w])border\s*:|(?<![-\w])position\s*:/);
});

test("Windows 11 keeps its own frame in development", async () => {
  const css = await read("../ui/shell/shell.css");
  assert.doesNotMatch(css, /body\.win11-frame\.dev-frame|body\.dev-frame\s*\{/);
  // Confirms the retint is reachable only through the Windows 10 class.
  const installedRule = /body\.win10-borders\s*\{([^}]*)\}/.exec(css)[1];
  assert.match(installedRule, new RegExp(WINDOWS_10_FRAME, "i"));
});

test("the shell marks the document as a development launch from host app info", async () => {
  const html = await read("../ui/index.html");
  assert.match(html, /getAppInfo\(\)/);
  assert.match(html, /classList\.toggle\('dev-frame', info\?\.isPackaged === false\)/);
});

test("a packaged launch and an unavailable host both leave the dev frame off", async () => {
  const html = await read("../ui/index.html");
  // `isPackaged === false` rather than `!isPackaged`, so a host that answers with an
  // incomplete payload cannot be read as a development launch.
  assert.doesNotMatch(html, /classList\.toggle\('dev-frame', !info/);
  const block = /if \(window\.ADAHost\?\.getAppInfo\) \{([\s\S]*?)\n      \}/.exec(html);
  assert.ok(block, "the app-info lookup must be guarded on the host API being present");
  assert.match(block[1], /catch/);
});

test("the shell stylesheet cache key was bumped so the new rule is fetched", async () => {
  const html = await read("../ui/index.html");
  const link = /shell\/shell\.css\?v=([0-9a-z]+)/.exec(html);
  assert.ok(link, "index.html must request shell.css with a cache key");
  assert.notEqual(link[1], "20260809d", "the pre-change cache key would serve the old stylesheet");
});
