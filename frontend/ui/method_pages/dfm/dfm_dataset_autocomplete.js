import {
  listDfmDatasetInstances,
  readDfmMethodIdentityFromPage,
} from "/ui/method_pages/dfm/dfm_method_api.js?v=20260811b";
import {
  completeDfmDatasetName,
  filterDfmDatasetNames,
  findActiveDfmDatasetNameQuery,
} from "/ui/method_pages/dfm/dfm_dataset_reference.js?v=20260811b";

const MAX_VISIBLE_DATASETS = 50;
const catalogPromises = new Map();
let activeAutocompleteController = null;

function catalogKey(identity) {
  return `${String(identity?.project_name || "").trim().toLocaleLowerCase()}\n${String(identity?.reserving_class || "").trim().toLocaleLowerCase()}`;
}

function loadCatalog(identity) {
  const key = catalogKey(identity);
  if (!key.trim()) return Promise.resolve([]);
  if (!catalogPromises.has(key)) {
    const request = listDfmDatasetInstances(identity).catch((error) => {
      catalogPromises.delete(key);
      throw error;
    });
    catalogPromises.set(key, request);
  }
  return catalogPromises.get(key);
}

function createPopup() {
  document.getElementById("dfmDatasetAutocomplete")?.remove();
  const popup = document.createElement("div");
  popup.id = "dfmDatasetAutocomplete";
  popup.className = "dfmDatasetAutocomplete";
  popup.setAttribute("role", "listbox");
  popup.setAttribute("aria-label", "Available datasets");
  popup.hidden = true;
  document.body.appendChild(popup);
  return popup;
}

function positionPopup(input, popup) {
  const rect = input.getBoundingClientRect();
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  const desiredHeight = Math.min(240, popup.scrollHeight || 240);
  const roomBelow = viewportHeight - rect.bottom - 8;
  const placeAbove = roomBelow < Math.min(140, desiredHeight) && rect.top > roomBelow;
  popup.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 268))}px`;
  popup.style.width = `${Math.max(260, Math.min(rect.width, window.innerWidth - 16))}px`;
  popup.style.top = placeAbove
    ? `${Math.max(8, rect.top - desiredHeight - 4)}px`
    : `${Math.min(viewportHeight - 8, rect.bottom + 4)}px`;
}

export function installDfmDatasetAutocomplete(input, options = {}) {
  if (!input || input.dataset.datasetAutocompleteWired === "1") return;
  activeAutocompleteController?.abort();
  activeAutocompleteController = new AbortController();
  const { signal } = activeAutocompleteController;
  input.dataset.datasetAutocompleteWired = "1";
  const identityProvider = options.identityProvider || readDfmMethodIdentityFromPage;
  const popup = createPopup();
  let activeQuery = null;
  let datasetNames = null;
  let loadError = "";
  let selectedIndex = 0;
  let renderGeneration = 0;

  function closePopup() {
    activeQuery = null;
    popup.hidden = true;
    popup.replaceChildren();
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  function chooseDataset(name) {
    const completion = completeDfmDatasetName(input.value, activeQuery, name);
    if (!completion) return;
    input.value = completion.value;
    input.setSelectionRange(completion.caret, completion.caret);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus({ preventScroll: true });
    closePopup();
  }

  function appendStatus(message, state = "") {
    const status = document.createElement("div");
    status.className = `dfmDatasetAutocompleteStatus${state ? ` is-${state}` : ""}`;
    status.setAttribute("role", state === "error" ? "alert" : "status");
    status.textContent = message;
    popup.appendChild(status);
  }

  function renderPopup() {
    const current = findActiveDfmDatasetNameQuery(input.value, input.selectionStart);
    if (!current || document.activeElement !== input) {
      closePopup();
      return;
    }
    activeQuery = current;
    popup.hidden = false;
    input.setAttribute("aria-expanded", "true");
    popup.replaceChildren();

    if (loadError) {
      appendStatus(loadError, "error");
      positionPopup(input, popup);
      return;
    }
    if (!datasetNames) {
      appendStatus("Loading datasets…", "loading");
      positionPopup(input, popup);
      return;
    }

    const matches = filterDfmDatasetNames(datasetNames, current.query).slice(0, MAX_VISIBLE_DATASETS);
    if (!matches.length) {
      appendStatus(current.query.trim() ? `No datasets contain “${current.query.trim()}”.` : "No datasets are available.");
      positionPopup(input, popup);
      return;
    }
    selectedIndex = Math.max(0, Math.min(selectedIndex, matches.length - 1));
    matches.forEach((name, index) => {
      const option = document.createElement("div");
      option.id = `dfmDatasetAutocompleteOption${index}`;
      option.className = "dfmDatasetAutocompleteOption";
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", index === selectedIndex ? "true" : "false");
      option.textContent = name;
      option.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        chooseDataset(name);
      });
      option.addEventListener("pointermove", () => {
        if (selectedIndex === index) return;
        selectedIndex = index;
        renderPopup();
      });
      popup.appendChild(option);
    });
    const activeOption = popup.querySelector(`[role="option"]:nth-child(${selectedIndex + 1})`);
    if (activeOption) {
      input.setAttribute("aria-activedescendant", activeOption.id);
      activeOption.scrollIntoView({ block: "nearest" });
    }
    positionPopup(input, popup);
  }

  async function refreshPopup() {
    const current = findActiveDfmDatasetNameQuery(input.value, input.selectionStart);
    if (!current) {
      closePopup();
      return;
    }
    activeQuery = current;
    selectedIndex = 0;
    renderPopup();
    if (datasetNames || loadError) return;
    const generation = ++renderGeneration;
    try {
      datasetNames = await loadCatalog(identityProvider());
    } catch (error) {
      loadError = error?.message || "Dataset list could not be loaded.";
    }
    if (generation === renderGeneration) renderPopup();
  }

  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-haspopup", "listbox");
  input.setAttribute("aria-controls", popup.id);
  input.setAttribute("aria-expanded", "false");
  input.addEventListener("input", () => void refreshPopup(), { signal });
  input.addEventListener("click", () => void refreshPopup(), { signal });
  input.addEventListener("keyup", (event) => {
    if (["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(event.key)) return;
    void refreshPopup();
  }, { signal });
  input.addEventListener("blur", () => window.setTimeout(closePopup, 0), { signal });
  input.addEventListener("keydown", (event) => {
    if (popup.hidden) return;
    const options = Array.from(popup.querySelectorAll('[role="option"]'));
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      closePopup();
      return;
    }
    if ((event.key === "Enter" || event.key === "Tab") && options[selectedIndex]) {
      event.preventDefault();
      event.stopImmediatePropagation();
      chooseDataset(options[selectedIndex].textContent);
      return;
    }
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && options.length) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      selectedIndex = (selectedIndex + direction + options.length) % options.length;
      renderPopup();
    }
  }, { capture: true, signal });
  window.addEventListener("resize", () => {
    if (!popup.hidden) positionPopup(input, popup);
  }, { signal });
  window.addEventListener("scroll", () => {
    if (!popup.hidden) positionPopup(input, popup);
  }, { capture: true, signal });
}
