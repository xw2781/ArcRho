import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dfmHtml = await readFile(
  new URL("../ui/method_pages/dfm/dfm.html", import.meta.url),
  "utf8",
);

function getModeButtonContent(action) {
  const match = dfmHtml.match(new RegExp(
    `<button[^>]*data-action="${action}"[^>]*>([\\s\\S]*?)<\\/button>`,
    "u",
  ));
  assert.ok(match, `Expected the ${action} context-menu button.`);
  return match[1];
}

for (const action of ["toggle-summary-ratio-mode", "toggle-ratio-mode"]) {
  test(`${action} places its mode icon after its text`, () => {
    const content = getModeButtonContent(action);
    const labelIndex = content.indexOf('class="dfmCtxItemLabel"');
    const editIconIndex = content.indexOf("dfmCtxModeIconEdit");
    const selectIconIndex = content.indexOf("dfmCtxModeIconSelect");
    assert.ok(labelIndex >= 0);
    assert.ok(editIconIndex > labelIndex);
    assert.ok(selectIconIndex > labelIndex);
  });
}
