import { shell } from "./shell_context.js?v=20260510a";

let homeWired = false;
let cachedHomeBrandName = null;
let homeBrandNamePromise = null;

const DEFAULT_HOME_BRAND_NAME = "ArcRho";
const HOME_AVATAR_TEXT = "#526071";

export function getHomeBrandInitial(name) {
  const text = String(name || "").trim();
  const firstAscii = Array.from(text).find((char) => /^[A-Za-z0-9]$/.test(char));
  return firstAscii ? firstAscii.toUpperCase() : "#";
}

function createHomeBrandMarkSvg(initial) {
  const safeInitial = getHomeBrandInitial(initial);
  return `
    <svg viewBox="0 0 32 32" role="img" aria-label="${safeInitial} initial mark" focusable="false">
      <text x="16" y="21" text-anchor="middle" fill="${HOME_AVATAR_TEXT}" font-family="Segoe UI, Arial, sans-serif" font-size="14" font-weight="700">${safeInitial}</text>
    </svg>
  `;
}

function applyHomeBrandIdentity(homeView, userName) {
  const displayName = String(userName || "").trim() || DEFAULT_HOME_BRAND_NAME;
  const initial = getHomeBrandInitial(displayName);
  const title = homeView.querySelector(".homeBrandTitle");
  const mark = homeView.querySelector(".homeBrandMark");
  if (title) title.textContent = displayName;
  if (mark) mark.innerHTML = createHomeBrandMarkSvg(initial);
}

async function updateHomeBrandIdentity(homeView) {
  if (cachedHomeBrandName) {
    applyHomeBrandIdentity(homeView, cachedHomeBrandName);
    return;
  }
  const hostApi = window.ADAHost;
  if (!hostApi?.getWindowsUserName) return;
  if (!homeBrandNamePromise) {
    homeBrandNamePromise = hostApi.getWindowsUserName()
      .then((userName) => String(userName || "").trim() || DEFAULT_HOME_BRAND_NAME)
      .catch(() => DEFAULT_HOME_BRAND_NAME);
  }
  try {
    cachedHomeBrandName = await homeBrandNamePromise;
    applyHomeBrandIdentity(homeView, cachedHomeBrandName);
  } catch {
    applyHomeBrandIdentity(homeView, DEFAULT_HOME_BRAND_NAME);
  }
}

