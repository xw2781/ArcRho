import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const contractSource = await readFile(
  new URL("../ui/shared/dataset/berquist_sherman_contract.js", import.meta.url),
  "utf8"
);
const {
  BERQUIST_SHERMAN_VARIANTS,
  getBerquistShermanContract,
  normalizeBerquistShermanVariant,
} = await import(`data:text/javascript;base64,${Buffer.from(contractSource).toString("base64")}`);

const [
  htmlSource,
  cacheSource,
  tableSource,
  windowsSource,
  messagesSource,
  dataTabSource,
  indexServiceSource,
  sidecarStatusSource,
  migrationCoreSource,
  methodPageSource,
] = await Promise.all([
  readFile(new URL("../ui/project_instance/project_instance.html", import.meta.url), "utf8"),
  readFile(new URL("../ui/project_instance/project_instance_dataset_cache.js", import.meta.url), "utf8"),
  readFile(new URL("../ui/project_instance/project_instance_dataset_table.js", import.meta.url), "utf8"),
  readFile(new URL("../ui/project_instance/project_instance_windows.js", import.meta.url), "utf8"),
  readFile(new URL("../ui/project_instance/project_instance_messages.js", import.meta.url), "utf8"),
  readFile(new URL("../ui/shared/tabs/data/data_tab_details_controller.js", import.meta.url), "utf8"),
  readFile(new URL("../app_server/services/dataset_instance_index_service.py", import.meta.url), "utf8"),
  readFile(new URL("../app_server/services/dataset_sidecar_status_service.py", import.meta.url), "utf8"),
  readFile(new URL("../../python-api/migration/resq_migration/core.py", import.meta.url), "utf8"),
  readFile(new URL("../ui/method_pages/berquist_sherman/berquist_sherman_main.js", import.meta.url), "utf8"),
]);

test("Berquist Sherman variants share one canonical frontend contract", () => {
  assert.deepEqual(BERQUIST_SHERMAN_VARIANTS, ["sr", "cra"]);
  assert.deepEqual(getBerquistShermanContract("sr"), {
    variant: "sr",
    methodType: "B&S Settlement Rate Adjustment",
    sourceKind: "berquist_sherman_sr",
    filenamePrefix: "BSSR@",
    jsonFormat: "arcrho-berquist-sherman-sr-method-by-tab-v1",
  });
  assert.deepEqual(getBerquistShermanContract("cra"), {
    variant: "cra",
    methodType: "B&S Case Reserve Adequacy Adjustment",
    sourceKind: "berquist_sherman_cra",
    filenamePrefix: "BSCRA@",
    jsonFormat: "arcrho-berquist-sherman-cra-method-by-tab-v1",
  });
  assert.equal(normalizeBerquistShermanVariant("B&S Settlement Rate Adjustment"), "sr");
  assert.equal(normalizeBerquistShermanVariant("berquist_sherman_cra"), "cra");
});

test("Project Instance exposes two direct annual-triangle Add commands", () => {
  assert.match(htmlSource, /data-row-action="add-berquist-sherman-sr">B&amp;S Settlement Rate Adjustment</u);
  assert.match(htmlSource, /data-row-action="add-berquist-sherman-cra">B&amp;S Case Reserve Adequacy Adjustment</u);
  assert.doesNotMatch(htmlSource, /data-row-action="add-bsm"/u);
  assert.match(tableSource, /getDatasetRecordValue\(record, "dataFormat"\)\) === "triangle"/u);
  assert.match(tableSource, /\["", "none"\]\.includes\(normalizeLookupKey\(getDatasetRecordValue\(record, "methodType"\)\)\)/u);
  assert.match(tableSource, /originLength === 12/u);
  assert.match(tableSource, /developmentLength === 12/u);
  assert.match(cacheSource, /meta\.developmentLength = Math\.trunc\(developmentLength\)/u);
  assert.match(tableSource, /fresh:\s*true[\s\S]*?inputTriangle:\s*datasetName[\s\S]*?variant:\s*contract\.variant/u);
});

