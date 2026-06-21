export function createIframeHost(deps) {
  const {
    closeAllShellMenus,
    getAutoSaveEnabled,
    getIframeHost,
    getState,
    normalizeBrowsingHistoryEntry,
    refreshActiveTab,
    setActive,
    handleShellFileDragOver,
    handleShellFileDrop,
    uiVersionParam,
  } = deps;

  function wireIframeMenuAutoClose(iframe) {
    if (!iframe) return;
    const attachBridge = () => {
      try {
        const frameWin = iframe.contentWindow;
        const frameDoc = frameWin?.document;
        if (!frameWin || !frameDoc) return;
        if (frameWin.__arcRhoShellBridgeWiredV2) return;

        const suppressFrameEvent = (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
        };

        const shouldSuppressActivationFollowup = () => {
          const until = Number(frameWin.__arcRhoActivationSuppressUntil || 0);
          return until && Date.now() <= until;
        };

        const activateFrameTab = (e) => {
          if (document.body?.classList?.contains("floatingTabDragActive")) return false;
          const tabId = iframe.dataset.tabId || "";
          if (!tabId) return false;
          const state = getState();
          const tab = state.tabs.find(t => t.id === tabId);
          if (!tab) return false;
          if (state.activeId === tabId) return false;
          frameWin.__arcRhoActivationSuppressUntil = Date.now() + 450;
          setActive(tabId);
          suppressFrameEvent(e);
          return true;
        };

        const closeMenus = () => {
          closeAllShellMenus();
        };

        frameDoc.addEventListener("pointerdown", (e) => {
          if (activateFrameTab(e)) return;
          closeMenus();
        }, true);
        for (const eventName of ["mousedown", "pointerup", "mouseup", "click", "dblclick"]) {
          frameDoc.addEventListener(eventName, (e) => {
            if (!shouldSuppressActivationFollowup()) return;
            suppressFrameEvent(e);
            if (eventName === "click" || eventName === "dblclick") {
              frameWin.__arcRhoActivationSuppressUntil = 0;
            }
          }, true);
        }
        frameWin.addEventListener("keydown", (e) => {
          if (e.key === "Escape") closeMenus();
          const key = String(e.key || "");
          const isRefreshKey = (key === "F5" && e.ctrlKey) || ((key === "r" || key === "R") && e.ctrlKey && !e.shiftKey);
          if (isRefreshKey) {
            e.preventDefault();
            e.stopPropagation();
            refreshActiveTab();
          }
        }, true);
        frameDoc.addEventListener("dragover", (e) => {
          if (typeof handleShellFileDragOver === "function" && handleShellFileDragOver(e)) return;
        }, true);
        frameDoc.addEventListener("drop", (e) => {
          if (typeof handleShellFileDrop === "function" && handleShellFileDrop(e)) return;
        }, true);
        frameWin.__arcRhoShellBridgeWiredV2 = true;
      } catch {
        // ignore cross-frame wiring failures
      }
    };

    iframe.addEventListener("load", attachBridge);
    attachBridge();
  }

  function ensureIframe(tab) {
    const iframeHost = getIframeHost();
    if (!iframeHost) return;

    if (tab.iframe && !tab.iframe.isConnected) {
      tab.iframe = null;
    }

    if (tab.iframe) {
      tab.iframe.dataset.tabId = tab.id;
      return;
    }

    const iframe = document.createElement("iframe");
    iframe.dataset.tabId = tab.id;
    iframe.style.width = "100%";
    iframe.style.height = "100%";
    iframe.style.border = "0";
    iframe.style.display = "none";
    wireIframeMenuAutoClose(iframe);

    if (tab.type === "dataset") {
      const params = new URLSearchParams();
      if (tab.datasetId) params.set("ds", tab.datasetId);
      const initial = normalizeBrowsingHistoryEntry(tab.datasetInputs || null);
      if (initial) {
        params.set("project", initial.project);
        params.set("path", initial.path);
        params.set("tri", initial.tri);
      }
      const inst = tab.dsInst || tab.id || `ds_${Date.now()}`;
      params.set("inst", inst);
      params.set("v", uiVersionParam);
      iframe.src = `/ui/dataset/dataset_viewer.html?${params.toString()}`;
    } else if (tab.type === "dfm") {
      const params = new URLSearchParams();
      if (tab.datasetId) params.set("ds", tab.datasetId);
      const inst = tab.dsInst || tab.id || `dfm_${Date.now()}`;
      params.set("inst", inst);
      params.set("v", uiVersionParam);
      if (tab.dfmTab) params.set("tab", tab.dfmTab);
      const inputs = tab.dfmInputs && typeof tab.dfmInputs === "object" ? tab.dfmInputs : {};
      if (inputs.project) params.set("project", String(inputs.project));
      if (inputs.reservingClass) params.set("class", String(inputs.reservingClass));
      if (inputs.methodName) params.set("method_name", String(inputs.methodName));
      if (inputs.outputType) params.set("output_type", String(inputs.outputType));
      if (inputs.inputTriangle) params.set("input_triangle", String(inputs.inputTriangle));
      iframe.src = `/ui/dfm/dfm.html?${params.toString()}`;
    } else if (tab.type === "workflow") {
      const inst = tab.wfInst || tab.id || `wf_${Date.now()}`;
      iframe.src = `/ui/workflow/workflow.html?inst=${encodeURIComponent(inst)}${tab.wfFresh ? '&fresh=1' : ''}`;
      tab.wfFresh = false;
      iframe.addEventListener("load", () => {
        try {
          iframe.contentWindow?.postMessage({ type: "arcrho:autosave-toggle", enabled: getAutoSaveEnabled() }, "*");
        } catch {
          // ignore
        }
      }, { once: true });
    } else if (tab.type === "project_settings") {
      iframe.src = `/ui/project_settings/project_settings.html?v=${encodeURIComponent(uiVersionParam)}`;
    } else if (tab.type === "project_instance") {
      const params = new URLSearchParams();
      params.set("project", String(tab.projectName || tab.title || "").trim());
      if (tab.projectFolder) params.set("folder", String(tab.projectFolder || ""));
      if (tab.projectTablePath) params.set("tablePath", String(tab.projectTablePath || ""));
      params.set("v", uiVersionParam);
      iframe.addEventListener("load", () => {
        const state = tab.projectInstanceState && typeof tab.projectInstanceState === "object"
          ? tab.projectInstanceState
          : null;
        if (!state) return;
        try {
          iframe.contentWindow?.postMessage({ type: "arcrho:project-instance-restore-state", state }, "*");
        } catch {
          // ignore
        }
      });
      iframe.src = `/ui/project_instance/project_instance.html?${params.toString()}`;
    } else if (tab.type === "browsing_history") {
      iframe.src = `/ui/shell/browsing_history.html?v=${encodeURIComponent(uiVersionParam)}`;
    } else if (tab.type === "agent_guide") {
      iframe.src = `/ui/agent_guide/agent_guide.html?v=${encodeURIComponent(uiVersionParam)}`;
    } else if (tab.type === "scripting") {
      const inst = tab.scInst || tab.id || `sc_${Date.now()}`;
      const openPath = String(tab.scOpenPath || "").trim();
      const params = new URLSearchParams();
      params.set("inst", inst);
      if (tab.scFresh) params.set("fresh", "1");
      if (openPath) {
        params.set("skipLast", "1");
        iframe.addEventListener("load", () => {
          try {
            iframe.contentWindow?.postMessage({ type: "arcode:scripting-open-path", path: openPath }, "*");
          } catch {
            // ignore
          }
          tab.scOpenPath = "";
        }, { once: true });
      }
      iframe.src = `/ui/arcode/notebook-editor/?${params.toString()}`;
      tab.scFresh = false;
    }

    iframeHost.appendChild(iframe);
    tab.iframe = iframe;
  }

  return {
    ensureIframe,
  };
}
