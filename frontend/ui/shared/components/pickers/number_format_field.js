import { DATASET_NUMBER_FORMAT_PRESETS } from "/ui/shared/dataset/dataset_number_format.js";

/**
 * Wires the shared Number Format field: an editable pattern input with an
 * in-field caret that opens the canonical preset list under it.
 *
 * The component owns opening, rendering, dismissal, and the ARIA expanded state.
 * The host owns what a chosen preset means, because that differs per page: the
 * Dataset Viewer re-derives Decimal Places and repaints its grid, while a method
 * page records the pair on its method JSON and marks the page dirty.
 */
export function wireNumberFormatField({
  input,
  field,
  toggle,
  menu,
  getPresets = () => DATASET_NUMBER_FORMAT_PRESETS,
  onApply,
  documentRef = globalThis.document,
} = {}) {
  if (!input || !field || !menu) return null;

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

  // Choosing a preset must not blur the input first, or the host's own blur
  // commit would race the applied value.
  menu.addEventListener("mousedown", (event) => event.preventDefault());
  menu.addEventListener("click", (event) => {
    const option = event.target?.closest?.(".arNumberFormatOption");
    if (!option || !menu.contains(option)) return;
    const preset = option.dataset.value || option.textContent || "";
    close();
    onApply?.(preset);
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
