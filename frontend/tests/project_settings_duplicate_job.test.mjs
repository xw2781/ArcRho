import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectOpsSource = await readFile(
  new URL("../ui/project_settings/project_settings_project_ops.js", import.meta.url),
  "utf8",
);
const duplicateJobSource = await readFile(
  new URL("../ui/project_settings/project_settings_duplicate_job.js", import.meta.url),
  "utf8",
);
const duplicateJobHelpers = await import(
  `data:text/javascript;base64,${Buffer.from(duplicateJobSource).toString("base64")}`
);
const { waitForDuplicateProjectJob } = duplicateJobHelpers;
const projectOpsTestSource = projectOpsSource.replace(
  /import \{[\s\S]*?from "\/ui\/project_settings\/project_settings_duplicate_job\.js\?v=[^"]+";\s*/u,
  `
const buildEmptyProjectRow = (headers, name) => headers.map((header) => header === "Project Name" ? name : "");
const ensureFolderPathInList = () => {};
const joinProjectTreePath = (folder, name) => [folder, name].filter(Boolean).join("/");
const normalizeTreePath = (value) => String(value || "");
const pathEqualsCI = (left, right) => String(left).toLowerCase() === String(right).toLowerCase();
const splitProjectTreePath = () => ({ folderPath: "", projectName: "" });
const {
  clearPendingDuplicateJob,
  createDuplicateRequestId,
  createDuplicateSourceSnapshotHash,
  createDuplicateWorkspaceScope,
  loadPendingDuplicateJob,
  readDuplicateResponseError,
  savePendingDuplicateJob,
  waitForDuplicateProjectJob,
} = globalThis.__duplicateJobHelpers;
`,
);
globalThis.__duplicateJobHelpers = duplicateJobHelpers;
const { createProjectOpsFeature } = await import(
  `data:text/javascript;base64,${Buffer.from(projectOpsTestSource).toString("base64")}`
);
delete globalThis.__duplicateJobHelpers;

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

const NO_STORAGE_OVERRIDE = Symbol("NO_STORAGE_OVERRIDE");

function response(body, status = 200) {
  const raw = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => raw,
  };
}

function pendingRecord(workspaceRoot = "E:\\ArcRho Server", overrides = {}) {
  const headers = ["Project Name", "Owner"];
  const row = ["Source Project", "owner"];
  return {
    version: 2,
    sourceKey: "project_map",
    workspaceScope: duplicateJobHelpers.createDuplicateWorkspaceScope(workspaceRoot),
    requestId: "job-resume",
    sourceName: "Source Project",
    targetName: "Source Project (2)",
    sourceFolderPath: "Pricing",
    sourceSnapshotHash: duplicateJobHelpers.createDuplicateSourceSnapshotHash(headers, row),
    submittedAt: 100,
    submissionAcknowledged: true,
    metadataFinalized: false,
    ...overrides,
  };
}

function makeFeature({
  fetchImpl,
  storage = new MemoryStorage(),
  workspaceRoot = "E:\\ArcRho Server",
  requestId = "job-123",
  headers = ["Project Name", "Owner"],
  rows,
  projectPaths,
  saveFolderStructure,
  saveProjectMapRows,
  publishShellProgress = () => {},
  setStatus = () => {},
  showDialog = async () => "Source Project (2)",
}) {
  const sourceRow = ["Source Project", "owner"];
  const sheet = { headers, rows: rows ?? [sourceRow] };
  const projectData = {
    customFolders: ["Pricing"],
    projectPaths: projectPaths || ["Pricing/Source Project"],
  };
  const sequence = [];
  const feature = createProjectOpsFeature({
    defaultSource: "project_map",
    fetchImpl,
    ...(storage === NO_STORAGE_OVERRIDE ? {} : { pendingJobStorage: storage }),
    duplicateRequestIdFactory: () => requestId,
    store: {
      getProjectData: () => projectData,
      getSheetName: () => "Projects",
      getSheet: () => sheet,
      getProjectFolderFromStructure: () => "Pricing",
      saveFolderStructure: saveFolderStructure || (async () => sequence.push("save-structure")),
      saveProjectMapRows: saveProjectMapRows || (async (_name, mutate) => {
        sequence.push("save-project-map");
        const copy = sheet.rows.map((row) => [...row]);
        mutate(copy);
      }),
      buildTreeData: () => sequence.push("build-tree"),
      findProjectBySnapshot: () => null,
    },
    treeView: {
      expandFolder: () => sequence.push("expand-folder"),
      render: () => sequence.push("render-tree"),
    },
    setStatus,
    showDialog,
    showConfirm: async () => true,
    publishShellProgress: (message) => {
      sequence.push(`progress-${message.action}`);
      publishShellProgress(message);
    },
    waitForDuplicatePoll: async (delayMs) => sequence.push(`wait-${delayMs}`),
    appendAuditLogAction: async () => sequence.push("audit"),
    getSelectedProject: () => null,
    setSelectedProject: () => {},
    selectProject: () => {},
    showProjectDetails: () => {},
    clearProjectSelection: () => {},
    reloadProjectData: async () => sequence.push("reload"),
  });
  feature.setWorkspaceRoot(workspaceRoot);
  return {
    feature,
    project: { name: "Source Project", _row: sheet.rows[0] },
    projectData,
    sequence,
    sheet,
    storage,
  };
}

