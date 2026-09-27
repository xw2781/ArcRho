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

// Components panel -----------------------------------------------------------------------------

// How often the panel asks again while it is on screen, and how often it checks whether it is.
export const COMPONENT_REFRESH_MS = 5000;
export const COMPONENT_VISIBILITY_TICK_MS = 1000;

// "4 s ago", "3 min ago", "2 h ago"; a heartbeat with no readable time is "Unknown".
export function heardAgo(ageSeconds) {
  if (typeof ageSeconds !== "number" || !Number.isFinite(ageSeconds)) return "Unknown";
  const seconds = Math.max(0, Math.round(ageSeconds));
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  return `${Math.floor(seconds / 3600)} h ago`;
}

function roleSummary(rows) {
  if (!rows.length) return "Not running";
  const active = rows.filter((row) => !row.stale).length;
  const stale = rows.length - active;
  const parts = [];
  if (active) parts.push(`${active} active`);
  if (stale) parts.push(`${stale} stale`);
  return parts.join(", ");
}

// One group per role, in the server's order, each with its stop switch and one row per heartbeat.
export function buildComponentGroups(status) {
  const roles = Array.isArray(status?.roles) ? status.roles : [];
  return roles.map((role) => {
    const rows = (Array.isArray(role.instances) ? role.instances : []).map((item) => {
      const stale = item.status === "Stale";
      return {
        key: `${role.role}/${item.name || item.server}`,
        machine: item.machine || "Unknown",
        user: item.user || "Unknown",
        heard: heardAgo(item.age_seconds),
        status: stale ? "Stale" : "Active",
        stale,
      };
    });
    return {
      role: role.role,
      label: role.label || role.role,
      stopSwitch: !!role.stop_switch,
      summary: roleSummary(rows),
      rows,
    };
  });
}

// What the panel header and body say: still loading, a failed request, a silent Gateway, or rows.
export function componentPanelState(status, error = "") {
  if (error) return { kind: "error", message: String(error) };
  if (!status) return { kind: "loading", message: "Reading component status..." };
  if (status.answering === false) {
    return { kind: "silent", message: String(status.detail || "Gateway not answering.") };
  }
  const source = status.source === "disk" ? "Read from this PC's server folder" : "Reported by the server's Gateway";
  return { kind: "ready", message: "", source: `${source} at ${String(status.checked_at || "").slice(11)}` };
}

// Whether the panel should ask now: never while hidden or already asking; at once when it comes
// back into view; otherwise once the refresh interval has passed.
export function shouldRefreshComponents({ visible, wasHidden, inFlight, lastFetchAt, now }) {
  if (!visible || inFlight) return false;
  if (wasHidden || !lastFetchAt) return true;
  return now - lastFetchAt >= COMPONENT_REFRESH_MS;
}

// Start and stop -------------------------------------------------------------------------------

// While a start or stop is under way the panel asks this often, and gives up waiting after this.
export const SERVER_ACTION_POLL_MS = 2000;
export const SERVER_ACTION_TIMEOUT_MS = 90000;

// The roles start and stop cover (from the app server) that have a live heartbeat, and whether
// any of their stop switches is on.
function supervisedState(status) {
  const roles = Array.isArray(status?.control?.roles) ? status.control.roles : [];
  const byRole = new Map((Array.isArray(status?.roles) ? status.roles : []).map((role) => [role.role, role]));
  const running = roles.filter((role) => (byRole.get(role)?.instances || []).some((item) => item.status !== "Stale"));
  const switchOn = roles.some((role) => !!byRole.get(role)?.stop_switch);
  return { roles, running, allUp: roles.length > 0 && running.length === roles.length && !switchOn };
}

// Whether a start or stop in progress has finished, is still waiting, or ran out of time.
export function serverActionOutcome(status, action, now) {
  if (!action) return "";
  const { running, allUp } = supervisedState(status);
  if (action.kind === "start" ? allUp : running.length === 0) return "done";
  return now - action.startedAt >= SERVER_ACTION_TIMEOUT_MS ? "timeout" : "waiting";
}

// What the panel offers: Start and Stop for a server this PC may control, otherwise one line
// saying why not; while an action runs, its progress instead of the buttons' use.
export function serverControlView(status, action, now) {
  const control = status?.control;
  if (!control) return { show: false, note: "", canStart: false, canStop: false, progress: "" };
  if (!control.available) {
    return { show: false, note: String(control.detail || ""), canStart: false, canStop: false, progress: "" };
  }
  const { running, allUp } = supervisedState(status);
  const progress = action
    ? `${action.kind === "start" ? "Starting" : "Stopping"}... ${Math.max(0, Math.round((now - action.startedAt) / 1000))} s`
    : "";
  return { show: true, note: "", canStart: !action && !allUp, canStop: !action && running.length > 0, progress };
}

// What the page says when a start or stop ends.
export function serverActionMessage(kind, outcome) {
  if (outcome === "done") {
    return { text: kind === "start" ? "The server is running." : "The server is stopped.", tone: "" };
  }
  const seconds = SERVER_ACTION_TIMEOUT_MS / 1000;
  return kind === "start"
    ? { text: `Not every component started within ${seconds} s.`, tone: "error" }
    : { text: `Some components were still running after ${seconds} s.`, tone: "error" };
}
