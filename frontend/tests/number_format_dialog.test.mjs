import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const frontendRoot = new URL("../", import.meta.url);
const read = (relativePath) => readFile(new URL(relativePath, frontendRoot), "utf8");

const formatUrl = new URL("ui/shared/dataset/dataset_number_format.js", frontendRoot);
const {
  applyDecimalPlacesToDatasetNumberFormat,
  datasetNumberValueColor,
  formatDatasetNumberValue,
  getDatasetNumberFormatDecimalPlaces,
} = await import(formatUrl.href);

// The dialog resolves the format engine through the app server's absolute `/ui`
// route, which node cannot serve.
const dialogSource = await read("ui/shared/components/pickers/number_format_dialog.js");
const {
  buildNumberFormatCode,
  detectNumberFormatState,
  NUMBER_FORMAT_CATEGORIES,
  NUMBER_FORMAT_SYMBOLS,
} = await import(
  `data:text/javascript;base64,${Buffer.from(
    dialogSource.replace(
      /"\/ui\/shared\/dataset\/dataset_number_format\.js"/u,
      JSON.stringify(formatUrl.href),
    ),
  ).toString("base64")}`
);

test("the patterns the app already stores render exactly as they did", () => {
  assert.equal(formatDatasetNumberValue(1234.5678, "0,000", 0), "1,235");
  assert.equal(formatDatasetNumberValue(1234.5678, "0,000.00", 2), "1,234.57");
  assert.equal(formatDatasetNumberValue(0.123456, "0.0%", 1), "12.3%");
  assert.equal(formatDatasetNumberValue(1234.5678, "0", 0), "1235");
  assert.equal(formatDatasetNumberValue(-1234.5678, "0,000", 0), "-1,235");
  assert.equal(formatDatasetNumberValue(0, "0,000", 0), "0");
  // The integer part is never padded, whatever the pattern's zeros suggest.
  assert.equal(formatDatasetNumberValue(5, "0,000", 0), "5");
  assert.equal(formatDatasetNumberValue("not a number", "0,000", 0), "");
});

test("Excel sections, colours, scaling and scientific notation are honoured", () => {
  assert.equal(formatDatasetNumberValue(-1234.5678, "#,##0.00;(#,##0.00)", 2), "(1,234.57)");
  assert.equal(formatDatasetNumberValue(0, '#,##0;(#,##0);"-"', 0), "-");
  assert.equal(formatDatasetNumberValue(-1234.5678, "$#,##0.00", 2), "-$1,234.57");
  assert.equal(formatDatasetNumberValue(1234567, '#,##0,,"M"', undefined), "1M");
  assert.equal(formatDatasetNumberValue(1234.5678, "0.00E+00", 2), "1.23E+03");
  assert.equal(formatDatasetNumberValue(0.000012345, "0.00E+00", 2), "1.23E-05");
  assert.equal(formatDatasetNumberValue(1234.5678, "General"), "1234.5678");
  // A value that rounds away to nothing must not keep its sign.
  assert.equal(formatDatasetNumberValue(-0.004, "0.0", 1), "0.0");
});

test("an explicit decimal count owns a fixed fraction and leaves an optional one alone", () => {
  assert.equal(formatDatasetNumberValue(1234.5678, "#,##0.00", 1), "1,234.6");
  assert.equal(formatDatasetNumberValue(1234.5, "#,##0.##", 0), "1,234.5");
  assert.equal(formatDatasetNumberValue(1234, "#,##0.##", 0), "1,234");
});

test("a section colour is reported apart from the text it renders", () => {
  const pattern = "#,##0.00;[Red](#,##0.00)";
  assert.match(datasetNumberValueColor(-1, pattern), /--ar-number-format-red/u);
  assert.equal(datasetNumberValueColor(1, pattern), "");
  assert.equal(datasetNumberValueColor(-1, "#,##0.00"), "");
});

test("Decimal Places rewrites every section of a pattern", () => {
  assert.equal(applyDecimalPlacesToDatasetNumberFormat("#,##0.00;(#,##0.00)", 1), "#,##0.0;(#,##0.0)");
  assert.equal(applyDecimalPlacesToDatasetNumberFormat("0,000", 2), "0,000.00");
  assert.equal(applyDecimalPlacesToDatasetNumberFormat("0.0%", 0), "0%");
  assert.equal(applyDecimalPlacesToDatasetNumberFormat("General", 2), "General");
  assert.equal(getDatasetNumberFormatDecimalPlaces("#,##0.00;(#,##0.00)"), 2);
});

