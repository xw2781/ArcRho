import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("shell add-tab control uses an accessible centered SVG with theme-owned colors", async () => {
  const strip = await read("../ui/shell/tab_strip.js");
  const styles = await read("../ui/shell/shell.css");

  assert.match(strip, /document\.createElement\("button"\)/u);
  assert.match(strip, /setAttribute\("aria-label", "Add tab"\)/u);
  assert.match(strip, /class="plusTabIcon"/u);
  assert.doesNotMatch(strip, /plusBtnEl\.textContent = "\+"/u);
  assert.match(styles, /\.plusTab\s*\{[^}]*background:\s*var\(--ar-color-surface-muted/su);
  assert.match(styles, /\.plusTab\s*\{[^}]*border:\s*1px solid var\(--ar-color-border/su);
  assert.match(styles, /\.plusTabIcon\s*\{[^}]*stroke:\s*var\(--ar-color-text-strong/su);
  assert.match(styles, /\.plusTab:focus-visible\s*\{/u);
});
