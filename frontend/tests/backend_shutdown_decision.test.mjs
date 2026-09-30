import assert from "node:assert/strict";
import test from "node:test";

const { decideBackendShutdownOnExit } = (await import(new URL("../electron/backend_port.js", import.meta.url))).default;

const SELF = { pid: 100, port: 28765, mode: "arcrho" };

test("the last window on a server stops it", () => {
  const result = decideBackendShutdownOnExit({ ...SELF, markers: [{ pid: 100, port: 28765, mode: "arcrho" }] });
  assert.deepEqual(result, { stop: true, others: 0 });
});

test("a window with a live sibling on the same server keeps it", () => {
  const result = decideBackendShutdownOnExit({
    ...SELF,
    markers: [
      { pid: 100, port: 28765, mode: "arcrho" },
      { pid: 200, port: 28765, mode: "arcrho" },
    ],
  });
  assert.deepEqual(result, { stop: false, others: 1 });
});

test("a window that inherited the server still stops it when alone on that port", () => {
  // The sibling that started 28765 has gone; a sibling on its own port does not hold this one.
  const result = decideBackendShutdownOnExit({
    ...SELF,
    markers: [
      { pid: 100, port: 28765, mode: "arcrho" },
      { pid: 300, port: 31044, mode: "arcrho" },
    ],
  });
  assert.deepEqual(result, { stop: true, others: 0 });
});

test("an Arcode window on the same port does not count as a sibling", () => {
  const result = decideBackendShutdownOnExit({
    ...SELF,
    markers: [{ pid: 400, port: 28765, mode: "arcode" }],
  });
  assert.equal(result.stop, true);
});
