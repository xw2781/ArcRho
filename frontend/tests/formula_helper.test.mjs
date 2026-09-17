import "./ui_module_loader.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { openFormulaHelper } from "../ui/shared/components/formula_bar/formula_helper.js";

// DOM lifecycle fixture; geometry and painting require a browser check.
class Element extends EventTarget {
  constructor(tag, doc) {
    super(); Object.assign(this, {tagName: tag, ownerDocument: doc, children: [], attributes: {}, dataset: {}, style: {}, value: "", className: "", selectionStart: 0, selectionEnd: 0});
    this.classList = { add: name => { this.className += ` ${name}`; }, remove: name => { this.className = this.className.split(" ").filter(item => item !== name).join(" "); } };
  }
  append(...nodes) { for (let node of nodes) { if (typeof node === "string") { const text = new Element("text", this.ownerDocument); text.textContent = node; node = text; } node.parent = this; this.children.push(node); } }
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) { this.children.forEach(node => { node.parent = null; }); this.children = []; this._text = ""; this.append(...nodes); }
  set textContent(value) { this.replaceChildren(); this._text = value; }
  get textContent() { return (this._text || "") + this.children.map(node => node.textContent).join(""); }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  focus() { const doc = this.ownerDocument; if (doc.activeElement === this) return; doc.activeElement?.dispatchEvent(new Event("blur")); doc.activeElement = this; this.dispatchEvent(new Event("focus")); }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
  get isConnected() { return !!this.parent || this === this.ownerDocument.body; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  getBoundingClientRect() { return {left: 10, top: 10, right: 310, bottom: 40, width: 300, height: 30}; }
  scrollIntoView() {}
}
const walk = node => [node, ...node.children.flatMap(walk)];
function fixture(options = {}) {
  const doc = { activeElement: null, defaultView: Object.assign(new EventTarget(), {innerWidth: 1000, innerHeight: 700}) };
  doc.createElement = tag => new Element(tag, doc);
  doc.body = doc.createElement("body"); doc.head = doc.createElement("head");
  doc.getElementById = id => [...walk(doc.body), ...walk(doc.head)].find(node => node.id === id);
  const input = doc.createElement("input"); input.value = "=SUM(1,2)"; doc.body.append(input); input.focus();
  let inserts = 0;
  const helper = openFormulaHelper(input, {identityProvider: () => ({project_name: "Synthetic", reserving_class: "RC"}), onInsert: () => inserts++, ...options});
  const byLabel = label => walk(doc.body).find(node => node.attributes["aria-label"] === label);
  const click = text => { const node = walk(doc.body).find(node => node.tagName === "button" && node.textContent === text); assert.ok(node, text); if (!node.disabled) node.dispatchEvent(new Event("click")); };
  const edit = (node, value) => { node.value = value; node.dispatchEvent(new Event("input")); };
  return {doc, input, helper, byLabel, click, edit, inserts: () => inserts};
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test("helper previews values without applying and inserts only a validated draft", async () => {
  const f = fixture();
  f.click("TAKE"); f.edit(f.byLabel("array"), "{1,2;3,4}"); f.edit(f.byLabel("rows"), "-1");
  f.click("Preview values"); await settle();
  assert.equal(f.input.value, "=SUM(1,2)"); assert.equal(f.inserts(), 0);
  assert.ok(walk(f.doc.body).some(node => node.textContent.includes("1 row × 2 columns")));
  f.click("Insert formula");
  assert.equal(f.input.value, "=TAKE({1,2;3,4}, -1)"); assert.equal(f.inserts(), 1);
  assert.equal(f.input.dataset.formulaHelperOpen, undefined); assert.equal(f.doc.activeElement, f.input);
});

test("changing a draft cancels its preview and prevents stale insertion", async () => {
  let finish, signal;
  const f = fixture({evaluate: (_raw, options) => { signal = options.signal; return new Promise(resolve => { finish = resolve; }); }});
  f.edit(f.byLabel("Formula"), "=SUM(1,2)"); f.click("Preview values");
  f.edit(f.byLabel("Formula"), "=SUM(8,9)"); assert.equal(signal.aborted, true);
  finish({ok: true, rows: 1, cols: 1, values: [[3]]}); await settle(); f.click("Insert formula");
  assert.equal(f.inserts(), 0); assert.equal(f.input.value, "=SUM(1,2)");
  f.click("Cancel"); assert.equal(f.input.value, "=SUM(1,2)"); assert.equal(f.doc.activeElement, f.input);
});

test("preview errors retain the draft and Cancel never applies it", async () => {
  const f = fixture(); f.edit(f.byLabel("Formula"), "=TAKE({1,2},0)");
  f.click("Preview values"); await settle(); f.click("Insert formula");
  assert.equal(f.inserts(), 0); assert.equal(f.byLabel("Formula").value, "=TAKE({1,2},0)");
  f.click("Cancel"); assert.equal(f.input.value, "=SUM(1,2)");
});
