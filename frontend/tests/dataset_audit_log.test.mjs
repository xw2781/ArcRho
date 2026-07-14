import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const componentUrl = new URL("../ui/shared/dataset_audit_log.js", import.meta.url);
const componentSource = await readFile(componentUrl, "utf8");
const stylesheetUrl = new URL("../ui/shared/dataset_audit_log.css", import.meta.url);
const stylesheetSource = await readFile(stylesheetUrl, "utf8");
const auditLog = await import(
  `data:text/javascript;base64,${Buffer.from(componentSource).toString("base64")}`
);

test("normalizes canonical and title-case dataset audit entries", () => {
  const entries = auditLog.normalizeDatasetAuditLog([
    {
      event_date: " 2026-07-14T09:15:30 ",
      action: " Saved ",
      change_info: " Updated values ",
      user: " analyst ",
    },
    {
      "Event Date": "2026-07-14T10:00:00",
      Action: "Created",
      "Change Info": "Initial save",
      User: "owner",
    },
    null,
    {},
  ]);

  assert.deepEqual(entries, [
    {
      eventDate: "2026-07-14T09:15:30",
      action: "Saved",
      changeInfo: "Updated values",
      user: "analyst",
    },
    {
      eventDate: "2026-07-14T10:00:00",
      action: "Created",
      changeInfo: "Initial save",
      user: "owner",
    },
  ]);
});

test("does not normalize the separate project audit-log schema", () => {
  assert.deepEqual(
    auditLog.normalizeDatasetAuditLog([
      {
        timestamp: "2026-07-14T09:15:30",
        action: "Saved",
        details: "Project setting changed",
        user: "analyst",
      },
    ]),
    [],
  );
});

test("keeps only the latest 50 normalized entries in source order", () => {
  const source = Array.from({ length: 55 }, (_, index) => ({
    event_date: `event-${index}`,
    action: `action-${index}`,
  }));
  const entries = auditLog.normalizeDatasetAuditLog(source);

  assert.equal(entries.length, 50);
  assert.equal(entries[0].eventDate, "event-5");
  assert.equal(entries.at(-1).eventDate, "event-54");
});

test("formats valid dates in the existing DSV local 12-hour style", () => {
  assert.equal(
    auditLog.formatDatasetAuditEventDate("2026-07-14T00:05:09"),
    "7/14/2026 12:05:09 AM",
  );
  assert.equal(
    auditLog.formatDatasetAuditEventDate("2026-07-14T13:05:09"),
    "7/14/2026 1:05:09 PM",
  );
});

test("preserves invalid date text and clears blank values", () => {
  assert.equal(auditLog.formatDatasetAuditEventDate(" not-a-date "), "not-a-date");
  assert.equal(auditLog.formatDatasetAuditEventDate("  "), "");
  assert.equal(auditLog.formatDatasetAuditEventDate(null), "");
});

test("does not reserve a vertical scrollbar gutter when scrolling is unnecessary", () => {
  assert.match(stylesheetSource, /scrollbar-gutter:\s*auto;/u);
  assert.doesNotMatch(stylesheetSource, /scrollbar-gutter:\s*stable;/u);
});