test("Project Instance routes and restores shared Berquist Sherman windows", () => {
  assert.match(windowsSource, /kind:\s*"berquist_sherman"/u);
  assert.match(windowsSource, /\/ui\/method_pages\/berquist_sherman\/berquist_sherman\.html/u);
  assert.match(windowsSource, /params\.set\("variant", variant\)/u);
  assert.match(windowsSource, /params\.set\("fresh", "1"\)/u);
  assert.match(windowsSource, /params\.set\("input_triangle", toText\(options\.inputTriangle\)\)/u);
  assert.match(windowsSource, /bsTab:\s*kind === "berquist_sherman"/u);
  assert.match(windowsSource, /bsVariant:\s*kind === "berquist_sherman"/u);
  assert.match(messagesSource, /msg\.type === "arcrho:berquist-sherman-tab-changed"/u);
  assert.match(messagesSource, /frame\.dataset\.bsTab = toText\(msg\.tab \|\| ""\)/u);
  assert.match(messagesSource, /openMethod && bsVariant/u);
  assert.match(
    windowsSource,
    /kind === "berquist_sherman"[\s\S]*?openBerquistShermanWindow\(name,\s*\{\s*path:\s*item\?\.path/u,
  );
});

test("a successful B&S draft save rekeys the same Project Instance window to its output name", () => {
  assert.match(
    methodPageSource,
    /type:\s*"arcrho:project-instance-refresh-datasets"[\s\S]*?inst,[\s\S]*?savedDatasetName:\s*details\.name,[\s\S]*?variant/u,
  );
  assert.match(
    messagesSource,
    /msg\.type === "arcrho:project-instance-refresh-datasets"[\s\S]*?syncBerquistShermanWindowIdentity\([\s\S]*?savedDatasetName/u,
  );
  assert.match(windowsSource, /function syncBerquistShermanWindowIdentity\(frame, datasetName, variant = ""\)/u);
  assert.match(windowsSource, /datasetWindows\.delete\(previousKey\)/u);
  assert.match(windowsSource, /frame\.dataset\.windowKey = nextKey/u);
  assert.match(windowsSource, /frame\.dataset\.windowDatasetName = name/u);
  assert.match(windowsSource, /frame\.dataset\.windowItemName = name/u);
  assert.match(windowsSource, /datasetWindows\.set\(nextKey, frame\)/u);
});

test("the shared method page uses the routed tab and generic lifecycle messages", () => {
  assert.match(methodPageSource, /from "\/ui\/shared\/dataset\/berquist_sherman_contract\.js"/u);
  assert.match(methodPageSource, /type:\s*"arcrho:berquist-sherman-tab-changed"/u);
  assert.match(methodPageSource, /type:\s*"arcrho:dataset-dirty"/u);
  assert.match(methodPageSource, /message\.type === "arcrho:dataset-save"/u);
  assert.match(methodPageSource, /messageType:\s*"arcrho:dataset-close-confirmed"/u);
});

test("method JSON and shared Data-tab links retain the canonical B&S method identity", () => {
  assert.match(messagesSource, /filename = `\$\{contract\.filenamePrefix\}\$\{namePart\}\.json`/u);
  assert.match(dataTabSource, /getBerquistShermanContract\(text\)/u);
  assert.match(dataTabSource, /return berquistShermanContract\.methodType/u);
});

test("app-server and migration adapters retain every canonical frontend contract value", () => {
  for (const variant of BERQUIST_SHERMAN_VARIANTS) {
    const contract = getBerquistShermanContract(variant);
    assert.ok(indexServiceSource.includes(contract.jsonFormat));
    assert.ok(indexServiceSource.includes(contract.filenamePrefix));
    assert.ok(sidecarStatusSource.includes(contract.methodType));
    assert.ok(sidecarStatusSource.includes(contract.sourceKind));
    assert.ok(migrationCoreSource.includes(contract.jsonFormat));
    assert.ok(migrationCoreSource.includes(contract.filenamePrefix));
    assert.ok(migrationCoreSource.includes(contract.methodType));
    assert.ok(migrationCoreSource.includes(contract.sourceKind));
  }
});