test("fresh duplicate persists before polling and finalizes metadata after Engine success", async () => {
  const progressMessages = [];
  const statusPayloads = [
    { ok: true, status: "queued", updated_at: "1", progress: { stage: "queued", completed: 0, total: 0, label: "Queued..." } },
    { ok: true, status: "processing", updated_at: "2", progress: { stage: "copying", completed: 1, total: 3, label: "Copying..." } },
    { ok: true, status: "success", updated_at: "3", progress: { stage: "complete", completed: 3, total: 3, label: "Complete" } },
  ];
  let duplicateBody = null;
  let preparedAtPost = null;
  const statusOptions = [];
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/duplicate_project_folder") && options.method === "POST") {
      duplicateBody = JSON.parse(options.body);
      preparedAtPost = JSON.parse([...context.storage.values.values()][0]);
      return response({ ok: true, job_id: "job-123", status: "queued" }, 202);
    }
    if (url.endsWith("/status/job-123")) {
      statusOptions.push(options);
      return response(statusPayloads.shift());
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const context = makeFeature({
    fetchImpl,
    publishShellProgress: (message) => progressMessages.push(message),
  });

  await context.feature.duplicateProject(context.project);

  assert.deepEqual(duplicateBody, {
    old_name: "Source Project",
    new_name: "Source Project (2)",
    request_id: "job-123",
  });
  assert.equal(preparedAtPost.requestId, "job-123");
  assert.equal(preparedAtPost.submissionAcknowledged, false);
  assert.match(preparedAtPost.sourceSnapshotHash, /^row_[0-9a-f]{16}$/u);
  assert.equal(JSON.stringify(preparedAtPost).includes("owner"), false);
  assert.equal(context.sheet.rows.filter((row) => row[0] === "Source Project (2)").length, 1);
  assert.ok(context.sequence.indexOf("wait-750") < context.sequence.indexOf("save-structure"));
  assert.ok(context.sequence.indexOf("save-structure") < context.sequence.indexOf("save-project-map"));
  assert.ok(statusOptions.every((options) => options.cache === "no-store"));
  assert.equal(context.storage.values.size, 0);
  assert.equal(progressMessages.at(-1).autoCloseMs, 850);
});

