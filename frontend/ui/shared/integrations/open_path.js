function normalizeOpenPathResult(result) {
  if (result === true) return { ok: true, error: "" };
  if (!result || typeof result !== "object") {
    return { ok: false, error: "Open path failed." };
  }
  return {
    ok: result.ok === true,
    error: String(result.error || ""),
  };
}

/** Opens a path through the desktop host, using the shell message bridge from iframe pages. */
export function openPathThroughDesktopHost(
  targetPath,
  { readOnly = false, preferredApp = "" } = {},
  windowRef = globalThis.window,
) {
  const path = String(targetPath || "").trim();
  if (!path) return Promise.resolve({ ok: false, error: "Empty path." });

  const hostApi = windowRef?.ADAHost || null;
  if (hostApi && typeof hostApi.openPath === "function") {
    return Promise.resolve(hostApi.openPath({ path, readOnly: !!readOnly, preferredApp }))
      .then(normalizeOpenPathResult)
      .catch((error) => ({ ok: false, error: String(error?.message || error) }));
  }

  return new Promise((resolve) => {
    const parentWindow = windowRef?.parent;
    if (!parentWindow || parentWindow === windowRef) {
      resolve({ ok: false, error: "Open path requires desktop app." });
      return;
    }

    const requestId = `open-path-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let settled = false;
    let timeoutId = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeoutId !== null) windowRef.clearTimeout(timeoutId);
      windowRef.removeEventListener("message", handleMessage);
      resolve(normalizeOpenPathResult(result));
    };
    const handleMessage = (event) => {
      const message = event?.data;
      if (!message || message.type !== "arcrho:open-path-result") return;
      if (String(message.requestId || "") !== requestId) return;
      finish(message);
    };

    windowRef.addEventListener("message", handleMessage);
    timeoutId = windowRef.setTimeout(() => {
      finish({ ok: false, error: "Open path timed out." });
    }, 5000);
    try {
      parentWindow.postMessage({
        type: "arcrho:open-path",
        requestId,
        path,
        readOnly: !!readOnly,
        ...(preferredApp ? { preferredApp } : {}),
      }, "*");
    } catch {
      finish({ ok: false, error: "Open path requires desktop app." });
    }
  });
}
