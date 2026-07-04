(function () {
  const parts = window.ResultSelectionParts || (window.ResultSelectionParts = {});

  parts.installUi = function installUi(ctx) {
    with (ctx) {
      function numberOrNull(value) {
        if (value === null || value === undefined || value === "") return null;
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
      }

      function roundRsJsonNumber(value) {
        const n = numberOrNull(value);
        if (n === null) return null;
        const factor = 10 ** RS_JSON_VALUE_DECIMAL_PLACES;
        return Math.round(n * factor) / factor;
      }

      function roundRsJsonVector(values) {
        return Array.isArray(values) ? values.map(roundRsJsonNumber) : [];
      }

      function positiveInt(value, fallback = DEFAULT_ORIGIN_LENGTH) {
        const n = Number.parseInt(String(value ?? ""), 10);
        return Number.isFinite(n) && n > 0 ? n : fallback;
      }

      function validOriginLength(value, fallback = DEFAULT_ORIGIN_LENGTH) {
        const n = positiveInt(value, fallback);
        return VALID_ORIGIN_LENGTHS.includes(n) ? n : fallback;
      }

      function validSourceOriginLength(value) {
        const n = validOriginLength(value, 0);
        return VALID_ORIGIN_LENGTHS.includes(n) ? n : null;
      }

      function isEngineSource(source) {
        return norm(source?.sourceKind || source?.source_kind) === "engine";
      }

      function isVectorSource(source) {
        return norm(source?.dataFormat || source?.data_format) === "vector";
      }

      function datasetTypeCategoryForName(name) {
        const key = norm(name);
        if (!key) return "";
        const item = datasetTypeItems.find((entry) => norm(entry?.name) === key);
        return text(item?.category);
      }

      function getOutputCategory() {
        const fromOutputType = datasetTypeCategoryForName(els.outputTypeInput?.value);
        return fromOutputType || state.outputCategory || "";
      }

      function syncOutputCategory() {
        state.outputCategory = getOutputCategory();
        return state.outputCategory;
      }

      function sourceCategory(source) {
        return text(source?.category || source?.dataset_category || datasetTypeCategoryForName(source?.datasetType || source?.dataset_type || source?.name));
      }

      function matchesOutputCategory(source) {
        const outputCategory = getOutputCategory();
        if (!outputCategory) return true;
        return norm(sourceCategory(source)) === norm(outputCategory);
      }

      function nonNegativeInt(value, fallback = 0) {
        const n = Number.parseInt(String(value ?? ""), 10);
        return Number.isFinite(n) && n >= 0 ? n : fallback;
      }

      function statisticDecimalPlacesValue(value, fallback = 1) {
        return Math.max(0, Math.min(8, nonNegativeInt(value, fallback)));
      }

      function syncStatisticDecimalInputs(source = "details") {
        const sourceEl = source === "method" && els.methodStatisticDecimalsInput
          ? els.methodStatisticDecimalsInput
          : els.statisticDecimalsInput;
        const fallback = statisticDecimalPlacesValue(els.statisticDecimalsInput?.value, 1);
        const next = String(statisticDecimalPlacesValue(sourceEl?.value, fallback));
        if (els.statisticDecimalsInput && els.statisticDecimalsInput.value !== next) {
          els.statisticDecimalsInput.value = next;
        }
        if (els.methodStatisticDecimalsInput && els.methodStatisticDecimalsInput.value !== next) {
          els.methodStatisticDecimalsInput.value = next;
        }
        return next;
      }

      function getHostApi() {
        if (window.ADAHost) return window.ADAHost;
        try {
          let w = window.parent;
          while (w && w !== window) {
            if (w.ADAHost) return w.ADAHost;
            if (w === w.parent) break;
            w = w.parent;
          }
        } catch {}
        return null;
      }

      function postStatus(message, tone = "") {
        try {
          window.parent?.postMessage({ type: "arcrho:status", text: String(message || ""), ...(tone ? { tone } : {}) }, "*");
        } catch {}
      }

      function postDirty(dirty, force = false) {
        const next = !!dirty;
        if (!force && isDirty === next) return;
        isDirty = next;
        updateTabbedPageSaveControls({
          saveButton: els.saveBtn,
          cancelButton: els.cancelBtn,
          dirty: next,
        });
        try {
          window.parent?.postMessage({ type: "arcrho:dataset-dirty", inst, dirty: next }, "*");
        } catch {}
      }

      function markDirty() {
        if (programmatic) return;
        postDirty(true);
        postResultSelectionDependencyPreview();
      }

      function sourceMessageNames(message = {}) {
        const names = Array.isArray(message.names) ? message.names : [message.datasetName, message.datasetTypeName, message.name];
        return new Set(names.map((value) => norm(value)).filter(Boolean));
      }

      function sourceMessageMatchesContext(message = {}) {
        const project = text(message.project);
        const reservingClass = text(message.reservingClass || message.reserving_class);
        if (project && norm(project) !== norm(state.project)) return false;
        if (reservingClass && norm(reservingClass) !== norm(state.reservingClass)) return false;
        return true;
      }

      function sourceMessageMatchesSource(message, source) {
        if (!source) return false;
        const names = sourceMessageNames(message);
        return [source.name, source.datasetType, source.dataset_type]
          .some((value) => names.has(norm(value)));
      }

      function normalizePreviewValues(values) {
        return Array.isArray(values) ? values.map(numberOrNull) : [];
      }

      function buildResultSelectionDependencySourceMessage(type, reason = "") {
        const details = getDetails();
        const payload = {
          type,
          inst,
          project: state.project,
          reservingClass: state.reservingClass,
          datasetName: details.name,
          datasetTypeName: details.outputType,
          names: [details.name, details.outputType].filter(Boolean),
          methodType: "Result Selection",
          sourceKind: "result_selection",
          dataFormat: "Vector",
          reason,
        };
        if (type === "arcrho:dependency-source-preview") {
          payload.values = buildPayload().method_tab.selected_ultimate || [];
          payload.originLabels = state.originLabels.map(String);
        }
        return payload;
      }

      function postResultSelectionDependencySourceMessage(type, reason = "") {
        const message = buildResultSelectionDependencySourceMessage(type, reason);
        if (!message.names.length) return;
        try {
          window.parent?.postMessage(message, "*");
        } catch {}
      }

      function postResultSelectionDependencyPreview() {
        postResultSelectionDependencySourceMessage("arcrho:dependency-source-preview", "dirty");
      }

      function clearResultSelectionDependencyPreview(reason = "") {
        postResultSelectionDependencySourceMessage("arcrho:dependency-source-cleared", reason || "clean");
      }

      async function reloadSourcesMatchingMessage(message, options = {}) {
        if (!sourceMessageMatchesContext(message)) return false;
        const matches = [];
        for (let index = 0; index < state.sources.length; index += 1) {
          if (sourceMessageMatchesSource(message, state.sources[index])) matches.push(index);
        }
        if (!matches.length) return false;
        if (options.refreshCache) await loadCachedRows(true).catch(() => {});
        for (const index of matches) {
          const existing = state.sources[index];
          const record = cachedRows.find((row) => norm(row.name) === norm(existing.name)) || null;
          const reloadExisting = { ...existing, values: [] };
          const built = await buildSourceFromRecord(record || { name: existing.name }, reloadExisting);
          state.sources[index] = built;
        }
        state.sources = state.sources.filter(Boolean);
        renderMethodGrid();
        return true;
      }

      function applyDependencySourcePreview(message) {
        if (!sourceMessageMatchesContext(message)) return false;
        const values = normalizePreviewValues(message.values);
        if (!values.length) return false;
        let changed = false;
        for (const source of state.sources) {
          if (!sourceMessageMatchesSource(message, source)) continue;
          source.values = values.slice();
          source.dataFormat = text(message.dataFormat || message.data_format || source.dataFormat || "Vector");
          source.sourceKind = text(message.sourceKind || message.source_kind || source.sourceKind);
          source.methodType = text(message.methodType || message.method_type || source.methodType);
          source.originLength = validSourceOriginLength(message.originLength || message.origin_length) || source.originLength;
          if (!Array.isArray(source.weights)) source.weights = [];
          while (source.weights.length < source.values.length) source.weights.push(0);
          changed = true;
        }
        if (changed) renderMethodGrid();
        return changed;
      }

      function withProgrammatic(fn) {
        programmatic = true;
        try {
          return fn();
        } finally {
          programmatic = false;
        }
      }

      function dropdownOptions(menu) {
        return Array.from(menu?.querySelectorAll?.(".rsDropdownOption") || []);
      }

      function getDropdownValue(menu) {
        const selected = dropdownOptions(menu).find((option) => option.getAttribute("aria-selected") === "true");
        return text(selected?.dataset?.value);
      }

      function setDropdownOpen(dropdown, button, open) {
        if (!dropdown || !button || button.disabled) return;
        dropdown.classList.toggle("open", !!open);
        button.setAttribute("aria-expanded", open ? "true" : "false");
      }

      function closeDropdown(dropdown, button) {
        if (!dropdown || !button) return;
        dropdown.classList.remove("open");
        button.setAttribute("aria-expanded", "false");
      }

      function closeAllDropdowns(except = null) {
        const pairs = [
          [els.weightDisplayDropdown, els.weightDisplayButton],
          [els.originLengthDropdown, els.originLengthButton],
          [els.activeRatioBasisDropdown, els.activeRatioBasisButton],
        ];
        for (const [dropdown, button] of pairs) {
          if (!dropdown || dropdown === except) continue;
          closeDropdown(dropdown, button);
        }
      }

      function makeDropdownOption(value, label, selected = false) {
        const option = document.createElement("button");
        option.className = "rsDropdownOption";
        option.type = "button";
        option.setAttribute("role", "option");
        option.dataset.value = text(value);
        option.textContent = text(label);
        option.setAttribute("aria-selected", selected ? "true" : "false");
        return option;
      }

      function syncDropdownValue(menu, labelEl, value, fallbackLabel = "") {
        const options = dropdownOptions(menu);
        const wanted = text(value);
        let selected = null;
        for (const option of options) {
          const isSelected = text(option.dataset.value) === wanted;
          option.setAttribute("aria-selected", isSelected ? "true" : "false");
          if (isSelected) selected = option;
        }
        if (!selected && options.length) {
          selected = options[0];
          selected.setAttribute("aria-selected", "true");
        }
        if (labelEl) labelEl.textContent = selected?.textContent || fallbackLabel;
        return text(selected?.dataset?.value);
      }

      function wireDropdown(dropdown, button, menu, onSelect) {
        if (!dropdown || !button || !menu) return;
        button.addEventListener("click", (event) => {
          event.preventDefault();
          const nextOpen = !dropdown.classList.contains("open");
          closeAllDropdowns(dropdown);
          setDropdownOpen(dropdown, button, nextOpen);
          if (nextOpen) {
            const selected = dropdownOptions(menu).find((option) => option.getAttribute("aria-selected") === "true");
            selected?.focus?.({ preventScroll: true });
          }
        });
        menu.addEventListener("click", (event) => {
          const option = event.target?.closest?.(".rsDropdownOption");
          if (!option) return;
          event.preventDefault();
          const value = text(option.dataset.value);
          onSelect?.(value);
          closeDropdown(dropdown, button);
          button.focus?.({ preventScroll: true });
        });
        dropdown.addEventListener("keydown", (event) => {
          const key = event.key;
          if (key === "Escape") {
            event.preventDefault();
            closeDropdown(dropdown, button);
            button.focus?.({ preventScroll: true });
            return;
          }
          if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Enter" && key !== " ") return;
          const options = dropdownOptions(menu);
          if (!options.length) return;
          if (!dropdown.classList.contains("open")) {
            event.preventDefault();
            closeAllDropdowns(dropdown);
            setDropdownOpen(dropdown, button, true);
            const selected = options.find((option) => option.getAttribute("aria-selected") === "true") || options[0];
            selected.focus?.({ preventScroll: true });
            return;
          }
          const activeIndex = Math.max(0, options.indexOf(document.activeElement));
          if (key === "ArrowDown" || key === "ArrowUp") {
            event.preventDefault();
            const delta = key === "ArrowDown" ? 1 : -1;
            const nextIndex = (activeIndex + delta + options.length) % options.length;
            options[nextIndex]?.focus?.({ preventScroll: true });
            return;
          }
          if (document.activeElement?.classList?.contains("rsDropdownOption")) {
            event.preventDefault();
            document.activeElement.click();
          }
        });
      }

      function uniqueRatioBasisNames(names) {
        const out = [];
        const seen = new Set();
        for (const value of Array.isArray(names) ? names : []) {
          const name = text(value);
          const key = norm(name);
          if (!name || !key || seen.has(key)) continue;
          seen.add(key);
          out.push(name);
          if (out.length >= MAX_RATIO_BASIS_COUNT) break;
        }
        return out;
      }

      function getRatioBasisNames() {
        return uniqueRatioBasisNames((els.ratioBasisInputs || []).map((input) => input?.value));
      }

      function matchRatioBasisName(value, names = getRatioBasisNames()) {
        const key = norm(value);
        if (!key) return "";
        return names.find((name) => norm(name) === key) || "";
      }

      function normalizeRatioBasisDetails(details = {}) {
        const fromList = Array.isArray(details.ratio_basis_datasets)
          ? details.ratio_basis_datasets
          : [];
        const fallback = text(details.ratio_basis_dataset || details.ratio_basis);
        const names = uniqueRatioBasisNames(fromList.length ? fromList : [fallback]);
        const active = text(details.active_ratio_basis_dataset || fallback);
        if (active && !matchRatioBasisName(active, names) && names.length < MAX_RATIO_BASIS_COUNT) {
          names.push(active);
        }
        return {
          names: uniqueRatioBasisNames(names),
          active: matchRatioBasisName(active, names) || names[0] || "",
        };
      }

      function syncRatioBasisSelector() {
        const menu = els.activeRatioBasisMenu;
        const button = els.activeRatioBasisButton;
        const names = getRatioBasisNames();
        const active = matchRatioBasisName(state.activeRatioBasisName, names) || names[0] || "";
        state.activeRatioBasisName = active;
        if (!menu) return active;
        const previous = getDropdownValue(menu);
        menu.replaceChildren();
        if (!names.length) {
          menu.appendChild(makeDropdownOption("", "No basis", true));
          if (button) {
            button.disabled = true;
            button.title = "No ratio basis";
          }
          syncDropdownValue(menu, els.activeRatioBasisLabel, "", "No basis");
          closeDropdown(els.activeRatioBasisDropdown, button);
          return "";
        }
        for (const name of names) {
          menu.appendChild(makeDropdownOption(name, name, norm(name) === norm(active || names[0])));
        }
        if (button) button.disabled = false;
        const selected = syncDropdownValue(menu, els.activeRatioBasisLabel, active || names[0], names[0]);
        if (button && previous !== selected) {
          button.title = selected ? `Active ratio basis: ${selected}` : "No ratio basis";
        }
        return selected;
      }

      function getActiveRatioBasisName() {
        const selectValue = getDropdownValue(els.activeRatioBasisMenu);
        const names = getRatioBasisNames();
        const selected = matchRatioBasisName(selectValue, names)
          || matchRatioBasisName(state.activeRatioBasisName, names)
          || names[0]
          || "";
        state.activeRatioBasisName = selected;
        return selected;
      }

      function getDetails() {
        const ratioBases = getRatioBasisNames();
        const ratioBasis = getActiveRatioBasisName();
        const outputCategory = syncOutputCategory();
        return {
          name: text(els.nameInput.value),
          outputType: text(els.outputTypeInput.value),
          outputCategory,
          originLength: validOriginLength(els.originLengthInput.value),
          ratioBasis,
          ratioBases,
          showRatiosAsPercentages: !!els.showRatiosPctInput.checked,
          statisticDecimalPlaces: statisticDecimalPlacesValue(els.statisticDecimalsInput.value, 1),
          showWeights: !!els.showWeightsInput.checked,
        };
      }

      function getResultSelectionDisplayName() {
        return getDetails().name || "Result Selection";
      }

      function resolveCloseConfirm(value) {
        if (els.closeConfirmOverlay) els.closeConfirmOverlay.hidden = true;
        const resolve = closeConfirmResolve;
        closeConfirmResolve = null;
        if (resolve) resolve(!!value);
      }

      function resetCloseConfirmPosition() {
        const box = els.closeConfirmBox;
        if (!box) return;
        box.classList.remove("is-dragging");
        box.style.position = "";
        box.style.left = "";
        box.style.top = "";
        box.style.width = "";
      }

      function placeCloseConfirmBox(left, top) {
        const box = els.closeConfirmBox;
        if (!box) return;
        const rect = box.getBoundingClientRect();
        const pad = 8;
        const maxLeft = Math.max(pad, window.innerWidth - rect.width - pad);
        const maxTop = Math.max(pad, window.innerHeight - rect.height - pad);
        box.style.left = `${Math.round(Math.max(pad, Math.min(left, maxLeft)))}px`;
        box.style.top = `${Math.round(Math.max(pad, Math.min(top, maxTop)))}px`;
      }

      function startCloseConfirmDrag(event) {
        if (event.button !== 0) return;
        if (event.target?.closest?.("button,input,select,textarea,a,[contenteditable='true']")) return;
        const box = els.closeConfirmBox;
        if (!box) return;
        event.preventDefault();
        const rect = box.getBoundingClientRect();
        const offsetX = event.clientX - rect.left;
        const offsetY = event.clientY - rect.top;
        box.style.position = "fixed";
        box.style.width = `${Math.round(rect.width)}px`;
        box.classList.add("is-dragging");
        placeCloseConfirmBox(rect.left, rect.top);
        const onMove = (moveEvent) => {
          moveEvent.preventDefault();
          placeCloseConfirmBox(moveEvent.clientX - offsetX, moveEvent.clientY - offsetY);
        };
        const onUp = () => {
          box.classList.remove("is-dragging");
          document.removeEventListener("mousemove", onMove, true);
          document.removeEventListener("mouseup", onUp, true);
        };
        document.addEventListener("mousemove", onMove, true);
        document.addEventListener("mouseup", onUp, true);
      }

      function showCloseConfirm(reason = "close") {
        if (closeConfirmResolve) return Promise.resolve(false);
        if (!els.closeConfirmOverlay || !els.closeConfirmOk) return Promise.resolve(false);
        const displayName = getResultSelectionDisplayName();
        const isClose = reason === "close";
        if (els.closeConfirmTitle) els.closeConfirmTitle.textContent = isClose ? "Cancel and close?" : "Cancel changes?";
        if (els.closeConfirmMessage) {
          els.closeConfirmMessage.textContent = isClose
            ? `Unsaved changes to ${displayName} will be discarded and the window will close.`
            : `Unsaved changes to ${displayName} will be discarded.`;
        }
        closeCellContextMenu();
        closeSourceContextMenu();
        resetCloseConfirmPosition();
        els.closeConfirmOverlay.hidden = false;
        requestAnimationFrame(() => els.closeConfirmOk?.focus());
        return new Promise((resolve) => {
          closeConfirmResolve = resolve;
        });
      }

      function requestConfirmedClose() {
        clearResultSelectionDependencyPreview("close-discard");
        postDirty(false, true);
        requestTabbedPageWindowClose({
          messageType: "arcrho:dataset-close-confirmed",
          inst,
        });
      }

      function normalizeRsTab(tab) {
        const key = norm(tab);
        return ALLOWED_RS_TABS.has(key) ? key : "details";
      }

      function getRsPageId(tab) {
        const next = normalizeRsTab(tab);
        return `rs${next[0].toUpperCase()}${next.slice(1)}Page`;
      }

      function syncRsPageState(tab) {
        const activePageId = getRsPageId(tab);
        document.querySelectorAll(".rsPage").forEach((page) => {
          const active = page.id === activePageId;
          page.classList.toggle("active", active);
          if (!active) {
            page.style.display = "none";
          } else if (page.id === "rsDetailsPage" || page.id === "rsMethodPage" || page.id === "rsResultsPage") {
            page.style.display = "flex";
          } else {
            page.style.display = "block";
          }
        });
      }

      function onRsTabChanged(tab) {
        const next = normalizeRsTab(tab);
        state.activeTab = next;
        syncRsPageState(next);
        try {
          window.parent?.postMessage({ type: "arcrho:result-selection-tab-changed", inst, tab: next }, "*");
        } catch {}
      }

      function setTab(tab) {
        const next = normalizeRsTab(tab);
        if (rsTabSystem) {
          if (rsTabSystem.getCurrentTab?.() !== next) rsTabSystem.setActive(next);
          else syncRsPageState(next);
          return;
        }
        state.activeTab = next;
        document.querySelectorAll(".rsTab").forEach((btn) => btn.classList.toggle("active", btn.dataset.page === next));
        document.querySelectorAll(".rsPage").forEach((page) => {
          const active = page.id === getRsPageId(next);
          page.classList.toggle("active", active);
          page.style.display = active ? (page.id === "rsDetailsPage" ? "flex" : "block") : "none";
        });
        try {
          window.parent?.postMessage({ type: "arcrho:result-selection-tab-changed", inst, tab: next }, "*");
        } catch {}
      }
      function wireEvents() {
        [els.nameInput, els.outputTypeInput, els.originLengthInput, els.showRatiosPctInput, els.statisticDecimalsInput, els.showWeightsInput].forEach((el) => {
          el?.addEventListener("input", () => {
            if (el === els.statisticDecimalsInput) syncStatisticDecimalInputs("details");
            markDirty();
            if (el === els.outputTypeInput) {
              syncOutputCategory();
              pruneLoadedSourcesForOutputCategory();
            }
            if (el === els.originLengthInput) {
              state.sidecarOriginLength = null;
              state.sidecarOriginLabels = [];
              setOriginLabels([], getDetails().originLength);
            }
            renderMethodGrid();
          });
          el?.addEventListener("change", () => {
            if (el === els.statisticDecimalsInput) syncStatisticDecimalInputs("details");
            markDirty();
            if (el === els.outputTypeInput) {
              syncOutputCategory();
              pruneLoadedSourcesForOutputCategory();
            }
            if (el === els.originLengthInput) {
              state.sidecarOriginLength = null;
              state.sidecarOriginLabels = [];
              setOriginLabels([], getDetails().originLength);
              void (async () => {
                try {
                  await refreshOriginLabels({ render: false });
                  await reloadSourcesForCurrentOriginLength({ render: false });
                  if (getActiveRatioBasisName()) await refreshRatioBasisValues();
                  else renderMethodGrid();
                } catch (err) {
                  postStatus(`Origin length reload failed: ${err?.message || err}`, "error");
                  renderMethodGrid();
                }
              })();
              return;
            }
            renderMethodGrid();
          });
        });
        els.methodStatisticDecimalsInput?.addEventListener("input", () => {
          syncStatisticDecimalInputs("method");
          markDirty();
          renderMethodGrid();
        });
        els.methodStatisticDecimalsInput?.addEventListener("change", () => {
          syncStatisticDecimalInputs("method");
          markDirty();
          renderMethodGrid();
        });
        function stepStatisticDecimals(source, delta) {
          const target = source === "details" ? els.statisticDecimalsInput : els.methodStatisticDecimalsInput;
          const current = statisticDecimalPlacesValue(target?.value, 1);
          const next = String(statisticDecimalPlacesValue(current + delta, current));
          if (target) target.value = next;
          syncStatisticDecimalInputs(source);
          markDirty();
          renderMethodGrid();
        }
        els.statisticDecimalsUp?.addEventListener("click", () => stepStatisticDecimals("details", 1));
        els.statisticDecimalsDown?.addEventListener("click", () => stepStatisticDecimals("details", -1));
        els.methodStatisticDecimalsUp?.addEventListener("click", () => stepStatisticDecimals("method", 1));
        els.methodStatisticDecimalsDown?.addEventListener("click", () => stepStatisticDecimals("method", -1));
        wireDropdown(els.weightDisplayDropdown, els.weightDisplayButton, els.weightDisplayMenu, (value) => {
          const next = text(value) === "effective";
          if (state.showEffectiveWeights === next) return;
          state.showEffectiveWeights = next;
          renderMethodGrid();
        });
        wireDropdown(els.originLengthDropdown, els.originLengthButton, els.originLengthMenu, (value) => {
          const next = validOriginLength(value, 0);
          if (!next || !els.originLengthInput || text(els.originLengthInput.value) === String(next)) return;
          els.originLengthInput.value = String(next);
          syncOriginLengthDropdownOptions();
          els.originLengthInput.dispatchEvent(new Event("input", { bubbles: true }));
          els.originLengthInput.dispatchEvent(new Event("change", { bubbles: true }));
        });
        els.cellContextMenu?.addEventListener("click", (event) => {
          const action = event.target?.closest?.("[data-rs-cell-action]")?.dataset?.rsCellAction || "";
          if (action === "copy-values") {
            void copyHighlightedMethodValues().catch((err) => postStatus(`Copy failed: ${err?.message || err}`, "error"));
            closeCellContextMenu();
          } else if (action === "paste-values") {
            void pasteHighlightedMethodValues().catch((err) => postStatus(`Paste failed: ${err?.message || err}`, "error"));
          } else if (action === "remove-highlights") {
            removeMethodHighlights();
            closeCellContextMenu();
          } else if (action === "revert-ultimate") {
            if (revertHighlightedUltimateValues()) {
              markDirty();
              renderMethodGrid();
            }
            closeCellContextMenu();
          } else if (action === "revert-all-ultimate") {
            if (revertAllUltimateValues()) {
              markDirty();
              renderMethodGrid();
            }
            closeCellContextMenu();
          }
        });
        els.sourceContextMenu?.addEventListener("click", (event) => {
          const action = event.target?.closest?.("[data-rs-source-action]")?.dataset?.rsSourceAction || "";
          if (!action) return;
          const sourceIndex = sourceContextIndex();
          const anchor = {
            left: Number(els.sourceContextMenu.dataset.anchorLeft) || 8,
            bottom: Number(els.sourceContextMenu.dataset.anchorTop) || 8,
          };
          closeSourceContextMenu();
          if (action === "view-edit") {
            viewOrEditSourceDataset(sourceIndex);
          } else if (action === "add") {
            void openAddSourcePicker(anchor).catch((err) => postStatus(`Source picker failed: ${err?.message || err}`, "error"));
          } else if (action === "delete") {
            removeSourceAt(sourceIndex);
          }
        });
        document.addEventListener("mousedown", (event) => {
          if (els.cellContextMenu?.contains(event.target)) return;
          if (els.sourceContextMenu?.contains(event.target)) return;
          closeCellContextMenu();
          closeSourceContextMenu();
        }, true);
        document.addEventListener("keydown", (event) => {
          if (event.key === "Escape") {
            if (state.activeTab === "results" && normalizedResultsHighlight()) {
              removeResultsHighlights();
              event.preventDefault();
            } else if (normalizedMethodHighlight()) {
              removeMethodHighlights();
              event.preventDefault();
            } else if (normalizedResultsHighlight()) {
              removeResultsHighlights();
              event.preventDefault();
            } else {
              resetWeightEditSession();
            }
            closeCellContextMenu();
            closeSourceContextMenu();
            return;
          }
          if (handleMethodHighlightArrowKey(event)) return;
          if (handleResultsHighlightArrowKey(event)) return;
          if (
            (event.ctrlKey || event.metaKey)
            && event.key?.toLowerCase?.() === "c"
            && normalizedMethodHighlight()
            && !isTextEntryTarget(event.target)
          ) {
            event.preventDefault();
            void copyHighlightedMethodValues().catch((err) => postStatus(`Copy failed: ${err?.message || err}`, "error"));
            return;
          }
          if (
            (event.ctrlKey || event.metaKey)
            && event.key?.toLowerCase?.() === "v"
            && normalizedMethodHighlight()
            && !isTextEntryTarget(event.target)
          ) {
            event.preventDefault();
            void pasteHighlightedMethodValues().catch((err) => postStatus(`Paste failed: ${err?.message || err}`, "error"));
            return;
          }
          if (
            normalizedMethodHighlight()
            && !event.ctrlKey
            && !event.metaKey
            && !event.altKey
            && /^[0-9.]$/.test(event.key || "")
          ) {
            if (isTextEntryTarget(event.target)) return;
            if (applyHighlightedWeightKey(event.key)) {
              event.preventDefault();
              markDirty();
              renderMethodGrid();
            }
          }
        });
        (els.ratioBasisInputs || []).forEach((input, index) => {
          input?.addEventListener("input", () => {
            markDirty();
            const previousActive = state.activeRatioBasisName;
            syncRatioBasisSelector();
            if (previousActive !== state.activeRatioBasisName) state.ratioBasisValues = [];
            renderMethodGrid();
          });
          input?.addEventListener("change", () => {
            markDirty();
            syncRatioBasisSelector();
            void refreshRatioBasisValues();
          });
          input?.addEventListener("keydown", (event) => {
            if (event.key !== "ArrowDown") return;
            event.preventDefault();
            void openRatioBasisDatasetPicker(index);
          });
        });
        (els.ratioBasisButtons || []).forEach((button, index) => {
          button?.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            void openRatioBasisDatasetPicker(index);
          });
        });
        (els.ratioBasisClearButtons || []).forEach((button, index) => {
          button?.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            const input = els.ratioBasisInputs?.[index];
            if (!input || !text(input.value)) return;
            input.value = "";
            input.dispatchEvent(new Event("change", { bubbles: true }));
          });
        });
        wireDropdown(els.activeRatioBasisDropdown, els.activeRatioBasisButton, els.activeRatioBasisMenu, (value) => {
          state.activeRatioBasisName = text(value);
          markDirty();
          void refreshRatioBasisValues();
        });
        document.addEventListener("mousedown", (event) => {
          const target = event.target;
          if (target instanceof Node && (
            els.weightDisplayDropdown?.contains?.(target)
            || els.originLengthDropdown?.contains?.(target)
            || els.activeRatioBasisDropdown?.contains?.(target)
          )) return;
          closeAllDropdowns();
        });
        els.outputTypeBtn?.addEventListener("click", async () => {
          if (!state.project) {
            postStatus("Select a project before choosing an output vector.", "warn");
            return;
          }
          await openDatasetNamePicker({
            projectName: state.project,
            initialName: els.outputTypeInput?.value || "",
            anchorElement: els.outputTypeInput || els.outputTypeBtn,
            title: "Select Output Vector",
            allowedDataFormats: ["Vector"],
            includeCalculated: true,
            emptyMessage: "No output vectors found (Vector).",
            setStatus: (message) => {
              const msg = text(message);
              if (msg) postStatus(msg, "warn");
            },
            onError: (err) => {
              console.error("Failed to open Result Selection output picker:", err);
              postStatus(`Error loading output vector names: ${String(err?.message || err)}`, "error");
            },
            onSelect: (name, item) => {
              const selected = text(name);
              if (!selected) return;
              els.outputTypeInput.value = selected;
              state.outputCategory = text(item?.category || datasetTypeCategoryForName(selected) || state.outputCategory);
              const removed = pruneLoadedSourcesForOutputCategory();
              markDirty();
              renderMethodGrid();
              if (removed) postStatus(`Removed ${removed} loaded source${removed === 1 ? "" : "s"} from a different Category.`, "warn");
            },
          });
        });
        els.syncBtn?.addEventListener("click", () => {
          startResultSelectionRpcBridgeSync({
            getDetails,
            getProject: () => state.project,
            getReservingClass: () => state.reservingClass,
            getIsDirty: () => isDirty,
            save: saveResultSelection,
            applyPayload,
            postStatus,
          }, els.syncBtn).catch((err) => postStatus(`Result Selection sync failed: ${err?.message || err}`, "error"));
        });
        els.saveBtn?.addEventListener("click", () => {
          saveResultSelection().catch((err) => postStatus(`Result Selection save failed: ${err?.message || err}`, "error"));
        });
        els.cancelBtn?.addEventListener("click", async () => {
          if (!isDirty) {
            requestConfirmedClose();
            return;
          }
          const discard = await showCloseConfirm("close");
          if (!discard) return;
          try {
            await restoreCleanState();
            requestConfirmedClose();
          } catch (err) {
            postStatus(`Result Selection restore failed: ${err?.message || err}`, "error");
          }
        });
        els.closeConfirmOk?.addEventListener("click", () => resolveCloseConfirm(true));
        els.closeConfirmCancel?.addEventListener("click", () => resolveCloseConfirm(false));
        els.closeConfirmClose?.addEventListener("click", () => resolveCloseConfirm(false));
        els.closeConfirmBox?.addEventListener("mousedown", startCloseConfirmDrag);
        els.closeConfirmOverlay?.addEventListener("mousedown", (event) => {
          if (event.target === event.currentTarget) resolveCloseConfirm(false);
        });
        els.closeConfirmOverlay?.addEventListener("keydown", (event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            resolveCloseConfirm(false);
          }
        });
        window.addEventListener("message", (event) => {
          const msg = event.data || {};
          if (msg.type === "arcrho:dataset-save" || msg.type === "arcrho:result-selection-save") {
            saveResultSelection().catch((err) => postStatus(`Result Selection save failed: ${err?.message || err}`, "error"));
            return;
          }
          if (msg.type === "arcrho:dependency-source-preview") {
            applyDependencySourcePreview(msg);
            return;
          }
          if (msg.type === "arcrho:dependency-source-cleared") {
            reloadSourcesMatchingMessage(msg, { refreshCache: msg.reason === "save" || msg.reason === "clean" })
              .catch((err) => postStatus(`Source reload failed: ${err?.message || err}`, "error"));
          }
        });
        window.__arcrho_request_close = () => {
          if (!isDirty) return false;
          void (async () => {
            const close = await showCloseConfirm("close");
            if (close) requestConfirmedClose();
          })();
          return true;
        };
        window.__arcrho_consume_close_shortcut = window.__arcrho_request_close;
      }

      function initTabs() {
        rsTabSystem = createTabbedPage(document.body, {
          tabs: RS_TAB_DEFS,
          cssPrefix: "rs",
          initialTab: state.activeTab,
          injectTabBar: false,
          onTabChange: onRsTabChanged,
        });
        window.rsTabSystem = rsTabSystem;
      }

      async function init() {
        withProgrammatic(() => {
          els.nameInput.value = text(params.get("name") || params.get("dataset_name"));
          els.outputTypeInput.value = text(params.get("output_type") || params.get("dataset_type") || els.nameInput.value);
          els.originLengthInput.value = String(validOriginLength(params.get("origin_length"), DEFAULT_ORIGIN_LENGTH));
          state.outputCategory = text(params.get("category"));
        });
        applyTabbedPageSaveBar(els.saveBar);
        initTabs();
        syncOriginLengthDropdownOptions();
        wireEvents();
        wireNotes();
        await loadOutputSidecarSettings().catch((err) => console.warn("Result Selection sidecar settings load failed:", err));
        if (!state.originLabels.length) await refreshOriginLabels({ render: false });
        await loadDatasetTypes();
        await loadCachedRows(false).catch((err) => postStatus(`Cached dataset lookup failed: ${err?.message || err}`, "error"));
        const loaded = await tryLoadExistingMethod().catch((err) => {
          postStatus(`Result Selection load failed: ${err?.message || err}`, "error");
          return false;
        });
        if (!loaded) {
          await initializeDefaultSources().catch((err) => postStatus(`Default source load failed: ${err?.message || err}`, "error"));
          renderMethodGrid();
        }
        setTab(state.activeTab);
        markClean();
        postStatus("Result Selection ready.");
      }

      return {
        numberOrNull,
        roundRsJsonNumber,
        roundRsJsonVector,
        positiveInt,
        validOriginLength,
        validSourceOriginLength,
        isEngineSource,
        isVectorSource,
        datasetTypeCategoryForName,
        getOutputCategory,
        syncOutputCategory,
        sourceCategory,
        matchesOutputCategory,
        nonNegativeInt,
        statisticDecimalPlacesValue,
        syncStatisticDecimalInputs,
        getHostApi,
        postStatus,
        postDirty,
        markDirty,
        sourceMessageNames,
        sourceMessageMatchesContext,
        sourceMessageMatchesSource,
        normalizePreviewValues,
        buildResultSelectionDependencySourceMessage,
        postResultSelectionDependencySourceMessage,
        postResultSelectionDependencyPreview,
        clearResultSelectionDependencyPreview,
        reloadSourcesMatchingMessage,
        applyDependencySourcePreview,
        withProgrammatic,
        dropdownOptions,
        getDropdownValue,
        setDropdownOpen,
        closeDropdown,
        closeAllDropdowns,
        makeDropdownOption,
        syncDropdownValue,
        wireDropdown,
        uniqueRatioBasisNames,
        getRatioBasisNames,
        matchRatioBasisName,
        normalizeRatioBasisDetails,
        syncRatioBasisSelector,
        getActiveRatioBasisName,
        getDetails,
        getResultSelectionDisplayName,
        resolveCloseConfirm,
        resetCloseConfirmPosition,
        placeCloseConfirmBox,
        startCloseConfirmDrag,
        showCloseConfirm,
        requestConfirmedClose,
        normalizeRsTab,
        getRsPageId,
        syncRsPageState,
        onRsTabChanged,
        setTab,
        wireEvents,
        initTabs,
        init
      };
    }
  };
})();
