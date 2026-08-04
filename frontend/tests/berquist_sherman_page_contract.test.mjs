import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, main, css] = await Promise.all([
  readFile(
    new URL("../ui/method_pages/berquist_sherman/berquist_sherman.html", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL("../ui/method_pages/berquist_sherman/berquist_sherman_main.js", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL("../ui/method_pages/berquist_sherman/berquist_sherman.css", import.meta.url),
    "utf8",
  ),
]);

test("every B&S source picker uses a calculation role key", () => {
  const roles = Array.from(
    html.matchAll(/data-picker-role="([^"]+)"/gu),
    (match) => match[1],
  );
  assert.deepEqual(roles, [
    "paid_claims",
    "closed_claim_numbers",
    "ultimate_claim_numbers",
    "reported_claim_numbers",
    "closed_claim_numbers",
    "incurred_claims",
    "paid_claims",
  ]);
  assert.doesNotMatch(html, /data-picker-role="(?:sr|cra)_/u);
});

test("B&S rejects source format and period mismatches", () => {
  assert.match(main, /norm\(payloadFormat\) !== norm\(role\.format\)/u);
  assert.match(
    main,
    /const payload = state\.sourcePayloads\[role\.key\][\s\S]{0,300}Array\.isArray\(originLabels\)\s*&& originLabels\.length\s*&& \(/u,
  );
  assert.match(main, /uses different origin periods/u);
  assert.match(main, /uses different development periods/u);
  assert.match(main, /createDatasetHeadersService/u);
  assert.doesNotMatch(main, /`\$\{\(index \+ 1\) \* ANNUAL_PERIOD_LENGTH\}m`/u);
});

test("B&S publishes and clears full-triangle dependency previews", () => {
  assert.match(main, /message\.matrixValues = cloneMatrix\(output\)/u);
  assert.match(main, /message\.mask = output\.map/u);
  assert.match(main, /scheduleOutputDependencyPreview\("upstream-preview", true\)/u);
  assert.match(main, /else clearOutputDependencyPreview\("clean"\)/u);
  assert.match(main, /type:\s*"arcrho:dependency-source-cleared"/u);
});

test("B&S keeps previews reproducible across invalid, clear, picker, and save paths", () => {
  assert.match(
    main,
    /if \(lastOutputPreviewMessage\) clearOutputDependencyPreview\("invalid"\)/u,
  );
  assert.match(main, /isDirty \|\| activeDependencyPreviews\.size > 0/u);
  assert.match(
    main,
    /blockSaveForActiveSourcePreviews\(\)[\s\S]+await refreshSourceRoles\(\);[\s\S]+blockSaveForActiveSourcePreviews\(\)/u,
  );
  assert.match(main, /state\.sourceNames\[role\.key\] = priorName/u);
  assert.match(main, /input\.addEventListener\("input"/u);
});

test("result-affecting MVP selections remain editable and persisted", () => {
  assert.match(main, /\["case_column", "case_all", "paid_column", "paid_all", "user"\]/u);
  assert.match(main, /\["latest", "monotone", "user"\]/u);
  assert.match(main, /methodTab\.selected_adjustment = cloneMatrix/u);
  assert.match(main, /methodTab\.loess_span = state\.loessSpan/u);
  assert.match(main, /methodTab\.inflation_selection = state\.inflationSelection\.slice/u);
});

test("SR method views follow the ResQ sub-tab order with in-grid selection UX", () => {
  const labels = Array.from(
    main.matchAll(/label: "([^"]+)",\s*\n?\s*caption:/gu),
    (match) => match[1],
  );
  assert.deepEqual(labels, [
    "Paid Claims",
    "Numbers Closed",
    "Proportion Settled",
    "Selected Numbers Closed",
    "Adjusted Paid Claims",
  ]);
  assert.match(main, /currentView: variant === "sr" \? "paidClaims" : "output"/u);
  assert.match(main, /Select Leading Diagonal/u);
  assert.match(main, /bsPropSelectedInput/u);
  assert.match(main, /state\.selectedProportionIsDefault\[devIndex\] = false/u);
  assert.match(main, /Paid Claims Adjusted to Constant Proportions Settled/u);
});

test("SR adjusted paid grid supports per-cell, per-origin, and all-origin selection", () => {
  assert.match(main, /dataset\.adjustMethod = gridRow\.method/u);
  assert.match(main, /dataset\.adjustDev = String\(devIndex\)/u);
  assert.match(main, /applyAdjustmentSelection\(/u);
  assert.match(main, /event\.ctrlKey \|\| event\.metaKey/u);
  assert.match(main, /state\.selectedAdjustment\[originIndex\]\[devIndex\] = method/u);
  assert.match(main, /state\.loessSpan = normalizeLoessSpan\(method\.loess_span\)/u);
  assert.match(html, /bsLoessSpanInput/u);
  assert.match(html, /tabbedPageTabBar/u);
});

test("B&S frames its pages on the shared tabbed-page gutter like DFM", () => {
  // The shell must lay the tab strip, page frame, and save bar out as flex rows
  // so the frame cannot overflow past the bottom of the window.
  assert.match(css, /\.bsTabbed \{[^}]*flex-direction: column;/u);
  assert.match(css, /\.bsPageHost \{[^}]*flex: 1 1 auto;/u);
  assert.doesNotMatch(css, /\.bsPageHost \{[^}]*height: 100%/u);
  // The frame, the strip, and the save bar share one gutter, and every Method
  // row shares one inset derived from it.
  assert.match(css, /\.bsPageHost \{[^}]*margin: 0 var\(--tabbed-page-gutter, 8px\);/u);
  assert.match(css, /\.bsSaveBar \{[^}]*padding: 6px var\(--tabbed-page-gutter, 8px\) 4px;/u);
  assert.match(css, /#bsMethodPage \{[^}]*--bs-method-inset: var\(--tabbed-page-gutter, 8px\);/u);
  // The nested strip inherits the gutter instead of redeclaring it.
  assert.doesNotMatch(css, /\.bsMethodTabBar \{[^}]*--tabbed-page-gutter/u);
});

test("the method label column has one alignment source", () => {
  assert.match(css, /\.bsMethodTable td:first-child \{[^}]*text-align: center;/u);
  // The adjusted grid's origin and estimator rows must not re-align the column.
  assert.doesNotMatch(css, /\.bsMethodTable tr\.bsAdjYearRow td \{[^}]*text-align/u);
  assert.doesNotMatch(css, /\.bsMethodTable td\.bsAdjRowLabel \{[^}]*text-align/u);
});

test("row hover never repaints a meaningful cell fill", () => {
  const rule = css.match(/\.bsMethodTable tbody tr[^{]*:hover[^{]*\{[^}]*--bs-row-hover[^}]*\}/u);
  assert.ok(rule, "row-hover rule not found");
  const excluded = new Set(
    Array.from(rule[0].matchAll(/:not\(:is\(([^)]*)\)\)/gu), (match) =>
      match[1].split(",").map((entry) => entry.trim())).flat(),
  );
  for (const selector of [
    ".bsAdjYearRow",
    ".bsPropSelectedRow",
    ".bsPropSpacerRow",
    ".bsResultCell",
    ".bsAdjSelectedSource",
    ".bsPropSelectedSource",
  ]) {
    assert.ok(excluded.has(selector), `row hover must leave ${selector} alone`);
  }
});

test("the nested calculation strip encloses its client area like ResQ", () => {
  // The caption, summary, message, and table live inside the nested strip's own
  // frame, not directly on the Method page.
  assert.match(
    html,
    /<div class="bsMethodFrame">[\s\S]*bsMethodCaption[\s\S]*bsSelectionSummary[\s\S]*bsMethodMessage[\s\S]*bsTableWrap[\s\S]*<\/div>\s*<\/section>/u,
  );
  // The frame takes the strip's bottom rule as its top edge and shares the
  // strip's gutter, so the active calculation tab sits on a closed box.
  assert.match(css, /\.bsMethodFrame \{[^}]*margin: 0 var\(--bs-method-inset\) var\(--bs-method-inset\);/u);
  assert.match(css, /\.bsMethodFrame \{[^}]*border-top: 0;/u);
  // Rows inside the frame are inset by the frame's own padding, not the gutter.
  for (const rule of ["bsMethodCaption", "bsSelectionSummary", "bsMethodMessage", "bsTableWrap"]) {
    assert.match(css, new RegExp(String.raw`\.${rule} \{[^}]*var\(--bs-method-pad\)`, "u"), rule);
  }
});
