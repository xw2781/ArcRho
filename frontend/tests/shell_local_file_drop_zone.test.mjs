import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { handleShellFileDragOver, handleShellFileDrop } from "../ui/shell/shell_file_drop.js";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

function makeFileDragEvent({ insideDropZone }) {
  const calls = { prevented: 0, stopped: 0 };
  return {
    calls,
    target: {
      closest: (selector) => (insideDropZone && selector === "[data-file-drop-zone]" ? {} : null),
    },
    dataTransfer: { types: ["Files"], files: [], items: [] },
    preventDefault() { calls.prevented += 1; },
    stopPropagation() { calls.stopped += 1; },
  };
}

test("a file dragged over a panel that reads files itself is left to that panel", () => {
  const dragOver = makeFileDragEvent({ insideDropZone: true });
  assert.equal(handleShellFileDragOver(dragOver), false);
  assert.equal(dragOver.calls.prevented, 0, "the shell must not claim the drag");

  const drop = makeFileDragEvent({ insideDropZone: true });
  assert.equal(handleShellFileDrop(drop), false);
  assert.equal(drop.calls.prevented, 0, "the shell must not consume the drop");
});

// The drag-over half of this case paints the shell overlay, which needs a document;
// the drop half runs headless and is what proves the guard is target-specific.
test("a file dropped anywhere else is still the shell's scripting-file drop", () => {
  const drop = makeFileDragEvent({ insideDropZone: false });
  assert.equal(handleShellFileDrop(drop), true);
  assert.equal(drop.calls.prevented, 1);
});

test("a panel that reads settings files marks itself with the attribute the shell looks for", async () => {
  const settingsFile = await read("../ui/shared/components/settings_file/settings_file.js");
  assert.match(
    settingsFile,
    /target\.dataset\.fileDropZone = String\(options\?\.name \|\| "settings-file"\);/u,
    "the shared drop zone must carry the attribute the shell looks for",
  );

  // Both panels reach the shell through that one helper, so neither can drift
  // into its own drop wiring and lose the shell's yield.
  const picker = await read("../ui/shared/components/pickers/path_tree_picker.js");
  assert.match(picker, /attachSettingsFileDropZone\(win, \{/u);
  const datasetTable = await read("../ui/project_instance/project_instance_dataset_table.js");
  assert.match(datasetTable, /attachSettingsFileDropZone\(els\.rightPanel, \{/u);
});
