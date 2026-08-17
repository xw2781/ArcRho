import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const layoutUrl = new URL("../ui/shared/tabs/details/details_form_layout.js", import.meta.url);
const hostFieldsUrl = new URL("../ui/shared/tabs/details/details_host_fields.js", import.meta.url);
const hostFieldsSource = await readFile(hostFieldsUrl, "utf8");

// The module resolves its dependency through the app server's absolute `/ui`
// route, which node cannot serve, so the specifier is pointed at the same file
// on disk before importing.
const hostFields = await import(
  `data:text/javascript;base64,${Buffer.from(
    hostFieldsSource.replace(
      /"\/ui\/shared\/tabs\/details\/details_form_layout\.js\?[^"]*"/u,
      JSON.stringify(layoutUrl.href),
    ),
  ).toString("base64")}`
);
const detailsForm = await import(layoutUrl.href);

function fakeRoot(cells) {
  return {
    style: { setProperty() {} },
    querySelectorAll(selector) {
      const match = selector.match(/\[data-details-field="([^"]+)"\]/u);
      return cells.filter((cell) => cell.field === match?.[1]);
    },
  };
}

const DETAILS_MARKUP = [
  ["../ui/dataset_viewer/dataset_viewer_view.js", ["project"]],
  ["../ui/method_pages/dfm/dfm.html", ["project"]],
  ["../ui/method_pages/berquist_sherman/berquist_sherman.html", ["project", "method_type"]],
  ["../ui/method_pages/cape_cod/cape_cod.html", ["project"]],
  ["../ui/method_pages/bornhuetter_ferguson/bornhuetter_ferguson.html", ["project"]],
];

test("only a Workflow step still lets the page choose its own project", () => {
  assert.equal(hostFields.hostFixesDetailsProject("?project_instance=1&inst=pi_1"), true);
  assert.equal(hostFields.hostFixesDetailsProject("?inst=ds_1"), true);
  assert.equal(hostFields.hostFixesDetailsProject(""), true);
  assert.equal(hostFields.hostFixesDetailsProject("?wf=wf_17&inst=step_1"), false);
  assert.equal(hostFields.hostFixesDetailsProject("?wf=&inst=step_1"), true);
});

test("hides both grid cells of a host-fixed row and restores them for a Workflow host", () => {
  const cells = [
    { field: "project", hidden: false },
    { field: "project", hidden: false },
    { field: "method_type", hidden: false },
  ];

  hostFields.applyHostFixedDetailsFields({ root: fakeRoot(cells), search: "?project_instance=1" });
  assert.deepEqual(cells.map((cell) => cell.hidden), [true, true, true]);

  hostFields.applyHostFixedDetailsFields({ root: fakeRoot(cells), search: "?wf=wf_17" });
  assert.deepEqual(cells.map((cell) => cell.hidden), [false, false, false]);
});

test("a hidden row never widens the shared label column", () => {
  const labels = [
    { textContent: "Reserving Class : ", hidden: false },
    { textContent: "A Very Long Hidden Label : ", hidden: true },
  ];
  const computedStyle = { font: "400 12px Arial", letterSpacing: "0px", paddingLeft: "0px", paddingRight: "0px" };

  const width = detailsForm.measureDetailsLabelWidth(labels, {
    getComputedStyle: () => computedStyle,
    measureText: ({ text }) => text.length * 5,
  });

  assert.equal(width, "Reserving Class :".length * 5);
});

test("every Details page tags the rows its host fixes", async () => {
  for (const [path, fields] of DETAILS_MARKUP) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    for (const field of fields) {
      const occurrences = source.split(`data-details-field="${field}"`).length - 1;
      assert.equal(occurrences, 2, `${path} tags the label and field cell of ${field}`);
    }
  }
});

test("the shared stylesheet outranks page layout when a row is hidden", async () => {
  const stylesheet = await readFile(
    new URL("../ui/shared/tabs/details/details_form_layout.css", import.meta.url),
    "utf8",
  );
  assert.match(stylesheet, /\.arDetailsRoot \[hidden\]\[data-details-field\]\s*\{\s*display:\s*none;/su);
});
