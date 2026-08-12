import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const toDataUrl = (source) => (
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);

const helperSource = await readFile(
  new URL("../ui/method_pages/berquist_sherman/calculation_helpers.js", import.meta.url),
  "utf8",
);
const helperUrl = toDataUrl(helperSource);
const helpers = await import(helperUrl);

async function loadCalculationModule(filename) {
  const source = await readFile(
    new URL(`../ui/method_pages/berquist_sherman/${filename}`, import.meta.url),
    "utf8",
  );
  return import(toDataUrl(source.replace("./calculation_helpers.js", helperUrl)));
}

const settlementRate = await loadCalculationModule(
  "settlement_rate_calculation.js",
);
const caseReserveAdequacy = await loadCalculationModule(
  "case_reserve_adequacy_calculation.js",
);
const fixture = JSON.parse(await readFile(
  new URL("./fixtures/berquist_sherman_col_golden.json", import.meta.url),
  "utf8",
));

function assertClose(actual, expected, path = "value") {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${path} must be an array`);
    assert.equal(actual.length, expected.length, `${path} length`);
    expected.forEach((value, index) => {
      assertClose(actual[index], value, `${path}[${index}]`);
    });
    return;
  }
  if (expected === null) {
    assert.equal(actual, null, path);
    return;
  }
  assert.ok(Number.isFinite(actual), `${path} must be finite`);
  const tolerance = Math.max(1e-9, Math.abs(expected) * 1e-11);
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${path}: expected ${expected}, received ${actual}`,
  );
}

test("annual B&S triangles mask structural lower-right zero padding", () => {
  assert.deepEqual(
    helpers.normalizeAnnualTriangle([
      [100, 200, 300],
      [400, 0, 0],
      [0, 0, 0],
    ]),
    [
      [100, 200, 300],
      [400, 0],
      [0],
    ],
  );
});

test("annual B&S triangles honor the Dataset Viewer mask without hiding real zeroes", () => {
  assert.deepEqual(
    helpers.normalizeAnnualTriangle(
      [
        [0, 20, 30],
        [40, 50, 0],
        [60, 0, 0],
      ],
      [
        [true, false, true],
        [true, true, false],
        [true, false, false],
      ],
    ),
    [
      [0, null, 30],
      [40, 50],
      [60],
    ],
  );
});

test("settlement-rate calculation reproduces the annual COL ResQ object", () => {
  const source = fixture.settlementRate;
  const result = settlementRate.calculateSettlementRate(source.input);

  assert.strictEqual(result.output, result.adjustedPaidClaims);
  [
    "proportionSettled",
    "selectedClaimNumbers",
    "pairsAdjustment",
    "allAdjustment",
    "loessAdjustment",
    "adjustedPaidClaims",
  ].forEach((name) => assertClose(result[name], source.expected[name], name));
});

test("settlement-rate loess selections reproduce the COL loess estimates per cell", () => {
  const source = fixture.settlementRate;
  const result = settlementRate.calculateSettlementRate({
    ...source.input,
    selectedAdjustment: source.input.selectedAdjustment.map((row) => row.map(() => "loess")),
  });

  assert.equal(result.loessSpan, source.input.loessSpan);
  assertClose(result.adjustedPaidClaims, source.expected.loessAdjustment, "loess output");
});

test("settlement-rate loess uses the default span and reverts to pairs when the fit fails", () => {
  const source = fixture.settlementRate;
  const defaultSpanResult = settlementRate.calculateSettlementRate({
    ...source.input,
    loessSpan: undefined,
  });
  assert.equal(defaultSpanResult.loessSpan, 7);
  assertClose(
    defaultSpanResult.loessAdjustment,
    source.expected.loessAdjustment,
    "default span loess",
  );

  // Two populated points leave a single non-zero tri-cube weight, so the
  // degenerate loess fit must fall back to the pair-wise interpolation.
  assertClose(
    defaultSpanResult.loessAdjustment[8],
    source.expected.pairsAdjustment[8],
    "loess pairs fallback",
  );
});

test("settlement-rate defaults use the leading diagonal and preserve a one-point row", () => {
  const result = settlementRate.calculateSettlementRate({
    paidClaims: [[100, 400, 900], [40]],
    closedClaimNumbers: [[10, 20, 20], [5]],
    ultimateClaimNumbers: [20, 10],
    selectedProportionIsDefault: [true, true, true],
  });

  assert.deepEqual(result.selectedProportionSettled, [0.5, 1, 1]);
  assert.equal(result.pairsAdjustment[0][2], 600);
  assert.equal(result.selectedAdjustment[1][0], "unadjusted");
  assert.equal(result.adjustedPaidClaims[1][0], 40);
});

test("settlement-rate duplicate closed counts use the pair geometric mean", () => {
  const result = settlementRate.calculateSettlementRate({
    paidClaims: [[25, 100, 400]],
    closedClaimNumbers: [[5, 10, 10]],
    ultimateClaimNumbers: [10],
    selectedProportionSettled: [1, 1, 1],
    selectedAdjustment: [["pairs", "pairs", "pairs"]],
  });

  assertClose(result.pairsAdjustment[0][2], 200, "duplicate pair estimate");
});

test("case-reserve adequacy calculation reproduces the annual COL ResQ object", () => {
  const source = fixture.caseReserveAdequacy;
  const result = caseReserveAdequacy.calculateCaseReserveAdequacy(source.input);

  assert.strictEqual(result.output, result.adjustedIncurredClaims);
  [
    "openClaimNumbers",
    "caseReserves",
    "averageCaseReserves",
    "averagePaidClaims",
    "caseInflationByColumn",
    "caseInflationOverall",
    "paidInflationByColumn",
    "paidInflationOverall",
    "selectedInflation",
    "latestAverageCaseReserves",
    "monotoneAverageCaseReserves",
    "selectedAverageCaseReserves",
    "adjustedAverageCaseReserves",
    "adjustedIncurredClaims",
  ].forEach((name) => assertClose(result[name], source.expected[name], name));
});

