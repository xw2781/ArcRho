import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import {
  BUILTIN_ICON_NAMES,
  DRAW_CANVAS_SIZE,
  DRAW_MARK_TOOLS,
  builtinIconMarks,
  cutMarksNear,
  defaultIconForScopes,
  eraseMarksNear,
  iconForMacro,
  iconToMarks,
  marksToIconMarkup,
  normalizeIcon,
  packMarks,
  sanitizeCustomIcon,
  unpackMarks,
} from "../ui/flight_deck/flight_deck_icons.js";

const point = (x, y) => ({ x, y });

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("View menu and Ctrl+B both drive the Flight Deck", () => {
  const html = read("../ui/index.html");
  const menus = read("../ui/shell/shell_menus.js");
  const hotkeys = read("../ui/shell/shell_hotkeys.js");
  const shell = read("../ui/shell/ui_shell.js");

  assert.match(html, /data-action="toggle-flight-deck"[\s\S]*?Show Flight Deck[\s\S]*?Ctrl\+B/);
  assert.match(menus, /action === "toggle-flight-deck"[\s\S]*?toggleFlightDeck\(\)/);
  assert.match(menus, /isFlightDeckVisible\(\)\s*\?\s*"Hide Flight Deck"\s*:\s*"Show Flight Deck"/);
  assert.match(hotkeys, /"Ctrl\+B":\s*"view_toggle_flight_deck"/);
  assert.match(hotkeys, /action === "view_toggle_flight_deck"[\s\S]*?shell\.toggleFlightDeck/);
  assert.match(shell, /initFlightDeck\(\)/);
  assert.match(shell, /toggleFlightDeck,/);
});

test("dragging a macro onto the deck adds a button instead of deleting the macro", () => {
  const macroWindow = read("../ui/macro/macro_window.js");
  const deck = read("../ui/flight_deck/flight_deck.js");

  assert.match(macroWindow, /closest\?\.\("#flightDeck"\)/);
  assert.match(macroWindow, /flightDeck \? \{ kind: "deck", highlight: flightDeck \} : \{ kind: "remove" \}/);
  assert.match(macroWindow, /target\.kind === "deck"[\s\S]*?arcrho:flight-deck-add-macro/);
  assert.match(deck, /arcrho:flight-deck-add-macro[\s\S]*?addMacroToFlightDeck/);
});

