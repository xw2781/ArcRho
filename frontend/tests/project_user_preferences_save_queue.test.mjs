import assert from "node:assert/strict";
import test from "node:test";

import {
  scheduleProjectUserPreferencesSave,
} from "../ui/shared/services/project_user_preferences.js";


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

async function waitFor(predicate, message, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(message);
}

test("scheduled preference saves wait for the active project save", async (t) => {
  const originalFetch = globalThis.fetch;
  const firstResponse = deferred();
  const secondResponse = deferred();
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? firstResponse.promise : secondResponse.promise;
  };
  t.after(() => {
    firstResponse.resolve(successResponse());
    secondResponse.resolve(successResponse());
    globalThis.fetch = originalFetch;
  });

  scheduleProjectUserPreferencesSave("Queue Success", { first: 1 }, 0);
  await waitFor(() => calls.length === 1, "The first preference save did not start.");
  scheduleProjectUserPreferencesSave("Queue Success", { second: 2 }, 0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, 1);

  firstResponse.resolve(successResponse({ first: 1 }));
  await waitFor(() => calls.length === 2, "The queued preference save did not start.");
  assert.deepEqual(JSON.parse(calls[0].options.body).data, { first: 1 });
  assert.deepEqual(JSON.parse(calls[1].options.body).data, { second: 2 });
  secondResponse.resolve(successResponse({ first: 1, second: 2 }));
});

test("a failed preference save does not block the next queued save", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const firstResponse = deferred();
  const secondResponse = deferred();
  const calls = [];
  const warnings = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? firstResponse.promise : secondResponse.promise;
  };
  console.warn = (...args) => warnings.push(args);
  t.after(() => {
    firstResponse.resolve(successResponse());
    secondResponse.resolve(successResponse());
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  });

  scheduleProjectUserPreferencesSave("Queue Failure", { first: 1 }, 0);
  await waitFor(() => calls.length === 1, "The first preference save did not start.");
  scheduleProjectUserPreferencesSave("Queue Failure", { second: 2 }, 0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, 1);

  firstResponse.reject(new Error("network unavailable"));
  await waitFor(() => calls.length === 2, "The queued save stayed blocked after a failure.");
  secondResponse.resolve(successResponse({ second: 2 }));
  await waitFor(() => warnings.length === 1, "The failed preference save was not reported.");
  assert.match(String(warnings[0][0]), /Failed to save project user preferences/);
});
