import assert from "node:assert/strict";
import test from "node:test";

const expressions = await import(
  new URL("../ui/shared/tabs/notes/notes_expressions.js", import.meta.url)
);
const dfmExpressions = await import(
  new URL("../ui/method_pages/dfm/dfm_notes_expressions.js", import.meta.url)
);

const { renderNotesExpressions, evaluateNotesExpression, findNotesExpressionMatches } = expressions;

function rendered(source, context) {
  return renderNotesExpressions(source, context).map((segment) => segment.text).join("");
}

const payload = {
  details_tab: { name: "Paid DFM", input_triangle: "Net Loss--Paid", output_dataset: "F 12", origin_length: 12, development_length: 12 },
  data_tab: {
    origin_labels: ["2019", "2020", "2021"],
    development_labels: ["12", "24", "36"],
    input_data_triangle_values: [[100, 150, 160], [110, 170], [120]],
  },
  ratios_tab: {
    ratio_triangle: {
      development_labels: ["(1) 12-24", "(2) 24-36", "Ult"],
      ratio_values: [[1.5, 1.0666666666666667], [1.5454545454545454]],
      excluded: [[0, 0], [1]],
    },
    average_formulas: {
      label: ["Volume - all", "User Entry"],
      selected: [[1, 0, 0], [0, 1, 1]],
      values: [[1.52, 1.0667, 1.0], [1.5, 1.1, 1.05]],
    },
  },
  curves_tab: { selected_values: [1.52, 1.1, 1.05] },
  results_tab: { ultimate_vector: [168, 196.35, 210.672], ratio_basis_values: [1, 2, 3] },
  method_metadata: { last_modified: "2026-09-10T10:00:00Z" },
};
const context = dfmExpressions.buildDfmNotesExpressionContext(payload);

test("placeholders are found with their format spec and literal braces are kept", () => {
  assert.deepEqual(
    findNotesExpressionMatches("a {x:.2f} {{b}} {y"),
    [
      { start: 2, end: 9, expression: "x", spec: ".2f" },
      { start: 10, end: 12, literal: "{" },
      { start: 13, end: 15, literal: "}" },
    ],
  );
});

test("Python-style arithmetic, logic, and calls evaluate", () => {
  const scope = { values: { x: 7, label: "abc" }, functions: { double: (n) => n * 2 } };
  assert.equal(evaluateNotesExpression("x // 2 + x % 3 * 2 ** 3", scope), 11);
  assert.equal(evaluateNotesExpression("-x / 2", scope), -3.5);
  assert.equal(evaluateNotesExpression("double(x) if x > 5 and not x == 8 else 0", scope), 14);
  assert.equal(evaluateNotesExpression("'x is ' + str(x)", scope), "x is 7");
  assert.equal(evaluateNotesExpression("None or label", scope), "abc");
  assert.equal(evaluateNotesExpression("round(2.5) + round(1.23456, 2)", scope), 3.23);
  assert.equal(evaluateNotesExpression("max(1, x, 3) - min(4, 2)", scope), 5);
  assert.equal(evaluateNotesExpression("len(label)", scope), 3);
});

test("short-circuit branches are not evaluated", () => {
  const scope = { functions: { boom: () => { throw new Error("boom"); } } };
  assert.equal(evaluateNotesExpression("1 if True else boom()", scope), 1);
  assert.equal(evaluateNotesExpression("False and boom()", scope), false);
  assert.equal(evaluateNotesExpression("True or boom()", scope), true);
});

test("format specs follow Python: fixed, grouping, percent, integer, exponent", () => {
  const scope = { values: { big: 12345678.9, ratio: 0.5702, n: 3.9 } };
  assert.equal(rendered("{big:,.1f}|{big:,}|{ratio:.1%}|{n:d}|{big:.2e}|{n}|{None}|{True}", scope),
    "12,345,678.9|12,345,678.9|57.0%|3|1.23e+7|3.9||True");
});

test("a placeholder that cannot be rendered keeps its raw text and reports the reason", () => {
  const segments = renderNotesExpressions("ok {1/0} {nope} {'a' + 1} {name:.2f}", { values: { name: "x" } });
  const errors = segments.filter((segment) => segment.error);
  assert.deepEqual(errors.map((segment) => segment.text), ["{1/0}", "{nope}", "{'a' + 1}", "{name:.2f}"]);
  assert.deepEqual(errors.map((segment) => segment.error), [
    "division by zero",
    "unknown name 'nope'",
    "cannot add text and number",
    "text cannot use format '.2f'",
  ]);
});

