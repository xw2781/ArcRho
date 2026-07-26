import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  canHideChartLegendSeries,
  hiddenChartSeriesIdsAfterContextToggle,
} from "../ui/shared/components/chart_legend/chart_legend.js";

const frontendRoot = new URL("../", import.meta.url);

test("shared chart legend keeps one series visible and toggles isolation", () => {
  const series = [{ id: 0 }, { id: 1 }, { id: 2 }];
  assert.equal(canHideChartLegendSeries(series, 2, [0, 1]), false);
  assert.deepEqual([...hiddenChartSeriesIdsAfterContextToggle(series, 1)], [0, 2]);
  assert.deepEqual([...hiddenChartSeriesIdsAfterContextToggle(series, 1, [0, 2])], []);
});

test("Dataset Viewer uses the shared Result Selection chart legend panel and behavior", async () => {
  const [view, renderer, css] = await Promise.all([
    readFile(new URL("ui/dataset_viewer/dataset_viewer_view.js", frontendRoot), "utf8"),
    readFile(new URL("ui/dataset_viewer/tabs/dataset_chart_renderer.js", frontendRoot), "utf8"),
    readFile(new URL("ui/shared/components/chart_legend/chart_legend.css", frontendRoot), "utf8"),
  ]);
  assert.match(
    view,
    /class="arChartLegendPanel"[\s\S]*id="devChartLegendCount"[\s\S]*id="devChartLegend"/u,
  );
  assert.doesNotMatch(view, /Click to show or hide|arChartLegendHint/u);
  assert.match(renderer, /renderChartLegend\(\{/u);
  assert.match(css, /\.arChartLegendItem:focus-within[\s\S]*\.arChartLegendSwatch::after/u);
});
