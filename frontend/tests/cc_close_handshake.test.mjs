import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ccSource = await readFile(
  new URL("../ui/method_pages/cape_cod/cape_cod_main.js", import.meta.url),
  "utf8",
);
const projectInstanceMessagesSource = await readFile(
  new URL("../ui/project_instance/project_instance_messages.js", import.meta.url),
  "utf8",
);

test("Cape Cod closes through the Project Instance confirmed-close handshake", () => {
  assert.match(ccSource, /function requestConfirmedClose\(\)/);
  assert.match(ccSource, /messageType:\s*"arcrho:dataset-close-confirmed"/);
  assert.doesNotMatch(ccSource, /requestTabbedPageWindowClose\(\{\s*inst\s*\}\)/);

  assert.match(
    projectInstanceMessagesSource,
    /msg\.type === "arcrho:dataset-close-confirmed"[\s\S]*?closeDatasetWindow\(frame, \{ skipChildCloseRequest: true \}\)/,
  );
});

test("Cape Cod does not clear its dirty guard before its host accepts the close", () => {
  const closeFlow = ccSource.match(
    /function requestConfirmedClose\(\)[\s\S]*?async function closeOrConfirm\(\)[\s\S]*?\n\}/,
  )?.[0] || "";

  assert.notEqual(closeFlow, "");
  assert.doesNotMatch(closeFlow, /postDirty\(false/);
});
