import test from "node:test";
import assert from "node:assert/strict";

/** Just enough of a DOM for a renderer that only appends text nodes and inline elements. */
function createElementStub(tag) {
  return {
    tag,
    className: "",
    href: "",
    title: "",
    target: "",
    rel: "",
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
    addEventListener() {},
    appendChild(child) {
      this.children.push(child);
      return child;
    },
  };
}

globalThis.document = {
  createElement: (tag) => createElementStub(tag),
  createTextNode: (text) => ({ tag: "#text", children: [], textContent: String(text ?? "") }),
};

const { appendAssistantInlineMarkdown } = await import("../ui/ai-assistant/messages.js");
const { renderSqlAiReviewResponse } = await import("../ui/ai-assistant/skills.js");

function render(markdown) {
  const root = createElementStub("div");
  appendAssistantInlineMarkdown(root, markdown);
  return root;
}

test("escaped punctuation reaches the reader as plain characters", () => {
  const root = render("grouping\\-key combination\\. policy\\_id is an unindexed heap\\.");
  assert.equal(root.textContent, "grouping-key combination. policy_id is an unindexed heap.");
});

test("escaping defeats markup rather than leaking backslashes", () => {
  const root = render("\\*\\*not a heading\\*\\* and \\`not code\\` and \\[not]\\(a link\\)");
  assert.equal(root.textContent, "**not a heading** and `not code` and [not](a link)");
  assert.deepEqual(root.children.map((child) => child.tag), ["#text"]);
});

test("entity-encoded text renders as the characters it stands for", () => {
  const root = render("claim_status &lt;&gt; 'Closed' &amp; still open");
  assert.equal(root.textContent, "claim_status <> 'Closed' & still open");
  assert.deepEqual(root.children.map((child) => child.tag), ["#text"]);
});

test("unescaped markup still renders as markup", () => {
  const root = render("**Summary** of `SELECT 1` in [standards](https://example.com/sql)");
  assert.deepEqual(root.children.map((child) => child.tag), ["strong", "#text", "code", "#text", "a"]);
  assert.equal(root.children[0].textContent, "Summary");
  assert.equal(root.children[2].textContent, "SELECT 1");
  assert.equal(root.children[4].href, "https://example.com/sql");
});

test("a review finding survives the escape and render round trip word for word", () => {
  const message = "DISTINCT is redundant because GROUP BY returns one row per grouping-key combination.";
  const recommendation = "Drop it once claim_status <> 'Closed' is confirmed.";
  const markdown = renderSqlAiReviewResponse({
    dialect: "tsql",
    summary: "One finding.",
    syntax_and_formatting: [],
    performance_and_optimizations: [{
      line_start: 10,
      line_end: 16,
      severity: "warning",
      message,
      recommendation,
    }],
  }, { expectedDialect: "tsql" });

  const line = markdown.split("\n").find((entry) => entry.startsWith("- Lines 10-16"));
  const rendered = render(line).textContent;
  assert.ok(rendered.includes(message), rendered);
  assert.ok(rendered.includes(recommendation), rendered);
  assert.doesNotMatch(rendered, /\\/);
  assert.doesNotMatch(rendered, /&(amp|lt|gt);/);
});
