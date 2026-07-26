import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, main] = await Promise.all([
  readFile(
    new URL("../ui/method_pages/berquist_sherman/berquist_sherman.html", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL("../ui/method_pages/berquist_sherman/berquist_sherman_main.js", import.meta.url),
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
  assert.match(main, /\["unadjusted", "pairs", "all"\]/u);
  assert.match(main, /\["case_column", "case_all", "paid_column", "paid_all", "user"\]/u);
  assert.match(main, /\["latest", "monotone", "user"\]/u);
  assert.match(main, /methodTab\.selected_adjustment = cloneMatrix/u);
  assert.match(main, /methodTab\.inflation_selection = state\.inflationSelection\.slice/u);
});