test("COL CRA exclusion flags are safely deferred because they do not change the result", () => {
  const source = fixture.caseReserveAdequacy;
  const cases = [
    ["neither", [], []],
    ["case only", source.input.avgCaseReserveExclusions, []],
    ["paid only", [], source.input.avgPaidClaimsExclusions],
    [
      "both",
      source.input.avgCaseReserveExclusions,
      source.input.avgPaidClaimsExclusions,
    ],
  ];
  for (const [label, avgCaseReserveExclusions, avgPaidClaimsExclusions] of cases) {
    const result = caseReserveAdequacy.calculateCaseReserveAdequacy({
      ...source.input,
      avgCaseReserveExclusions,
      avgPaidClaimsExclusions,
    });
    assertClose(
      result.paidInflationOverall,
      source.expected.paidInflationOverall,
      `${label}.paidInflationOverall`,
    );
    assertClose(
      result.selectedInflation,
      source.expected.selectedInflation,
      `${label}.selectedInflation`,
    );
    assertClose(
      result.output,
      source.expected.adjustedIncurredClaims,
      `${label}.adjustedIncurredClaims`,
    );
  }
});

// Two independent ResQ "Avg. Selections" tabs pin the loess average case
// reserves. The values are read off a triangle whose latest average case
// reserves are the `latest` vector below, so the test drives the estimator
// through a triangle that reproduces exactly that diagonal.
function triangleWithLatestAverageCaseReserves(latest) {
  // Average case reserve = (incurred - paid) / (reported - closed), and one
  // open claim per cell makes the latest diagonal the requested vector.
  const count = latest.length;
  const rows = Array.from({ length: count }, (_, rowIndex) => count - rowIndex);
  return {
    reportedClaimNumbers: rows.map((width) => Array(width).fill(2)),
    closedClaimNumbers: rows.map((width) => Array(width).fill(1)),
    paidClaims: rows.map((width) => Array(width).fill(0)),
    incurredClaims: rows.map((width, rowIndex) => (
      Array.from({ length: width }, (_, columnIndex) => (
        // The latest diagonal of a column is its last populated row.
        rowIndex === count - columnIndex - 1 ? latest[columnIndex] : 1
      ))
    )),
  };
}

test("case-reserve adequacy loess reproduces the ResQ current average case reserves", () => {
  const documented = caseReserveAdequacy.calculateCaseReserveAdequacy({
    ...triangleWithLatestAverageCaseReserves([838.36, 454.033, 557.75, 622, 0, 0]),
    loessSpan: 7,
  });
  assert.equal(documented.loessSpan, 7);
  assert.deepEqual(
    documented.latestAverageCaseReserves,
    [838.36, 454.033, 557.75, 622, 0, 0],
  );
  assert.deepEqual(
    documented.loessAverageCaseReserves.map((value) => Number(value.toFixed(3))),
    [779.906, 593.765, 546.45, 626.727, 702.698, 776.541],
  );

  // The COL "Gross Loss--Paid" method leaves only three positive averages, and
  // ResQ reports 0.000 across the row rather than interpolating between two.
  const sparse = caseReserveAdequacy.calculateCaseReserveAdequacy({
    ...triangleWithLatestAverageCaseReserves([2.315, 0, 0, 120.966, 0, 0, 0, 0, 0, 1.143]),
    loessSpan: 7,
  });
  assert.deepEqual(sparse.loessAverageCaseReserves, Array(10).fill(0));
  // Monotone regression still carries its blocks forward, as ResQ shows.
  assert.deepEqual(
    sparse.monotoneAverageCaseReserves.map((value) => Number(value.toFixed(3))),
    [2.315, 2.315, 2.315, 61.054, 61.054, 61.054, 61.054, 61.054, 61.054, 61.054],
  );
});

test("case-reserve adequacy selects the loess average case reserves", () => {
  const developmentCount = 6;
  const result = caseReserveAdequacy.calculateCaseReserveAdequacy({
    ...triangleWithLatestAverageCaseReserves([838.36, 454.033, 557.75, 622, 0, 0]),
    loessSpan: 7,
    averageCaseReserveSelection: Array(developmentCount).fill("loess"),
    inflationSelection: Array(developmentCount).fill("user"),
    userInflation: Array(developmentCount).fill(0),
  });

  assert.deepEqual(
    result.selectedAverageCaseReserves,
    result.loessAverageCaseReserves,
  );
});

test("case-reserve adequacy supports semantic estimator selections", () => {
  const common = {
    reportedClaimNumbers: [[20, 40], [30]],
    closedClaimNumbers: [[10, 20], [15]],
    incurredClaims: [[300, 700], [600]],
    paidClaims: [[100, 300], [200]],
    inflationSelection: ["user", "case_column"],
    userInflation: [0.1, 0],
    averageCaseReserveSelection: ["user", "latest"],
    userAverageCaseReserves: [50, 0],
  };
  const result = caseReserveAdequacy.calculateCaseReserveAdequacy(common);

  assert.deepEqual(result.selectedInflation, [0.1, 0]);
  assert.deepEqual(result.selectedAverageCaseReserves, [50, 20]);
  assert.deepEqual(result.adjustedAverageCaseReserves, [[50 / 1.1, 20], [50]]);
  assert.deepEqual(result.adjustedIncurredClaims, [
    [100 + (50 / 1.1) * 10, 300 + 20 * 20],
    [200 + 50 * 15],
  ]);
});
