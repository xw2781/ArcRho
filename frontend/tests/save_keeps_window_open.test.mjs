// A save is an edit checkpoint, not a way out: every dataset and method window
// stays open after a successful save so the user keeps working in it. Only
// Cancel, the titlebar close, and the close shortcut close a window, each still
// through the dirty-close confirmation handshake.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const SAVE_SURFACES = [
  {
    label: "Dataset",
    path: "ui/shared/tabs/data/data_tab_persistence_controller.js",
    closeFn: "requestConfirmedDatasetClose",
  },
  {
    label: "DFM",
    path: "ui/method_pages/dfm/dfm_tabs_orchestrator.js",
    closeFn: "requestConfirmedDfmClose",
  },
  {
    label: "Bornhuetter Ferguson",
    path: "ui/method_pages/bornhuetter_ferguson/bornhuetter_ferguson_main.js",
    closeFn: "requestConfirmedClose",
  },
  {
    label: "Cape Cod",
    path: "ui/method_pages/cape_cod/cape_cod_main.js",
    closeFn: "requestConfirmedClose",
  },
  {
    label: "Berquist Sherman",
    path: "ui/method_pages/berquist_sherman/berquist_sherman_main.js",
    closeFn: "requestConfirmedClose",
  },
  {
    label: "Result Selection",
    path: "ui/method_pages/result_selection/result_selection_ui.js",
    closeFn: "requestConfirmedClose",
  },
];

async function source(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

// The post-save notice is the tail of every save handler, so the text right
// after it is where a close-on-save call would sit. The scan stops at the next
// top-level function so a neighbouring close handler cannot read as a hit.
const NOTICE_CALL = "showSavedDependentsNotice(";
const TAIL_LENGTH = 260;

function saveHandlerTail(text, index) {
  const tail = text.slice(index, index + TAIL_LENGTH);
  const nextFunction = tail.search(/\n(?:async )?function /u);
  return nextFunction === -1 ? tail : tail.slice(0, nextFunction);
}

test("no save path closes its window", async () => {
  for (const surface of SAVE_SURFACES) {
    const text = await source(surface.path);
    const closeCall = new RegExp(`${surface.closeFn}\\(`, "u");
    let index = text.indexOf(NOTICE_CALL);
    assert.notEqual(index, -1, `${surface.label} no longer reports its refreshed dependents`);
    while (index !== -1) {
      assert.doesNotMatch(
        saveHandlerTail(text, index),
        closeCall,
        `${surface.label} still closes its window after a save`,
      );
      index = text.indexOf(NOTICE_CALL, index + NOTICE_CALL.length);
    }
  }
});

test("the notice still waits for a clean dependent walk", async () => {
  for (const surface of SAVE_SURFACES) {
    const text = await source(surface.path);
    assert.match(
      text,
      /propagationClean/u,
      `${surface.label} no longer gates its post-save notice on the dependent walk`,
    );
  }
});

test("the dirty-close handshake survives on every save surface", async () => {
  for (const surface of SAVE_SURFACES) {
    const text = await source(surface.path);
    assert.match(
      text,
      new RegExp(`function ${surface.closeFn}\\(`, "u"),
      `${surface.label} lost its confirmed-close helper`,
    );
    assert.match(
      text,
      /window\.__arcrho_request_close =/u,
      `${surface.label} lost the host close hook`,
    );
  }
});
