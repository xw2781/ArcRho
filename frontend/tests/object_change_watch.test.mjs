import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const watchSource = await readFile(
  new URL("../ui/shared/services/object_change_watch.js", import.meta.url),
  "utf8",
);
const {
  createMethodObjectChangeWatchController,
  createObjectChangeWatch,
  DEFAULT_POLL_INTERVAL_MS,
  OBJECT_CHANGE_FINGERPRINT_URL,
  OBJECT_UPDATED_MESSAGE,
  OBJECT_UPDATED_REFRESH_ACTION,
  OBJECT_UPDATED_TITLE,
  PROPAGATION_SCOPE_FINISHED_MESSAGE,
  PROPAGATION_SCOPE_STARTED_MESSAGE,
  showObjectUpdatedAlert,
  wireSamePropagationScopePause,
} = await import(
  `data:text/javascript;base64,${Buffer.from(watchSource).toString("base64")}`
);

const source = (relativePath) => readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");

function tokenResponse(token, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => ({ ok: true, token }) };
}

function drain() {
  return new Promise((resolve) => setImmediate(resolve));
}

function harness({ tokens }) {
  const queue = [...tokens];
  const requests = [];
  let intervalFn = null;
  let intervalCleared = false;
  const watchArgsBase = {
    identity: { kind: "dataset", name: "Paid Loss" },
    fetchImpl: (url, options) => {
      requests.push({ url, options });
      const next = queue.shift();
      if (next instanceof Error) return Promise.reject(next);
      if (typeof next === "function") return next();
      return Promise.resolve(tokenResponse(String(next)));
    },
    setIntervalImpl: (fn) => {
      intervalFn = fn;
      return 1;
    },
    clearIntervalImpl: () => {
      intervalCleared = true;
    },
  };
  return {
    watchArgsBase,
    requests,
    queue,
    tick: async () => {
      intervalFn?.();
      await drain();
    },
    wasCleared: () => intervalCleared,
  };
}

test("advisory message and endpoint constants stay canonical", () => {
  assert.equal(
    OBJECT_UPDATED_MESSAGE,
    "The dataset is updated by another user or external automation process "
      + "since last opened, please close and reopen to view the updated values.",
  );
  assert.equal(OBJECT_UPDATED_TITLE, "Updated Outside This Window");
  assert.equal(OBJECT_CHANGE_FINGERPRINT_URL, "/object_change/fingerprint");
  assert.ok(DEFAULT_POLL_INTERVAL_MS >= 1000);
});

test("first poll records the baseline; a moved fingerprint alerts exactly once and stops", async () => {
  const h = harness({ tokens: ["a", "a", "b", "c"] });
  let alerts = 0;
  const watch = createObjectChangeWatch({ ...h.watchArgsBase, onChange: () => { alerts += 1; } });
  watch.start();
  await drain();
  assert.equal(alerts, 0);
  await h.tick();
  assert.equal(alerts, 0);
  await h.tick();
  assert.equal(alerts, 1);
  assert.ok(h.wasCleared());
  assert.ok(watch.hasAlerted());
  await h.tick();
  assert.equal(alerts, 1);
  const posted = h.requests[0];
  assert.equal(posted.url, OBJECT_CHANGE_FINGERPRINT_URL);
  assert.equal(posted.options.method, "POST");
  assert.equal(JSON.parse(posted.options.body).name, "Paid Loss");
});

test("failed polls are skipped silently and never alert", async () => {
  const h = harness({
    tokens: ["a", new Error("network down"), () => Promise.resolve(tokenResponse("", false)), "a", "b"],
  });
  let alerts = 0;
  const watch = createObjectChangeWatch({ ...h.watchArgsBase, onChange: () => { alerts += 1; } });
  watch.start();
  await drain();
  await h.tick();
  await h.tick();
  await h.tick();
  assert.equal(alerts, 0);
  await h.tick();
  assert.equal(alerts, 1);
});

test("pause suppresses polling and resume rebases so a self-save is not reported", async () => {
  const h = harness({ tokens: ["a", "self-saved", "self-saved", "outside"] });
  let alerts = 0;
  const watch = createObjectChangeWatch({ ...h.watchArgsBase, onChange: () => { alerts += 1; } });
  watch.start();
  await drain();
  watch.pause();
  await h.tick();
  assert.equal(h.requests.length, 1);
  await watch.resume();
  await h.tick();
  assert.equal(alerts, 0);
  await h.tick();
  assert.equal(alerts, 1);
});

test("a rebase invalidates an in-flight poll result", async () => {
  let release = null;
  const h = harness({
    tokens: [
      "a",
      () => new Promise((resolve) => { release = () => resolve(tokenResponse("stale")); }),
      "rebased",
      "rebased",
    ],
  });
  let alerts = 0;
  const watch = createObjectChangeWatch({ ...h.watchArgsBase, onChange: () => { alerts += 1; } });
  watch.start();
  await drain();
  const inFlight = h.tick();
  await drain();
  await watch.rebase();
  release();
  await inFlight;
  assert.equal(alerts, 0);
  await h.tick();
  assert.equal(alerts, 0);
});

