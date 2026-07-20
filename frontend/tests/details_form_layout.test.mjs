import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const componentUrl = new URL("../ui/shared/tabs/details/details_form_layout.js", import.meta.url);
const componentSource = await readFile(componentUrl, "utf8");
const stylesheetUrl = new URL("../ui/shared/tabs/details/details_form_layout.css", import.meta.url);
const stylesheetSource = await readFile(stylesheetUrl, "utf8");
const detailsForm = await import(
  `data:text/javascript;base64,${Buffer.from(componentSource).toString("base64")}`
);

function fakeStyle() {
  const properties = new Map();
  return {
    properties,
    setProperty(name, value) {
      properties.set(name, String(value));
    },
  };
}

test("keeps visual defaults exclusively in the shared stylesheet", () => {
  assert.equal("DETAILS_FORM_LABEL_GAP" in detailsForm, false);
  assert.equal("DETAILS_FORM_CONTROL_HEIGHT" in detailsForm, false);
  assert.equal(detailsForm.DETAILS_FORM_CLASS_NAMES.root, "arDetailsRoot");
  assert.match(stylesheetSource, /--ar-details-label-control-gap:\s*5px;/u);
  assert.match(stylesheetSource, /\.arDetailsGroup\s*\+\s*\.arDetailsGroup/u);
  assert.match(stylesheetSource, /grid-template-columns:\s*var\(--ar-details-label-width\)\s+minmax\(0,\s*1fr\);/u);
  assert.match(stylesheetSource, /height:\s*var\(--ar-details-control-height\);/u);
});

test("keeps authored label punctuation literal", () => {
  assert.equal(detailsForm.getDetailsLabelText("Output Type : "), "Output Type :");
  assert.equal(detailsForm.getDetailsLabelText({ textContent: "Prior   Vector : " }), "Prior Vector :");
  assert.match(stylesheetSource, /\.arDetailsLabel::after\s*\{\s*content:\s*none;/su);
});

test("measures all groups and writes one common label width", () => {
  const labels = [
    { textContent: "Name : " },
    { textContent: "Output Type : " },
  ];
  const style = fakeStyle();
  const root = {
    style,
    querySelectorAll(selector) {
      assert.equal(selector, ".arDetailsLabel");
      return labels;
    },
  };
  const computedStyle = {
    font: '400 12px Arial, "Segoe UI", sans-serif',
    letterSpacing: "1px",
    paddingLeft: "2px",
    paddingRight: "3px",
  };

  const result = detailsForm.syncDetailsLabelWidth({
    root,
    getComputedStyle: () => computedStyle,
    measureText: ({ text }) => text.length * 5,
  });

  assert.equal(result.labelCount, 2);
  assert.equal(result.width, 82);
  assert.equal(style.properties.get("--ar-details-label-width"), "82px");
  assert.equal(style.properties.has("--ar-details-label-control-gap"), false);
  assert.equal(style.properties.has("--ar-details-control-height"), false);
});

test("writes a visual token only when the caller explicitly overrides it", () => {
  const style = fakeStyle();
  const root = { style };

  detailsForm.applyDetailsFormTokens(root, { labelGap: "7px" });

  assert.equal(style.properties.get("--ar-details-label-control-gap"), "7px");
  assert.equal(style.properties.has("--ar-details-row-gap"), false);
});
