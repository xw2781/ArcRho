const cleanValue = (value) => String(value ?? "").trim();

/**
 * The native `<select>` stays the value store, so its options own the choice
 * set and the disabled first option owns the placeholder text.
 */
export function readFormatOptions(select) {
  const all = [...(select?.options || [])];
  const placeholderOption = all.find((option) => option.disabled);
  return {
    placeholder: cleanValue(placeholderOption?.textContent),
    options: all
      .filter((option) => !option.disabled)
      .map((option) => ({
        value: cleanValue(option.value),
        label: cleanValue(option.textContent) || cleanValue(option.value),
      }))
      .filter((option) => !!option.value),
  };
}

export function isAllowedFormatValue(value, options) {
  const key = cleanValue(value);
  return !!key && (Array.isArray(options) ? options : [])
    .some((option) => cleanValue(option?.value) === key);
}

/**
 * App-styled listbox for the Dataset Type `Data Format` field. A native select
 * popup cannot be themed, so the select is kept as the hidden value store and
 * the shared `sd-select` primitives draw the trigger and the option list.
 */
export function createDatasetTypeFormatSelect({
  root,
  select,
  trigger,
  valueEl,
  list,
} = {}) {
  const { options, placeholder } = readFormatOptions(select);
  let activeIndex = -1;

  // The list renders into document.body: the editor is a dragged floating
  // panel, so a list nested inside it would be clipped and mis-anchored.
  if (list && list.parentElement !== document.body) document.body.appendChild(list);

  const getValue = () => cleanValue(select?.value);
  const optionRows = () => [...(list?.querySelectorAll(".dt-format-option") || [])];

  function syncTrigger() {
    const value = getValue();
    const match = options.find((option) => option.value === value);
    if (valueEl) valueEl.textContent = match ? match.label : placeholder;
    trigger?.classList.toggle("is-placeholder", !match);
  }

  function setActive(index) {
    const rows = optionRows();
    activeIndex = rows.length && index >= 0
      ? Math.max(0, Math.min(rows.length - 1, index))
      : -1;
    rows.forEach((row, rowIndex) => row.classList.toggle("active", rowIndex === activeIndex));
    const active = activeIndex >= 0 ? rows[activeIndex] : null;
    if (active?.id) trigger?.setAttribute("aria-activedescendant", active.id);
    else trigger?.removeAttribute("aria-activedescendant");
    active?.scrollIntoView({ block: "nearest" });
  }

  function render() {
    if (!list) return;
    const value = getValue();
    list.replaceChildren();
    options.forEach((option, index) => {
      const row = document.createElement("div");
      row.className = "sd-select-opt dt-format-option";
      row.id = `dt-format-option-${index}`;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(option.value === value));
      row.dataset.value = option.value;

      const label = document.createElement("span");
      label.className = "sd-select-opt-name";
      label.textContent = option.label;
      row.appendChild(label);
      list.appendChild(row);
    });
    setActive(options.findIndex((option) => option.value === value));
  }

  function positionFloating() {
    if (!root || !list || list.hidden) return;
    const rect = root.getBoundingClientRect();
    const margin = 8;
    const gap = 4;
    list.style.width = `${Math.round(rect.width)}px`;
    list.style.left = "-9999px";
    list.style.top = "0px";
    const listHeight = list.getBoundingClientRect().height;
    let top = rect.bottom + gap;
    if (top + listHeight > window.innerHeight - margin) {
      top = Math.max(margin, rect.top - listHeight - gap);
    }
    const left = Math.max(margin, Math.min(rect.left, window.innerWidth - rect.width - margin));
    list.style.left = `${Math.round(left)}px`;
    list.style.top = `${Math.round(top)}px`;
  }

  function open() {
    if (!list || !options.length || trigger?.disabled) return;
    render();
    list.hidden = false;
    trigger?.setAttribute("aria-expanded", "true");
    positionFloating();
  }

  function close() {
    if (list) list.hidden = true;
    trigger?.setAttribute("aria-expanded", "false");
    setActive(-1);
  }

  function setValue(value, { notify = false } = {}) {
    const next = cleanValue(value);
    if (select) select.value = isAllowedFormatValue(next, options) ? next : "";
    syncTrigger();
    if (!list?.hidden) render();
    if (notify) select?.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function choose(value) {
    setValue(value, { notify: true });
    close();
    trigger?.focus();
  }

  trigger?.addEventListener("click", () => {
    if (list?.hidden) open();
    else close();
  });
  trigger?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (list?.hidden) return;
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (list?.hidden) {
        open();
        return;
      }
      const count = optionRows().length;
      if (!count) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const next = activeIndex < 0 ? (delta > 0 ? 0 : count - 1) : activeIndex + delta;
      setActive((next + count) % count);
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && !list?.hidden && activeIndex >= 0) {
      const active = optionRows()[activeIndex];
      if (!active) return;
      event.preventDefault();
      choose(active.dataset.value);
    }
  });

  // A validation failure focuses the select; the trigger is the visible control.
  select?.addEventListener("focus", () => trigger?.focus());

  list?.addEventListener("mousedown", (event) => event.preventDefault());
  list?.addEventListener("click", (event) => {
    const option = event.target.closest(".dt-format-option");
    if (option) choose(option.dataset.value);
  });
  document.addEventListener("mousedown", (event) => {
    if (root?.contains(event.target) || list?.contains(event.target)) return;
    close();
  });
  window.addEventListener("resize", positionFloating);
  window.addEventListener("scroll", positionFloating, true);

  syncTrigger();

  return {
    close,
    open,
    positionFloating,
    getValue,
    setValue,
  };
}
