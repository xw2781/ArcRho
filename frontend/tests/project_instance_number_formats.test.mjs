import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("Project Instance exposes the global number-format editor from the dataset toolbar", async () => {
  const [html, boot, moduleSource] = await Promise.all([
    readFile(new URL("ui/project_instance/project_instance.html", root), "utf8"),
    readFile(new URL("ui/project_instance/project_instance_boot.js", root), "utf8"),
    readFile(new URL("ui/project_instance/project_instance_number_formats.js", root), "utf8"),
  ]);

  assert.match(html, /id="datasetNumberFormatsBtn"/);
  assert.match(html, /id="datasetNumberFormatsOverlay"/);
  assert.match(html, /<th>Dataset Type Name<\/th>/);
  assert.doesNotMatch(html, /<th>Dataset Name<\/th>/);
  assert.match(boot, /installProjectInstanceNumberFormats\(ctx\)/);
  assert.match(moduleSource, /\/dataset\/number-format-defaults/);
  assert.match(moduleSource, /method: "PUT"/);
  assert.match(moduleSource, /expected_revision/);
  assert.match(moduleSource, /dataset_type_name/);
  assert.doesNotMatch(moduleSource, /row\.dataset_name/);
});
