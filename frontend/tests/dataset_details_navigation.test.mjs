import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const dependenciesSource = await readFile(
  new URL("../ui/shared/tabs/details/details_dependencies.js", import.meta.url),
  "utf8",
);
const dependenciesCss = await readFile(
  new URL("../ui/shared/tabs/details/details_dependencies.css", import.meta.url),
  "utf8",
);

test("a Details precedent or dependent chip requests method-aware routing", () => {
  const chipBuilder = dependenciesSource.match(
    /function buildChip[\s\S]*?\r?\n  \}\r?\n/u,
  )?.[0] || "";

  assert.match(chipBuilder, /openRelated\(entry, \{ openMethod: true \}\)/u);
  assert.match(dependenciesSource, /"cape cod": "Cape Cod"/u);
  assert.match(dependenciesSource, /getBerquistShermanContract\(text\)\?\.methodType/u);
});

test("the formula names its sources as quoted text and leaves opening them to Precedents", () => {
  const formulaComponent = dependenciesSource.match(
    /function appendFormulaComponent[\s\S]*?\r?\n  \}\r?\n/u,
  )?.[0] || "";

  // Plain text, not a control: nothing the user can activate, and the quotes are
  // always drawn so a name containing spaces reads as one operand.
  assert.match(formulaComponent, /doc\.createElement\("span"\)/u);
  assert.match(formulaComponent, /`"\$\{String\(label \?\? ""\)\.trim\(\)\}"`/u);
  assert.doesNotMatch(formulaComponent, /addEventListener|createElement\("button"\)|openRelated/u);

  const component = dependenciesCss.match(/\.arDetailsFormulaComponent \{[^}]*\}/u)?.[0] || "";
  // Read-only colour: the field is display-only, its formula belonging to the
  // dataset type in Project Settings.
  assert.match(component, /color:\s*var\(--ar-details-readonly-color/u);
  assert.doesNotMatch(component, /cursor:\s*pointer|text-decoration/u);
});

test("Project Instance falls back to Dataset Viewer when method-aware routing finds no method", async () => {
  const messagesSource = await readFile(
    new URL("../ui/project_instance/project_instance_messages.js", import.meta.url),
    "utf8",
  );
  const handler = messagesSource.match(
    /function handleOpenDependentDataset[\s\S]*?function handleAutomationWindowCommand/u,
  )?.[0] || "";

  assert.match(handler, /const openMethod = !!message\?\.openMethod/u);
  assert.match(handler, /else \{\s*frame = openDatasetWindow\(datasetName,/u);
});

test("the Dataset Viewer and every method page render Precedents and Dependents from one owner", async () => {
  const consumers = [
    ["../ui/shared/tabs/data/data_tab_details_controller.js", "dsPrecedentsList", "dsDependentsList"],
    ["../ui/method_pages/dfm/dfm_details_dependencies.js", "dfmPrecedentsList", "dfmDependentsList"],
    ["../ui/method_pages/bornhuetter_ferguson/bornhuetter_ferguson_main.js", "bfPrecedentsList", "bfDependentsList"],
    ["../ui/method_pages/cape_cod/cape_cod_main.js", "ccPrecedentsList", "ccDependentsList"],
    ["../ui/method_pages/result_selection/result_selection_main.js", "rsPrecedentsList", "rsDependentsList"],
    ["../ui/method_pages/berquist_sherman/berquist_sherman_main.js", "bsPrecedentsList", "bsDependentsList"],
  ];

  for (const [path, precedentsId, dependentsId] of consumers) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.match(source, /shared\/tabs\/details\/details_dependencies\.js/u, path);
    assert.match(source, new RegExp(`precedentsList: "${precedentsId}"`, "u"), path);
    assert.match(source, new RegExp(`dependentsList: "${dependentsId}"`, "u"), path);
  }

  // The markup has to carry the ids the controllers name, and the shared chip
  // classes rather than page-local copies.
  const markup = [
    ["../ui/dataset_viewer/dataset_viewer_view.js", "ds"],
    ["../ui/method_pages/dfm/dfm.html", "dfm"],
    ["../ui/method_pages/bornhuetter_ferguson/bornhuetter_ferguson.html", "bf"],
    ["../ui/method_pages/cape_cod/cape_cod.html", "cc"],
    ["../ui/method_pages/result_selection/result_selection.html", "rs"],
    ["../ui/method_pages/berquist_sherman/berquist_sherman.html", "bs"],
  ];
  for (const [path, prefix] of markup) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    for (const role of ["Precedents", "Dependents"]) {
      assert.match(
        source,
        new RegExp(`id="${prefix}${role}List" class="arDetailsChipList"`, "u"),
        `${path} ${role}`,
      );
    }
    assert.match(source, /class="arDetailsChipBox"/u, path);
  }
});

test("a method page reads its graph for the dataset it publishes, not for the method", async () => {
  // The sidecar graph is keyed by dataset name. A method page that asked for
  // its own method name would silently render an empty pair of rows.
  assert.match(dependenciesSource, /export async function loadDetailsDependencies/u);
  assert.match(dependenciesSource, /"\/dataset\/sidecar\/load"/u);
  assert.match(dependenciesSource, /precedents: normalizeDependencyEntries\(payload\.Precedents\)/u);
  assert.match(dependenciesSource, /dependents: normalizeDependencyEntries\(payload\.Dependents\)/u);

  const dfmSource = await readFile(
    new URL("../ui/method_pages/dfm/dfm_details_dependencies.js", import.meta.url),
    "utf8",
  );
  assert.match(dfmSource, /datasetName: outputDatasetName/u);

  const persistence = await readFile(
    new URL("../ui/method_pages/dfm/dfm_persistence.js", import.meta.url),
    "utf8",
  );
  // Both the load and the save resolve the output identity, and both repaint.
  const refreshes = persistence.split("refreshDfmDetailsDependencies(currentDfmOutputDataset)").length - 1;
  assert.equal(refreshes, 2);
});

test("no page keeps its own copy of the dependency chip or formula rendering", async () => {
  const featureDirs = [
    "../ui/dataset_viewer/",
    "../ui/method_pages/dfm/",
    "../ui/method_pages/bornhuetter_ferguson/",
    "../ui/method_pages/cape_cod/",
    "../ui/method_pages/result_selection/",
    "../ui/method_pages/berquist_sherman/",
  ];
  for (const dir of featureDirs) {
    const dirUrl = new URL(dir, import.meta.url);
    for (const entry of await readdir(dirUrl, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".css")) continue;
      const css = await readFile(new URL(entry.name, dirUrl), "utf8");
      assert.doesNotMatch(
        css,
        /\.arDetailsChip\b|\.arDetailsChipBox|\.arDetailsFormulaBox|\.arDetailsFormulaComponent/u,
        `${dir}${entry.name} must not restate the shared dependency look`,
      );
    }
  }
});
