import "./ui_module_loader.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// While a User Entry formula is being typed, each reference in it is written in
// the colour the cell it names is filled with. An input cannot colour part of
// its own text, so a layer behind it carries the same characters; these tests
// pin that layer to the input character for character, because a layer that
// drifts by one space puts every colour on the wrong word.

const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;

const barPath = new URL(
  "../ui/method_pages/dfm/ratios_summary/summary_formula_bar.js",
  import.meta.url,
);
const barSource = await readFile(barPath, "utf8");
const formulaBarCss = await readFile(
  new URL("../ui/shared/components/formula_bar/formula_bar.css", import.meta.url),
  "utf8",
);
const dfmCss = await readFile(new URL("../ui/method_pages/dfm/dfm.css", import.meta.url), "utf8");

// Every module the bar pulls in is answered by one stub, except the formula
// tokenizer, which is the real one: the offsets it reports are what the layer
// slices the text with.
const COLORS = new Map([
  ["simple - 5 ex hi/lo", "summaryFormulaRefColor0"],
  ["volume - all", "summaryFormulaRefColor1"],
]);
const stubUrl = dataUrl(`
  export {
    formatFormulaText,
    stripRoundWrappers,
    tokenizeFormula,
  } from "/ui/shared/components/formula_bar/formula_text.js";
  export const attachArcrhoTooltip = () => {};
  export const installDfmDatasetAutocomplete = () => {};
  export const wireFormulaHelper = () => {};
  export const evaluateFormulaValues = async () => ({ ok: false });
  export const getCachedDfmDatasetReferenceValues = () => [];
  export const resolveDfmDatasetReferencesInFormulaDetailed = async () => ({});
  export const createFormulaBarExcelLinkButton = () => ({ el: null, update() {} });
  export const summaryRuntime = {
    summaryFormulaBarState: { mode: "display", input: null, generation: 0 },
    buildSummaryFormulaReferenceColorsByLabel: () => new Map(${
      JSON.stringify(Array.from(COLORS.entries()))
    }),
  };
  export const registerSummaryFunctions = (functions) => Object.assign(summaryRuntime, functions);
`);

/** Just enough of a DOM for a renderer that only appends text and spans. */
function createElementStub(tag) {
  return {
    tag,
    className: "",
    hidden: false,
    children: [],
    _text: "",
    set textContent(value) {
      this._text = String(value ?? "");
      this.children.length = 0;
    },
    get textContent() {
      return this.children.length
        ? this.children.map((child) => child.textContent).join("")
        : this._text;
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
  };
}
globalThis.document = {
  createElement: (tag) => createElementStub(tag),
  createTextNode: (text) => ({ textContent: String(text ?? "") }),
};
globalThis.window = { requestAnimationFrame: () => 0 };

const patchedBar = barSource.replace(
  /"\/ui\/[^"]*"/gu,
  (match) => (match.includes("formula_text.js") ? match : JSON.stringify(stubUrl)),
);
await import(dataUrl(patchedBar));
// The bar registers its functions on the runtime the stub handed it.
const { renderSummaryFormulaEditOverlay } = (await import(stubUrl)).summaryRuntime;

/** The colour class each reference span in the layer was given, in order. */
const spanColors = (overlay) => overlay.children
  .filter((child) => child.className)
  .map((child) => ({ text: child.textContent, className: child.className }));

test("the colour layer holds the formula's own characters, space for space", () => {
  const overlay = createElementStub("div");
  const formula = '=  ("Simple - 5 Ex hi/lo"  +  "Volume - all" * 1.05) / 2 ';
  renderSummaryFormulaEditOverlay(overlay, formula);

  assert.equal(overlay.textContent, formula, "one lost space moves every colour after it");
});

test("each reference is written in the colour its cell is filled with", () => {
  const overlay = createElementStub("div");
  renderSummaryFormulaEditOverlay(overlay, '= ("Simple - 5 Ex hi/lo" + "Volume - all") / 2');

  assert.deepEqual(spanColors(overlay), [
    { text: '"Simple - 5 Ex hi/lo"', className: "fmtEditRowRef summaryFormulaRefColor0" },
    { text: '"Volume - all"', className: "fmtEditRowRef summaryFormulaRefColor1" },
  ]);
});

