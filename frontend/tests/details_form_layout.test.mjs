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
  assert.match(stylesheetSource, /\.arDetailsSection\s*\+\s*\.arDetailsSection/u);
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
  const selectors = [];
  const root = {
    style,
    querySelectorAll(selector) {
      selectors.push(selector);
      return selector === ".arDetailsLabel" ? labels : [];
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

  assert.ok(selectors.includes(".arDetailsLabel"));
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

function fakeSection(fields, { hidden = false } = {}) {
  const attributes = new Map();
  return {
    hidden,
    attributes,
    querySelectorAll(selector) {
      assert.equal(selector, ".arDetailsField");
      return fields;
    },
    setAttribute(name, value) {
      attributes.set(name, value);
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
  };
}

function fakeSectionRoot(sections) {
  return {
    style: fakeStyle(),
    querySelectorAll(selector) {
      return selector === ".arDetailsSection" ? sections : [];
    },
  };
}

test("marks the first section that still renders a row as the lead", () => {
  const identity = fakeSection([{ hidden: false }, { hidden: false }]);
  const inputs = fakeSection([{ hidden: false }]);
  const result = detailsForm.syncDetailsSections(fakeSectionRoot([identity, inputs]));

  assert.equal(result.lead, identity);
  assert.equal(identity.attributes.has("data-details-section-lead"), true);
  assert.equal(inputs.attributes.has("data-details-section-lead"), false);
  assert.equal(identity.attributes.has("data-details-section-empty"), false);
});

test("a section every host emptied collapses and never leads", () => {
  // Nothing in the tab may sit under a divider that has no rows above it, so a
  // section whose every row the host fixed hands the lead to the next one.
  const emptied = fakeSection([{ hidden: true }, { hidden: true }]);
  const inputs = fakeSection([{ hidden: false }]);
  const result = detailsForm.syncDetailsSections(fakeSectionRoot([emptied, inputs]));

  assert.equal(result.lead, inputs);
  assert.equal(emptied.attributes.get("data-details-section-empty"), "");
  assert.equal(emptied.attributes.has("data-details-section-lead"), false);
  assert.equal(inputs.attributes.get("data-details-section-lead"), "");
});

test("a section the page hid hands the lead on, as the B&S source swap needs", () => {
  const srSources = fakeSection([{ hidden: false }], { hidden: true });
  const craSources = fakeSection([{ hidden: false }]);
  const result = detailsForm.syncDetailsSections(fakeSectionRoot([srSources, craSources]));

  assert.equal(result.lead, craSources);
  assert.equal(srSources.attributes.has("data-details-section-lead"), false);
  assert.equal(craSources.attributes.get("data-details-section-lead"), "");
});

test("the shared stylesheet owns the divider, its gap, and the short field width", () => {
  assert.match(stylesheetSource, /--ar-details-section-gap:\s*12px;/u);
  assert.match(stylesheetSource, /--ar-details-short-field-width:\s*70px;/u);
  assert.match(
    stylesheetSource,
    /\.arDetailsSection \+ \.arDetailsSection \{[^}]*border-top:\s*1px solid var\(--ar-details-section-divider\)/su,
  );
  assert.match(
    stylesheetSource,
    /\[data-details-section-lead\]\s*\{[^}]*border-top:\s*0/su,
  );
  // A group wrapper no longer exists: `.arDetailsSection` is the one way a page
  // wraps a set of Details rows, whether to show them together or to group them.
  assert.doesNotMatch(stylesheetSource, /arDetailsGroup/u);
  assert.equal("group" in detailsForm.DETAILS_FORM_CLASS_NAMES, false);
  assert.equal(detailsForm.DETAILS_FORM_CLASS_NAMES.section, "arDetailsSection");
  assert.equal(detailsForm.DETAILS_FORM_CLASS_NAMES.shortField, "arDetailsShortField");
});
