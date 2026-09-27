// What the Server tab shows, derived from the app server's server-profile listing. Pure functions
// only, so the rules are tested without a page; `server.js` owns the DOM.

// The row that stands for this window's own server while a launch fixed it. Profile ids are
// lowercase letters, digits, "_" and "-", so this key can never collide with one.
export const CURRENT_SERVER_KEY = "@current";

// "http://NE7SASWPN02:28767/" -> "NE7SASWPN02:28767", keeping the host as it was written.
export function serverAddress(url) {
  return String(url || "").trim().replace(/^[a-z][a-z0-9+.-]*:\/\//iu, "").split("/")[0];
}

export function serverLabel(name, url) {
  const address = serverAddress(url);
  return address ? `${name} — ${address}` : name;
}

export function isSetAtLaunch(listing) {
  const launch = listing?.set_at_launch || {};
  return !!(String(launch.root || "").trim() || String(launch.gateway_config || "").trim());
}

function detailsFor(server) {
  return {
    folder: server.root || "",
    credentialFile: server.gateway_config || "",
    credentialExists: !!server.credential_exists,
    user: server.user || "",
  };
}

// One row per saved server. While a launch fixed this window's server, that server leads the
// list as the one in use and nothing can be switched; otherwise the active profile is marked.
export function buildServerRows(listing) {
  const launched = isSetAtLaunch(listing);
  const rows = [];
  if (launched && listing?.current) {
    rows.push({
      key: CURRENT_SERVER_KEY,
      profileId: "",
      name: "Set at launch",
      label: serverLabel("Set at launch", listing.current.gateway_url),
      gatewayUrl: listing.current.gateway_url || "",
      chip: "In Use",
      canSwitch: false,
      details: detailsFor(listing.current),
    });
  }
  for (const profile of Array.isArray(listing?.profiles) ? listing.profiles : []) {
    const active = !launched && !!profile.active;
    rows.push({
      key: profile.id,
      profileId: profile.id,
      name: profile.name,
      label: serverLabel(profile.name, profile.gateway_url),
      gatewayUrl: profile.gateway_url || "",
      chip: active ? "Active" : "",
      canSwitch: !launched && !active,
      details: detailsFor(profile),
    });
  }
  return rows;
}

// The query string that asks the app server for one row's health; the launch row asks for this
// window's own server.
export function healthQuery(row) {
  return row.key === CURRENT_SERVER_KEY ? "" : `?id=${encodeURIComponent(row.profileId)}`;
}

// A new server needs a folder that was checked, a name, and a name no saved server already uses.
export function addServerProblem(listing, { name, inspectedRoot }) {
  const trimmed = String(name || "").trim();
  if (!String(inspectedRoot || "").trim()) return "Choose the server's folder first.";
  if (!trimmed) return "Give the server a name.";
  const taken = (listing?.profiles || []).some(
    (profile) => String(profile.name || "").trim().toLowerCase() === trimmed.toLowerCase(),
  );
  return taken ? `A server named ${trimmed} is already in the list.` : "";
}

// What the page says after the shell answers a switch request.
export function switchResultMessage(result, label) {
  if (result?.ok) {
    return result.restartRequired
      ? { text: `Restarting to connect to ${label}...`, tone: "" }
      : { text: `Already connected to ${label}.`, tone: "" };
  }
  const dirty = Array.isArray(result?.dirtyTabs) ? result.dirtyTabs : [];
  if (dirty.length) {
    return { text: `Save or close these tabs first: ${dirty.join(", ")}.`, tone: "error" };
  }
  return { text: String(result?.error || "The server could not be switched."), tone: "error" };
}