test("a lost POST response is recovered by replaying the same prepared request after reload", async () => {
  const storage = new MemoryStorage();
  globalThis.alert = () => {};
  const postBodies = [];
  let postAttempts = 0;
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/duplicate_project_folder") && options.method === "POST") {
      postAttempts += 1;
      postBodies.push(JSON.parse(options.body));
      if (postAttempts === 1) throw new Error("response connection lost");
      return response({ ok: true, job_id: "job-lost-response", status: "processing" }, 202);
    }
    if (url.endsWith("/status/job-lost-response")) {
      return response({ ok: true, status: "success", progress: { completed: 1, total: 1, label: "Complete" } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const first = makeFeature({
    fetchImpl,
    storage,
    requestId: "job-lost-response",
  });

  await first.feature.duplicateProject(first.project);

  assert.equal(storage.values.size, 1);
  assert.equal(JSON.parse([...storage.values.values()][0]).submissionAcknowledged, false);
  const reloaded = makeFeature({ fetchImpl, storage });
  assert.equal(await reloaded.feature.resumePendingDuplicateProject(), true);
  assert.equal(postAttempts, 2);
  assert.deepEqual(postBodies[1], postBodies[0]);
  assert.equal(reloaded.sheet.rows.filter((row) => row[0] === "Source Project (2)").length, 1);
  assert.equal(storage.values.size, 0);
});

test("a missing accepted-job status replays the same submission before polling again", async () => {
  const storage = new MemoryStorage();
  globalThis.alert = () => {};
  const postBodies = [];
  let statusAttempts = 0;
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/duplicate_project_folder") && options.method === "POST") {
      postBodies.push(JSON.parse(options.body));
      return response({ ok: true, job_id: "job-status-repair", status: "queued" }, 202);
    }
    if (url.endsWith("/status/job-status-repair")) {
      statusAttempts += 1;
      if (statusAttempts === 1) return response({ detail: "not found" }, 404);
      return response({ ok: true, status: "success", progress: { completed: 1, total: 1, label: "Complete" } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const context = makeFeature({
    fetchImpl,
    storage,
    requestId: "job-status-repair",
  });

  await context.feature.duplicateProject(context.project);
  assert.equal(JSON.parse([...storage.values.values()][0]).submissionAcknowledged, false);
  await context.feature.duplicateProject(context.project);

  assert.equal(postBodies.length, 2);
  assert.deepEqual(postBodies[1], postBodies[0]);
  assert.equal(storage.values.size, 0);
});

test("definitive submission rejection clears prepared state while uncertain failures retain it", async () => {
  globalThis.alert = () => {};
  for (const [httpStatus, expectedSize] of [
    [404, 0], [409, 0], [422, 0],
    [408, 1], [423, 1], [425, 1], [429, 1], [500, 1],
  ]) {
    const storage = new MemoryStorage();
    const requestId = `job-submit-${httpStatus}`;
    const context = makeFeature({
      storage,
      requestId,
      fetchImpl: async (url, options = {}) => {
        assert.ok(url.endsWith("/duplicate_project_folder"));
        assert.equal(JSON.parse(options.body).request_id, requestId);
        return response({ detail: `HTTP ${httpStatus}` }, httpStatus);
      },
    });

    await context.feature.duplicateProject(context.project);

    assert.equal(storage.values.size, expectedSize, `HTTP ${httpStatus} retention policy`);
  }
});

test("same-page finalization uses the submission-time row snapshot", async () => {
  let context;
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/duplicate_project_folder") && options.method === "POST") {
      return response({ ok: true, job_id: "job-row-snapshot", status: "queued" }, 202);
    }
    if (url.endsWith("/status/job-row-snapshot")) {
      context.sheet.rows[0][1] = "changed after submission";
      return response({ ok: true, status: "success", progress: { completed: 1, total: 1, label: "Complete" } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  context = makeFeature({ fetchImpl, requestId: "job-row-snapshot" });

  await context.feature.duplicateProject(context.project);

  const target = context.sheet.rows.find((row) => row[0] === "Source Project (2)");
  assert.deepEqual(target, ["Source Project (2)", "owner"]);
});

test("reload blocks finalization when source row or ordered headers changed or disappeared", async () => {
  globalThis.alert = () => {};
  const variants = [
    { label: "changed row", headers: ["Project Name", "Owner"], rows: [["Source Project", "changed"]] },
    { label: "deleted row", headers: ["Project Name", "Owner"], rows: [] },
    { label: "changed headers", headers: ["Owner", "Project Name"], rows: [["owner", "Source Project"]] },
  ];
  for (const variant of variants) {
    const storage = new MemoryStorage();
    duplicateJobHelpers.savePendingDuplicateJob(storage, pendingRecord());
    const context = makeFeature({
      storage,
      headers: variant.headers,
      rows: variant.rows,
      fetchImpl: async (url) => {
        assert.ok(url.endsWith("/status/job-resume"));
        return response({ ok: true, status: "success", progress: { completed: 1, total: 1, label: "Complete" } });
      },
    });

    assert.equal(await context.feature.resumePendingDuplicateProject(), true, variant.label);
    assert.equal(context.sequence.includes("save-project-map"), false, variant.label);
    assert.equal(storage.values.size, 1, variant.label);
  }
});

test("request IDs and source fingerprints are safe and deterministic", () => {
  assert.equal(
    duplicateJobHelpers.createDuplicateRequestId({ randomUUID: () => "01234567-89ab-cdef-0123-456789abcdef" }),
    "psdup_01234567-89ab-cdef-0123-456789abcdef",
  );
  const first = duplicateJobHelpers.createDuplicateSourceSnapshotHash(
    ["Project Name", "Owner"],
    ["Source Project", "owner"],
  );
  assert.equal(
    first,
    duplicateJobHelpers.createDuplicateSourceSnapshotHash(
      ["Project Name", "Owner"],
      ["Source Project", "owner"],
    ),
  );
  assert.notEqual(
    first,
    duplicateJobHelpers.createDuplicateSourceSnapshotHash(
      ["Owner", "Project Name"],
      ["owner", "Source Project"],
    ),
  );
  const defaultScope = duplicateJobHelpers.createDuplicateWorkspaceScope("E:\\ArcRho Server");
  assert.equal(
    defaultScope,
    duplicateJobHelpers.createDuplicateWorkspaceScope({
      workspace_root: "e:/arcrho server/",
      paths: { projects_dir: "PROJECTS", requests_dir: "requests" },
    }),
  );
  assert.notEqual(
    defaultScope,
    duplicateJobHelpers.createDuplicateWorkspaceScope({
      workspace_root: "E:\\ArcRho Server",
      paths: { projects_dir: "project-data", requests_dir: "requests" },
    }),
  );
  assert.notEqual(
    defaultScope,
    duplicateJobHelpers.createDuplicateWorkspaceScope({
      workspace_root: "E:\\ArcRho Server",
      paths: { projects_dir: "projects", requests_dir: "engine-requests" },
    }),
  );
});

test("reload does not adopt an unrelated pre-existing target row", async () => {
  const storage = new MemoryStorage();
  const alerts = [];
  globalThis.alert = (message) => alerts.push(String(message));
  duplicateJobHelpers.savePendingDuplicateJob(storage, pendingRecord());
  const context = makeFeature({
    storage,
    rows: [
      ["Source Project", "owner"],
      ["Source Project (2)", "different owner"],
    ],
    fetchImpl: async (url) => {
      if (url.endsWith("/status/job-resume")) {
        return response({
          ok: true,
          status: "success",
          progress: { stage: "complete", completed: 1, total: 1, label: "Complete" },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  assert.equal(await context.feature.resumePendingDuplicateProject(), true);

  assert.equal(storage.values.size, 1);
  assert.equal(context.sequence.includes("save-project-map"), false);
  assert.match(alerts.at(-1), /does not belong to this duplicate request/iu);
});

test("map finalization failure preserves target and pending record, then reload resumes idempotently", async () => {
  const storage = new MemoryStorage();
  const alerts = [];
  globalThis.alert = (message) => alerts.push(message);
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/duplicate_project_folder") && options.method === "POST") {
      return response({ ok: true, job_id: "job-resume", status: "queued" }, 202);
    }
    if (url.endsWith("/status/job-resume")) {
      return response({ ok: true, status: "success", progress: { completed: 2, total: 2, label: "Copied" } });
    }
    throw new Error(`Unexpected request (server target must not be deleted): ${url}`);
  };
  let firstSequence;
  const first = makeFeature({
    fetchImpl,
    storage,
    requestId: "job-resume",
    saveProjectMapRows: async () => {
      firstSequence.push("save-project-map");
      throw new Error("map write failed");
    },
  });
  firstSequence = first.sequence;

  await first.feature.duplicateProject(first.project);

  assert.ok(first.sequence.includes("save-structure"));
  assert.doesNotMatch(first.sequence.join(" "), /rollback|delete-folder/u);
  assert.match(alerts[0], /server-side copy state were both preserved/u);
  assert.equal(storage.values.size, 1);

  const resumed = makeFeature({
    fetchImpl,
    storage,
    projectPaths: ["Pricing/Source Project", "Pricing/Source Project (2)"],
  });
  assert.equal(await resumed.feature.resumePendingDuplicateProject(), true);
  assert.equal(resumed.sequence.filter((value) => value === "save-structure").length, 0);
  assert.equal(resumed.sequence.filter((value) => value === "save-project-map").length, 1);
  assert.equal(resumed.sheet.rows.filter((row) => row[0] === "Source Project (2)").length, 1);
  assert.equal(await resumed.feature.resumePendingDuplicateProject(), false);
  assert.equal(storage.values.size, 0);
});

test("metadata-finalized recovery skips polling and all duplicate metadata writes", async () => {
  const storage = new MemoryStorage();
  duplicateJobHelpers.savePendingDuplicateJob(storage, pendingRecord(undefined, { metadataFinalized: true }));
  const rows = [["Source Project", "owner"], ["Source Project (2)", "owner"]];
  const context = makeFeature({
    storage,
    rows,
    projectPaths: ["Pricing/Source Project", "Pricing/Source Project (2)"],
    fetchImpl: async () => { throw new Error("Finalized recovery must not poll."); },
  });

  assert.equal(await context.feature.resumePendingDuplicateProject(), true);
  assert.equal(context.sequence.filter((value) => value === "save-structure").length, 0);
  assert.equal(context.sequence.filter((value) => value === "save-project-map").length, 0);
  assert.equal(context.sheet.rows.filter((row) => row[0] === "Source Project (2)").length, 1);
  assert.equal(storage.values.size, 0);
});

test("a workspace switch cannot resume or clean another workspace record", async () => {
  const storage = new MemoryStorage();
  duplicateJobHelpers.savePendingDuplicateJob(storage, pendingRecord("E:\\Server A"));
  const requests = [];
  const context = makeFeature({
    storage,
    workspaceRoot: "E:\\Server B",
    fetchImpl: async (url) => { requests.push(url); throw new Error("unexpected"); },
  });

  assert.equal(await context.feature.resumePendingDuplicateProject(), false);
  assert.deepEqual(requests, []);
  assert.equal(storage.values.size, 1);
  assert.doesNotMatch([...storage.values.values()][0], /E:\\\\Server A/u);
});

test("an active workspace switch preserves the original job for later recovery", async () => {
  const storage = new MemoryStorage();
  globalThis.alert = () => {};
  let releaseFirstStatus;
  let markStatusRequested;
  let statusCalls = 0;
  const firstStatus = new Promise((resolve) => { releaseFirstStatus = resolve; });
  const statusRequested = new Promise((resolve) => { markStatusRequested = resolve; });
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/duplicate_project_folder") && options.method === "POST") {
      return response({ ok: true, job_id: "job-workspace-switch", status: "queued" }, 202);
    }
    if (url.endsWith("/status/job-workspace-switch")) {
      statusCalls += 1;
      if (statusCalls === 1) {
        markStatusRequested();
        return firstStatus;
      }
      return response({ ok: true, status: "success", progress: { completed: 1, total: 1, label: "Complete" } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const context = makeFeature({
    fetchImpl,
    storage,
    workspaceRoot: "E:\\Server A",
    requestId: "job-workspace-switch",
  });
  const running = context.feature.duplicateProject(context.project);
  await statusRequested;
  context.feature.setWorkspaceRoot("E:\\Server B");
  releaseFirstStatus(response({
    ok: true,
    status: "success",
    progress: { completed: 1, total: 1, label: "Complete" },
  }));
  await running;

  assert.equal(storage.values.size, 1);
  assert.equal(context.sequence.includes("save-project-map"), false);
  assert.equal(await context.feature.resumePendingDuplicateProject(), false);
  context.feature.setWorkspaceRoot("E:\\Server A");
  assert.equal(await context.feature.resumePendingDuplicateProject(), true);
  assert.equal(context.sheet.rows.filter((row) => row[0] === "Source Project (2)").length, 1);
  assert.equal(storage.values.size, 0);
});

test("localStorage write failure continues the submitted job in memory", async (t) => {
  t.mock.method(console, "warn", () => {});
  const storage = new MemoryStorage();
  storage.setItem = () => { throw new Error("storage disabled"); };
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/duplicate_project_folder") && options.method === "POST") {
      return response({ ok: true, job_id: "job-memory", status: "queued" }, 202);
    }
    if (url.endsWith("/status/job-memory")) {
      return response({ ok: true, status: "success", progress: { completed: 1, total: 1, label: "Complete" } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const context = makeFeature({ fetchImpl, storage, requestId: "job-memory" });

  await context.feature.duplicateProject(context.project);

  assert.equal(context.sheet.rows.filter((row) => row[0] === "Source Project (2)").length, 1);
  assert.ok(context.sequence.includes("save-project-map"));
});

test("in-memory recovery retries finalization when localStorage and the first metadata write fail", async (t) => {
  t.mock.method(console, "warn", () => {});
  const storage = new MemoryStorage();
  storage.setItem = () => { throw new Error("storage disabled"); };
  let mapAttempts = 0;
  let submissions = 0;
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/duplicate_project_folder") && options.method === "POST") {
      submissions += 1;
      return response({ ok: true, job_id: "job-memory-retry", status: "queued" }, 202);
    }
    if (url.endsWith("/status/job-memory-retry")) {
      return response({ ok: true, status: "success", progress: { completed: 1, total: 1, label: "Complete" } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const context = makeFeature({
    fetchImpl,
    storage,
    requestId: "job-memory-retry",
    saveProjectMapRows: async (_name, mutate) => {
      mapAttempts += 1;
      if (mapAttempts === 1) throw new Error("first map write failed");
      const copy = context.sheet.rows.map((row) => [...row]);
      mutate(copy);
    },
  });

  await context.feature.duplicateProject(context.project);
  assert.equal(context.sheet.rows.some((row) => row[0] === "Source Project (2)"), false);
  await context.feature.duplicateProject(context.project);

  assert.equal(submissions, 1);
  assert.equal(mapAttempts, 2);
  assert.equal(context.sequence.filter((value) => value === "save-structure").length, 1);
  assert.equal(context.sheet.rows.filter((row) => row[0] === "Source Project (2)").length, 1);
});

test("storage cleanup failure cannot turn committed metadata into a duplicate failure", async () => {
  const storage = new MemoryStorage();
  storage.removeItem = () => { throw new Error("storage cleanup disabled"); };
  const alerts = [];
  const statuses = [];
  globalThis.alert = (message) => alerts.push(message);
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/duplicate_project_folder") && options.method === "POST") {
      return response({ ok: true, job_id: "job-clear-failure", status: "queued" }, 202);
    }
    if (url.endsWith("/status/job-clear-failure")) {
      return response({ ok: true, status: "success", progress: { completed: 1, total: 1, label: "Complete" } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const context = makeFeature({
    fetchImpl,
    storage,
    requestId: "job-clear-failure",
    setStatus: (message) => statuses.push(message),
  });

  await context.feature.duplicateProject(context.project);

  assert.equal(context.sheet.rows.filter((row) => row[0] === "Source Project (2)").length, 1);
  assert.match(statuses.at(-1), /^Duplicated /u);
  assert.deepEqual(alerts, []);
  assert.equal(await context.feature.resumePendingDuplicateProject(), false);
});

test("cleanup never removes a newer job from the same workspace scope", () => {
  const storage = new MemoryStorage();
  const newer = pendingRecord(undefined, { requestId: "job-newer" });
  duplicateJobHelpers.savePendingDuplicateJob(storage, newer);

  assert.equal(duplicateJobHelpers.clearPendingDuplicateJob(
    storage,
    newer.sourceKey,
    newer.workspaceScope,
    "job-older",
  ), false);
  assert.equal(
    duplicateJobHelpers.loadPendingDuplicateJob(
      storage,
      newer.sourceKey,
      newer.workspaceScope,
    )?.requestId,
    "job-newer",
  );
});

test("recovery records reject absolute server paths", () => {
  const storage = new MemoryStorage();
  assert.throws(
    () => duplicateJobHelpers.savePendingDuplicateJob(
      storage,
      pendingRecord(undefined, { sourceFolderPath: "E:\\ArcRho Server\\projects" }),
    ),
    /unavailable/u,
  );
  assert.equal(storage.values.size, 0);
});

test("a throwing localStorage getter does not prevent Project Settings initialization", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() { throw new Error("storage blocked"); },
  });
  try {
    const context = makeFeature({
      storage: NO_STORAGE_OVERRIDE,
      fetchImpl: async () => { throw new Error("not called"); },
    });
    assert.equal(await context.feature.resumePendingDuplicateProject(), false);
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete globalThis.localStorage;
  }
});

test("close requests are blocked only while duplication is active", async () => {
  let releaseSubmit;
  const alerts = [];
  globalThis.alert = (message) => alerts.push(message);
  const submitResponse = new Promise((resolve) => { releaseSubmit = resolve; });
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/duplicate_project_folder") && options.method === "POST") return submitResponse;
    if (url.endsWith("/status/job-close")) {
      return response({ ok: true, status: "success", progress: { completed: 1, total: 1, label: "Complete" } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const context = makeFeature({ fetchImpl, requestId: "job-close" });
  const running = context.feature.duplicateProject(context.project);
  await Promise.resolve();

  assert.equal(context.feature.requestClose(), true);
  releaseSubmit(response({ ok: true, job_id: "job-close", status: "queued" }, 202));
  await running;
  assert.equal(context.feature.requestClose(), false);
  assert.match(alerts[0], /still running or finalizing/u);
});

test("unchanged valid status stops at the idle threshold and retains uncertainty", async () => {
  let clock = 100;
  await assert.rejects(
    waitForDuplicateProjectJob({
      fetchImpl: async () => response({
        ok: true,
        status: "processing",
        updated_at: "same",
        progress: { stage: "copying", completed: 0, total: 0, label: "Copying" },
      }),
      statusUrl: "/status/job-stale",
      jobId: "job-stale",
      now: () => clock,
      waitForPoll: async () => { clock += 750; },
      staleStatusMs: 800,
    }),
    (error) => error?.code === "DUPLICATE_STATUS_STALE" && /record was retained/u.test(error.message),
  );
});

test("recovery-required Engine error remains distinct from ordinary terminal error", async () => {
  await assert.rejects(
    waitForDuplicateProjectJob({
      fetchImpl: async () => response({
        ok: true,
        status: "error",
        message: "Target preserved",
        progress: { stage: "recovery_required", completed: 0, total: 0, label: "Recovery required" },
      }),
      statusUrl: "/status/job-recovery",
      jobId: "job-recovery",
    }),
    (error) => error?.code === "DUPLICATE_JOB_RECOVERY_REQUIRED",
  );
});

test("recovery-required retains the pending record while an ordinary terminal error clears it", async () => {
  globalThis.alert = () => {};
  for (const [stage, expectedSize] of [["recovery_required", 1], ["failed", 0]]) {
    const storage = new MemoryStorage();
    const jobId = `job-${stage}`;
    const fetchImpl = async (url, options = {}) => {
      if (url.endsWith("/duplicate_project_folder") && options.method === "POST") {
        return response({ ok: true, job_id: jobId, status: "queued" }, 202);
      }
      if (url.endsWith(`/status/${jobId}`)) {
        return response({
          ok: true,
          status: "error",
          message: "Engine stopped",
          progress: { stage, completed: 0, total: 1, label: "Stopped" },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    const context = makeFeature({ fetchImpl, storage, requestId: jobId });

    await context.feature.duplicateProject(context.project);

    assert.equal(storage.values.size, expectedSize, `${stage} retention policy`);
  }
});

test("transient status failures retry but eventually preserve the uncertain job", async () => {
  const waits = [];
  await assert.rejects(
    waitForDuplicateProjectJob({
      fetchImpl: async () => { throw new Error("network unavailable"); },
      statusUrl: "/status/job-uncertain",
      jobId: "job-uncertain",
      waitForPoll: async (delayMs) => waits.push(delayMs),
      maxStatusRetries: 2,
    }),
    (error) => error?.code === "DUPLICATE_STATUS_UNAVAILABLE",
  );
  assert.deepEqual(waits, [750, 750]);
});
