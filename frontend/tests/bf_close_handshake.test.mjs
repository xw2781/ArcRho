import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const bfSource = await readFile(
  new URL("../ui/bornhuetter_ferguson/bornhuetter_ferguson_main.js", import.meta.url),
  "utf8",
);
const projectInstanceMessagesSource = await readFile(
  new URL("../ui/project_instance/project_instance_messages.js", import.meta.url),
  "utf8",
);

test("BF closes through the Project Instance confirmed-close handshake", () => {
  assert.match(bfSource, /function requestConfirmedClose\(\)/);
  assert.match(bfSource, /messageType:\s*"arcrho:dataset-close-confirmed"/);
  assert.doesNotMatch(bfSource, /requestTabbedPageWindowClose\(\{\s*inst\s*\}\)/);

  assert.match(
    projectInstanceMessagesSource,
    /msg\.type === "arcrho:dataset-close-confirmed"[\s\S]*?closeDatasetWindow\(frame, \{ skipChildCloseRequest: true \}\)/,
  );
});

test("BF does not clear its dirty guard before its host accepts the close", () => {
  const closeFlow = bfSource.match(
    /function requestConfirmedClose\(\)[\s\S]*?async function closeOrConfirm\(\)[\s\S]*?\n\}/,
  )?.[0] || "";

  assert.notEqual(closeFlow, "");
  assert.doesNotMatch(closeFlow, /postDirty\(false/);
});