test("a deck button runs its macro through the one shared macro run path", () => {
  const macroWindow = read("../ui/macro/macro_window.js");
  const deck = read("../ui/flight_deck/flight_deck.js");

  assert.match(macroWindow, /export async function runMacroById\(macroId\)/);
  assert.match(macroWindow, /async function runSelectedMacro\(\)[\s\S]*?return runMacro\(macro\)/);
  assert.match(deck, /import \{ runMacroById \} from "\.\.\/macro\/macro_window\.js/);
  assert.match(deck, /await runMacroById\(button\.macroId\)/);
});

test("the deck is dragged with pointer capture and positioned in pixels", () => {
  const deck = read("../ui/flight_deck/flight_deck.js");
  const css = read("../ui/flight_deck/flight_deck.css");

  assert.match(deck, /setPointerCapture/);
  assert.match(deck, /deck\.style\.left = `\$\{Math\.round\(nextLeft\)\}px`/);
  assert.match(css, /#flightDeck \{[\s\S]*?position: fixed;/);
  assert.match(css, /#flightDeck \{[\s\S]*?z-index: 12200;/);
});

test("deck settings are kept in a preferences file on the PC, not in browser storage", () => {
  const deck = read("../ui/flight_deck/flight_deck.js");
  const preload = read("../electron/preload.js");
  const main = read("../electron/main.js");

  assert.match(deck, /host\.loadFlightDeckPreferences\(\)/);
  assert.match(deck, /host\.saveFlightDeckPreferences\(payload\)/);
  assert.match(preload, /loadFlightDeckPreferences:\s*\(\)\s*=>\s*invoke\("flight-deck-preferences-load"\)/u);
  assert.match(preload, /saveFlightDeckPreferences:\s*\(preferences\)\s*=>\s*invoke\("flight-deck-preferences-save",\s*\{ preferences \}\)/u);
  assert.match(main, /ipcMain\.handle\("flight-deck-preferences-load"/u);
  assert.match(main, /ipcMain\.handle\("flight-deck-preferences-save"/u);
  assert.match(main, /const FLIGHT_DECK_PREFS_FILE = "flight_deck\.json";/u);
  // Its own file: macro_prefs.json is written whole, so sharing it would lose the macro order.
  assert.match(main, /function getFlightDeckPrefsPath\(\) \{[\s\S]*?FLIGHT_DECK_PREFS_FILE/u);
});

test("a deck set up before the move is carried into the preferences file once", () => {
  const deck = read("../ui/flight_deck/flight_deck.js");

  assert.match(deck, /const LEGACY_STORAGE_KEY = "arcrho_flight_deck_v1";/);
  assert.match(deck, /const legacy = readLegacyConfig\(\);[\s\S]*?saveConfig\(\);[\s\S]*?localStorage\.removeItem\(LEGACY_STORAGE_KEY\)/);
  assert.match(deck, /waitForHostApi[\s\S]*?adaHostReady/);
  assert.match(deck, /export async function initFlightDeck\(\) \{\s*await ensureConfigLoaded\(\);/);
});

test("built-in icons cover the macro scopes and fall back to a known glyph", () => {
  assert.ok(BUILTIN_ICON_NAMES.length >= 24);
  assert.deepEqual(defaultIconForScopes(["DFM"]), { kind: "builtin", name: "chart" });
  assert.deepEqual(defaultIconForScopes(["reserving class"]), { kind: "builtin", name: "layers" });
  assert.deepEqual(defaultIconForScopes([]), { kind: "builtin", name: "bolt" });
  assert.deepEqual(normalizeIcon({ kind: "builtin", name: "not-a-glyph" }), { kind: "builtin", name: "bolt" });
  assert.deepEqual(normalizeIcon(null), { kind: "builtin", name: "bolt" });
});

test("a macro's own icon name decides the glyph a new button starts with", () => {
  assert.deepEqual(iconForMacro({ icon: "Calculator", scopes: ["DFM"] }), { kind: "builtin", name: "calculator" });
  // An unknown name, or none, leaves the scope glyph in charge rather than showing nothing.
  assert.deepEqual(iconForMacro({ icon: "not-a-glyph", scopes: ["DFM"] }), { kind: "builtin", name: "chart" });
  assert.deepEqual(iconForMacro({ scopes: ["Reserving Class"] }), { kind: "builtin", name: "layers" });
  assert.deepEqual(iconForMacro({ icon: "sync", scope: "Reserving Class" }), { kind: "builtin", name: "sync" });
  assert.deepEqual(iconForMacro(null), { kind: "builtin", name: "bolt" });

  // Both routes to a new button read the macro's icon, and the deck stores whatever the button
  // ended up with, so a user's own choice is never overwritten by the macro.
  const deck = read("../ui/flight_deck/flight_deck.js");
  assert.equal(deck.match(/icon: iconForMacro\(/g)?.length, 2);
  assert.match(deck, /icon: normalizeIcon\(entry\?\.icon\)/);
});

test("every published macro names an icon the deck knows", () => {
  const macroDir = new URL("../../python-api/macros/", import.meta.url);
  const files = readdirSync(macroDir).filter((name) => name.endsWith(".py") && name !== "publish_macro_library.py");
  assert.ok(files.length >= 7);
  for (const name of files) {
    const block = readFileSync(new URL(name, macroDir), "utf8").match(/# <arcrho-macro>[\s\S]*?# <\/arcrho-macro>/)?.[0];
    assert.ok(block, `${name} has no metadata block`);
    const icon = block.match(/^# Icon:\s*(\S+)\s*$/m)?.[1];
    assert.ok(icon, `${name} names no icon`);
    assert.ok(BUILTIN_ICON_NAMES.includes(icon), `${name} names an unknown icon: ${icon}`);
  }
});

test("a pasted drawing is accepted as path data and rejected when it is not a drawing", () => {
  const accepted = sanitizeCustomIcon("M4 4 L20 20");
  assert.equal(accepted.ok, true);
  assert.equal(accepted.icon.kind, "custom");
  assert.match(accepted.icon.markup, /^<path d="M4 4 L20 20"><\/path>$/);

  assert.equal(sanitizeCustomIcon("").ok, false);
  assert.equal(sanitizeCustomIcon("alert('hi')").ok, false);
});

test("the drawing allow-list cannot admit script, handlers, or remote references", () => {
  const icons = read("../ui/flight_deck/flight_deck_icons.js");
  const allowedTags = icons.match(/const ALLOWED_TAGS = new Set\(\[([^\]]*)\]\)/)[1];
  const allowedAttributes = icons.match(/const ALLOWED_ATTRIBUTES = new Set\(\[([\s\S]*?)\]\)/)[1];

  assert.doesNotMatch(allowedTags, /script|image|foreignObject|use|style/);
  assert.doesNotMatch(allowedAttributes, /href|on[a-z]+|style/);
  assert.match(icons, /url\\s\*\\\(\/i\.test\(attribute\.value\)/);
});

test("a drawing on the pad becomes one stroked path in the icon's own coordinates", () => {
  assert.equal(DRAW_CANVAS_SIZE, 24);

  const line = marksToIconMarkup([{ tool: "pen", points: [point(0, 0), point(12, 12), point(24, 24)] }]);
  assert.match(line, /^<path d="M0 0Q12 12 18 18L24 24"/);
  // The stylesheet fills custom icons, so a drawn line has to carry its own stroke to be seen.
  assert.match(line, /fill="none" stroke="currentColor" stroke-width="1\.6"/);

  // Two lifts of the mouse stay one path, and a single click is kept as a round dot.
  const twoLines = marksToIconMarkup([
    { tool: "pen", points: [point(1, 1), point(20, 3)] },
    { tool: "pen", points: [point(6, 6)] },
  ]);
  assert.match(twoLines, /d="M1 1L20 3M6 6L6 6"/);
  assert.equal((twoLines.match(/<path/g) || []).length, 1);
  assert.match(twoLines, /stroke-linecap="round"/);

  // Samples a hand cannot separate are dropped, so a slow drag does not turn into a furry line.
  const jitter = [{ tool: "pen", points: [point(4, 4), point(4.05, 4.05), point(4.1, 4.1)] }];
  assert.match(marksToIconMarkup(jitter), /d="M4 4L4 4"/);

  assert.equal(marksToIconMarkup([]), "");
  assert.equal(marksToIconMarkup([{ tool: "pen", points: [] }]), "");
});

test("each shape tool draws its own outline whichever way it was dragged", () => {
  assert.deepEqual(DRAW_MARK_TOOLS, ["pen", "line", "box", "oval"]);

  assert.match(marksToIconMarkup([{ tool: "line", points: [point(3, 4), point(20, 18)] }]), /d="M3 4L20 18"/);
  // A box or an oval is the same shape dragged from any corner, so both orders give one outline.
  const boxUp = marksToIconMarkup([{ tool: "box", points: [point(20, 18), point(3, 4)] }]);
  assert.match(boxUp, /d="M3 4H20V18H3Z"/);
  assert.equal(boxUp, marksToIconMarkup([{ tool: "box", points: [point(3, 4), point(20, 18)] }]));
  assert.match(marksToIconMarkup([{ tool: "oval", points: [point(4, 6), point(20, 18)] }]), /d="M4 12A8 6 0 1 0 20 12A8 6 0 1 0 4 12Z"/);

  // A shape dragged nowhere at all leaves nothing behind.
  assert.equal(marksToIconMarkup([{ tool: "oval", points: [point(8, 8), point(8, 8)] }]), "");
});

test("the eraser takes away whole pieces of the drawing it is passed over", () => {
  const marks = [
    { tool: "line", points: [point(0, 2), point(10, 2)] },
    { tool: "box", points: [point(14, 14), point(20, 20)] },
    { tool: "pen", points: [point(2, 22), point(8, 22)] },
  ];

  // A pass near the top line takes that line and leaves the box and the freehand mark alone.
  assert.deepEqual(eraseMarksNear(marks, point(5, 2.5)).map((mark) => mark.tool), ["box", "pen"]);
  // The box goes when its outline is brushed, not only when its middle is.
  assert.deepEqual(eraseMarksNear(marks, point(17, 14.2)).map((mark) => mark.tool), ["line", "pen"]);
  assert.equal(eraseMarksNear(marks, point(17, 17)).length, 3);
  assert.equal(eraseMarksNear(marks, point(12, 8)).length, 3);
});

test("a built-in glyph comes apart into pieces the pad can work on", () => {
  // The clock is a circle and a pair of hands: an oval the shape tools understand, and one run of
  // the glyph's own path data kept as it was drawn.
  assert.deepEqual(builtinIconMarks("clock"), [
    { tool: "oval", points: [point(4, 4), point(20, 20)] },
    { tool: "path", d: "M12 7.5V12l3 2" },
  ]);

  // Each move-to is its own piece, so one dot of the calculator's keypad can be rubbed out.
  const calculator = builtinIconMarks("calculator");
  assert.equal(calculator.filter((mark) => mark.tool === "box").length, 2);
  assert.equal(calculator.filter((mark) => mark.tool === "path").length, 6);

  assert.deepEqual(iconToMarks({ kind: "builtin", name: "clock" }), builtinIconMarks("clock"));
  assert.deepEqual(builtinIconMarks("not-a-glyph"), []);
  // A pasted drawing cannot be taken apart, so the pad stays clear for it.
  assert.deepEqual(iconToMarks({ kind: "custom", markup: '<path d="M2 2L8 8"></path>' }), []);
});

test("a drawing keeps its pieces so the pad reopens on it rather than empty", () => {
  const drawn = [
    { tool: "pen", points: [point(2, 2), point(9, 14)] },
    { tool: "box", points: [point(18, 4), point(18.5, 20)] },
    { tool: "path", d: "M12 7.5V12l3 2" },
  ];
  const packed = packMarks(drawn);
  assert.deepEqual(packed, [
    { t: "pen", p: [2, 2, 9, 14] },
    { t: "box", p: [18, 4, 18.5, 20] },
    { t: "path", d: "M12 7.5V12l3 2" },
  ]);

  const stored = normalizeIcon({ kind: "custom", markup: marksToIconMarkup(drawn), marks: packed });
  assert.deepEqual(stored.marks, packed);
  assert.deepEqual(unpackMarks(stored.marks), drawn);

  // A drawing saved before the shape tools existed is a bare list of points: a freehand line.
  assert.deepEqual(normalizeIcon({ kind: "custom", markup: '<path d="M0 0"></path>', strokes: [[1, 1, 9, 9]] }).marks, [{ t: "pen", p: [1, 1, 9, 9] }]);

  // Nonsense in the preferences file is dropped rather than drawn, and a glyph never carries any.
  assert.equal(normalizeIcon({ kind: "custom", markup: '<path d="M0 0"></path>', marks: "scribble" }).marks, undefined);
  assert.equal(normalizeIcon({ kind: "builtin", name: "bolt", marks: [{ t: "pen", p: [1, 2, 3, 4] }] }).marks, undefined);
  assert.deepEqual(unpackMarks([{ t: "path", d: "alert('hi')" }, { t: "nope", p: [1, 2, 3, 4] }]), []);

  // A point drawn off the pad is pulled back to the edge instead of stretching the icon.
  assert.deepEqual(packMarks([{ tool: "pen", points: [point(-8, 40), point(12, 12)] }]), [{ t: "pen", p: [0, 24, 12, 12] }]);
});

test("the drawing pad tracks the pointer through capture and lands on the button when released", () => {
  const editor = read("../ui/flight_deck/flight_deck_editor.js");

  assert.match(editor, /pad\.addEventListener\("pointerdown"[\s\S]*?pad\.setPointerCapture\(event\.pointerId\)/);
  assert.match(editor, /pad\.addEventListener\("pointercancel", endStroke\)/);
  assert.match(editor, /if \(finished\.mark && keepMark\(finished\.mark\)\) session\.marks\.push\(finished\.mark\)/);
  // Anything the pad produces is cleaned by the same gate a pasted drawing goes through.
  assert.match(editor, /function commitDrawing\(\)[\s\S]*?sanitizeCustomIcon\(`<svg viewBox="\$\{DRAW_VIEWBOX\}">\$\{markup\}<\/svg>`\)/);
  // An empty pad hands the button back to the glyph that was in force before the drawing started.
  assert.match(editor, /if \(!markup\) \{\s*\n\s*session\.icon = normalizeIcon\(session\.baseIcon\);/);
});

test("the pad carries the five tools, and undo steps back through everything they do", () => {
  const editor = read("../ui/flight_deck/flight_deck_editor.js");
  const css = read("../ui/flight_deck/flight_deck.css");

  assert.match(editor, /const DRAW_TOOLS = \[[\s\S]*?id: "pen"[\s\S]*?id: "line"[\s\S]*?id: "box"[\s\S]*?id: "oval"[\s\S]*?id: "erase"[\s\S]*?\];/);
  assert.match(editor, /session\.marks = tool === \"cut\"\s*\n\s*\? cutMarksNear\(session\.marks, point, eraserRadius\)\s*\n\s*: eraseMarksNear\(session\.marks, point, eraserRadius\)/);
  assert.match(editor, /constrainShape\(stroke\.tool, stroke\.mark\.points\[0\], point, event\.shiftKey\)/);
  // Every change is snapshotted, so undo steps back over an erase as readily as over a line.
  assert.match(editor, /if \(session\.marks\.length !== finished\.before\.length\) pushHistory\(finished\.before\)/);
  assert.match(editor, /session\.marks = session\.history\.pop\(\)/);
});

test("the pad's tools sit in one compact toolbar, with their icons kept as files", () => {
  const editor = read("../ui/flight_deck/flight_deck_editor.js");
  const css = read("../ui/flight_deck/flight_deck.css");
  const icons = read("../ui/flight_deck/draw-tool-icons/draw_tool_icons.css");

  assert.match(editor, /toolbar\.setAttribute\("role", "toolbar"\)/);
  assert.match(editor, /const \[undoBtn, clearBtn\] = DRAW_ACTIONS\.map/);
  // No path data lives in the module: every glyph is a file the mask stylesheet points at.
  assert.doesNotMatch(editor, /<path d=/);
  ["pen", "line", "box", "oval", "erase", "cut", "undo", "clear"].forEach((tool) => {
    assert.match(read(`../ui/flight_deck/draw-tool-icons/${tool}.svg`), /stroke="currentColor"/);
    if (tool !== "pen") {
      assert.match(icons, new RegExp(`\\[data-draw-tool="${tool}"\\] \\{[\\s\\S]*?mask-image: url\\("${tool}\\.svg`));
    }
  });
  // The eraser's pressed state is red where the drawing tools' is blue.
  assert.match(css, /\.flightDeckDrawTool\[data-tool="erase"\]\[aria-pressed="true"\],\s*\n\.flightDeckDrawTool\[data-tool="cut"\]\[aria-pressed="true"\] \{/);
  // The running note under the pad is gone; only a rejected paste still says anything.
  assert.doesNotMatch(editor, /flightDeckEditorNote/);
  assert.doesNotMatch(css, /flightDeckEditorNote/);
  assert.match(editor, /showPasteError\(result\.error\)/);
});

test("the area eraser cuts only what its ring covers and leaves the rest as lines", () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 0.01, `${a} is not near ${b}`);
  const across = { tool: "line", points: [point(2, 12), point(22, 12)] };
  const clear = { tool: "line", points: [point(2, 4), point(22, 4)] };
  const dot = { tool: "pen", points: [point(12, 11)] };

  const cut = cutMarksNear([across, clear, dot], point(12, 12), 1.6);
  // The line through the ring becomes two lines that stop at the ring's edge; the dot under it is
  // gone; the line clear of it is the very same piece.
  assert.deepEqual(cut.map((mark) => mark.tool), ["line", "line", "line"]);
  near(cut[0].points[1].x, 10.4);
  near(cut[1].points[0].x, 13.6);
  assert.equal(cut[2], clear);

  // A box cut at one corner opens into straight lines rather than a rounded pen stroke, and the
  // rest of its edges are kept whole.
  const box = { tool: "box", points: [point(4, 4), point(20, 20)] };
  const opened = cutMarksNear([box], point(4, 4), 1.6);
  assert.ok(opened.length >= 3 && opened.every((mark) => mark.tool === "line"));
  assert.ok(opened.some((mark) => mark.points[0].x === 20 && mark.points[1].x === 20));

  // An oval and a measured glyph curve are left as freehand runs; an unmeasured curve stays put.
  const oval = { tool: "oval", points: [point(4, 6), point(20, 18)] };
  assert.ok(cutMarksNear([oval], point(12, 6), 1.6).every((mark) => mark.tool === "pen"));
  const curve = { tool: "path", d: "M2 2L22 22", outline: [point(2, 2), point(12, 12), point(22, 22)] };
  assert.equal(cutMarksNear([curve], point(12, 12), 1.6).length, 2);
  const unmeasured = { tool: "path", d: "M2 2L22 22" };
  assert.deepEqual(cutMarksNear([unmeasured], point(12, 12), 1.6), [unmeasured]);
});

test("the eraser ring is resized with plus and minus, and both erasers use it", () => {
  const editor = read("../ui/flight_deck/flight_deck_editor.js");
  const css = read("../ui/flight_deck/flight_deck.css");

  assert.match(editor, /id: "cut", label: "Erase Area"/);
  assert.match(editor, /cutMarksNear\(session\.marks, point, eraserRadius\)/);
  assert.match(editor, /eraseMarksNear\(session\.marks, point, eraserRadius\)/);
  // Plus and minus reach the pad from the number pad or the main keys, never from a text box.
  assert.match(editor, /event\.key === "\+" \|\| event\.key === "=" \|\| event\.key === "-"\) && isEraser\(activeTool\) && !isTextTarget\(event\.target\)/);
  assert.match(editor, /padWrap\.focus\(\{ preventScroll: true \}\)/);
  assert.match(editor, /r="\$\{eraserRadius\}" class="flightDeckEraserRing"/);
  assert.match(css, /\.flightDeckDrawTool\[data-tool="cut"\]\[aria-pressed="true"\] \{/);
});

test("picking a built-in glyph puts it on the pad to be worked on", () => {
  const editor = read("../ui/flight_deck/flight_deck_editor.js");

  assert.match(editor, /if \(swatch\) takeGlyphToPad\(swatch\.dataset\.iconName\)/);
  assert.match(editor, /function takeGlyphToPad[\s\S]*?session\.marks = measureMarks\(iconToMarks\(icon\)\)/);
  // It stays the plain built-in icon until the pad is actually drawn on.
  assert.match(editor, /function takeGlyphToPad[\s\S]*?session\.icon = icon;/);
  // Reopening any button lays its icon back out on the pad the same way.
  assert.match(editor, /session\.marks = iconToMarks\(session\.icon\)/);
  assert.match(editor, /overlay\.classList\.add\("open"\);[\s\S]*?measureMarks\(session\.marks\)/);
  assert.match(editor, /session\.baseIcon = session\.marks\.length \? normalizeIcon\(null\) : session\.icon/);
  assert.match(editor, /normalizeIcon\(\{ \.\.\.result\.icon, marks: packMarks\(session\.marks\) \}\)/);
});

test("the deck keeps a custom icon out of the built-in glyph path", () => {
  const custom = normalizeIcon({ kind: "custom", viewBox: "0 0 32 32", markup: '<circle cx="16" cy="16" r="8"></circle>' });
  assert.equal(custom.kind, "custom");
  assert.equal(custom.viewBox, "0 0 32 32");

  const badViewBox = normalizeIcon({ kind: "custom", viewBox: "javascript:alert(1)", markup: "<path d=\"M0 0\"></path>" });
  assert.equal(badViewBox.viewBox, "0 0 24 24");
});
