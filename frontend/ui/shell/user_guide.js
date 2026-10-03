// The current server profile owns the address; documentation stays on Gateway.
export async function openUserGuide({ hostApi, updateStatus, fetchImpl = fetch, browserWindow = window }) {
  // Open synchronously in browser mode so the user gesture survives the fetch.
  const desktop = typeof hostApi?.openExternalUrl === "function";
  const tab = desktop ? null : browserWindow.open("about:blank", "_blank");
  if (tab) tab.opener = null;
  try {
    if (!desktop && !tab) throw new Error("Allow pop-ups to open the User Guide.");
    const response = await fetchImpl("/server_profiles");
    if (!response.ok) throw new Error("Could not read the current server connection.");
    const profiles = await response.json();
    const address = String(profiles.current?.gateway_url || "").trim();
    if (!address) throw new Error("Set the server address in Settings → Server Connection to open the User Guide.");
    const url = new URL(address);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("The server address must be an HTTP or HTTPS address.");
    }
    url.pathname = `${url.pathname.replace(/\/$/, "")}/user-guide/`;
    url.search = "";
    url.hash = "";
    if (desktop) {
      const result = await hostApi.openExternalUrl({ url: url.href });
      if (!result?.ok) throw new Error(result?.error || "Could not open the User Guide.");
    } else {
      tab.location.replace(url.href);
    }
    updateStatus?.("User Guide opened in your browser.");
    return true;
  } catch (error) {
    tab?.close();
    updateStatus?.(String(error?.message || error), { tone: "error" });
    return false;
  }
}
