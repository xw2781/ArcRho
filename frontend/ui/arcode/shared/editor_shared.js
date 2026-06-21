(function () {
  const SCRIPTING_SESSION_STORAGE_KEY = "arcode_scripting_session_id";
  const SCRIPTING_SESSION_HEADER = "X-Scripting-Session-Id";

  function sanitizeStorageId(raw) {
    const normalized = String(raw || "").trim();
    if (!normalized) return "";
    return normalized.replace(/[^a-zA-Z0-9_-]/g, "");
  }

  function getOrCreateScriptingSessionId() {
    const fallback = `sc-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    try {
      const existing = sessionStorage.getItem(SCRIPTING_SESSION_STORAGE_KEY);
      if (existing) return existing;
      const next = (window.crypto && typeof window.crypto.randomUUID === "function")
        ? window.crypto.randomUUID()
        : fallback;
      sessionStorage.setItem(SCRIPTING_SESSION_STORAGE_KEY, next);
      return next;
    } catch {
      return fallback;
    }
  }

  function scriptingFetch(path, options = {}, sessionId = getOrCreateScriptingSessionId()) {
    const headers = {
      [SCRIPTING_SESSION_HEADER]: sessionId,
      ...(options.headers || {}),
    };
    return fetch(`${window.location.origin}${path}`, { ...options, headers });
  }

  function getHostApi() {
    const frames = [window];
    try {
      if (window.parent && window.parent !== window) frames.push(window.parent);
    } catch {}
    try {
      if (window.top && window.top !== window && !frames.includes(window.top)) frames.push(window.top);
    } catch {}
    for (const frame of frames) {
      try {
        if (frame?.ADAHost) return frame.ADAHost;
      } catch {}
    }
    return null;
  }

  function filenameFromPath(pathLike) {
    const normalized = String(pathLike || "").replace(/\\/g, "/").trim();
    if (!normalized) return "";
    const parts = normalized.split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : "";
  }

  function directoryFromPath(pathLike) {
    const raw = String(pathLike || "").trim();
    if (!raw) return "";
    const slash = Math.max(raw.lastIndexOf("\\"), raw.lastIndexOf("/"));
    return slash >= 0 ? raw.slice(0, slash) : "";
  }

  function extensionFromPath(pathLike) {
    const name = filenameFromPath(pathLike).toLowerCase();
    const dot = name.lastIndexOf(".");
    return dot >= 0 ? name.slice(dot) : "";
  }

  function isAbsoluteFilePath(pathLike) {
    const value = String(pathLike || "").trim();
    return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.startsWith("/");
  }

  function languageFromPath(pathLike) {
    const name = filenameFromPath(pathLike).toLowerCase();
    const extension = extensionFromPath(pathLike);
    if (extension === ".py") return "python";
    if (extension === ".sql") return "sql";
    if (extension === ".md") return "markdown";
    if (extension === ".json" || extension === ".jsonc") return "json";
    if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return "javascript";
    if (extension === ".ts") return "typescript";
    if (extension === ".css") return "css";
    if (extension === ".html" || extension === ".htm") return "html";
    if (extension === ".r") return "r";
    if (name === ".gitignore") return "ignore";
    return "plaintext";
  }

  function postParentMessage(message) {
    try {
      window.parent?.postMessage(message, "*");
    } catch {}
  }

  function postTabTitle({ title, inst = "", path = "" } = {}) {
    postParentMessage({
      type: "arcode:update-active-tab-title",
      title: String(title || "").trim(),
      inst: String(inst || "").trim(),
      path: String(path || "").trim(),
    });
  }

  function postDirty({ inst = "", dirty = false } = {}) {
    postParentMessage({
      type: "arcode:scripting-dirty",
      inst: String(inst || "").trim(),
      dirty: !!dirty,
    });
  }

  function postStatus(text) {
    const value = String(text || "").trim();
    if (!value) return;
    postParentMessage({ type: "arcode:status", text: value });
  }

  function revisionToken(revision) {
    if (!revision || typeof revision !== "object") return "";
    const hash = String(revision.hash || "").trim();
    if (hash) return hash;
    return `${Number(revision.size || 0)}:${Number(revision.mtimeMs || 0)}`;
  }

  function sameRevision(left, right) {
    const leftToken = revisionToken(left);
    const rightToken = revisionToken(right);
    return !!leftToken && !!rightToken && leftToken === rightToken;
  }

  async function readTextFile(path) {
    const host = getHostApi();
    if (typeof host?.readTextFile !== "function") {
      return { ok: false, error: "Opening files requires the desktop app host." };
    }
    return host.readTextFile({ path });
  }

  async function saveTextFile({ path, data, filters, suggestedName, startDir } = {}) {
    const host = getHostApi();
    if (typeof host?.saveTextFile !== "function") {
      return { ok: false, error: "Saving files requires the desktop app host." };
    }
    return host.saveTextFile({ path, data, filters, suggestedName, startDir });
  }

  async function getFileRevision(path) {
    const host = getHostApi();
    if (typeof host?.getFileRevision !== "function" || !path) return null;
    const result = await host.getFileRevision({ path });
    return result?.exists ? result.revision || null : null;
  }

  window.ArcodeEditorShared = {
    SCRIPTING_SESSION_HEADER,
    sanitizeStorageId,
    getOrCreateScriptingSessionId,
    scriptingFetch,
    getHostApi,
    filenameFromPath,
    directoryFromPath,
    extensionFromPath,
    isAbsoluteFilePath,
    languageFromPath,
    postParentMessage,
    postTabTitle,
    postDirty,
    postStatus,
    sameRevision,
    readTextFile,
    saveTextFile,
    getFileRevision,
  };
})();