export function renderHomeViewOnce(homeView) {
  if (!homeView) return;
  if (!homeView.dataset.rendered) {
    homeView.innerHTML = `
      <div class="homeLayout">
        <aside class="homeSidebar" aria-label="Home sections">
          <div class="homeBrand">
            <div class="homeBrandMark" aria-hidden="true">${createHomeBrandMarkSvg(DEFAULT_HOME_BRAND_NAME)}</div>
            <div class="homeBrandText">
              <div class="homeBrandTitle">ArcRho</div>
              <div class="homeBrandSub">Actuarial Workspace</div>
            </div>
          </div>
          <div class="homeNavGroup">
            <div class="homeNavLabel">Home</div>
            <div class="homeNavItem active"><span class="homeNavDot"></span><span>Launch</span></div>
          </div>
          <div class="homeNavGroup">
            <div class="homeNavLabel">Areas</div>
            <div class="homeNavItem"><span class="homeNavDot data"></span><span>Data</span></div>
            <div class="homeNavItem"><span class="homeNavDot automation"></span><span>Automation</span></div>
            <div class="homeNavItem"><span class="homeNavDot general"></span><span>General</span></div>
          </div>
        </aside>
        <main class="homeMain">
          <div class="homeHeader">
            <h1 class="homeTitle">Launch Center</h1>
            <div class="homeSubtitle">Open the core ArcRho components from a focused workspace.</div>
          </div>
          <div class="homeGroup">
            <div class="groupTitle">Data</div>
            <div class="cards">
              <div class="card clickable" id="cardOpenDataset"><div class="homeIconBox dataset" aria-hidden="true"><svg class="homeIcon" viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="7" ry="3"></ellipse><path d="M5 5v10c0 1.7 3.1 3 7 3s7-1.3 7-3V5"></path><path d="M5 10c0 1.7 3.1 3 7 3s7-1.3 7-3"></path></svg></div><div><h3>Open Dataset</h3><div class="muted">View a dataset in a new tab.</div></div></div>
              <div class="card clickable" id="cardOpenDfm"><div class="homeIconBox dfm" aria-hidden="true"><svg class="homeIcon" viewBox="0 0 24 24"><path d="M4 18h16"></path><path d="M6 15l4-5 4 3 4-7"></path><circle cx="6" cy="15" r="1.2"></circle><circle cx="10" cy="10" r="1.2"></circle><circle cx="14" cy="13" r="1.2"></circle><circle cx="18" cy="6" r="1.2"></circle></svg></div><div><h3>DFM</h3><div class="muted">Create a development factor method.</div></div></div>
            </div>
          </div>
          <div class="homeGroup">
            <div class="groupTitle">Automation</div>
            <div class="cards">
              <div class="card clickable" id="cardNewWorkflow"><div class="homeIconBox workflow" aria-hidden="true"><svg class="homeIcon" viewBox="0 0 24 24"><rect x="3" y="4" width="6" height="5" rx="1.2"></rect><rect x="15" y="4" width="6" height="5" rx="1.2"></rect><rect x="9" y="15" width="6" height="5" rx="1.2"></rect><path d="M9 6.5h6"></path><path d="M6 9v3.5h6V15"></path><path d="M18 9v3.5h-6"></path></svg></div><div><h3>New Workflow</h3><div class="muted">Build or load a workflow tab.</div></div></div>
              <div class="card clickable" id="cardScripting"><div class="homeIconBox scripting" aria-hidden="true"><svg class="homeIcon" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M7 9l3 3-3 3"></path><path d="M12 15h5"></path></svg></div><div><h3>Scripting</h3><div class="muted">Write code in a notebook.</div></div></div>
            </div>
          </div>
          <div class="homeGroup">
            <div class="groupTitle">General</div>
            <div class="cards">
              <div class="card clickable" id="cardProjectSettings"><div class="homeIconBox project" aria-hidden="true"><svg class="homeIcon" viewBox="0 0 24 24"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z"></path><circle cx="16.5" cy="13" r="2"></circle><path d="M16.5 10v1"></path><path d="M16.5 15v1"></path><path d="M19.1 11.5l-.9.5"></path><path d="M14.8 14l-.9.5"></path></svg></div><div><h3>Project Explorer</h3><div class="muted">Browse and manage projects.</div></div></div>
              <div class="card clickable" id="cardBrowsingHistory"><div class="homeIconBox history" aria-hidden="true"><svg class="homeIcon" viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.3-5.7"></path><path d="M4 5v5h5"></path><path d="M12 8v5l3 2"></path></svg></div><div><h3>Browsing History</h3><div class="muted">Restore recent pages and dataset views.</div></div></div>
            </div>
          </div>
        </main>
      </div>
    `;
    homeView.dataset.rendered = "1";
  }
  updateHomeBrandIdentity(homeView);
  if (!homeWired) {
    document.getElementById("cardOpenDataset")?.addEventListener("click", () => shell.openDatasetTab?.());
    document.getElementById("cardNewWorkflow")?.addEventListener("click", () => shell.openWorkflowTab?.());
    document.getElementById("cardOpenDfm")?.addEventListener("click", () => shell.openDFMTab?.());
    document.getElementById("cardProjectSettings")?.addEventListener("click", () => shell.openProjectSettingsTab?.());
    document.getElementById("cardBrowsingHistory")?.addEventListener("click", () => shell.openBrowsingHistoryTab?.());
    document.getElementById("cardScripting")?.addEventListener("click", () => shell.openScriptingTab?.({ forceNew: true }));
    homeWired = true;
  }
}
