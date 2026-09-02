import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("The macro library request and overwrite prompt have one owner", () => {
  const client = read("../ui/macro/macro_library_client.js");
  const library = read("../ui/macro/macro_library_window.js");
  const macro = read("../ui/macro/macro_window.js");

  assert.match(client, /\/scripting\/macro-library`/);
  assert.match(client, /\/scripting\/macro-library\/install`/);
  assert.match(client, /needs_confirmation/);
  assert.match(client, /new CustomEvent\("arcrho:local-macros-changed"\)/);
  // Neither window may talk to the library or re-ask the overwrite question.
  for (const source of [library, macro]) {
    assert.doesNotMatch(source, /\/scripting\/macro-library/);
    assert.doesNotMatch(source, /needs_confirmation/);
  }
  assert.match(library, /copyLibraryMacroToLocal, fetchLibraryMacros/);
  assert.match(macro, /copyLibraryMacroToLocal,\s*\n\s*fetchLibraryMacros,/);
});

test("A macro with a newer library version wears a stamp that updates it", () => {
  const macro = read("../ui/macro/macro_window.js");
  const css = read("../ui/macro/macro_window.css");

  // Only a library copy whose version is genuinely newer is stamped.
  assert.match(macro, /macro\?\.status === LIBRARY_STATUS_UPDATE_AVAILABLE/);
  assert.match(macro, /found\.set\(macro\.id, macro\)/);
  assert.match(macro, /found\.forEach\(\(macro, id\) => macroLibraryUpdates\.set\(id, macro\)\)/);
  assert.match(macro, /if \(update\) topRow\.appendChild\(createMacroUpdateStamp\(macro, update\)\)/);
  assert.match(macro, /stamp\.textContent = "Update"/);
  assert.match(macro, /stamp\.addEventListener\("click", startUpdate\)/);
  assert.match(macro, /void updateMacroFromLibrary\(macro\)/);
  // Rows carry no native tooltip, so the stamp uses the shared tooltip surface.
  assert.match(macro, /attachArcrhoTooltip\(\s*\n?\s*stamp,/);
  assert.doesNotMatch(macro, /stamp\.title = /);
  // An unreachable library leaves the rows unstamped instead of failing, and
  // an unchanged answer never rebuilds the rendered rows.
  assert.match(macro, /\} catch \{\s*\n\s*found\.clear\(\);/);
  assert.match(macro, /if \(macroUpdateSignature\(found\) === macroUpdateSignature\(macroLibraryUpdates\)\) return;/);
  // Filled yellow so it reads as a stamp beside the outlined scope tags, and a
  // control, so it keeps hover and focus states.
  assert.match(css, /\.macroUpdateStamp \{[^}]*background: #fcd34d/);
  assert.match(css, /\.macroUpdateStamp \{[^}]*cursor: pointer/);
  assert.match(css, /\.macroUpdateStamp:hover \{/);
  assert.match(css, /\.macroUpdateStamp:focus-visible \{/);
});

test("A control inside a macro row keeps its own press", () => {
  const interactions = read("../ui/macro/macro_list_interactions.js");
  const macro = read("../ui/macro/macro_window.js");

  assert.match(interactions, /closest\?\.\("\.macroListItemAction"\)\) return;/);
  assert.match(macro, /stamp\.className = "macroUpdateStamp macroListItemAction"/);
});

test("Both macro windows refresh from the same local-macros event", () => {
  const library = read("../ui/macro/macro_library_window.js");
  const macro = read("../ui/macro/macro_window.js");

  assert.match(library, /addEventListener\("arcrho:local-macros-changed"[\s\S]*?loadLibraryMacros\(\)/);
  assert.match(macro, /addEventListener\("arcrho:local-macros-changed"[\s\S]*?loadMacros\(\)/);
  assert.match(macro, /setMacroStatus\(`\$\{liveMacros\.length\} macro\(s\) available\.`\);\s*\n\s*void refreshMacroLibraryUpdates\(\);/);
});
