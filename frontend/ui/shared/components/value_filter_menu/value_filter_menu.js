/** The PI dataset table's searchable checkbox menu, shared by filter consumers. */
export function allFilterValuesSelected(selected, options) {
  return selected instanceof Set && Array.isArray(options) && options.length > 0
    && selected.size === options.length && options.every(option => selected.has(option.key));
}

export function renderValueFilterMenu(container, { label, options, selected, searchText = "", onSearch = () => {}, onChange }) {
  const doc = container.ownerDocument;
  container.replaceChildren();
  const title = doc.createElement("div");
  title.className = "pi-table-filter-title";
  title.textContent = `${label} Filter`;
  const search = doc.createElement("input");
  search.className = "pi-table-filter-search";
  search.type = "search";
  search.autocomplete = "off";
  search.placeholder = "Type to search";
  search.setAttribute("aria-label", `Search ${label} filter values`);
  search.value = searchText;
  const list = doc.createElement("div");
  list.className = "pi-table-filter-list";
  container.append(title, search, list);

  function commit(action) {
    onChange({ action, allSelected: allFilterValuesSelected(selected, options) });
    renderOptions();
  }

  function renderOptions() {
    list.replaceChildren();
    const needle = search.value.trim().toLocaleLowerCase();
    const visible = options.filter(option => option.label.toLocaleLowerCase().includes(needle));
    const allRow = doc.createElement("label");
    allRow.className = "pi-table-filter-option";
    const allBox = doc.createElement("input");
    allBox.type = "checkbox";
    allBox.checked = !selected.size || allFilterValuesSelected(selected, options);
    allBox.addEventListener("change", () => { selected.clear(); commit("all"); });
    const allText = doc.createElement("span");
    allText.textContent = "All";
    allRow.append(allBox, allText);
    list.appendChild(allRow);
    for (const option of visible) {
      const row = doc.createElement("label");
      row.className = "pi-table-filter-option";
      const box = doc.createElement("input");
      box.type = "checkbox";
      box.value = option.key;
      box.checked = selected.has(option.key);
      box.addEventListener("change", () => {
        box.checked ? selected.add(option.key) : selected.delete(option.key);
        commit("value");
      });
      row.addEventListener("contextmenu", event => {
        event.preventDefault();
        event.stopPropagation();
        selected.clear();
        for (const other of options) if (other.key !== option.key) selected.add(other.key);
        commit("exclude");
      });
      const text = doc.createElement("span");
      text.textContent = option.label;
      row.append(box, text);
      list.appendChild(row);
    }
    if (!visible.length) {
      const empty = doc.createElement("div");
      empty.className = "pi-table-filter-empty";
      empty.textContent = options.length ? "No matching values" : "No values";
      list.appendChild(empty);
    }
  }
  search.addEventListener("input", () => { onSearch(search.value); renderOptions(); });
  renderOptions();
  return { search };
}