test("method controller starts once, rebases on same identity, recreates on rename", () => {
  const created = [];
  const controller = createMethodObjectChangeWatchController({
    methodType: "dfm",
    onChange: () => {},
    watchFactory: (options) => {
      const record = {
        identity: options.identity,
        started: 0,
        stopped: 0,
        rebased: 0,
        paused: 0,
        resumed: 0,
        start() { this.started += 1; },
        stop() { this.stopped += 1; },
        async rebase() { this.rebased += 1; },
        pause() { this.paused += 1; },
        async resume() { this.resumed += 1; },
      };
      created.push(record);
      return record;
    },
  });
  controller.ensure({ projectName: "P", reservingClass: "RC", methodName: "M", outputDataset: "M Out" });
  assert.equal(created.length, 1);
  assert.equal(created[0].started, 1);
  assert.equal(created[0].identity.method_type, "dfm");
  assert.equal(created[0].identity.output_dataset, "M Out");

  controller.ensure({ projectName: "P", reservingClass: "RC", methodName: "M", outputDataset: "M Out" });
  assert.equal(created.length, 1);
  assert.equal(created[0].rebased, 1);

  controller.ensure({ projectName: "P", reservingClass: "RC", methodName: "Renamed", outputDataset: "Renamed" });
  assert.equal(created.length, 2);
  assert.equal(created[0].stopped, 1);

  controller.pause();
  controller.resume();
  assert.equal(created[1].paused, 1);
  assert.equal(created[1].resumed, 1);

  controller.ensure({ projectName: "", reservingClass: "RC", methodName: "X" });
  assert.equal(created.length, 2);
});

test("dataset viewer and every propagation-saving method page wire the change alert", async () => {
  const surfaces = [
    ["ui/dataset_viewer/dataset_viewer_main.js", "createObjectChangeWatch"],
    ["ui/method_pages/dfm/dfm_persistence.js", "createMethodObjectChangeWatchController"],
    ["ui/method_pages/bornhuetter_ferguson/bornhuetter_ferguson_main.js", "createMethodObjectChangeWatchController"],
    ["ui/method_pages/cape_cod/cape_cod_main.js", "createMethodObjectChangeWatchController"],
    ["ui/method_pages/result_selection/result_selection_main.js", "createMethodObjectChangeWatchController"],
  ];
  for (const [path, factory] of surfaces) {
    const text = await source(path);
    assert.match(text, /object_change_watch\.js/, path);
    assert.ok(text.includes(factory), `${path} uses ${factory}`);
    assert.ok(text.includes("showObjectUpdatedAlert"), `${path} shows the shared refreshable alert`);
  }
  const model = await source("ui/method_pages/result_selection/result_selection_model.js");
  assert.ok(model.includes("rsWatch.pause()"), "RS save pauses the watch");
  assert.ok(model.includes("rsWatch.resume()"), "RS save resumes the watch");
});

test("the updated-object alert offers a refresh action that reloads only clean windows", async () => {
  let reloads = 0;
  let blocked = 0;
  const boxes = [];
  const showMessageBox = (options) => {
    boxes.push(options);
    return Promise.resolve(OBJECT_UPDATED_REFRESH_ACTION);
  };
  await showObjectUpdatedAlert({
    showMessageBox,
    isDirty: () => false,
    onBlockedRefresh: () => { blocked += 1; },
    reloadImpl: () => { reloads += 1; },
  });
  assert.equal(reloads, 1);
  assert.equal(boxes[0].message, OBJECT_UPDATED_MESSAGE);
  assert.equal(boxes[0].title, OBJECT_UPDATED_TITLE);
  assert.equal(boxes[0].actions[0].id, OBJECT_UPDATED_REFRESH_ACTION);

  await showObjectUpdatedAlert({
    showMessageBox,
    isDirty: () => true,
    onBlockedRefresh: () => { blocked += 1; },
    reloadImpl: () => { reloads += 1; },
  });
  assert.equal(reloads, 1);
  assert.equal(blocked, 1);

  await showObjectUpdatedAlert({
    showMessageBox: () => Promise.resolve(undefined),
    reloadImpl: () => { reloads += 1; },
  });
  assert.equal(reloads, 1);
});