test("segments keep the raw span they came from so a click can map back to the note", () => {
  const segments = renderNotesExpressions("Age {development_label(1)} first", context);
  assert.deepEqual(segments.map(({ kind, start, end, text }) => ({ kind, start, end, text })), [
    { kind: "text", start: 0, end: 4, text: "Age " },
    { kind: "expression", start: 4, end: 26, text: "12" },
    { kind: "text", start: 26, end: 32, text: " first" },
  ]);
});

test("DFM names map onto the method JSON with 1-based positions and -1 for the last", () => {
  assert.equal(
    rendered("{name} {input_triangle} {output_dataset} {origin_label(1)}-{origin_label(-1)} {development_label(2)} {ratio_development_label(-1)}", context),
    "Paid DFM Net Loss--Paid F 12 2019-2021 24 Ult",
  );
  assert.equal(
    rendered("{input_data_triangle_value(2, 2)} {ratio_value(2, 1):.4f} {excluded(2, 1)} {excluded(1, 1)}", context),
    "170 1.5455 True False",
  );
  assert.equal(
    rendered("{average_formula_label(2)}={average_formula_value('user entry', 3)} sel {selected_average_formula(2)}", context),
    "User Entry=1.05 sel User Entry",
  );
  assert.equal(
    rendered("{selected_value(1)} {cumulative_factor(1):.4f} {selected_tail_factor} {ultimate_value(3):,.2f} {ratio_basis_value(2)}", context),
    "1.52 1.7556 1.05 210.67 2",
  );
  assert.equal(rendered("{percent_developed(3):.1%} {percent_developed(1):.2%}", context), "57.0% 95.24%");
  assert.equal(rendered("{origin_count}/{development_count}/{average_formula_count} {last_modified}", context), "3/3/2 2026-09-10T10:00:00Z");
});

test("DFM positions outside the method are reported, and empty cells render as nothing", () => {
  const segments = renderNotesExpressions("{origin_label(4)} {development_label(0)} {input_data_triangle_value(3, 2)}", context);
  assert.equal(segments[0].error, "origin 4 is out of range (1-3)");
  assert.equal(segments[2].error, "development period position must be a whole number, not 0");
  assert.equal(segments[4].text, "");
});

test("the Insert Value catalog lists only names the context resolves", () => {
  for (const entry of context.catalog) {
    const [segment] = renderNotesExpressions(entry.snippet, context);
    assert.equal(segment.kind, "expression", entry.snippet);
    assert.equal(segment.error, undefined, `${entry.snippet}: ${segment.error}`);
  }
});

test("a note without a context renders its braces untouched", () => {
  const source = "keep {this} as is";
  assert.deepEqual(renderNotesExpressions(source, { values: {} }).map((segment) => segment.text).join(""), source);
});

test("dotted paths walk the method JSON and lists are called with positions", () => {
  assert.equal(
    rendered("{details_tab.name} {data_tab.origin_labels(1)} {ratio_triangle.development_label(1)} {ratios_tab.ratio_triangle.development_labels(-1)}", context),
    "Paid DFM 2019 (1) 12-24 Ult",
  );
  assert.equal(
    rendered("{ratio_triangle.ratio_values(1, 2):.4f} {ratio_triangle.ratio_values(2)(1):.2f} {average_formulas.values(2, 3)} {average_formulas.label(2)}", context),
    "1.0667 1.55 1.05 User Entry",
  );
  assert.equal(rendered("{curves_tab.selected_values} [{data_tab.input_data_triangle_values(2)}]", context), "1.52, 1.1, 1.05 [110, 170]");
  assert.equal(rendered("{len(data_tab.origin_labels)} {sum(results_tab.ultimate_vector):,.2f} {max(curves_tab.selected_values)}", context), "3 575.02 1.52");
});

