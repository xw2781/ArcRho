import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  canonicalizeMacroContext,
  macroContextFingerprint,
} from "../ui/macro/macro_context_fingerprint.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Arcode routes its single full-file Run action from the current source", () => {
  const html = read("../ui/arcode/code-editor/index.html");
  const js = read("../ui/arcode/code-editor/index.js");
  const css = read("../ui/arcode/code-editor/code-editor.css");

  assert.match(html, /id="runBtn"[^>]*>Run</);
  assert.doesNotMatch(html, /id="runInArcRhoBtn"/);
  assert.match(js, /scriptingFetch\("\/scripting\/run-in-arcrho"/);
  assert.match(js, /JSON\.stringify\(\{[\s\S]*?\bsource,/);
  assert.match(js, /source_path:\s*currentPath/);
  assert.match(js, /function isArcRhoMacroSource\(code\)/);
  assert.match(js, /<arcrho-macro>/);
  assert.match(js, /run_macro/);
  assert.match(js, /runBtn"\)\?\.addEventListener\("click", \(\) => void runCurrentPython/);
  assert.match(js, /runSelectionBtn"\)\?\.addEventListener\("click", \(\) => void runPython/);
  assert.doesNotMatch(js, /runInArcRhoBtn/);
  assert.match(js, /scriptingFetch\("\/scripting\/run-stream"/);

  const classifierSource = js.match(/function isArcRhoMacroSource\(code\) \{[\s\S]*?\n\}/)?.[0] || "";
  const classify = Function(`${classifierSource}\nreturn isArcRhoMacroSource;`)();
  const maintainedMacro = read("../../python-api/macros/apply_growth_adjustments.py");
  assert.equal(classify(maintainedMacro), true);
  assert.equal(classify("def run_macro(active_dfm):\n    return active_dfm\n"), true);
  assert.equal(classify("print('ordinary local script')\n"), false);

  const toolbarRule = css.match(/\.ce-toolbar\s*\{([^}]*)\}/)?.[1] || "";
  const buttonRule = css.match(/\.ce-btn\s*\{([^}]*)\}/)?.[1] || "";
  assert.match(toolbarRule, /overflow-x:\s*auto/);
  assert.match(buttonRule, /flex:\s*0 0 auto/);
  assert.match(buttonRule, /min-width:\s*max-content/);
  assert.match(buttonRule, /white-space:\s*nowrap/);
});

test("ArcRho captures and reapplies an exact DFM target around source execution", () => {
  const automation = read("../ui/shell/ui_automation.js");
  const macro = read("../ui/macro/macro_window.js");
  const projectMessages = read("../ui/project_instance/project_instance_messages.js");

  assert.match(automation, /macro\.captureActiveDfmContext/);
  assert.match(automation, /macro\.reviewAndApplyResult/);
  assert.match(macro, /capturedExternalMacroTargets/);
  assert.match(macro, /fingerprint/);
  assert.match(macro, /changed while the macro was running/);
  assert.match(macro, /Macro review expired before the result could be applied/);
  assert.match(macro, /active_dfm will be None/);
  assert.match(projectMessages, /message\?\.targetWindowId/);
  assert.match(projectMessages, /findWindowByInstance\(targetWindowId\)/);
});

test("ArcRho macro validation ignores volatile timestamps but detects live DFM edits", () => {
  const initial = {
    activeJson: {
      "method metadata": { "last modified": "2026-07-22T12:00:00.000Z" },
      "ratios tab": { "ratio values": [[1.1, 1.2]], "cell notes": {} },
    },
    dirty: true,
    fields: { methodName: "Paid Ultimate", project: "Example" },
    methodPath: "E:\\ArcRho Server\\projects\\Example\\Paid Ultimate.json",
  };
  const recaptured = {
    ...initial,
    activeJson: {
      ...initial.activeJson,
      "method metadata": { "last modified": "2026-07-22T12:00:05.000Z" },
    },
    dirty: false,
    fields: { project: "Example", methodName: "Paid Ultimate" },
  };
  const edited = {
    ...recaptured,
    activeJson: {
      ...recaptured.activeJson,
      "ratios tab": { "ratio values": [[1.1, 1.2]], "cell notes": { Summary: { Paid: "Changed" } } },
    },
  };

  assert.equal(macroContextFingerprint(initial), macroContextFingerprint(recaptured));
  assert.notEqual(macroContextFingerprint(initial), macroContextFingerprint(edited));
  assert.equal(canonicalizeMacroContext(initial).activeJson["method metadata"]["last modified"], undefined);
  assert.equal(initial.activeJson["method metadata"]["last modified"], "2026-07-22T12:00:00.000Z");
});

test("standalone Arcode packages the first-party ArcRho API", () => {
  const spec = read("../build/arcode_server.spec");
  const fullRouter = read("../app_server/api/scripting_router.py");
  const arcodeRouter = read("../app_server/api/arcode_scripting_router.py");

  assert.match(spec, /python_api_src/);
  assert.match(spec, /collect_submodules\("arcrho_api"\)/);
  assert.match(fullRouter, /@router\.post\("\/scripting\/run-in-arcrho"\)/);
  assert.match(arcodeRouter, /@router\.post\("\/scripting\/run-in-arcrho"\)/);
});

test("packaged ArcRho server resolves the monorepo ArcRho API before collecting it", () => {
  const spec = read("../build/server.spec");
  const pathInsertion = spec.indexOf("sys.path.insert(0, str(python_api_src))");
  const submoduleCollection = spec.indexOf("collect_submodules('arcrho_api')");

  assert.ok(pathInsertion >= 0);
  assert.ok(submoduleCollection > pathInsertion);
});
