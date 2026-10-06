import assert from "node:assert/strict";
import test from "node:test";

import { getAssistantToolLabel } from "../ui/ai-assistant/tool-labels.js";

// A tool call in the work log is the tool name, its arguments as JSON, then its output.
const call = (tool, input, output) => [tool, JSON.stringify(input), ...(output ? [output] : [])].join("\n");

test("each ArcBot tool call reads in plain words, running and then done", () => {
  assert.equal(getAssistantToolLabel(call("arco_run_macro", { macro_id: "show_diagnostic_triangle" })),
    "Running the Show Diagnostic Triangle macro");
  assert.equal(getAssistantToolLabel(call("arco_run_macro", { macro_id: "show_diagnostic_triangle" }, "{\"success\":true}")),
    "Ran the Show Diagnostic Triangle macro");
  assert.equal(getAssistantToolLabel(call("arco_project_read", { kind: "catalog", arguments: {} }, "{}")),
    "Checked what project data ArcBot can read");
  assert.equal(getAssistantToolLabel(call("arco_project_read", { kind: "project_names", arguments: {} })),
    "Reading the list of projects on the server");
  assert.equal(getAssistantToolLabel(call("arco_project_read", { kind: "dataset_cache_load", arguments: { dataset_name: "CWOP as % of Reported Claims" } }, "{}")),
    "Read dataset \"CWOP as % of Reported Claims\"");
  assert.equal(getAssistantToolLabel(call("arco_project_read", {
    kind: "dfm_method_load",
    arguments: { project_name: "NJ_Annual_Prod_202605_Fake", reserving_class: "PA\\NJ\\BI", method_name: "C 22 - CWOP DFM" },
  }, "{}")), "Read DFM \"C 22 - CWOP DFM\" from NJ_Annual_Prod_202605_Fake");
  assert.equal(getAssistantToolLabel(call("arco_project_read", { kind: "dataset_index", arguments: { reserving_class: "PA\\NJ\\BI" } })),
    "Reading the datasets in BI");
});

test("chats saved under the old arcrho_ names keep their labels", () => {
  assert.equal(getAssistantToolLabel(call("arcrho_project_read", { kind: "project_names", arguments: {} }, "[]")),
    "Read the list of projects on the server");
});

test("a read kind without its own label is described from its name", () => {
  assert.equal(getAssistantToolLabel(call("arco_project_read", { kind: "loss_ratio_load", arguments: {} })),
    "Reading loss ratio");
});

test("a shell command or an unknown tool gets no label", () => {
  assert.equal(getAssistantToolLabel("powershell.exe -Command 'rg --files'"), "");
  assert.equal(getAssistantToolLabel(call("arco_unknown", {})), "");
});
