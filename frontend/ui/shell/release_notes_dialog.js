// The in-app release-notes surface: the update prompt the desktop host asks for
// before downloading an installer, and the Release History window opened from
// About. Both render the same note structure, so a change to how a release reads
// lands in both at once.
import { shell } from "./shell_context.js?v=20260510a";

const overlay = document.getElementById("releaseNotesOverlay");
const titleEl = document.getElementById("releaseNotesTitle");
const summaryEl = document.getElementById("releaseNotesSummary");
const scrollEl = document.getElementById("releaseNotesScroll");
const sourceNoteEl = document.getElementById("releaseNotesSourceNote");
const laterBtn = document.getElementById("releaseNotesLaterBtn");
const updateBtn = document.getElementById("releaseNotesUpdateBtn");
const closeBtn = document.getElementById("releaseNotesCloseBtn");

let wired = false;
let pendingChoice = null;

function settle(choice) {
  const resolve = pendingChoice;
  pendingChoice = null;
  overlay?.classList.remove("open");
  if (resolve) resolve({ choice });
}

// The host is waiting on a choice, so a dialog that is replaced or dismissed must
// still answer; "later" is the safe answer because it installs nothing.
function closeDialog() { settle("later"); }

function releaseDateText(release) {
  const releasedOn = String(release?.releasedOn || "").trim();
  if (releasedOn) return releasedOn;
  const published = String(release?.publishedAt || "").trim();
  return published ? published.slice(0, 10) : "";
}

function appendEntries(container, entries) {
  let list = null;
  let item = null;
  let sublist = null;

  const closeLists = () => { list = null; item = null; sublist = null; };

  for (const entry of Array.isArray(entries) ? entries : []) {
    const text = String(entry?.text || "").trim();
    if (!text) continue;

    if (entry.kind === "title") {
      closeLists();
      const heading = document.createElement("div");
      heading.className = "releaseNotesGroup";
      heading.textContent = text;
      container.appendChild(heading);
      continue;
    }

    if (entry.kind === "nested" && item) {
      if (!sublist) {
        sublist = document.createElement("ul");
        sublist.className = "releaseNotesSubList";
        item.appendChild(sublist);
      }
      const subItem = document.createElement("li");
      subItem.textContent = text;
      sublist.appendChild(subItem);
      continue;
    }

    if (entry.kind === "bullet" || entry.kind === "nested") {
      if (!list) {
        list = document.createElement("ul");
        list.className = "releaseNotesList";
        container.appendChild(list);
      }
      item = document.createElement("li");
      item.textContent = text;
      sublist = null;
      list.appendChild(item);
      continue;
    }

    closeLists();
    const paragraph = document.createElement("p");
    paragraph.className = "releaseNotesText";
    paragraph.textContent = text;
    container.appendChild(paragraph);
  }
}

function buildReleaseSection(release, { open, installed }) {
  const section = document.createElement("details");
  section.className = "releaseNotesRelease";
  if (open) section.open = true;

  const head = document.createElement("summary");
  head.className = "releaseNotesReleaseHead";

  const version = document.createElement("span");
  version.className = "releaseNotesVersion";
  version.textContent = String(release?.version || "");
  head.appendChild(version);

  const dateText = releaseDateText(release);
  if (dateText) {
    const date = document.createElement("span");
    date.className = "releaseNotesDate";
    date.textContent = dateText;
    head.appendChild(date);
  }

  if (installed) {
    const chip = document.createElement("span");
    chip.className = "releaseNotesChip";
    chip.textContent = "Installed";
    head.appendChild(chip);
  }

  section.appendChild(head);

  const body = document.createElement("div");
  body.className = "releaseNotesReleaseBody";
  appendEntries(body, release?.entries);
  if (!body.childElementCount) {
    const empty = document.createElement("p");
    empty.className = "releaseNotesText muted";
    empty.textContent = "This release has no user-facing notes.";
    body.appendChild(empty);
  }
  section.appendChild(body);
  return section;
}

function buildSummaryLine(parts) {
  const line = document.createElement("div");
  line.className = "releaseNotesMeta";
  line.textContent = parts.filter(Boolean).join("  ·  ");
  return line;
}

