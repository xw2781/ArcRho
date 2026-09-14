import { DATASET_NUMBER_FORMAT_PRESETS } from "/ui/shared/dataset/dataset_number_format.js";

/**
 * Wires the shared Number Format field: a pattern input with an in-field caret
 * that opens the canonical preset list under it.
 *
 * The component owns opening, rendering, dismissal, and the ARIA expanded state.
 * The host owns what a chosen preset means, because that differs per page: the
 * Dataset Viewer re-derives Decimal Places and repaints its grid, while a method
 * page records the pair on its method JSON and marks the page dirty.
 *
 * A host that passes `onCustom` gets a last row under the presets, which hands
 * the choice back instead of applying a pattern; with `readOnly` the field stops
 * accepting typed patterns and only opens the list, so that row is the one way
 * in to a pattern the list does not carry.
 */
export function wireNumberFormatField({
  input,
  field,
  toggle,
  menu,
  getPresets = () => DATASET_NUMBER_FORMAT_PRESETS,
  onApply,
  onCustom,
  customLabel = "Custom...",
  readOnly = false,
  documentRef = globalThis.document,
} = {}) {
  if (!input || !field || !menu) return null;

  if (readOnly) {
    input.readOnly = true;
    field.classList.add("arNumberFormatFieldReadOnly");
  }

  const isOpen = () => field.classList.contains("open");

  function close() {
    field.classList.remove("open");
    menu.classList.remove("open");
    input.setAttribute("aria-expanded", "false");
    toggle?.setAttribute("aria-expanded", "false");
  }

  function open() {
    menu.innerHTML = "";
    for (const preset of getPresets() || []) {
      const option = documentRef.createElement("div");
      option.className = "datasetOption arNumberFormatOption";
      option.setAttribute("role", "option");
      option.dataset.value = preset;
      option.textContent = preset;
      option.title = preset;
      if (preset === input.value) option.classList.add("active");
      menu.appendChild(option);
    }
    if (onCustom) {
      const option = documentRef.createElement("div");
      option.className = "datasetOption arNumberFormatOption arNumberFormatCustomOption";
      option.setAttribute("role", "option");
      option.dataset.custom = "1";
      option.textContent = customLabel;
      option.title = customLabel;
      menu.appendChild(option);
    }
    field.classList.add("open");
    menu.classList.add("open");
    input.setAttribute("aria-expanded", "true");
    toggle?.setAttribute("aria-expanded", "true");
  }

  function toggleMenu() {
    if (isOpen()) close();
    else open();
  }

  toggle?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleMenu();
    input.focus();
  });

  // With typing switched off the box itself is the trigger, by pointer and by
  // keyboard, because there is nothing else the field can do.
  if (readOnly) {
    input.addEventListener("mousedown", (event) => {
      event.preventDefault();
      toggleMenu();
      input.focus();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (!isOpen()) open();
    });
  }

  // Choosing a preset must not blur the input first, or the host's own blur
  // commit would race the applied value.
  menu.addEventListener("mousedown", (event) => event.preventDefault());
  menu.addEventListener("click", (event) => {
    const option = event.target?.closest?.(".arNumberFormatOption");
    if (!option || !menu.contains(option)) return;
    close();
    if (option.dataset.custom) {
      onCustom?.();
      return;
    }
    onApply?.(option.dataset.value || option.textContent || "");
    input.focus();
  });

  documentRef.addEventListener("mousedown", (event) => {
    if (field.contains(event.target)) return;
    close();
  });
  documentRef.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });

  return { open, close, toggle: toggleMenu, isOpen };
}
