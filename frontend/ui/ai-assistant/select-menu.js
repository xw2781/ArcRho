const menus = new WeakMap();
let nextMenuId = 0;

const CHECK_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"></path></svg>';

/**
 * App-styled listbox over a settings `<select>`. A native select popup cannot be
 * themed, so the select stays the hidden value store: its options and optgroups
 * own the choices, `data-note` adds a quiet trailing tag, and picking a row sets
 * the value and fires the select's own `change` event.
 */
export function installAssistantSelectMenu(select) {
  if (!select || menus.has(select)) return menus.get(select) || null;
  const id = `aiAssistantSelectMenu${nextMenuId += 1}`;
  const wrap = document.createElement("div");
  wrap.className = "aiAssistantMenuSelect";
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.id = `${id}Trigger`;
  trigger.className = "aiAssistantMenuSelectTrigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-controls", `${id}List`);
  const valueEl = document.createElement("span");
  valueEl.className = "aiAssistantMenuSelectValue";
  const caret = document.createElement("span");
  caret.className = "aiAssistantMenuSelectCaret";
  caret.setAttribute("aria-hidden", "true");
  trigger.append(valueEl, caret);
  const list = document.createElement("div");
  list.id = `${id}List`;
  list.className = "aiAssistantMenuSelectList";
  list.setAttribute("role", "listbox");
  list.hidden = true;
  wrap.append(trigger, list);
  select.hidden = true;
  select.after(wrap);
  const label = select.closest("label");
  if (label?.htmlFor === select.id) label.htmlFor = trigger.id;
  list.setAttribute("aria-label", label?.querySelector("span")?.textContent?.trim() || select.id);

  let activeIndex = -1;
  const optionRows = () => [...list.querySelectorAll(".aiAssistantMenuSelectOption:not([aria-disabled=\"true\"])")];

  function selectedOption() {
    return [...select.options].find((option) => option.value === select.value) || null;
  }

  function sync() {
    const option = selectedOption();
    valueEl.textContent = option?.textContent || "";
    trigger.disabled = select.disabled;
    if (select.disabled) close();
  }

  function setActive(index) {
    const rows = optionRows();
    activeIndex = rows.length && index >= 0 ? Math.min(rows.length - 1, index) : -1;
    rows.forEach((row, rowIndex) => row.classList.toggle("active", rowIndex === activeIndex));
    const active = rows[activeIndex];
    if (active) {
      trigger.setAttribute("aria-activedescendant", active.id);
      active.scrollIntoView({ block: "nearest" });
    } else {
      trigger.removeAttribute("aria-activedescendant");
    }
  }

  function appendOption(option, index) {
    const row = document.createElement("div");
    row.id = `${id}Option${index}`;
    row.className = "aiAssistantMenuSelectOption";
    row.setAttribute("role", "option");
    const selected = option.value === select.value;
    row.setAttribute("aria-selected", String(selected));
    if (option.disabled) row.setAttribute("aria-disabled", "true");
    row.dataset.value = option.value;
    const check = document.createElement("span");
    check.className = "aiAssistantMenuSelectCheck";
    if (selected) check.innerHTML = CHECK_ICON;
    const name = document.createElement("span");
    name.className = "aiAssistantMenuSelectName";
    name.textContent = option.textContent;
    row.append(check, name);
    if (option.dataset.note) {
      const note = document.createElement("span");
      note.className = "aiAssistantMenuSelectNote";
      note.textContent = option.dataset.note;
      row.appendChild(note);
    }
    list.appendChild(row);
  }

  function render() {
    list.replaceChildren();
    let index = 0;
    for (const child of select.children) {
      if (child.tagName === "OPTGROUP") {
        const group = document.createElement("div");
        group.className = "aiAssistantMenuSelectGroup";
        group.setAttribute("role", "presentation");
        group.textContent = child.label;
        list.appendChild(group);
        for (const option of child.children) appendOption(option, index++);
      } else {
        appendOption(child, index++);
      }
    }
    setActive(optionRows().findIndex((row) => row.dataset.value === select.value));
  }

  function open() {
    if (select.disabled || !select.options.length) return;
    render();
    list.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    setActive(activeIndex);
  }

  function close() {
    if (list.hidden) return;
    list.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    setActive(-1);
  }

  function choose(value) {
    close();
    trigger.focus();
    if (value === select.value) return;
    select.value = value;
    sync();
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  trigger.addEventListener("click", () => {
    if (list.hidden) open();
    else close();
  });
  trigger.addEventListener("keydown", (event) => {
    const count = optionRows().length;
    if (event.key === "Escape" && !list.hidden) {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (list.hidden) {
        open();
        return;
      }
      if (!count) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const next = activeIndex < 0 ? (delta > 0 ? 0 : count - 1) : activeIndex + delta;
      setActive((next + count) % count);
    } else if ((event.key === "Home" || event.key === "End") && !list.hidden) {
      event.preventDefault();
      setActive(event.key === "Home" ? 0 : count - 1);
    } else if ((event.key === "Enter" || event.key === " ") && !list.hidden) {
      event.preventDefault();
      const active = optionRows()[activeIndex];
      if (active) choose(active.dataset.value);
      else close();
    } else if (event.key === "Tab") {
      close();
    }
  });
  list.addEventListener("mousedown", (event) => event.preventDefault());
  list.addEventListener("click", (event) => {
    // The list sits inside the field's <label>; stop the label from re-activating the trigger.
    event.preventDefault();
    const row = event.target.closest(".aiAssistantMenuSelectOption");
    if (row && row.getAttribute("aria-disabled") !== "true") choose(row.dataset.value);
  });
  list.addEventListener("mousemove", (event) => {
    const row = event.target.closest(".aiAssistantMenuSelectOption");
    const index = row ? optionRows().indexOf(row) : -1;
    if (index >= 0 && index !== activeIndex) setActive(index);
  });
  document.addEventListener("mousedown", (event) => {
    if (!wrap.contains(event.target)) close();
  }, true);

  const menu = { sync, open, close };
  menus.set(select, menu);
  sync();
  return menu;
}

export function syncAssistantSelectMenu(select) {
  if (select) menus.get(select)?.sync();
}
