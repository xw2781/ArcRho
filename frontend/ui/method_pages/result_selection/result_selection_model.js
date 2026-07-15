(function () {
  const parts = window.ResultSelectionParts || (window.ResultSelectionParts = {});

  parts.installModel = function installModel(ctx) {
    with (ctx) {
      function buildPayload() {
        const details = getDetails();
        return {
          json_format: RS_JSON_FORMAT,
          details_tab: {
            name: details.name,
            output_type: details.outputType,
            origin_length: details.originLength,
            ratio_basis: details.ratioBasis,
            ratio_basis_dataset: details.ratioBasis,
            ratio_basis_datasets: details.ratioBases,
            active_ratio_basis_dataset: details.ratioBasis,
            show_ratios_as_percentages: details.showRatiosAsPercentages,
            statistic_decimal_places: details.statisticDecimalPlaces,
          },
          method_tab: {
            origin_labels: Array.from({ length: getRowCount() }, (_, i) => originLabel(i)),
            show_weights: details.showWeights,
            loaded_datasets: state.sources.map((source) => ({
              name: source.name,
              dataset_type: source.datasetType,
              data_format: source.dataFormat,
              method_type: source.methodType,
              category: source.category,
              source_kind: source.sourceKind,
              values: roundRsJsonVector(source.values),
              weights: roundRsJsonVector(source.weights),
            })),
            calculated_ultimate: roundRsJsonVector(calculatedUltimateVector()),
            selected_ultimate: roundRsJsonVector(selectedUltimateVector()),
            ultimate_overrides: roundRsJsonVector(serializedUltimateOverrides()),
          },
          results_tab: {},
          validation_tab: {},
          notes_tab: {
            notes: els.notesInput?.value || "",
          },
          method_metadata: {
            last_modified: new Date().toISOString(),
          },
        };
      }

      async function applyPayload(payload) {
        const data = payload && typeof payload === "object" ? payload : {};
        const details = data.details_tab || {};
        const method = data.method_tab || {};
        const ratioBasisDetails = normalizeRatioBasisDetails(details);
        withProgrammatic(() => {
          els.nameInput.value = text(details.name || els.nameInput.value);
          els.outputTypeInput.value = text(details.output_type || els.outputTypeInput.value);
          els.originLengthInput.value = String(validOriginLength(details.origin_length || els.originLengthInput.value));
          if (state.sidecarOriginLength) els.originLengthInput.value = String(state.sidecarOriginLength);
          (els.ratioBasisInputs || []).forEach((input, index) => {
            if (input) input.value = ratioBasisDetails.names[index] || "";
          });
          state.activeRatioBasisName = ratioBasisDetails.active;
          syncRatioBasisSelector();
          els.showRatiosPctInput.checked = details.show_ratios_as_percentages !== false;
          els.statisticDecimalsInput.value = String(Math.max(0, Math.min(8, nonNegativeInt(details.statistic_decimal_places, 1))));
          syncStatisticDecimalInputs();
          els.showWeightsInput.checked = method.show_weights !== false;
          setNotesText(text(data.notes_tab?.notes));
        });
        const sources = [];
        for (const source of Array.isArray(method.loaded_datasets) ? method.loaded_datasets : []) {
          const record = cachedRows.find((row) => norm(row.name) === norm(source.name)) || null;
          const built = await buildSourceFromRecord(record || { name: source.name }, source);
          if (built) sources.push(built);
        }
        state.sources = sources;
        const originLengthChanged = syncOriginLengthOptions();
        if (originLengthChanged) {
          await reloadSourcesForCurrentOriginLength({ render: false });
        }
        if (getActiveRatioBasisName()) await refreshRatioBasisValues();
        const methodOriginLabels = Array.isArray(method.origin_labels) ? method.origin_labels.map(String) : [];
        if (methodOriginLabels.length && !shouldRejectOriginLabels(getDetails().originLength, methodOriginLabels)) {
          setOriginLabels(methodOriginLabels, getDetails().originLength);
        } else if (state.sidecarOriginLabels.length && !shouldRejectOriginLabels(getDetails().originLength, state.sidecarOriginLabels)) {
          setOriginLabels(state.sidecarOriginLabels, getDetails().originLength);
        } else {
          setOriginLabels([], getDetails().originLength);
        }
        state.ultimateOverrides = normalizeUltimateOverrides(method.ultimate_overrides, getRowCount());
        renderMethodGrid();
      }

      function snapshotPayload() {
        return JSON.stringify(buildPayload());
      }

      function markClean() {
        cleanSnapshot = snapshotPayload();
        notesController.markClean();
        clearResultSelectionDependencyPreview("clean");
        postDirty(false, true);
      }

      async function getWorkspacePathsConfig() {
        const res = await fetch("/workspace_paths", { cache: "no-store" });
        if (!res.ok) throw new Error(`Workspace paths failed (${res.status}).`);
        const payload = await res.json().catch(() => ({}));
        const config = payload?.config && typeof payload.config === "object" ? payload.config : {};
        const paths = config.paths && typeof config.paths === "object" ? config.paths : {};
        return {
          root: text(config.workspace_root) || "E:\\ArcRho",
          projectsDir: text(paths.projects_dir) || "projects",
        };
      }

      function isAbsolutePath(value) {
        return /^[A-Za-z]:[\\/]/.test(text(value)) || /^\\\\/.test(text(value));
      }

      function joinPath(...parts) {
        return parts
          .map((part, index) => {
            const value = text(part);
            if (!value) return "";
            return index === 0 ? value.replace(/[\\/]+$/g, "") : value.replace(/^[\\/]+|[\\/]+$/g, "");
          })
          .filter(Boolean)
          .join("\\");
      }

      async function getMethodsDir() {
        const cfg = await getWorkspacePathsConfig();
        const projectsRoot = isAbsolutePath(cfg.projectsDir) ? cfg.projectsDir : joinPath(cfg.root, cfg.projectsDir);
        return joinPath(
          projectsRoot,
          sanitizeFileNamePart(state.project, "UnknownProject"),
          "data",
          sanitizeDataFolderPart(state.reservingClass, "ReservingClass"),
          "methods",
        );
      }

      async function getDatasetDir() {
        const cfg = await getWorkspacePathsConfig();
        const projectsRoot = isAbsolutePath(cfg.projectsDir) ? cfg.projectsDir : joinPath(cfg.root, cfg.projectsDir);
        return joinPath(
          projectsRoot,
          sanitizeFileNamePart(state.project, "UnknownProject"),
          "data",
          sanitizeDataFolderPart(state.reservingClass, "ReservingClass"),
          "datasets",
        );
      }

      function getMethodFilename() {
        const name = getDetails().name || "Result Selection";
        return `RS@${sanitizeFileNamePart(name, "Name")}.json`;
      }

      async function getMethodPath() {
        return `${await getMethodsDir()}\\${getMethodFilename()}`;
      }

      function getCsvFilename() {
        const details = getDetails();
        const origin = validOriginLength(details.originLength);
        return `${sanitizeFileNamePart(details.name || "Result Selection", "Dataset")}@${origin}.csv`;
      }

      async function getCsvPath() {
        return `${await getDatasetDir()}\\${getCsvFilename()}`;
      }

      function getCsvFilenameForLength(originLength) {
        const details = getDetails();
        const origin = validOriginLength(originLength);
        return `${sanitizeFileNamePart(details.name || "Result Selection", "Dataset")}@${origin}.csv`;
      }

      function vectorCsv(values) {
        return `${(Array.isArray(values) ? values : []).map((v) => v == null ? "" : String(v)).join("\n")}\n`;
      }

      const MONTH_NAME_TO_NUM = new Map([
        ["jan", 1], ["january", 1],
        ["feb", 2], ["february", 2],
        ["mar", 3], ["march", 3],
        ["apr", 4], ["april", 4],
        ["may", 5],
        ["jun", 6], ["june", 6],
        ["jul", 7], ["july", 7],
        ["aug", 8], ["august", 8],
        ["sep", 9], ["sept", 9], ["september", 9],
        ["oct", 10], ["october", 10],
        ["nov", 11], ["november", 11],
        ["dec", 12], ["december", 12],
      ]);

      function parseOriginStartMonth(label, baseLen) {
        const s = text(label);
        if (!s) return null;
        if (baseLen === 1) {
          const yyyymm = s.match(/^(\d{4})(\d{2})$/);
          if (yyyymm) {
            const year = Number.parseInt(yyyymm[1], 10);
            const month = Number.parseInt(yyyymm[2], 10);
            if (Number.isFinite(year) && month >= 1 && month <= 12) return { year, month };
          }
          const monYear = s.match(/^([A-Za-z]{3,9})\s+(\d{4})$/);
          if (monYear) {
            const month = MONTH_NAME_TO_NUM.get(monYear[1].toLowerCase());
            const year = Number.parseInt(monYear[2], 10);
            if (month && Number.isFinite(year)) return { year, month };
          }
          return null;
        }
        if (baseLen === 3) {
          let match = s.match(/^(\d{4})\s*Q([1-4])$/i);
          if (match) return { year: Number.parseInt(match[1], 10), month: (Number.parseInt(match[2], 10) - 1) * 3 + 1 };
          match = s.match(/^Q([1-4])\s*(\d{4})$/i);
          if (match) return { year: Number.parseInt(match[2], 10), month: (Number.parseInt(match[1], 10) - 1) * 3 + 1 };
          return null;
        }
        if (baseLen === 6) {
          let match = s.match(/^(\d{4})\s*H([1-2])$/i);
          if (match) return { year: Number.parseInt(match[1], 10), month: (Number.parseInt(match[2], 10) - 1) * 6 + 1 };
          match = s.match(/^H([1-2])\s*(\d{4})$/i);
          if (match) return { year: Number.parseInt(match[2], 10), month: (Number.parseInt(match[1], 10) - 1) * 6 + 1 };
          return null;
        }
        if (baseLen === 12 && /^\d{4}$/.test(s)) {
          return { year: Number.parseInt(s, 10), month: 1 };
        }
        return null;
      }

      function aggregateVectorByLength(vector, originLabels, baseLen, targetLen) {
        if (!Array.isArray(vector) || !vector.length) return [];
        const factor = targetLen / baseLen;
        if (!Number.isFinite(factor) || factor <= 1 || Math.floor(factor) !== factor) return [];

        const labels = Array.isArray(originLabels) ? originLabels : [];
        if (labels.length === vector.length && [1, 3, 6, 12].includes(baseLen)) {
          const orderedKeys = [];
          const bucketMap = new Map();
          let parseFailed = false;
          for (let i = 0; i < vector.length; i += 1) {
            const parsed = parseOriginStartMonth(labels[i], baseLen);
            if (!parsed) {
              parseFailed = true;
              break;
            }
            const bucketMonth = Math.floor((parsed.month - 1) / targetLen) * targetLen + 1;
            const key = `${parsed.year}-${bucketMonth}`;
            if (!bucketMap.has(key)) {
              bucketMap.set(key, { sum: 0, hasValue: false });
              orderedKeys.push(key);
            }
            const bucket = bucketMap.get(key);
            const num = numberOrNull(vector[i]);
            if (num !== null) {
              bucket.sum += num;
              bucket.hasValue = true;
            }
          }
          if (!parseFailed) {
            return orderedKeys.map((key) => {
              const bucket = bucketMap.get(key);
              return bucket?.hasValue ? bucket.sum : null;
            });
          }
        }

        const out = [];
        for (let i = 0; i < vector.length; i += factor) {
          let sum = 0;
          let hasValue = false;
          const end = Math.min(i + factor, vector.length);
          for (let j = i; j < end; j += 1) {
            const num = numberOrNull(vector[j]);
            if (num === null) continue;
            sum += num;
            hasValue = true;
          }
          out.push(hasValue ? sum : null);
        }
        return out;
      }

      function buildAggregatedResultVariants(vector, originLabels, baseLen) {
        const nativeLen = validOriginLength(baseLen);
        return [3, 6, 12]
          .filter((len) => len > nativeLen && len % nativeLen === 0)
          .map((originLen) => ({
            originLen,
            vector: aggregateVectorByLength(vector, originLabels, nativeLen, originLen),
          }))
          .filter((variant) => variant.vector.length);
      }

      function getSourcePrecedentNames() {
        const seen = new Set();
        const out = [];
        for (const source of state.sources || []) {
          const name = text(source?.name);
          const key = norm(name);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          out.push(name);
        }
        return out;
      }

      async function saveSidecar(csvPath, originLabels = []) {
        const details = getDetails();
        const resp = await fetch("/dataset/sidecar/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            project_name: state.project,
            reserving_class: state.reservingClass,
            dataset_name: details.name,
            dataset_type: details.outputType || details.name,
            instance_name: details.name,
            source_kind: "result_selection",
            method_type: "Result Selection",
            status: 0,
            data_format: "Vector",
            origin_length: details.originLength,
            development_length: details.originLength,
            cumulative: true,
            transposed: false,
            calendar: false,
            origin_labels: Array.isArray(originLabels) ? originLabels.map(String) : [],
            csv_file: csvPath.split(/[\\/]/).pop(),
            precedents: getSourcePrecedentNames(),
          }),
        });
        const payload = await resp.json().catch(() => ({}));
        if (!resp.ok || payload?.ok === false) throw new Error(payload?.detail || payload?.error || `Sidecar save failed (${resp.status}).`);
        invalidateOutputSidecarLoad();
        auditLogView.render(payload?.audit_log);
        return payload;
      }

      async function saveResultSelection() {
        const details = getDetails();
        if (!details.name || !details.outputType) {
          postStatus("Result Selection save requires Name and Output Type.", "error");
          return { ok: false };
        }
        const hostApi = getHostApi();
        if (!hostApi?.saveJsonFile || !hostApi?.saveTextFile) {
          postStatus("Result Selection save requires the desktop app.", "error");
          return { ok: false };
        }
        await refreshOriginLabels({ render: false });
        const payload = buildPayload();
        const methodPath = await getMethodPath();
        const jsonOut = await hostApi.saveJsonFile({
          path: methodPath,
          suggestedName: getMethodFilename(),
          startDir: await getMethodsDir(),
          data: payload,
        });
        if (!jsonOut?.path || jsonOut?.error) throw new Error(jsonOut?.error || "Method JSON save failed.");
        const vector = selectedUltimateVector();
        const csvPath = await getCsvPath();
        const csvOut = await hostApi.saveTextFile({
          path: csvPath,
          data: vectorCsv(vector),
        });
        if (csvOut?.error) throw new Error(csvOut.error);
        await saveSidecar(csvPath, payload.method_tab.origin_labels || []);
        const datasetDir = await getDatasetDir();
        const aggregatedCsvPaths = [];
        for (const variant of buildAggregatedResultVariants(vector, payload.method_tab.origin_labels || [], details.originLength)) {
          const aggPath = `${datasetDir}\\${getCsvFilenameForLength(variant.originLen)}`;
          if (aggPath.toLowerCase() === csvPath.toLowerCase()) continue;
          const aggOut = await hostApi.saveTextFile({
            path: aggPath,
            data: vectorCsv(variant.vector),
          });
          if (aggOut?.error) throw new Error(aggOut.error);
          aggregatedCsvPaths.push(aggPath);
        }
        await loadCachedRows(true).catch(() => {});
        markClean();
        try {
          window.parent?.postMessage({ type: "arcrho:project-instance-refresh-datasets" }, "*");
        } catch {}
        postStatus(`Result Selection saved: ${details.name}${aggregatedCsvPaths.length ? ` (+${aggregatedCsvPaths.length} aggregated)` : ""}`);
        return { ok: true, path: jsonOut.path, csvPath, aggregatedCsvPaths };
      }

      async function tryLoadExistingMethod() {
        const hostApi = getHostApi();
        if (!hostApi?.readJsonFile) return false;
        const path = await getMethodPath();
        const result = await hostApi.readJsonFile({ path });
        if (!result?.exists || !result.data) return false;
        await applyPayload(result.data);
        postStatus(`Loaded Result Selection: ${getDetails().name}`);
        return true;
      }

      function setNotesText(value) {
        const next = text(value);
        notesController.setValue(next, { markClean: true });
      }

      function wireNotes() {
        return notesController;
      }

      return {
        buildPayload,
        applyPayload,
        snapshotPayload,
        markClean,
        getWorkspacePathsConfig,
        isAbsolutePath,
        joinPath,
        getMethodsDir,
        getDatasetDir,
        getMethodFilename,
        getMethodPath,
        getCsvFilename,
        getCsvPath,
        getCsvFilenameForLength,
        vectorCsv,
        parseOriginStartMonth,
        aggregateVectorByLength,
        buildAggregatedResultVariants,
        getSourcePrecedentNames,
        saveSidecar,
        saveResultSelection,
        tryLoadExistingMethod,
        setNotesText,
        wireNotes
      };
    }
  };
})();
