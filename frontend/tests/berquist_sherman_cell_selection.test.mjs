import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [html, main, css, selection] = await Promise.all([
  read("../ui/method_pages/berquist_sherman/berquist_sherman.html"),
  read("../ui/method_pages/berquist_sherman/berquist_sherman_main.js"),
  read("../ui/method_pages/berquist_sherman/berquist_sherman.css"),
  read("../ui/method_pages/berquist_sherman/berquist_sherman_cell_selection.js"),
]);

test("B&S grids take their selection from the shared spreadsheet controller", () => {
  // The same controller the Dataset Viewer and Result Selection grids use, and
  // the shared sticky-aware scroll, so the UX cannot drift from theirs.
  assert.match(
    selection,
    /import \{ createSpreadsheetTableController \} from "\/ui\/shared\/components\/spreadsheet\/spreadsheet_table\.js\?v=/u,
  );
  assert.match(
    selection,
    /import \{ scrollSpreadsheetCellIntoView \} from "\/ui\/shared\/components\/spreadsheet\/table_selection\.js\?v=20260726a"/u,
  );
  assert.match(selection, /getCellValue: \(_position, cell\) => cell\?\.dataset\?\.copyValue \?\? ""/u);
  // Row labels and column headers select their line; value cells carry both
  // positions.
  assert.match(selection, /const CELL_SELECTOR = "td\[data-r\]\[data-c\]";/u);
  assert.match(selection, /const ROW_LABEL_SELECTOR = "td\[data-r\]:not\(\[data-c\]\)";/u);
  assert.match(selection, /const COLUMN_HEADER_SELECTOR = "thead th\[data-c\]";/u);
  // Click, drag, Shift-extend, Ctrl-append, arrows, Ctrl+C, and Escape.
  assert.match(selection, /controller\.selectCell\(position, \{ append, extend: event\.shiftKey \}\)/u);
  assert.match(selection, /controller\.setRange\(drag\.anchor, positionOf\(cell\), \{ append: drag\.append, baseRanges: drag\.baseRanges \}\)/u);
  assert.match(selection, /controller\.move\(delta\[0\], delta\[1\], \{\s*extend: event\.shiftKey,\s*jump: event\.ctrlKey \|\| event\.metaKey,\s*\}\)/u);
  assert.match(selection, /String\(event\.key\)\.toLowerCase\(\) !== "c"/u);
  assert.match(selection, /if \(event\.key === "Escape"\)/u);
  // A key a grid cell already handled (the User Value row's Left and Right)
  // must not move the highlight a second time.
  assert.match(selection, /if \(event\.defaultPrevented \|\| isTypingTarget\(event\.target\)\) return;/u);
  // The two stacked Avg. Selections grids are exclusive.
  assert.match(selection, /if \(activeKey && activeKey !== key\) entries\.get\(activeKey\)\?\.controller\.clear\(\);/u);
});

