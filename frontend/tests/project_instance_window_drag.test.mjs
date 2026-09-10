import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFile(path.join(here, "..", rel), "utf8");

// Every move used to write the window's measured border-box size back as its
// content-box size, so the frame grew by its border on each title bar drag.
test("nested window frames size their border inside the width they are given", async () => {
  const css = await read("ui/project_instance/project_instance.css");
  const rule = css.match(/\.pi-window \{([^}]*)\}/u);
  assert.ok(rule, "the .pi-window rule exists");
  assert.match(rule[1], /box-sizing:\s*border-box;/u);
  assert.match(rule[1], /border:\s*1px solid/u);
});

test("nested window move and resize track the pointer with capture on the handle", async () => {
  const js = await read("ui/project_instance/project_instance_windows.js");
  assert.match(js, /titlebar\?\.addEventListener\("pointerdown", /u);
  assert.match(js, /handle\.addEventListener\("pointerdown", /u);
  assert.match(js, /handle\.setPointerCapture\?\.\(pointerId\)/u);
  for (const type of ["pointermove", "pointerup", "pointercancel", "lostpointercapture"]) {
    assert.match(js, new RegExp(`handle\\.addEventListener\\("${type}", `, "u"));
  }
  assert.doesNotMatch(js, /document\.addEventListener\("mousemove"/u);
  assert.doesNotMatch(js, /document\.addEventListener\("mouseup"/u);
});