test("each category writes the Excel code for its options", () => {
  assert.equal(buildNumberFormatCode({ category: "general" }), "General");
  assert.equal(buildNumberFormatCode({ category: "number", decimals: 2, separator: true, negative: 0 }), "#,##0.00");
  assert.equal(buildNumberFormatCode({ category: "number", decimals: 0, separator: false, negative: 0 }), "0");
  assert.equal(
    buildNumberFormatCode({ category: "number", decimals: 2, separator: true, negative: 3 }),
    "#,##0.00;[Red](#,##0.00)",
  );
  assert.equal(
    buildNumberFormatCode({ category: "currency", decimals: 2, symbol: "$", negative: 2 }),
    "$#,##0.00;($#,##0.00)",
  );
  assert.equal(
    buildNumberFormatCode({ category: "accounting", decimals: 2, symbol: "$" }),
    '_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)',
  );
  assert.equal(buildNumberFormatCode({ category: "percentage", decimals: 2 }), "0.00%");
  assert.equal(buildNumberFormatCode({ category: "scientific", decimals: 2 }), "0.00E+00");
  assert.equal(buildNumberFormatCode({ category: "custom", code: "#,##0.0\"x\"" }), '#,##0.0"x"');
});

test("every code a category can write is read back as that same category", () => {
  const categories = new Set(NUMBER_FORMAT_CATEGORIES.map((entry) => entry.key));
  assert.ok(categories.has("custom"));
  for (let decimals = 0; decimals <= 6; decimals += 1) {
    for (const negative of [0, 1, 2, 3]) {
      for (const separator of [true, false]) {
        const state = { category: "number", decimals, separator, negative };
        const read = detectNumberFormatState(buildNumberFormatCode(state));
        assert.deepEqual(
          { category: read.category, decimals: read.decimals, separator: read.separator, negative: read.negative },
          state,
          `number ${decimals}/${separator}/${negative}`,
        );
      }
      for (const symbol of NUMBER_FORMAT_SYMBOLS.filter((entry) => entry.value)) {
        const state = { category: "currency", decimals, symbol: symbol.value, negative };
        const read = detectNumberFormatState(buildNumberFormatCode(state));
        assert.equal(read.category, "currency", `currency ${symbol.value}`);
        assert.equal(read.symbol, symbol.value);
        assert.equal(read.decimals, decimals);
        assert.equal(read.negative, negative);
      }
    }
    for (const symbol of NUMBER_FORMAT_SYMBOLS) {
      const read = detectNumberFormatState(buildNumberFormatCode({ category: "accounting", decimals, symbol: symbol.value }));
      assert.equal(read.category, "accounting");
      assert.equal(read.symbol, symbol.value);
      assert.equal(read.decimals, decimals);
    }
    for (const category of ["percentage", "scientific"]) {
      const read = detectNumberFormatState(buildNumberFormatCode({ category, decimals }));
      assert.equal(read.category, category);
      assert.equal(read.decimals, decimals);
    }
  }
  assert.equal(detectNumberFormatState("General").category, "general");
});

test("the app's own stored patterns open on the category that describes them", () => {
  const stored = detectNumberFormatState("0,000");
  assert.equal(stored.category, "number");
  assert.equal(stored.decimals, 0);
  assert.equal(stored.separator, true);
  assert.equal(stored.negative, 0);
  assert.equal(detectNumberFormatState("0,000.00").decimals, 2);
  assert.equal(detectNumberFormatState("0.0%").category, "percentage");

  const unknown = detectNumberFormatState('#,##0.0"x"');
  assert.equal(unknown.category, "custom");
  assert.equal(unknown.code, '#,##0.0"x"');
});

test("the Data tab opens the dialog from its Number Format list instead of accepting typed patterns", async () => {
  const [controls, html, dialogCss, datasetCss, fieldCss, fieldSource] = await Promise.all([
    read("ui/shared/tabs/data/data_tab_controls.js"),
    read("ui/dataset_viewer/dataset_viewer.html"),
    read("ui/shared/components/pickers/number_format_dialog.css"),
    read("ui/dataset_viewer/dataset_viewer.css"),
    read("ui/shared/components/pickers/number_format_field.css"),
    read("ui/shared/components/pickers/number_format_field.js"),
  ]);

  assert.match(controls, /readOnly: true/u);
  assert.match(controls, /onCustom: \(\) => \{/u);
  assert.match(controls, /openNumberFormatDialog\(\{/u);
  assert.match(controls, /host: document\.getElementById\("dsDataPage"\)/u);
  // Typing is gone, so the listeners that committed a typed pattern are too.
  assert.doesNotMatch(controls, /numberFormatSelect\.addEventListener/u);

  assert.match(fieldSource, /input\.readOnly = true/u);
  assert.match(fieldSource, /arNumberFormatCustomOption/u);
  assert.match(fieldCss, /\.arNumberFormatFieldReadOnly > input \{/u);

  assert.match(html, /pickers\/number_format_dialog\.css/u);
  assert.match(dialogCss, /\.arFormatDialogLayer \{\s*position: absolute;/u);
  // The window floats inside the Data tab, so that tab has to be its frame.
  assert.match(datasetCss, /#dsDataPage \{[^}]*position: relative;/u);
});
