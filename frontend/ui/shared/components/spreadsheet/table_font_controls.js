import { TABLE_FONT_SIZE_MIN, TABLE_FONT_SIZE_MAX } from "./table_colors_model.js?v=20261003a";

/** Section-level typography controls; all changes use the existing preference owner. */
export function createTableFontControls(group, { get, set, reset }) {
  const row = document.createElement("div");
  row.className = "arTableFontControls";
  row.dataset.fontGroup = group.id;
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", `${group.label} font`);
  const inputs = {};
  for (const [key, label, type] of [["family", "Font Family", "text"], ["size", "Size (px)", "number"]]) {
    const field = document.createElement("label");
    const caption = document.createElement("span");
    caption.textContent = label;
    const input = document.createElement("input");
    input.type = type;
    input.setAttribute("aria-label", `${group.label} ${label}`);
    input.dataset.fontProperty = key;
    if (type === "number") {
      input.min = TABLE_FONT_SIZE_MIN;
      input.max = TABLE_FONT_SIZE_MAX;
      input.step = 1;
    } else {
      input.maxLength = 80;
      input.pattern = "[\\p{L}\\p{N}][\\p{L}\\p{N} _\\-]{0,79}";
    }
    input.addEventListener("change", () => {
      if (!input.reportValidity()) return;
      set(group.id, key, input.value);
      render();
    });
    inputs[key] = input;
    field.append(caption, input);
    row.append(field);
  }
  const buttons = {};
  for (const [key, text] of [["bold", "B"], ["italic", "I"]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `arTableFontStyle arTableFontStyle-${key}`;
    button.textContent = text;
    button.dataset.fontProperty = key;
    button.setAttribute("aria-label", `${group.label} ${key}`);
    button.addEventListener("click", () => set(group.id, key, button.getAttribute("aria-pressed") !== "true"));
    buttons[key] = button;
    row.append(button);
  }
  const resetButton = document.createElement("button");
  resetButton.type = "button";
  resetButton.className = "arTableFontReset";
  resetButton.textContent = "Reset";
  resetButton.setAttribute("aria-label", `Reset ${group.label} font`);
  resetButton.addEventListener("click", () => reset(group.id));
  row.append(resetButton);
  function render() {
    const font = get().fonts?.[group.id] || {};
    const cell = document.querySelector(`${group.fontSelector} td`);
    const style = cell && getComputedStyle(cell);
    const effective = {
      family: style?.fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, "") || "",
      size: style ? Number.parseFloat(style.fontSize) : "",
    };
    for (const key of ["family", "size"]) {
      inputs[key].value = font[key] ?? effective[key];
      inputs[key].classList.toggle("isCustom", font[key] != null);
    }
    buttons.bold.setAttribute("aria-pressed", String(font.bold ?? (Number(style?.fontWeight) >= 600)));
    buttons.italic.setAttribute("aria-pressed", String(font.italic ?? (style?.fontStyle === "italic")));
    for (const key of ["bold", "italic"]) buttons[key].classList.toggle("isCustom", font[key] != null);
    resetButton.disabled = !Object.keys(font).length;
  }
  return { element: row, render };
}
