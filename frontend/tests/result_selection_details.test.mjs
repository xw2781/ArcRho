import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const frontendRoot = new URL("../", import.meta.url);

async function source(relativePath) {
  return readFile(new URL(relativePath, frontendRoot), "utf8");
}

test("Result Selection hides the tooltip-free Ratio Basis add row at three datasets", async () => {
  const [html, css, ui] = await Promise.all([
    source("ui/method_pages/result_selection/result_selection.html"),
    source("ui/method_pages/result_selection/result_selection.css"),
    source("ui/method_pages/result_selection/result_selection_ui.js"),
  ]);

  const addButton = html.match(/<button id="rsRatioBasisAddBtn"[^>]*>/u)?.[0] || "";
  assert.ok(addButton);
  assert.doesNotMatch(addButton, /\btitle=/u);
  assert.match(addButton, /aria-label="Add ratio basis"/u);
  assert.match(ui, /ratioBasisAddButton\.hidden = atLimit;/u);
  assert.match(css, /\.rsRatioBasisAdd\[hidden\]\s*\{\s*display:\s*none;/u);
});