function renderUpdateSummary(payload) {
  const versions = document.createElement("div");
  versions.className = "releaseNotesVersionLine";

  const from = document.createElement("span");
  from.className = "releaseNotesFromVersion";
  from.textContent = String(payload.currentVersion || "");
  const arrow = document.createElement("span");
  arrow.className = "releaseNotesArrow";
  arrow.setAttribute("aria-hidden", "true");
  arrow.textContent = "→";
  const to = document.createElement("span");
  to.className = "releaseNotesToVersion";
  to.textContent = String(payload.version || "");
  versions.append(from, arrow, to);
  summaryEl.appendChild(versions);

  const skipped = Math.max(0, (payload.releases || []).length - 1);
  summaryEl.appendChild(buildSummaryLine([
    payload.assetName ? `Installer: ${payload.assetName}` : "",
    skipped > 0 ? `Includes ${skipped} earlier release${skipped === 1 ? "" : "s"} you have not installed` : "",
  ]));

  if (payload.mandatory) {
    const mandatory = document.createElement("div");
    mandatory.className = "releaseNotesMandatory";
    mandatory.textContent = "This update is marked as mandatory.";
    summaryEl.appendChild(mandatory);
  }
}

function renderHistorySummary(payload) {
  const count = (payload.releases || []).length;
  summaryEl.appendChild(buildSummaryLine([
    payload.currentVersion ? `Installed version ${payload.currentVersion}` : "",
    count ? `${count} release${count === 1 ? "" : "s"}` : "",
  ]));
}

function renderPayload(payload) {
  const isUpdate = payload.mode === "update";
  const releases = Array.isArray(payload.releases) ? payload.releases : [];

  titleEl.textContent = isUpdate ? "ArcRho Update Available" : "ArcRho Release History";
  summaryEl.replaceChildren();
  scrollEl.replaceChildren();
  scrollEl.scrollTop = 0;

  if (isUpdate) renderUpdateSummary(payload);
  else renderHistorySummary(payload);

  if (!releases.length) {
    const empty = document.createElement("p");
    empty.className = "releaseNotesText muted";
    empty.textContent = payload.available === false
      ? "Release notes are not bundled with this build."
      : "No release notes are available.";
    scrollEl.appendChild(empty);
  } else if (isUpdate && releases.length === 1) {
    // One version means the section header would only repeat the summary above.
    appendEntries(scrollEl, releases[0].entries);
  } else {
    releases.forEach((release, index) => {
      const installed = !isUpdate && release.version === payload.currentVersion;
      scrollEl.appendChild(buildReleaseSection(release, { open: index === 0, installed }));
    });
  }

  sourceNoteEl.textContent = payload.releasesUrl ? `All releases: ${payload.releasesUrl}` : "";
  updateBtn.hidden = !isUpdate;
  laterBtn.textContent = isUpdate ? "Later" : "Close";

  overlay.classList.add("open");
  (isUpdate ? updateBtn : laterBtn)?.focus();
}

function showUpdateDialog(payload) {
  if (!overlay) return Promise.resolve({ choice: "later" });
  // A second prompt while one is open would strand the first host request.
  settle("later");
  return new Promise((resolve) => {
    pendingChoice = resolve;
    renderPayload({ ...(payload || {}), mode: "update" });
  });
}

export async function openReleaseHistory() {
  if (!overlay) return;
  const hostApi = shell.getHostApi?.();
  if (typeof hostApi?.getReleaseHistory !== "function") {
    shell.updateStatusBar?.("Release history is available in the desktop app.");
    return;
  }
  let payload = null;
  try {
    payload = await hostApi.getReleaseHistory();
  } catch {
    payload = null;
  }
  if (!payload) {
    shell.updateStatusBar?.("Release history is unavailable.");
    return;
  }
  settle("later");
  renderPayload({ ...payload, mode: "history" });
}

export function initReleaseNotesDialog() {
  if (wired || !overlay) return;
  wired = true;

  updateBtn?.addEventListener("click", () => settle("update"));
  laterBtn?.addEventListener("click", closeDialog);
  closeBtn?.addEventListener("click", closeDialog);
  overlay.addEventListener("click", (event) => { if (event.target === overlay) closeDialog(); });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !overlay.classList.contains("open")) return;
    event.stopPropagation();
    closeDialog();
  }, true);

  // The desktop host calls this from the main process and waits on the answer.
  window.__arcrho_show_update_dialog = (payload) => showUpdateDialog(payload);
}
