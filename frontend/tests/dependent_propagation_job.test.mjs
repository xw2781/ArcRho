import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pollerSource = await readFile(
  new URL("../ui/shared/services/dependent_propagation_job.js", import.meta.url),
  "utf8",
);
const {
  dependentPropagationStatusUrl,
  isEngineUnavailableSaveError,
  trackSavePropagation,
  waitForDependentPropagationJob,
  waitForDependentPropagationOutcome,
} = await import(
  `data:text/javascript;base64,${Buffer.from(pollerSource).toString("base64")}`
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
    job_id: "job-1",
    contract_version: 1,
    status,
    updated_at: "2026-08-06T00:00:00+00:00",
    request_id: "job-1",
    progress: { stage: "dfm", completed: 1, total: 4, label: "Refreshing DFM methods" },
    ...overrides,
  };
}

const immediatePoll = () => Promise.resolve();

test("outcome waiter resolves terminally for success, error, and missing jobs without throwing", async () => {
  const success = await waitForDependentPropagationOutcome("job-1", {
    fetchImpl: async () => response(statusPayload("success")),
    waitForPoll: immediatePoll,
  });
  assert.deepEqual({ ok: success.ok, terminal: success.terminal }, { ok: true, terminal: true });

  const failed = await waitForDependentPropagationOutcome("job-1", {
    fetchImpl: async () => response(statusPayload("error", { message: "walk failed" })),
    waitForPoll: immediatePoll,
  });
  assert.deepEqual({ ok: failed.ok, terminal: failed.terminal }, { ok: false, terminal: true });

  const missing = await waitForDependentPropagationOutcome("   ");
  assert.deepEqual(missing, { ok: false, terminal: false });
});

test("status URL encodes the job id", () => {
  assert.equal(
    dependentPropagationStatusUrl("job one"),
    "/dependent_propagation/refresh_dependents/status/job%20one",
  );
});

test("engine-unavailable detection matches status code and message text", () => {
  assert.ok(isEngineUnavailableSaveError({ status: 503 }));
  assert.ok(
    isEngineUnavailableSaveError(
      new Error("The ArcRho Engine service is not available. Please try again later or contact the administrator."),
    ),
  );
  assert.ok(!isEngineUnavailableSaveError(new Error("HTTP 500")));
});

test("poller resolves on terminal success and reports tier progress", async () => {
  const responses = [
    response(statusPayload("processing")),
    response(statusPayload("success", {
      progress: { stage: "complete", completed: 1, total: 1, label: "Dependent updates complete" },
    })),
  ];
  const seenLabels = [];
  const result = await waitForDependentPropagationJob({
    fetchImpl: async () => responses.shift(),
    statusUrl: "/status",
    jobId: "job-1",
    onProgress: ({ label }) => seenLabels.push(label),
    waitForPoll: immediatePoll,
  });
  assert.equal(result.status, "success");
  assert.deepEqual(seenLabels, ["Refreshing DFM methods", "Dependent updates complete"]);
});

test("poller raises a coded error for a terminal error status", async () => {
  await assert.rejects(
    waitForDependentPropagationJob({
      fetchImpl: async () => response(statusPayload("error", { message: "walk failed" })),
      statusUrl: "/status",
      jobId: "job-1",
      waitForPoll: immediatePoll,
    }),
    (error) => error.code === "PROPAGATION_JOB_ERROR" && /walk failed/u.test(error.message),
  );
});

test("poller retries transient failures then reports unavailability", async () => {
  let calls = 0;
  await assert.rejects(
    waitForDependentPropagationJob({
      fetchImpl: async () => {
        calls += 1;
        return response({ detail: "locked" }, 423);
      },
      statusUrl: "/status",
      jobId: "job-1",
      waitForPoll: immediatePoll,
      maxStatusRetries: 3,
    }),
    (error) => error.code === "PROPAGATION_STATUS_UNAVAILABLE" && /locked/u.test(error.message),
  );
  assert.equal(calls, 4);
});

test("poller flags a missing status distinctly", async () => {
  await assert.rejects(
    waitForDependentPropagationJob({
      fetchImpl: async () => response({ detail: "gone" }, 404),
      statusUrl: "/status",
      jobId: "job-1",
      waitForPoll: immediatePoll,
    }),
    (error) => error.code === "PROPAGATION_STATUS_NOT_FOUND",
  );
});

test("poller detects a stale unchanged status", async () => {
  let clock = 0;
  await assert.rejects(
    waitForDependentPropagationJob({
      fetchImpl: async () => response(statusPayload("processing")),
      statusUrl: "/status",
      jobId: "job-1",
      waitForPoll: immediatePoll,
      pollIntervalMs: 1,
      staleStatusMs: 5,
      now: () => (clock += 10),
    }),
    (error) => error.code === "PROPAGATION_STATUS_STALE",
  );
});

test("trackSavePropagation ignores a no-op save", async () => {
  let statusCalls = 0;
  const result = await trackSavePropagation(
    { ok: true, status: "unchanged" },
    { onStatus: () => { statusCalls += 1; }, fetchImpl: async () => { throw new Error("no fetch"); } },
  );
  assert.deepEqual(result, { status: "unchanged" });
  assert.equal(statusCalls, 0);
});

test("trackSavePropagation warns when submission failed without a job", async () => {
  const seen = [];
  const result = await trackSavePropagation(
    { ok: false, status: "error", message: "engine offline" },
    { onStatus: (text, options) => seen.push([text, options?.tone]) },
  );
  assert.equal(result, null);
  assert.equal(seen.length, 1);
  assert.match(seen[0][0], /engine offline/u);
  assert.equal(seen[0][1], "warn");
});

test("trackSavePropagation completes a queued job and fires onComplete", async () => {
  const responses = [
    response(statusPayload("processing")),
    response(statusPayload("success")),
  ];
  const seen = [];
  let completed = null;
  const result = await trackSavePropagation(
    { ok: true, job_id: "job-1", status: "queued" },
    {
      fetchImpl: async () => responses.shift(),
      onStatus: (text, options) => seen.push([text, options?.tone]),
      onComplete: (payload) => { completed = payload; },
      waitForPoll: immediatePoll,
    },
  );
  assert.equal(result.status, "success");
  assert.equal(completed.status, "success");
  assert.equal(seen[0][0], "Updating dependents...");
  assert.ok(seen.every(([, tone]) => tone !== "warn"));
});

test("trackSavePropagation finishes a failed job quietly and still fires onComplete", async () => {
  // Owner decision (2026-08-07): a failed walk must not raise a warning status
  // line — the dataset table's review-needed flags are the failure surface —
  // but onComplete still fires so the table refresh happens after the walk
  // finalized downstream statuses.
  const seen = [];
  let completed = "unset";
  const result = await trackSavePropagation(
    { ok: true, job_id: "job-1", status: "queued" },
    {
      fetchImpl: async () => response(statusPayload("error", { message: "walk failed" })),
      onStatus: (text, options) => seen.push([text, options?.tone]),
      onComplete: (payload) => { completed = payload; },
      waitForPoll: immediatePoll,
    },
  );
  assert.equal(result, null);
  assert.equal(completed, null);
  assert.ok(seen.every(([, tone]) => tone !== "warn"));
  assert.ok(seen.every(([text]) => !/did not complete/u.test(text)));
  assert.match(seen.at(-1)[0], /Dependent updates finished/u);
});
