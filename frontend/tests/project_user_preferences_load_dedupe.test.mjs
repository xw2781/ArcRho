import assert from "node:assert/strict";
import test from "node:test";

import { loadProjectUserPreferences } from "../ui/shared/services/project_user_preferences.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function successResponse(data = {}) {
  return {
    ok: true,
    json: async () => ({ data }),
    text: async () => "",
  };
}

test("concurrent preference loads share one request", async (t) => {
  const originalFetch = globalThis.fetch;
  const response = deferred();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return response.promise;
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  // Project Instance loads these from its path panel and its dataset table at
  // the same time; on a network drive a second request is a wasted round trip.
  const first = loadProjectUserPreferences("Dedupe Concurrent");
  const second = loadProjectUserPreferences("Dedupe Concurrent");
  response.resolve(successResponse({ lastReservingClassPath: "A\\B" }));

  const [firstData, secondData] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(firstData, { lastReservingClassPath: "A\\B" });
  assert.equal(firstData, secondData);
});

test("a failed load is not cached and the next load retries", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async () => {
    calls.push(1);
    if (calls.length === 1) throw new Error("network down");
    return successResponse({ ok: true });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(() => loadProjectUserPreferences("Dedupe Retry"));
  const data = await loadProjectUserPreferences("Dedupe Retry");
  assert.equal(calls.length, 2);
  assert.deepEqual(data, { ok: true });
});

test("a forced reload issues its own request", async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return successResponse({ call: calls });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await loadProjectUserPreferences("Dedupe Forced");
  assert.equal(calls, 1);
  await loadProjectUserPreferences("Dedupe Forced");
  assert.equal(calls, 1, "A cached value must be reused.");
  const forced = await loadProjectUserPreferences("Dedupe Forced", { forceReload: true });
  assert.equal(calls, 2);
  assert.deepEqual(forced, { call: 2 });
});
