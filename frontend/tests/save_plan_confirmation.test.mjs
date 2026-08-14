// Step one of the two-step save, in the UI: the user sees what a save would
// refresh and decides, before anything reaches the network drive.
//
// The behaviour that matters here is what happens when the user says no, or
// says nothing: a cancelled or failed plan must leave the save unsent, and a
// dialog dismissed with Escape must never read as approval.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const frontendRoot = new URL("../", import.meta.url);

async function source(relativePath) {
  return readFile(new URL(relativePath, frontendRoot), "utf8");
}

// The runtime module loads the message box from the app-server URL space,
// which Node cannot resolve, so the real source is imported with that one
// specifier rewritten to a recording stub.
async function importSavePlan(answer = undefined) {
  const calls = [];
  const stub = `
    export const calls = ${JSON.stringify([])};
    export async function showPageMessageBox(options) {
      globalThis.__savePlanDialogCalls.push(options);
      return globalThis.__savePlanDialogAnswer;
    }
  `;
  globalThis.__savePlanDialogCalls = calls;
  globalThis.__savePlanDialogAnswer = answer;
  const text = (await source("ui/shared/services/save_plan.js")).replace(
    /"\/ui\/shared\/components\/message_box\/message_box\.js\?v=[0-9a-z]+"/u,
    JSON.stringify(`data:text/javascript,${encodeURIComponent(stub)}`),
  );
  const module = await import(`data:text/javascript,${encodeURIComponent(text)}`);
  return { module, calls };
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

const PLAN = {
  ok: true,
  fingerprint: "fp-1",
  dependent_count: 2,
  dependents: [
    { dataset_name: "Paid DFM", kind: "DFM" },
    { dataset_name: "Ultimate Loss", kind: "Calculated dataset" },
  ],
};

test("a save that reaches nothing is not worth a dialog", async () => {
  const { module, calls } = await importSavePlan();
  const decision = await module.planAndConfirmSave({
    saveUrl: "/dataset/sidecar/save",
    payload: { dataset_name: "Paid" },
    fetchImpl: async () => jsonResponse({ ok: true, fingerprint: "fp-0", dependent_count: 0, dependents: [] }),
  });

  assert.equal(decision.proceed, true);
  assert.equal(decision.fingerprint, "fp-0");
  assert.equal(calls.length, 0);
});

test("the plan is posted to the save endpoint's own plan sibling", async () => {
  const { module } = await importSavePlan("confirm");
  const seen = [];
  await module.planAndConfirmSave({
    saveUrl: "/cape-cod/save",
    payload: { project_name: "Demo" },
    fetchImpl: async (url, init) => {
      seen.push([url, JSON.parse(init.body)]);
      return jsonResponse(PLAN);
    },
  });

  assert.deepEqual(seen, [["/cape-cod/save/plan", { project_name: "Demo" }]]);
});

test("confirming carries the reviewed fingerprint into the save", async () => {
  const { module, calls } = await importSavePlan("confirm");
  const decision = await module.planAndConfirmSave({
    saveUrl: "/dataset/sidecar/save",
    payload: {},
    subject: "this dataset",
    fetchImpl: async () => jsonResponse(PLAN),
  });

  assert.equal(decision.proceed, true);
  assert.equal(decision.confirmed, true);
  assert.equal(decision.fingerprint, "fp-1");
  assert.equal(calls.length, 1);
  assert.match(calls[0].message, /Paid DFM {2}\(DFM\)/u);
  assert.match(calls[0].message, /Ultimate Loss {2}\(Calculated dataset\)/u);
  assert.match(calls[0].message, /Nothing has been saved yet/u);
});

test("Escape and the close button cancel the save instead of approving it", async () => {
  // The message box resolves undefined for OK, Escape, the close button and a
  // backdrop click alike, so the confirming button must be an action and
  // Cancel must be the box's own OK.
  const { module, calls } = await importSavePlan(undefined);
  const decision = await module.planAndConfirmSave({
    saveUrl: "/dataset/sidecar/save",
    payload: {},
    fetchImpl: async () => jsonResponse(PLAN),
  });

  assert.equal(decision.proceed, false);
  assert.equal(decision.cancelled, true);
  assert.equal(calls[0].okLabel, "Cancel");
  assert.deepEqual(calls[0].actions, [{ id: "confirm", label: "Save and update" }]);
});

test("a refused plan blocks the save and reports why", async () => {
  const { module, calls } = await importSavePlan("confirm");
  const decision = await module.planAndConfirmSave({
    saveUrl: "/dfm/method/save",
    payload: {},
    fetchImpl: async () => jsonResponse(
      { detail: "Dependent updates are currently running for this reserving class." },
      { ok: false, status: 423 },
    ),
  });

  assert.equal(decision.proceed, false);
  assert.equal(decision.failed, true);
  assert.equal(decision.error.status, 423);
  assert.match(decision.message, /currently running/u);
  assert.equal(calls.length, 0, "a refused plan must not open a dialog");
});

test("pages with their own API layer plan through it", async () => {
  const { module } = await importSavePlan("confirm");
  let planned = 0;
  const decision = await module.planAndConfirmSave({
    requestPlan: async () => {
      planned += 1;
      return PLAN;
    },
    subject: "this DFM",
  });

  assert.equal(planned, 1);
  assert.equal(decision.proceed, true);
  assert.equal(decision.fingerprint, "fp-1");
});

test("the dialog counts the names it could not list instead of dropping them", async () => {
  const { module } = await importSavePlan();
  const dependents = Array.from({ length: 40 }, (_, index) => ({
    dataset_name: `Dataset ${index}`,
    kind: "Calculated dataset",
  }));
  const message = module.describeSavePlan({ dependents }, { subject: "this dataset" });

  assert.match(message, /can refresh 40 dependent objects/u);
  assert.match(message, /\.\.\.and 15 more/u);
  assert.equal(message.includes("Dataset 39"), false);
});

test("one dependent reads as singular", async () => {
  const { module } = await importSavePlan();
  const message = module.describeSavePlan(
    { dependents: [{ dataset_name: "Paid DFM", kind: "DFM" }] },
    { subject: "this dataset" },
  );
  assert.match(message, /can refresh 1 dependent object:/u);
});

test("the dialog is shown with the saving spinner dropped", async () => {
  const { module } = await importSavePlan("confirm");
  const order = [];
  await module.planAndConfirmSave({
    requestPlan: async () => PLAN,
    showDialog: async (work) => {
      order.push("spinner down");
      const answer = await work();
      order.push("spinner up");
      return answer;
    },
  });

  // The busy overlay paints above the message box, so a dialog raised with
  // the spinner still up would be invisible.
  assert.deepEqual(order, ["spinner down", "spinner up"]);
});

// Every editor window that saves an ArcRho object plans first, sends the
// reviewed fingerprint, and treats a cancellation as the user's answer.
const SAVE_SURFACES = [
  { label: "Dataset", path: "ui/shared/tabs/data/data_tab_persistence_controller.js" },
  { label: "DFM", path: "ui/method_pages/dfm/dfm_persistence.js" },
  { label: "Cape Cod", path: "ui/method_pages/cape_cod/cape_cod_main.js" },
  { label: "Bornhuetter Ferguson", path: "ui/method_pages/bornhuetter_ferguson/bornhuetter_ferguson_main.js" },
  { label: "Result Selection", path: "ui/method_pages/result_selection/result_selection_model.js" },
  { label: "Berquist Sherman", path: "ui/method_pages/berquist_sherman/berquist_sherman_main.js" },
];

test("every save surface plans before it writes and passes the fingerprint on", async () => {
  for (const surface of SAVE_SURFACES) {
    const text = await source(surface.path);
    assert.match(text, /planAndConfirmSave\(/u, `${surface.label} does not plan its save`);
    assert.match(
      text,
      /plan_fingerprint: decision\.fingerprint|plan_fingerprint: String\(planFingerprint/u,
      `${surface.label} does not send the reviewed fingerprint`,
    );
    assert.match(
      text,
      /if \(!decision\.proceed\)/u,
      `${surface.label} does not stop when the user cancels`,
    );
    assert.match(
      text,
      /cancelled: !!decision\.cancelled/u,
      `${surface.label} does not report a cancellation as the user's answer`,
    );
  }
});

test("the Berquist Sherman plan runs before its method and CSV writes", async () => {
  const file = await source("ui/method_pages/berquist_sherman/berquist_sherman_main.js");
  const start = file.indexOf("async function runBerquistShermanSave(");
  assert.ok(start > 0, "the save entry point was renamed");
  const text = file.slice(start, file.indexOf("\nfunction requestConfirmedClose(", start));
  const planIndex = text.indexOf("planAndConfirmSave(");
  const jsonWriteIndex = text.indexOf("await hostApi.saveJsonFile({");
  const csvWriteIndex = text.indexOf("await hostApi.saveTextFile({");

  assert.ok(planIndex > 0 && jsonWriteIndex > 0 && csvWriteIndex > 0);
  // This window writes the method JSON and the CSV itself before the sidecar
  // save, so a plan placed next to the sidecar write would leave both files
  // behind on a cancelled save.
  assert.ok(planIndex < jsonWriteIndex, "the plan must precede the method JSON write");
  assert.ok(planIndex < csvWriteIndex, "the plan must precede the CSV write");
});
