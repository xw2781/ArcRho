import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const guardUrl = new URL(
  "../ui/project_instance/project_instance_delete_guard.js",
  import.meta.url,
);
const guardSource = await readFile(guardUrl, "utf8");
// The module is imported from a data: URL, which cannot resolve the app's
// absolute "/ui/..." specifier for the shared message box, so it is stubbed
// here and every call it receives is recorded.
const messageBoxCalls = [];
let messageBoxBehavior = () => {};
const testableSource = guardSource.replace(
  /^import \{ showPageMessageBox \} from .*;\s*/mu,
  [
    "const showPageMessageBox = async (options) => {",
    "  globalThis.__messageBoxCalls.push(options);",
    "  return await globalThis.__messageBoxBehavior(options);",
    "};",
    "",
  ].join("\n"),
);
globalThis.__messageBoxCalls = messageBoxCalls;
globalThis.__messageBoxBehavior = (options) => messageBoxBehavior(options);

const { installProjectInstanceDeleteGuard, DELETE_BLOCKED_BY_DEPENDENTS } = await import(
  `data:text/javascript;base64,${Buffer.from(testableSource).toString("base64")}`
);

function createGuard() {
  const opened = [];
  const api = {
    openDependentDatasetByName: (datasetName, options) => opened.push({ datasetName, options }),
  };
  installProjectInstanceDeleteGuard({ api, state: { selectedPath: "Direct Group/COLL" } });
  return { api, opened };
}

function blockedPayload(blockedDatasets, message = "Still in use.") {
  return {
    detail: {
      error: DELETE_BLOCKED_BY_DEPENDENTS,
      message,
      blocked_datasets: blockedDatasets,
    },
  };
}

test("the refusal code matches the app server constant", async () => {
  const serviceSource = await readFile(
    new URL(
      "../app_server/services/dataset_instance_index_service.py",
      import.meta.url,
    ),
    "utf8",
  );
  const match = serviceSource.match(/^DELETE_BLOCKED_BY_DEPENDENTS = "([^"]+)"/mu);
  assert.ok(match, "the app server must define DELETE_BLOCKED_BY_DEPENDENTS");
  assert.equal(
    DELETE_BLOCKED_BY_DEPENDENTS,
    match[1],
    "the page switches on this code, so the two spellings must stay identical",
  );
});

test("only this refusal is read as a blocked delete", () => {
  const { api } = createGuard();

  assert.equal(api.readDeleteBlockedDetail(undefined), null);
  assert.equal(api.readDeleteBlockedDetail({ detail: "Folder is locked." }), null);
  assert.equal(
    api.readDeleteBlockedDetail({ detail: { error: "something_else" } }),
    null,
    "another structured refusal must fall through to normal error handling",
  );
  assert.equal(
    api.readDeleteBlockedDetail(blockedPayload([])),
    null,
    "a refusal naming no dependents has nothing to offer the user",
  );
  assert.equal(
    api.readDeleteBlockedDetail(
      blockedPayload([{ dataset_name: "Paid Loss", dependents: [] }]),
    ),
    null,
  );
});

test("a blocked refusal is normalized into dataset and dependent names", () => {
  const { api } = createGuard();

  const detail = api.readDeleteBlockedDetail(
    blockedPayload(
      [
        {
          dataset_name: " Paid Loss ",
          dependents: [
            { dataset_name: "Paid DFM", method_type: "DFM" },
            { dataset_name: "  ", method_type: "DFM" },
          ],
        },
      ],
      "'Paid Loss' is used as input by other objects.",
    ),
  );

  assert.deepEqual(detail, {
    message: "'Paid Loss' is used as input by other objects.",
    blockedDatasets: [
      {
        datasetName: "Paid Loss",
        dependents: [{ datasetName: "Paid DFM", methodType: "DFM" }],
      },
    ],
    downstreamClosure: [],
  });
});

test("a refusal carrying the downstream closure lists the chain and offers deleting it", async () => {
  const { api } = createGuard();
  messageBoxCalls.length = 0;
  messageBoxBehavior = () => {};

  const payload = blockedPayload([
    {
      dataset_name: "Paid Loss",
      dependents: [{ dataset_name: "Paid DFM", method_type: "DFM" }],
    },
  ]);
  payload.detail.downstream_closure = [
    { dataset_name: "Paid DFM", method_type: "DFM" },
    { dataset_name: "Selected Ultimate", method_type: "Result Selection" },
  ];
  const detail = api.readDeleteBlockedDetail(payload);
  assert.deepEqual(detail.downstreamClosure, [
    { datasetName: "Paid DFM", methodType: "DFM" },
    { datasetName: "Selected Ultimate", methodType: "Result Selection" },
  ]);

  const decision = await api.showDeleteBlockedByDependents(detail);
  const options = messageBoxCalls.at(-1);
  assert.deepEqual(
    options.links.map((link) => link.label),
    ["Paid DFM — DFM", "Selected Ultimate — Result Selection"],
    "with a closure the listed chain replaces the direct-dependent rows",
  );
  assert.deepEqual(
    options.actions.map((action) => action.id),
    ["delete-chain"],
  );
  assert.equal(decision, null, "a dismissed box asks for no chain delete");
});

