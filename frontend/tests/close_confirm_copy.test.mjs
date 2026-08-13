import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../ui/shared/components/close_confirm/close_confirm.js", import.meta.url),
  "utf8",
);

test("dirty-close confirmation uses generic discard copy and a No secondary action", () => {
  assert.match(
    source,
    /"Unsaved changes will be discarded and the window will close\."/,
  );
  assert.match(
    source,
    /data-close-confirm-value="cancel">No<\/button>/,
  );
  assert.doesNotMatch(source, /Unsaved \$\{label\} changes/);
});
