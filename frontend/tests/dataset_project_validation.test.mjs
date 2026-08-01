import assert from "node:assert/strict";
import test from "node:test";

import { registerDataTabInputsController } from "../ui/shared/tabs/data/data_tab_inputs_controller.js";

function createRuntime(loadResult) {
  const projectInput = {
    value: "Project Alpha",
    setCustomValidity() {},
    reportValidity() {},
  };
  const originalDocument = globalThis.document;
  globalThis.document = {
    getElementById(id) {
      return id === "projectSelect" ? projectInput : null;
    },
  };

  const runtime = {
    state: {},
    workflowId: "",
    DEFAULT_TOKEN: "__DEFAULT__",
    allProjects: [],
    lastProjectSelection: "",
    getResolvedProjectValue: () => projectInput.value,
    loadProjectsDropdown: async () => {
      if (loadResult.ok) runtime.allProjects = loadResult.projects.slice();
      return loadResult;
    },
    isInputDefaultBound: () => false,
    clearInputInvalid: () => {},
  };
  registerDataTabInputsController(runtime);
  return {
    projectInput,
    runtime,
    restore() {
      globalThis.document = originalDocument;
    },
  };
}

test("on-demand project validation preserves a Project Instance dataset selection", async () => {
  const fixture = createRuntime({
    ok: true,
    projects: ["Project Alpha", "Project Beta"],
  });
  try {
    assert.equal(await fixture.runtime.ensureProjectValidationOptions(), true);
    assert.deepEqual(
      fixture.runtime.validateAndNormalizeProjectInput({ strict: true, showMessage: true }),
      { ok: true, value: "Project Alpha" },
    );
    assert.equal(fixture.projectInput.value, "Project Alpha");
  } finally {
    fixture.restore();
  }
});

test("failed on-demand project loading does not erase the current selection", async () => {
  const fixture = createRuntime({ ok: false, projects: [] });
  try {
    assert.equal(await fixture.runtime.ensureProjectValidationOptions(), false);
    assert.equal(fixture.projectInput.value, "Project Alpha");
  } finally {
    fixture.restore();
  }
});