test("choosing the delete-chain action resolves with the chain names", async () => {
  const { api, opened } = createGuard();
  messageBoxCalls.length = 0;
  messageBoxBehavior = () => "delete-chain";

  const payload = blockedPayload([
    {
      dataset_name: "Paid Loss",
      dependents: [{ dataset_name: "Paid DFM", method_type: "DFM" }],
    },
  ]);
  payload.detail.downstream_closure = [
    { dataset_name: "Paid DFM", method_type: "DFM" },
    { dataset_name: "Selected Ultimate", method_type: "Result Selection" },
  ];

  const decision = await api.showDeleteBlockedByDependents(
    api.readDeleteBlockedDetail(payload),
  );

  assert.deepEqual(decision, {
    deleteChainNames: ["Paid DFM", "Selected Ultimate"],
  });
  assert.deepEqual(opened, [], "confirming the chain delete opens no window");
});

test("one blocked dataset lists its dependents without repeating its own name", async () => {
  const { api } = createGuard();
  messageBoxCalls.length = 0;
  messageBoxBehavior = () => {};

  await api.showDeleteBlockedByDependents(
    api.readDeleteBlockedDetail(
      blockedPayload([
        {
          dataset_name: "Paid Loss",
          dependents: [
            { dataset_name: "Paid DFM", method_type: "DFM" },
            { dataset_name: "Selected Ultimate", method_type: "Result Selection" },
          ],
        },
      ]),
    ),
  );

  const options = messageBoxCalls.at(-1);
  assert.equal(options.title, "Cannot delete: still in use");
  assert.equal(options.closeOnLinkClick, true);
  assert.deepEqual(
    options.links.map((link) => link.label),
    ["Paid DFM — DFM", "Selected Ultimate — Result Selection"],
  );
});

test("several blocked datasets name the input each dependent still reads", async () => {
  const { api } = createGuard();
  messageBoxCalls.length = 0;
  messageBoxBehavior = () => {};

  await api.showDeleteBlockedByDependents(
    api.readDeleteBlockedDetail(
      blockedPayload([
        {
          dataset_name: "Paid Loss",
          dependents: [{ dataset_name: "Paid DFM", method_type: "DFM" }],
        },
        {
          dataset_name: "Reported Loss",
          dependents: [
            { dataset_name: "Paid DFM", method_type: "DFM" },
            { dataset_name: "Exposure", method_type: "None" },
          ],
        },
      ]),
    ),
  );

  assert.deepEqual(
    messageBoxCalls.at(-1).links.map((link) => link.label),
    [
      "Paid DFM — DFM (uses Paid Loss)",
      "Paid DFM — DFM (uses Reported Loss)",
      // A dependent that is not a method output carries no type suffix.
      "Exposure (uses Reported Loss)",
    ],
  );
});

test("clicking a dependent opens it only after the window has closed", async () => {
  const { api, opened } = createGuard();
  messageBoxCalls.length = 0;
  const openedDuringBox = [];
  messageBoxBehavior = (options) => {
    options.onLinkClick(options.links[0]);
    openedDuringBox.push(...opened);
  };

  await api.showDeleteBlockedByDependents(
    api.readDeleteBlockedDetail(
      blockedPayload([
        {
          dataset_name: "Paid Loss",
          dependents: [{ dataset_name: "Paid DFM", method_type: "DFM" }],
        },
      ]),
    ),
  );

  assert.deepEqual(
    openedDuringBox,
    [],
    "opening while the modal is up would leave the new window behind an inert overlay",
  );
  assert.deepEqual(opened, [
    {
      datasetName: "Paid DFM",
      options: { reservingClass: "Direct Group/COLL", methodType: "DFM" },
    },
  ]);
});

test("closing without choosing a dependent opens nothing", async () => {
  const { api, opened } = createGuard();
  messageBoxCalls.length = 0;
  messageBoxBehavior = () => {};

  await api.showDeleteBlockedByDependents(
    api.readDeleteBlockedDetail(
      blockedPayload([
        {
          dataset_name: "Paid Loss",
          dependents: [{ dataset_name: "Paid DFM", method_type: "DFM" }],
        },
      ]),
    ),
  );

  assert.deepEqual(opened, []);
});
