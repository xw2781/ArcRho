const cleanCategory = (value) => String(value ?? "").trim();
const categoryKey = (value) => cleanCategory(value).toLowerCase();

export function normalizeCategoryOptions(values) {
  const byKey = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    const label = cleanCategory(value);
    const key = categoryKey(label);
    if (key && !byKey.has(key)) byKey.set(key, label);
  }
  return [...byKey.values()].sort((left, right) =>
    left.localeCompare(right, undefined, { sensitivity: "base" }));
}

export function filterCategoryOptions(options, query) {
  const key = categoryKey(query);
  if (!key) return Array.isArray(options) ? options.slice() : [];
  return (Array.isArray(options) ? options : [])
    .filter((option) => categoryKey(option).includes(key));
}

export function isNewCategoryValue(value, options) {
  const key = categoryKey(value);
  return !!key && !(Array.isArray(options) ? options : [])
    .some((option) => categoryKey(option) === key);
}

export function createDatasetTypeCategoryCombo({
  root,
  input,
  toggle,
  list,
  newTip,
  newTipText,
} = {}) {
  let options = [];
  let activeIndex = -1;
  let filterText = "";

  if (list && list.parentElement !== document.body) document.body.appendChild(list);
  if (newTip && newTip.parentElement !== document.body) document.body.appendChild(newTip);

  const setExpanded = (expanded) => {
    input?.setAttribute("aria-expanded", String(expanded));
    toggle?.setAttribute("aria-expanded", String(expanded));
  };

  function exactOption(value) {
    const key = categoryKey(value);
    return options.find((option) => categoryKey(option) === key) || "";
  }

  function visibleOptions() {
    return filterCategoryOptions(options, filterText);
  }

  function updateNewTip() {
    const value = cleanCategory(input?.value);
    const visible = isNewCategoryValue(value, options);
    if (newTipText) {
      newTipText.textContent = visible
        ? `“${value}” will be created when you apply.`
        : "";
    }
    if (newTip) newTip.hidden = !visible;
    return visible;
  }

  function setActive(index) {
    const rows = [...(list?.querySelectorAll(".dt-category-option") || [])];
    activeIndex = rows.length && index >= 0
      ? Math.max(0, Math.min(rows.length - 1, index))
      : -1;
    rows.forEach((row, rowIndex) => row.classList.toggle("active", rowIndex === activeIndex));
    const active = activeIndex >= 0 ? rows[activeIndex] : null;
    if (active?.id) input?.setAttribute("aria-activedescendant", active.id);
    else input?.removeAttribute("aria-activedescendant");
    active?.scrollIntoView({ block: "nearest" });
  }

  function render() {
    if (!list) return;
    list.replaceChildren();
    const rows = visibleOptions();
    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "sd-select-empty";
      empty.textContent = options.length
        ? "No existing categories match."
        : "No existing categories yet.";
      list.appendChild(empty);
      activeIndex = -1;
      input?.removeAttribute("aria-activedescendant");
      return;
    }
    const selectedKey = categoryKey(input?.value);
    rows.forEach((value, index) => {
      const row = document.createElement("div");
      row.className = "sd-select-opt dt-category-option";
      row.id = `dt-category-option-${index}`;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(categoryKey(value) === selectedKey));
      row.dataset.value = value;

      const label = document.createElement("span");
      label.className = "sd-select-opt-name";
      label.textContent = value;
      row.appendChild(label);
      list.appendChild(row);
    });
    setActive(-1);
  }

  function positionFloating() {
    if (!root || !input) return;
    const rect = root.getBoundingClientRect();
    const margin = 8;
    const gap = 4;
    const left = Math.max(margin, Math.min(rect.left, window.innerWidth - rect.width - margin));
    let nextTop = rect.bottom + gap;

    if (newTip && !newTip.hidden) {
      newTip.style.width = `${Math.round(rect.width)}px`;
      newTip.style.left = `${Math.round(left)}px`;
      newTip.style.top = `${Math.round(nextTop)}px`;
      nextTop = newTip.getBoundingClientRect().bottom + gap;
    }

    if (list && !list.hidden) {
      list.style.width = `${Math.round(rect.width)}px`;
      list.style.left = "-9999px";
      list.style.top = "0px";
      const listHeight = list.getBoundingClientRect().height;
      let listTop = nextTop;
      if (listTop + listHeight > window.innerHeight - margin) {
        listTop = Math.max(margin, rect.top - listHeight - gap);
      }
      list.style.left = `${Math.round(left)}px`;
      list.style.top = `${Math.round(listTop)}px`;
    }
  }

  function open() {
    if (!list || input?.disabled) return;
    render();
    list.hidden = false;
    setExpanded(true);
    positionFloating();
  }

  function close({ hideNewTip = false } = {}) {
    if (list) list.hidden = true;
    setExpanded(false);
    setActive(-1);
    if (hideNewTip && newTip) newTip.hidden = true;
  }

  function choose(value) {
    if (input) input.value = cleanCategory(value);
    filterText = "";
    updateNewTip();
    close();
    input?.focus();
  }

  input?.addEventListener("focus", () => {
    filterText = "";
    open();
  });
  input?.addEventListener("input", () => {
    filterText = String(input.value || "");
    updateNewTip();
    open();
  });
  input?.addEventListener("blur", () => {
    const existing = exactOption(input.value);
    if (existing) input.value = existing;
    updateNewTip();
    positionFloating();
  });
  input?.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && list && !list.hidden) {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (list?.hidden) open();
      const count = list?.querySelectorAll(".dt-category-option").length || 0;
      if (!count) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const next = activeIndex < 0 ? (delta > 0 ? 0 : count - 1) : activeIndex + delta;
      setActive((next + count) % count);
      return;
    }
    if (event.key === "Enter" && activeIndex >= 0) {
      const active = list?.querySelectorAll(".dt-category-option")?.[activeIndex];
      if (!active) return;
      event.preventDefault();
      choose(active.dataset.value);
    }
  });

  toggle?.addEventListener("mousedown", (event) => event.preventDefault());
  toggle?.addEventListener("click", () => {
    if (list?.hidden) {
      filterText = "";
      open();
    }
    else close();
    input?.focus();
  });
  list?.addEventListener("mousedown", (event) => event.preventDefault());
  list?.addEventListener("click", (event) => {
    const option = event.target.closest(".dt-category-option");
    if (option) choose(option.dataset.value);
  });
  document.addEventListener("mousedown", (event) => {
    if (root?.contains(event.target) || list?.contains(event.target)) return;
    close();
  });
  window.addEventListener("resize", positionFloating);
  window.addEventListener("scroll", positionFloating, true);

  return {
    close,
    open,
    positionFloating,
    getValue() {
      return exactOption(input?.value) || cleanCategory(input?.value);
    },
    setOptions(values) {
      options = normalizeCategoryOptions(values);
      filterText = "";
      render();
      updateNewTip();
    },
    setValue(value) {
      if (input) input.value = cleanCategory(value);
      filterText = "";
      updateNewTip();
      close();
    },
  };
}
