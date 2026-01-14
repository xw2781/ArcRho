// Entry point: orchestrates load/save/toggle and wires events.

import { state } from "./state.js";
import { config } from "./config.js";
import { $ , logLine } from "./dom.js";
import { getDataset, patchDataset } from "./api.js";
import { parseFormulaInput } from "./formula.js";
import { renderTable, renderActiveCellUI, renderChart } from "./render.js";

async function loadDataset() {
  state.dirty.clear();

  const { ok, status, data } = await getDataset(config.DS_ID, config.START_YEAR);

  if (!ok) {
    logLine(`ERROR loading dataset: ${status}`);
    $("tableWrap").innerHTML = `<div style="color:#b00;"><b>Load failed:</b> ${status}</div>`;
    return;
  }

  state.model = data;
  state.fileMtime = data.mtime;

  renderTable();

  $("dsMeta").textContent =
    `id=${data.id} | origins=${data.origin_labels.length} | dev=${data.dev_labels.length} | mtime=${data.mtime}`;

  logLine("Loaded dataset");
}

async function savePatch() {
  if (state.dirty.size === 0) {
    logLine("No changes to save.");
    return;
  }

  const items = [];
  for (const [key, value] of state.dirty.entries()) {
    const [r, c] = key.split(",").map((x) => parseInt(x, 10));
    items.push({ r, c, value });
  }

  const { status, data } = await patchDataset(items, state.fileMtime, config.DS_ID);

  if (status === 409) {
    logLine("Conflict: file changed on disk. Reload first.");
    return;
  }

  logLine(`Saved patch: applied=${data.applied}, rejected=${(data.rejected || []).length}, new_mtime=${data.mtime}`);
  await loadDataset();
}

function toggleBlanks() {
  state.showBlanks = !state.showBlanks;
  $("toggleBlankBtn").textContent = state.showBlanks ? "Hide blanks" : "Show blanks";
  renderTable(); // re-render only, no reload
}

function wireEvents() {
  $("reloadBtn").addEventListener("click", loadDataset);
  $("saveBtn").addEventListener("click", savePatch);
  $("toggleBlankBtn").addEventListener("click", toggleBlanks);

  $("formulaBar").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (!state.activeCell) return;

  const { r, c } = state.activeCell;
  const key = `${r},${c}`;

  const parsed = parseFormulaInput($("formulaBar").value);
  if (!parsed.ok) {
    logLine(parsed.error);
    return;
  }

  state.dirty.set(key, parsed.value);
  logLine(`Set ${key} = ${parsed.value === null ? "null" : parsed.value}`);

  // re-render so the grid shows formatted value + keep highlight
  renderTable();
  renderActiveCellUI();
  });

  window.addEventListener("resize", () => {
    renderChart();
  });

}

wireEvents();
loadDataset();
