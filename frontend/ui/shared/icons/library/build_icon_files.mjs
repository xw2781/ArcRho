/*
 * Writes one standalone `.svg` per entry in arcrho_icon_library.js into this folder.
 *
 * The module is the source of truth; these files exist so a glyph can also be used the way the
 * tab-type set is used — as a CSS mask over `currentColor`, or as a plain `<img>` — without a
 * second hand-maintained copy of the artwork drifting from the inline one.
 *
 *   frontend/node-portable/node.exe frontend/ui/shared/icons/library/build_icon_files.mjs
 *
 * Files whose text already matches are left alone, so a rebuild only touches what really changed.
 * A `.svg` in this folder with no matching entry is reported and left in place; deleting artwork is
 * never something a build script should decide on its own.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ARCRHO_ICONS, iconFileText } from "./arcrho_icon_library.js";

const here = dirname(fileURLToPath(import.meta.url));

let written = 0;
let unchanged = 0;

for (const name of Object.keys(ARCRHO_ICONS)) {
  const target = join(here, `${name}.svg`);
  const text = iconFileText(name);
  let current = null;
  try {
    current = readFileSync(target, "utf8");
  } catch {
    current = null;
  }
  if (current === text) {
    unchanged += 1;
    continue;
  }
  writeFileSync(target, text, "utf8");
  written += 1;
}

const orphans = readdirSync(here)
  .filter((entry) => entry.endsWith(".svg"))
  .map((entry) => entry.slice(0, -4))
  .filter((name) => !Object.prototype.hasOwnProperty.call(ARCRHO_ICONS, name));

console.log(`icons: ${Object.keys(ARCRHO_ICONS).length}  written: ${written}  unchanged: ${unchanged}`);
if (orphans.length) {
  console.log(`no longer in the library, left on disk: ${orphans.join(", ")}`);
}