test("every B&S calculation grid tags its cells for selection and copy", () => {
  assert.match(main, /import \{ createBerquistShermanCellSelection \} from "\.\/berquist_sherman_cell_selection\.js";/u);
  assert.match(main, /\{ key: "primary", table: els\.methodTable, scrollHost: els\.methodTableWrap \}/u);
  assert.match(main, /\{ key: "secondary", table: els\.secondaryTable, scrollHost: els\.secondaryTableWrap \}/u);
  // The raw figure is what copies, as on the Dataset Viewer; the display text
  // keeps the view's format.
  assert.match(
    main,
    /function tagValueCell\(cell, rowIndex, colIndex, rawValue\) \{[\s\S]*?cell\.dataset\.copyValue = numberOrNull\(rawValue\) === null \? "" : String\(rawValue\);/u,
  );
  assert.match(main, /header\.dataset\.c = String\(devIndex\);/u);
  assert.match(main, /ultimateHeader\.dataset\.c = String\(developmentCount\);/u);
  assert.match(main, /tagValueCell\(ultimateCell, rowIndex, developmentCount, rawValue\)/u);
  // The masked corner is part of the grid, so a drag to it takes the triangle.
  assert.match(main, /function maskedCell\(rowIndex, devIndex\) \{[\s\S]*?return tagValueCell\(cell, rowIndex, devIndex, null\);/u);
  // Grouping and caption rows are not rows of values; the value rows number
  // consecutively in the Adjusted Paid Claims and Avg. Selections grids.
  assert.equal(Array.from(main.matchAll(/let gridRowIndex = 0;/gu)).length, 2);
  assert.equal(Array.from(main.matchAll(/gridRowIndex \+= 1;/gu)).length, 2);
  assert.match(main, /tagValueCell\(cell, gridRowIndex, devIndex, rawValue\)/u);
  // The Proportion Settled Selected row is the row after the triangle.
  assert.match(main, /tagRowLabel\(document\.createElement\("td"\), proportionMatrix\.length\)/u);
  assert.match(main, /tagValueCell\(document\.createElement\("td"\), proportionMatrix\.length, devIndex, selectedValues\[devIndex\]\)/u);
  // Every row label of every grid is a row selector.
  assert.equal(Array.from(main.matchAll(/tagRowLabel\(document\.createElement\("td"\), /gu)).length, 5);
  // A re-render paints the selection back; a view change drops it.
  assert.match(main, /function renderMethodTable\(\) \{[\s\S]*?renderMethodGrids\(\);[\s\S]*?cellSelection\.applyDom\(\);\s*\n\}/u);
  assert.match(main, /state\.currentView = view\.key;\s*\n\s*cellSelection\.clearAll\(\);/u);
  // Ctrl+C copies through the selection alone; the page keeps no copy handler
  // of its own.
  assert.doesNotMatch(main, /addEventListener\("copy"/u);
  assert.doesNotMatch(main, /proportionContextMenu/u);
});

test("the B&S cell context menu matches the Dataset Viewer's", () => {
  assert.match(html, /<div id="bsCellContextMenu" class="ctx-menu" role="menu" style="display:none;">/u);
  assert.match(html, /<button class="ctx-item" type="button" data-action="copy_value">Copy values<\/button>/u);
  assert.match(html, /<button class="ctx-item" type="button" data-action="remove_highlights">Remove Highlights<\/button>/u);
  assert.match(html, /id="bsSelectLeadingDiagonalItem" data-action="select_leading_diagonal" hidden>/u);
  assert.match(main, /els\.selectLeadingDiagonalItem\.hidden = !\(variant === "sr" && state\.currentView === "proportionSettled"\);/u);
  assert.match(html, /id="bsMethodTable"/u);
  assert.match(html, /id="bsSecondaryTable"/u);
});

test("a highlighted B&S cell keeps the fill that carries meaning", () => {
  // The selection tint layers over the band and picked-source fills.
  assert.match(
    css,
    /\.bsMethodTable td\.bsSelUserCell\[aria-selected="true"\],\s*\n\.bsMethodTable tr\.bsPropSelectedRow td\[aria-selected="true"\] \{[^}]*linear-gradient\(var\(--ar-spreadsheet-selection-fill\), var\(--ar-spreadsheet-selection-fill\)\),\s*\n\s*var\(--bs-selected-band\);/u,
  );
  assert.match(
    css,
    /\.bsMethodTable td\[aria-selected="true"\]:is\(\.bsAdjSelectedSource, \.bsPropSelectedSource, \.bsSelSelectedSource\) \{[^}]*var\(--ar-spreadsheet-weighted-selection-fill\);/u,
  );
  // The sticky label column and the headers take the shared selected-label fill.
  assert.match(
    css,
    /\.bsMethodTable td:first-child\.arSpreadsheetSelectedLabel,\s*\n\.bsMethodTable thead th\.arSpreadsheetSelectedLabel \{\s*\n\s*background: var\(--ar-spreadsheet-selected-label-fill\);/u,
  );
  // Row hover leaves a highlighted cell alone.
  const hover = css.match(/\.bsMethodTable tbody tr[^{]*:hover[^{]*\{[^}]*--bs-row-hover[^}]*\}/u);
  assert.ok(hover, "row-hover rule not found");
  assert.match(hover[0], /\[aria-selected="true"\]/u);
});