test("a wrong path reports where it went wrong", () => {
  const segments = renderNotesExpressions("{ratio_triangle.nothing} {ratio_triangle} {name.x} {ratio_triangle.ratio_values} {ratio_triangle.ratio_values(1, 9)}", context);
  assert.deepEqual(segments.filter((segment) => segment.error).map((segment) => segment.error), [
    "'ratio_triangle' has no property 'nothing'",
    "'ratio_triangle' is an object; pick one of its properties",
    "text has no properties; '.x' needs an object",
    "ratio_values position 9 is out of range (1-2)",
  ]);
  assert.equal(segments[6].text, "[1.5, 1.0666666666666667], [1.5454545454545454]");
});

test("the completion query finds the path and partial name under the caret", () => {
  const { findNotesCompletionQuery } = expressions;
  assert.deepEqual(findNotesCompletionQuery("see {ratio_tri"), { path: [], partial: "ratio_tri", start: 5 });
  assert.deepEqual(findNotesCompletionQuery("see {ratio_triangle."), { path: ["ratio_triangle"], partial: "", start: 20 });
  assert.deepEqual(findNotesCompletionQuery("{ratios_tab.ratio_triangle.dev"), { path: ["ratios_tab", "ratio_triangle"], partial: "dev", start: 27 });
  assert.deepEqual(findNotesCompletionQuery("{round(ratio_value(1, 1) * or"), { path: [], partial: "or", start: 27 });
  assert.deepEqual(findNotesCompletionQuery("{x + "), { path: [], partial: "", start: 5 });
  assert.equal(findNotesCompletionQuery("plain text"), null);
  assert.equal(findNotesCompletionQuery("{done} after"), null);
  assert.equal(findNotesCompletionQuery("{{literal"), null);
  assert.equal(findNotesCompletionQuery("{'in a str"), null);
  assert.equal(findNotesCompletionQuery("{x:.2f"), null);
  assert.equal(findNotesCompletionQuery("{origin_label(1)"), null);
  assert.equal(findNotesCompletionQuery("{origin_label("), null);
  assert.equal(findNotesCompletionQuery("{max(a, "), null);
  assert.deepEqual(findNotesCompletionQuery("{max(a, se"), { path: [], partial: "se", start: 8 });
  assert.deepEqual(findNotesCompletionQuery("{not "), { path: [], partial: "", start: 5 });
  assert.equal(findNotesCompletionQuery("{name "), null);
});

test("completions list root names and an object's properties with previews", () => {
  const { listNotesCompletions } = expressions;
  const root = listNotesCompletions(context, []);
  const byName = Object.fromEntries(root.map((entry) => [entry.name, entry]));
  assert.equal(byName.ratio_triangle.kind, "object");
  assert.equal(byName.ratio_triangle.insert, "ratio_triangle.");
  assert.equal(byName.origin_label.kind, "function");
  assert.equal(byName.origin_label.insert, "origin_label(");
  assert.equal(byName.origin_label.preview, "origin_label(i)");
  assert.equal(byName.name.kind, "value");
  assert.equal(byName.name.preview, "Paid DFM");
  assert.equal(byName.round.kind, "function");
  assert.equal(root.findIndex((entry) => entry.name === "round") > root.findIndex((entry) => entry.name === "ultimate_value"), true, "built-ins come last");

  const triangle = listNotesCompletions(context, ["ratios_tab", "ratio_triangle"]);
  assert.deepEqual(triangle.map((entry) => entry.name), [
    "development_labels", "ratio_values", "excluded", "development_label", "ratio_value",
  ]);
  assert.equal(triangle[0].kind, "list");
  assert.equal(triangle[0].preview, "(1) 12-24, (2) 24-36, Ult");
  assert.equal(triangle[0].insert, "development_labels(");
  assert.equal(triangle[1].preview, "[...], [...]");
  assert.deepEqual(listNotesCompletions(context, ["name"]), []);
  assert.deepEqual(listNotesCompletions(context, ["nope"]), []);
});

test("the rendered text a save stores replaces every placeholder and keeps a broken one as typed", () => {
  const { renderNotesExpressionText } = expressions;
  const source = "Latest origin {origin_label(-1)} at {ratio_value(1, 1):.2f}; {{kept}} {origin_label(9)}.";
  assert.equal(
    renderNotesExpressionText(source, context),
    "Latest origin 2021 at 1.50; {kept} {origin_label(9)}.",
  );
  assert.equal(renderNotesExpressionText("plain text", context), "plain text");
});
