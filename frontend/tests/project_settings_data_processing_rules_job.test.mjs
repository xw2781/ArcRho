import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const moduleSource = await readFile(
  new URL("../ui/project_settings/project_settings_data_processing_rules_job.js", import.meta.url),
  "utf8",
);
const rulesFeatureSource = await readFile(
  new URL("../ui/project_settings/project_settings_data_processing_rules.js", import.meta.url),
  "utf8",
);
const coordinatorSource = await readFile(
  new URL("../ui/project_settings/project_settings.js", import.meta.url),
  "utf8",
);
const {
  createDataProcessingRulesRequestId,
  dataProcessingRulesJobStatusUrl,
  waitForDataProcessingRulesJob,
} = await import(
  `data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`
);

function response(body, status = 200) {
  const raw = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => raw,
  };
}

function statusPayload(status, overrides = {}) {
  return {
    ok: true,
    job_id: "psrules_1",
    found: true,
    busy: status === "queued" || status === "processing",
    contract_version: 1,
    status,
    updated_at: "2026-09-05T00:00:00+00:00",
    request_id: "psrules_1",
    progress: { stage: "checking", completed: 2, total: 5, label: "Checking generated datasets (3 of 5)" },
    ...overrides,
  };
}

const immediatePoll = () => Promise.resolve();

test("the status URL names both the project and the job", () => {
  assert.equal(
    dataProcessingRulesJobStatusUrl("Demo Project", "psrules_1"),
    "/data_processing_rules/save_job/status?project_name=Demo+Project&job_id=psrules_1",
  );
});

test("request ids are generated in the accepted request-id shape", () => {
  const id = createDataProcessingRulesRequestId({ randomUUID: () => "8D0D8C1E-8D4F-4B1F-9F2B-3C2E1D0A9B8C" });
  assert.match(id, /^psrules_[a-z0-9-]+$/u);
  assert.ok(id.length <= 128);
});

test("a job is followed to success and hands back the save response", async () => {
  const payloads = [
    statusPayload("queued"),
    statusPayload("processing"),
    statusPayload("success", { result: { ok: true, data: { revision: 7 } } }),
  ];
  const seen = [];
  const result = await waitForDataProcessingRulesJob({
    fetchImpl: async () => response(payloads.shift()),
    projectName: "Demo Project",
    jobId: "psrules_1",
    onProgress: (progress) => seen.push([progress.completed, progress.total]),
    waitForPoll: immediatePoll,
  });
  assert.equal(result.status, "success");
  assert.equal(result.result.data.revision, 7);
  assert.deepEqual(seen, [[2, 5], [2, 5], [2, 5]]);
});

test("a refused save carries the direct route's status code", async () => {
  await assert.rejects(
    waitForDataProcessingRulesJob({
      fetchImpl: async () =>
        response(statusPayload("error", { message: "Rules revision changed.", status_code: 409 })),
      projectName: "Demo Project",
      jobId: "psrules_1",
      waitForPoll: immediatePoll,
    }),
    (error) => error.code === "DATA_PROCESSING_RULES_JOB_ERROR"
      && error.statusCode === 409
      && /revision changed/.test(error.message),
  );
});

test("a missing status is distinguished from a transient failure", async () => {
  await assert.rejects(
    waitForDataProcessingRulesJob({
      fetchImpl: async () => response({ detail: "Data processing rules job was not found." }, 404),
      projectName: "Demo Project",
      jobId: "psrules_1",
      waitForPoll: immediatePoll,
    }),
    (error) => error.code === "DATA_PROCESSING_RULES_STATUS_NOT_FOUND",
  );
  let calls = 0;
  await assert.rejects(
    waitForDataProcessingRulesJob({
      fetchImpl: async () => {
        calls += 1;
        return response({ detail: "locked" }, 423);
      },
      projectName: "Demo Project",
      jobId: "psrules_1",
      waitForPoll: immediatePoll,
      maxStatusRetries: 2,
    }),
    (error) => error.code === "DATA_PROCESSING_RULES_STATUS_UNAVAILABLE",
  );
  assert.equal(calls, 3);
});

test("a status that stops moving is treated as a stalled worker", async () => {
  let clock = 0;
  await assert.rejects(
    waitForDataProcessingRulesJob({
      fetchImpl: async () => response(statusPayload("processing")),
      projectName: "Demo Project",
      jobId: "psrules_1",
      waitForPoll: async () => { clock += 30_000; },
      now: () => clock,
      staleStatusMs: 45_000,
    }),
    (error) => error.code === "DATA_PROCESSING_RULES_STATUS_STALE",
  );
});

test("the rules editor saves through the Engine job and falls back without one", () => {
  assert.match(
    rulesFeatureSource,
    /async function saveRulesOnEngine\([\s\S]*fetchImpl\("\/data_processing_rules\/save_job"[\s\S]*response\.status === 503[\s\S]*return saveRulesDirectly\(/,
  );
  assert.match(rulesFeatureSource, /waitForDataProcessingRulesJob\(\{[\s\S]*jobId: submitted\?\.job_id/);
  assert.match(rulesFeatureSource, /return terminal\?\.result \|\| \{\}/);
  // A stale revision reloads the document on both paths, as it always did.
  assert.match(rulesFeatureSource, /if \(error\?\.statusCode === 409\) await loadRules\(name, \{ force: true \}\)/);
});

test("the save is followed in the shell progress window like the Source Data import", () => {
  assert.match(rulesFeatureSource, /type: "arcrho:project-settings-progress"/);
  assert.match(
    rulesFeatureSource,
    /publishProgress\("open", progressId, \{\s*title: "Save Data Processing Rules"/,
  );
  assert.match(rulesFeatureSource, /publishProgress\("update", progressId, \{[\s\S]*label: progress\.label/);
  assert.match(rulesFeatureSource, /publishProgress\("close", progressId, \{ autoCloseMs: 850 \}\)/);
  assert.match(
    coordinatorSource,
    /createDataProcessingRulesFeature\(\{[\s\S]*publishShellProgress: \(message\) => window\.parent\.postMessage\(message, window\.location\.origin\)/,
  );
});

test("the rules module and its job module carry one fresh version stamp", () => {
  const [, stamp] = coordinatorSource.match(
    /project_settings_data_processing_rules\.js\?v=([A-Za-z0-9]+)"/u,
  );
  assert.equal(stamp, "20260905rules1");
  assert.match(
    rulesFeatureSource,
    /from "\.\/project_settings_data_processing_rules_job\.js\?v=20260905rules1"/u,
  );
});