test("a same-app propagation job pauses the watch for its scope and resumes on finish", () => {
  const listeners = new Set();
  const windowRef = {
    addEventListener: (_type, fn) => listeners.add(fn),
    removeEventListener: (_type, fn) => listeners.delete(fn),
  };
  const emit = (data) => { for (const fn of Array.from(listeners)) fn({ data }); };
  const watch = {
    paused: 0,
    resumed: 0,
    pause() { this.paused += 1; },
    async resume() { this.resumed += 1; },
  };
  const timers = [];
  const dispose = wireSamePropagationScopePause({
    watch,
    getProject: () => "COL Project",
    getReservingClass: () => "HPPREF\\HO+DF\\NJ",
    windowRef,
    setTimeoutImpl: (fn) => { timers.push(fn); return timers.length; },
    clearTimeoutImpl: () => {},
  });

  emit({ type: PROPAGATION_SCOPE_STARTED_MESSAGE, project: "Other", reservingClass: "X", jobId: "j0" });
  assert.equal(watch.paused, 0);

  emit({ type: PROPAGATION_SCOPE_STARTED_MESSAGE, project: "col project", reservingClass: "hppref\\ho+df\\nj", jobId: "j1" });
  assert.equal(watch.paused, 1);
  emit({ type: PROPAGATION_SCOPE_STARTED_MESSAGE, project: "col project", reservingClass: "hppref\\ho+df\\nj", jobId: "j1" });
  assert.equal(watch.paused, 1);

  emit({ type: PROPAGATION_SCOPE_FINISHED_MESSAGE, jobId: "j1" });
  assert.equal(watch.resumed, 1);
  emit({ type: PROPAGATION_SCOPE_FINISHED_MESSAGE, jobId: "j1" });
  assert.equal(watch.resumed, 1);

  emit({ type: PROPAGATION_SCOPE_STARTED_MESSAGE, project: "COL Project", reservingClass: "HPPREF\\HO+DF\\NJ", jobId: "j2" });
  assert.equal(watch.paused, 2);
  timers.at(-1)();
  assert.equal(watch.resumed, 2, "the failsafe timer resumes a watch whose finish broadcast never arrived");

  dispose();
  emit({ type: PROPAGATION_SCOPE_STARTED_MESSAGE, project: "COL Project", reservingClass: "HPPREF\\HO+DF\\NJ", jobId: "j3" });
  assert.equal(watch.paused, 2);
});

test("Project Instance defers the dependency-source clear until the propagation job ends", async () => {
  const piSource = await source("ui/project_instance/project_instance_messages.js");
  assert.ok(piSource.includes("deferDependencyClearUntilPropagation(msg, event.source)"));
  assert.ok(piSource.includes("waitForDependentPropagationOutcome(jobId)"));
  assert.ok(piSource.includes("PROPAGATION_SCOPE_STARTED_MESSAGE"));
  assert.ok(piSource.includes("PROPAGATION_SCOPE_FINISHED_MESSAGE"));
  assert.match(piSource, /propagationJobId: ""/u, "the relayed cleared message never re-carries the job id");
  assert.ok(
    piSource.includes("pendingDependencyClearSourceCounts.get(sourceKey) > 0) return"),
    "a job-less cleared duplicate is swallowed while the same source has a deferral pending "
      + "(save flows fire more than one clean transition; only the first carries the job id)",
  );

  const producers = [
    ["ui/method_pages/dfm/dfm_tabs_orchestrator.js", "consumePendingDfmPropagationJobId()"],
    ["ui/method_pages/result_selection/result_selection_ui.js", "state.pendingPropagationJobId"],
    ["ui/method_pages/berquist_sherman/berquist_sherman_main.js", "pendingBsPropagationJobId"],
  ];
  for (const [path, marker] of producers) {
    const text = await source(path);
    assert.ok(text.includes("propagationJobId"), `${path} attaches the job id`);
    assert.ok(text.includes(marker), `${path} consumes its pending job id`);
  }

  const watchedPages = [
    "ui/dataset_viewer/dataset_viewer_main.js",
    "ui/method_pages/dfm/dfm_persistence.js",
    "ui/method_pages/bornhuetter_ferguson/bornhuetter_ferguson_main.js",
    "ui/method_pages/cape_cod/cape_cod_main.js",
    "ui/method_pages/result_selection/result_selection_main.js",
  ];
  for (const path of watchedPages) {
    const text = await source(path);
    assert.ok(text.includes("wireSamePropagationScopePause"), `${path} pauses during same-app jobs`);
    assert.ok(text.includes("showObjectUpdatedAlert"), `${path} uses the refreshable alert`);
  }
});

test("the shared data tab reports mutation boundaries and durable state through the port", async () => {
  const runController = await source("ui/shared/dataset/dataset_run_controller.js");
  assert.ok(runController.includes("notifyDataTabDurableDatasetState({ source: \"load\" })"));
  assert.ok(runController.includes("notifyDataTabDatasetMutationStarted({ source: \"patch\" })"));
  assert.ok(runController.includes("notifyDataTabDatasetMutationStarted({ source: \"run\" })"));
  const persistence = await source("ui/shared/tabs/data/data_tab_persistence_controller.js");
  assert.ok(persistence.includes("withDataTabDatasetMutation({ source: \"sidecar-save\" }"));
  assert.ok(persistence.includes("notifyDataTabDurableDatasetState({ source: \"sidecar-save\" })"));
});
