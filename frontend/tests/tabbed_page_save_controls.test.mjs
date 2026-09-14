import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { statusNeedsReview } from "../ui/shared/dataset/review_status.js";
import { updateTabbedPageSaveControls } from "../ui/shared/tabbed_page/tabbed_page.js";

const frontendRoot = new URL("../", import.meta.url);

function saveBar() {
  const make = () => {
    const element = {
      disabled: false,
      classes: new Set(),
    };
    element.classList = {
      add: (name) => element.classes.add(name),
      toggle: (name, on) => (on ? element.classes.add(name) : element.classes.delete(name)),
    };
    return element;
  };
  return { saveButton: make(), cancelButton: make() };
}

test("Save stays available on a clean page whose object needs review", () => {
  const clean = saveBar();
  updateTabbedPageSaveControls({ ...clean, dirty: false, needsReview: false });
  assert.equal(clean.saveButton.disabled, true, "a clean up-to-date object has nothing to save");

  const review = saveBar();
  updateTabbedPageSaveControls({ ...review, dirty: false, needsReview: true });
  assert.equal(review.saveButton.disabled, false, "re-saving unchanged is how the flag is cleared");
  assert.equal(review.saveButton.classes.has("is-clean"), true, "an unedited page keeps the neutral style");
  assert.equal(review.cancelButton.disabled, false);

  const dirty = saveBar();
  updateTabbedPageSaveControls({ ...dirty, dirty: true, needsReview: false });
  assert.equal(dirty.saveButton.disabled, false);
  assert.equal(dirty.saveButton.classes.has("is-clean"), false);
});

test("an in-flight or blocked save still wins over the review flag", () => {
  const saving = saveBar();
  updateTabbedPageSaveControls({ ...saving, dirty: true, needsReview: true, saving: true });
  assert.equal(saving.saveButton.disabled, true);
  assert.equal(saving.cancelButton.disabled, true);

  const blocked = saveBar();
  updateTabbedPageSaveControls({ ...blocked, dirty: false, needsReview: true, saveBlocked: true });
  assert.equal(blocked.saveButton.disabled, true);
});

test("the Needs Review code comes from one shared reading of the sidecar status", () => {
  assert.equal(statusNeedsReview(2), true);
  assert.equal(statusNeedsReview("2"), true);
  assert.equal(statusNeedsReview(0), false);
  assert.equal(statusNeedsReview(undefined), false);
  assert.equal(statusNeedsReview("review"), false);
});

test("every method page feeds its own review flag into the shared save bar", async () => {
  const pages = [
    "ui/method_pages/dfm/dfm_tabs_orchestrator.js",
    "ui/method_pages/bornhuetter_ferguson/bornhuetter_ferguson_main.js",
    "ui/method_pages/cape_cod/cape_cod_main.js",
    "ui/method_pages/berquist_sherman/berquist_sherman_main.js",
    "ui/method_pages/result_selection/result_selection_ui.js",
  ];
  const sources = await Promise.all(
    pages.map((page) => readFile(new URL(page, frontendRoot), "utf8")),
  );
  for (const [index, source] of sources.entries()) {
    assert.match(source, /needsReview:/u, `${pages[index]} passes needsReview to the save bar`);
  }
  const readers = await Promise.all([
    readFile(new URL("ui/method_pages/dfm/dfm_persistence.js", frontendRoot), "utf8"),
    readFile(new URL("ui/method_pages/bornhuetter_ferguson/bornhuetter_ferguson_main.js", frontendRoot), "utf8"),
    readFile(new URL("ui/method_pages/cape_cod/cape_cod_main.js", frontendRoot), "utf8"),
    readFile(new URL("ui/method_pages/berquist_sherman/berquist_sherman_main.js", frontendRoot), "utf8"),
    readFile(new URL("ui/method_pages/result_selection/result_selection_main.js", frontendRoot), "utf8"),
  ]);
  for (const source of readers) {
    assert.match(source, /shared\/dataset\/review_status\.js/u);
  }
});
