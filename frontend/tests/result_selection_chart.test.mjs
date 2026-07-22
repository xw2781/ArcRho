import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildResultSelectionChartSeries,
  canHideChartSeries,
  hiddenSeriesIdsAfterContextToggle,
} from "../ui/method_pages/result_selection/result_selection_chart.js";

const frontendRoot = new URL("../", import.meta.url);

test("Result Selection chart series follow Method source order and include selected output", () => {
  const series = buildResultSelectionChartSeries({
    sources: [
      { name: "Vector B", values: [20, "21", null] },
      { name: "Triangle A", values: [10, undefined, 12] },
    ],
    sourceIndexes: [1, 0],
    selectedUltimateValues: [15, 21, 18],
    selectedUltimateLabel: "Selected Loss",
    rowCount: 3,
  });

  assert.deepEqual(series.map((entry) => entry.id), ["source:triangle a", "source:vector b", "selected-ultimate"]);
  assert.deepEqual(series.map((entry) => entry.label), ["Triangle A", "Vector B", "Selected Loss"]);
  assert.deepEqual(series[0].values, [10, null, 12]);
  assert.deepEqual(series[1].values, [20, 21, null]);
  assert.deepEqual(series[2].values, [15, 21, 18]);
  assert.equal(series[2].emphasized, true);
});

test("Result Selection chart item context toggle isolates a line and then restores all lines", () => {
  const series = [
    { id: "source:paid" },
    { id: "source:incurred" },
    { id: "selected-ultimate" },
  ];
  const hidden = hiddenSeriesIdsAfterContextToggle(series, "selected-ultimate");

  assert.deepEqual([...hidden], ["source:paid", "source:incurred"]);

  const restored = hiddenSeriesIdsAfterContextToggle(series, "selected-ultimate", hidden);
  assert.deepEqual([...restored], []);
});

test("Result Selection chart keeps the final visible item checked", () => {
  const series = [
    { id: "source:paid" },
    { id: "source:incurred" },
    { id: "selected-ultimate" },
  ];

  assert.equal(canHideChartSeries(series, "selected-ultimate", ["source:paid", "source:incurred"]), false);
  assert.equal(canHideChartSeries(series, "source:incurred", ["source:paid"]), true);
});

test("Result Selection exposes Chart immediately after Method with a right-side visibility panel", async () => {
  const [html, chartSource] = await Promise.all([
    readFile(new URL("ui/method_pages/result_selection/result_selection.html", frontendRoot), "utf8"),
    readFile(new URL("ui/method_pages/result_selection/result_selection_chart.js", frontendRoot), "utf8"),
  ]);
  assert.match(html, /data-page="method"[\s\S]*data-page="chart"[\s\S]*data-page="results"/u);
  assert.match(html, /id="rsChartPage"[\s\S]*id="rsChartCanvas"[\s\S]*class="rsChartLegendPanel"[\s\S]*id="rsChartLegendList"/u);
  assert.match(chartSource, /item\.addEventListener\("contextmenu"/u);
});