test("the quotes travel with the reference, so no character is left uncoloured", () => {
  const overlay = createElementStub("div");
  renderSummaryFormulaEditOverlay(overlay, '= "Volume - all" * 2');

  const [ref] = spanColors(overlay);
  assert.equal(ref.text, '"Volume - all"');
  assert.equal(overlay.textContent, '= "Volume - all" * 2');
});

test("a name no row answers to is left in the ordinary colour", () => {
  const overlay = createElementStub("div");
  const formula = '= "Volume - all" + "Not a row"';
  renderSummaryFormulaEditOverlay(overlay, formula);

  assert.deepEqual(spanColors(overlay).map((span) => span.text), ['"Volume - all"']);
  assert.equal(overlay.textContent, formula);
});

test("an empty formula leaves the layer empty", () => {
  const overlay = createElementStub("div");
  renderSummaryFormulaEditOverlay(overlay, "");

  assert.equal(overlay.textContent, "");
  assert.equal(overlay.children.length, 0);
});

test("the layer is shown only while the formula is being typed", () => {
  // One call decides it, from the same flag that swaps the input and the
  // rendered display, so the two can never disagree about the mode.
  assert.match(
    barSource,
    /function updateFormulaBarDisplayMode[\s\S]*?updateSummaryFormulaEditOverlay\(barEl, isEditing\);/u,
  );
  // A disabled or read-only bar shows a value, not a formula being written.
  assert.match(
    barSource,
    /const showColors = !!isEditing && !input\.disabled && !input\.readOnly;/u,
  );
  // The draft decides the colours, so the layer follows every keystroke.
  assert.match(barSource, /input\?\.addEventListener\("input"[\s\S]*?updateSummaryFormulaEditOverlay\(el, true\);/u);
  // A formula too long for the bar scrolls; the layer has to scroll with it.
  assert.match(barSource, /input\?\.addEventListener\("scroll", \(\) => syncSummaryFormulaEditOverlay\(el\)\);/u);
});

test("the input gives up its glyphs to the layer, and nothing else", () => {
  // The caret and the selection stay the input's; only its text goes.
  assert.match(
    formulaBarCss,
    /\.arFormulaBarField\.hasColorOverlay > \.arFormulaBarInput \{\s*color: transparent;\s*-webkit-text-fill-color: transparent;\s*caret-color: var\(--ar-color-text/u,
  );
  // Selected text stays readable because the highlight is a wash, not a block.
  assert.match(
    formulaBarCss,
    /\.arFormulaBarField\.hasColorOverlay > \.arFormulaBarInput::selection \{\s*background: color-mix\(/u,
  );
  // The layer sits in the input's own box and takes no pointer of its own.
  assert.match(
    formulaBarCss,
    /\.arFormulaBarOverlay \{[\s\S]*?position: absolute;[\s\S]*?white-space: pre;[\s\S]*?pointer-events: none;/u,
  );
  // Same font and right-hand padding as the input, or the characters would not
  // land on top of each other.
  assert.match(formulaBarCss, /\.arFormulaBarOverlay \{[\s\S]*?padding: 0 20px 0 0;[\s\S]*?font: inherit;/u);
});

test("the typed reference and its cell read one palette entry", () => {
  // No colour of its own: the layer takes the same custom property the cell
  // outline and the idle pill take.
  assert.match(
    dfmCss,
    /\.dfmSummaryFormulaBarOverlay \.fmtEditRowRef \{\s*color: var\(--dfm-formula-ref-line\);\s*\}/u,
  );
  // A border, a background or a bolder weight would move the glyphs off the
  // input's own.
  const rule = /\.dfmSummaryFormulaBarOverlay \.fmtEditRowRef \{([^}]*)\}/u.exec(dfmCss)?.[1] || "";
  assert.doesNotMatch(rule, /border|background|font-weight|padding|letter-spacing/u);
});
