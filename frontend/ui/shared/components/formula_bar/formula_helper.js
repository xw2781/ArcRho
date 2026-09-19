import { FORMULA_CATALOG, quoteFormulaText } from "/ui/shared/components/formula_bar/formula_completion.js?v=20260917a";
import { ensureFormulaAssistStyles, installFormulaAutocomplete } from "/ui/shared/components/formula_bar/formula_autocomplete.js?v=20260917a";
import { formulaDatasetNames, formulaContextOptions, formulaPageIdentity } from "/ui/shared/components/formula_bar/formula_api.js?v=20260917a";
import { evaluateFormulaValues } from "/ui/shared/dataset/dataset_formula_values.js?v=20260919a";

/** A preview is read-only; Insert writes a draft, and Enter in the bar applies it. */
export function openFormulaHelper(input, { identityProvider = formulaPageIdentity, evaluate = evaluateFormulaValues, onInsert = () => {}, onClose = () => {} } = {}) {
  if (input.disabled || input.readOnly || input.dataset.formulaHelperOpen === "1") return;
  const doc = input.ownerDocument;
  ensureFormulaAssistStyles(doc);
  input.dataset.formulaHelperOpen = "1";
  const original = input.value;
  const selection = [input.selectionStart ?? original.length, input.selectionEnd ?? original.length];
  const dialog = doc.createElement("dialog"); dialog.className = "arFormulaHelper";
  dialog.setAttribute("aria-label", "Insert Formula");
  const el = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };
  const button = (text, action, className = "") => {
    const node = el("button", className, text); node.type = "button";
    node.addEventListener("click", action); return node;
  };
  dialog.appendChild(el("header", "", "Insert Formula"));
  const body = el("div", "arFormulaHelperBody"), sidebar = el("div"), main = el("div");
  const search = el("input"); search.placeholder = "Find a function"; search.setAttribute("aria-label", "Find a function");
  const functions = el("div", "arFormulaFunctionList");
  sidebar.append(search, functions);
  const argumentsRoot = el("div", "arFormulaArguments");
  const message = el("div", "arFormulaHelperMessage", "Choose a function and enter its arguments. Text arguments use double quotes.");
  const draft = el("textarea", "arFormulaHelperDraft"); draft.rows = 3; draft.setAttribute("aria-label", "Formula"); draft.spellcheck = false;
  const preview = el("div", "arFormulaHelperPreview"); preview.setAttribute("aria-live", "polite");
  main.append(argumentsRoot, draft, message, preview); body.append(sidebar, main); dialog.append(body);
  const footer = el("footer");
  let spec = FORMULA_CATALOG[0], fields = [], generation = 0, request = null;
  let validated = "", picker = null;
  const insert = button("Insert formula", insertFormula, "arFormulaInsert"); insert.disabled = true;
  const previewButton = button("Preview values", previewFormula);
  footer.append(button("Cancel", () => close()), previewButton, insert); dialog.append(footer);
  doc.body.appendChild(dialog);
  const autocomplete = installFormulaAutocomplete(draft, { identityProvider, popupParent: dialog });

  function invalidate() {
    generation++; request?.abort(); validated = ""; insert.disabled = true;
    preview.replaceChildren(); message.classList.remove("isError");
    message.textContent = "Preview values before inserting. Empty Path and ProjectName use the current segment and project.";
    previewButton.disabled = false;
  }
  function updateDraft() {
    const values = fields.map(field => field.value.trim());
    while (values.length && values.at(-1) === "" && spec.arguments[values.length - 1].optional) values.pop();
    draft.value = `=${spec.name}(${values.join(", ")})`;
    invalidate();
  }
  function renderFunctions() {
    functions.replaceChildren();
    FORMULA_CATALOG.filter(item => item.name.toLowerCase().includes(search.value.toLowerCase())).forEach(item => {
      const option = button(item.name, () => selectFunction(item)); option.setAttribute("aria-pressed", String(item === spec)); functions.append(option);
    });
  }
  function argumentIdentity() {
    const identity = { ...identityProvider() };
    spec.arguments.forEach((arg, i) => {
      const value = fields[i].value.trim();
      if (!/^"(?:[^"]|"")*"$/.test(value)) return;
      const text = value.slice(1, -1).replaceAll('""', '"');
      if (arg.name === "Path" && text) identity.reserving_class = text;
      if (arg.name === "ProjectName" && text && text.toLowerCase() !== "default") identity.project_name = text;
    });
    return identity;
  }
  async function chooseArgument(arg, field, control) {
    picker?.remove();
    const menu = el("div", "arFormulaFunctionList arFormulaArgumentChoices"); picker = menu; control.append(menu);
    menu.textContent = "Loading choices…";
    try {
      let choices;
      if (["TriangleName", "VectorName"].includes(arg.name)) {
        choices = (await formulaDatasetNames(argumentIdentity())).map(name => ({ label: name, value: quoteFormulaText(name) }));
      } else if (["Path", "ProjectName"].includes(arg.name)) {
        choices = (await formulaContextOptions(arg.name, argumentIdentity())).map(item => ({ label: item.label, value: quoteFormulaText(item.value) }));
      } else choices = ["TRUE", "FALSE"].map(value => ({ label: value, value }));
      if (picker !== menu || !dialog.isConnected) return;
      menu.replaceChildren();
      for (const item of choices) menu.append(button(item.label, () => { field.value = item.value; menu.remove(); updateDraft(); field.focus(); }));
      if (!choices.length) menu.textContent = "No datasets available.";
    } catch (error) { menu.textContent = error.message; }
  }
  function selectFunction(item) {
    spec = item; picker?.remove(); argumentsRoot.replaceChildren(); fields = [];
    spec.arguments.forEach((arg, i) => {
      const field = el("input"); field.setAttribute("aria-label", arg.name); field.spellcheck = false;
      field.placeholder = ["Path", "ProjectName"].includes(arg.name) ? "Current (leave empty)" : arg.optional ? "Optional" : "Required";
      if (arg.default != null && !["Path", "ProjectName"].includes(arg.name)) field.value = typeof arg.default === "boolean" ? String(arg.default).toUpperCase() : String(arg.default);
      const label = el("label", "", `${arg.name}${arg.optional ? " (optional)" : ""}`);
      field.id = `arFormulaArg-${i}`; label.htmlFor = field.id;
      const control = el("div", "arFormulaArgumentControl"); control.append(field);
      if (["TriangleName", "VectorName", "Path", "ProjectName", "ByTypeName", "SuppressWarnings"].includes(arg.name) || typeof arg.default === "boolean") control.append(button("Choose", () => void chooseArgument(arg, field, control)));
      field.addEventListener("input", updateDraft); fields.push(field); argumentsRoot.append(label, control);
    });
    updateDraft(); renderFunctions();
  }
  async function previewFormula() {
    request?.abort(); request = new AbortController();
    const ticket = ++generation, formula = draft.value;
    insert.disabled = true; previewButton.disabled = true; message.classList.remove("isError"); message.textContent = "Calculating preview…";
    try {
      const result = await evaluate(formula, { identity: identityProvider(), signal: request.signal });
      if (ticket !== generation || !dialog.isConnected) return;
      if (!result?.ok) throw new Error(result?.error || "Formula could not be evaluated.");
      preview.replaceChildren(); const table = el("table");
      result.values.slice(0, 20).forEach(row => { const tr = el("tr"); row.slice(0, 12).forEach(value => tr.append(el("td", "", value == null ? "" : String(value)))); table.append(tr); });
      preview.append(table);
      message.textContent = `${result.rows} row${result.rows === 1 ? "" : "s"} × ${result.cols} column${result.cols === 1 ? "" : "s"}${result.rows > 20 || result.cols > 12 ? " · Showing the first 20 rows and 12 columns" : ""}`;
      validated = formula; insert.disabled = false;
    } catch (error) {
      if (ticket !== generation) return;
      message.textContent = error.message; message.classList.add("isError"); preview.replaceChildren();
    } finally { if (ticket === generation) previewButton.disabled = false; }
  }
  function close(value) {
    generation++; request?.abort(); autocomplete.destroy(); dialog.close(); dialog.remove();
    if (value != null) input.value = value;
    input.focus({ preventScroll: true });
    delete input.dataset.formulaHelperOpen;
    if (value != null) { input.setSelectionRange(value.length, value.length); input.dispatchEvent(new Event("input", { bubbles: true })); onInsert(value); }
    onClose();
  }
  function insertFormula() {
    if (validated !== draft.value || insert.disabled) return;
    const body = draft.value.replace(/^\s*=\s*/, "");
    const hasSelection = selection[0] !== selection[1];
    const value = hasSelection && original.trimStart().startsWith("=")
      ? original.slice(0, Math.max(original.indexOf("=") + 1, selection[0])) + body + original.slice(selection[1])
      : `=${body}`;
    close(value);
  }
  draft.addEventListener("input", invalidate);
  search.addEventListener("input", renderFunctions);
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  selectFunction(spec); dialog.showModal(); search.focus();
  return { close };
}

/** Click opens the helper; moving the pointer keeps the existing fx drag gesture. */
export function wireFormulaHelper(button, input, options = {}) {
  button.setAttribute("role", "button"); button.setAttribute("tabindex", "0"); button.setAttribute("aria-label", "Insert formula");
  button.removeAttribute("aria-hidden"); button.removeAttribute("title");
  let start = null, dragged = false;
  const open = () => { if (input.disabled || input.readOnly) return; options.onOpen?.(); openFormulaHelper(input, options); };
  button.addEventListener("pointerdown", event => { start = { x: event.clientX, y: event.clientY }; dragged = false; event.preventDefault(); });
  button.addEventListener("pointermove", event => { if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) >= 3) dragged = true; });
  button.addEventListener("click", () => { if (!dragged) open(); start = null; });
  button.addEventListener("keydown", event => {
    if (["Enter", " "].includes(event.key)) { event.preventDefault(); open(); }
  });
}
