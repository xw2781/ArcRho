/* Run: frontend/node-portable/node.exe frontend/tests/dfm_guide.e2e.cjs
 * Real DFM page and renderers in isolated, hidden Electron/Chromium windows.
 * APIs are local fixtures; no project files or live services are accessed.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { spawnSync } = require("node:child_process");
const electron = require("electron");
const repository = path.resolve(__dirname, "../..");
const testRoot = path.join(repository, "test");

if (typeof electron === "string") {
  const existed = fs.existsSync(testRoot);
  fs.mkdirSync(testRoot, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(testRoot, "dfm-guide-"));
  try {
    const env = { ...process.env, TEMP: scratch, TMP: scratch, APPDATA: scratch, LOCALAPPDATA: scratch };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(electron, ["--disable-gpu", `--user-data-dir=${scratch}`, __filename, `--scratch=${scratch}`],
      { cwd: repository, env, windowsHide: true, encoding: "utf8", timeout: 90000 });
    process.stdout.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    assert.equal(path.dirname(scratch), testRoot);
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    if (!existed && !fs.readdirSync(testRoot).length) fs.rmdirSync(testRoot);
  }
} else {
  const { app, BrowserWindow, session } = electron;
  const scratch = process.argv.find((arg) => arg.startsWith("--scratch=")).slice(10);
  assert.equal(path.dirname(scratch), testRoot);
  for (const key of ["appData", "userData", "sessionData", "temp", "logs", "crashDumps"]) app.setPath(key, scratch);
  app.disableHardwareAcceleration();
  app.on("window-all-closed", () => {});
  const errors = [];
  const requests = [];
  let checks = 0;
  const verify = (condition, message) => { assert.ok(condition, message); checks++; };
  const evaluate = (win, fn, value) => win.webContents.executeJavaScript(`(${fn})(${JSON.stringify(value)})`, true);
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function until(win, fn, value) {
    for (let i = 0; i < 150; i++) {
      if (await evaluate(win, fn, value)) return;
      await delay(30);
    }
    throw new Error(`Timed out: ${fn}\n${errors.join("\n")}`);
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/ui/")) {
      const file = path.resolve(repository, "frontend", `.${decodeURIComponent(url.pathname)}`);
      if (!file.startsWith(path.join(repository, "frontend/ui") + path.sep) || !fs.existsSync(file)) {
        res.writeHead(404).end(); return;
      }
      const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
      res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
      return;
    }
    requests.push(`${req.method} ${url.pathname}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, projects: [], items: [], rows: [], entries: [], preferences: {} }));
  });
  async function click(win, selector, { button = "left", count = 1 } = {}) {
    const point = await evaluate(win, (s) => {
      const element = document.querySelector(s);
      element.scrollIntoView({ block: "nearest", inline: "nearest" });
      const r = element.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    }, selector);
    const hit = await evaluate(win, ({ selector, point }) => ({ ok: document.querySelector(selector).contains(document.elementFromPoint(point.x, point.y)), hit: document.elementFromPoint(point.x, point.y)?.outerHTML.slice(0, 160), width: innerWidth }), { selector, point });
    assert.equal(hit.ok, true, `${selector} is reachable by pointer: ${JSON.stringify({ point, ...hit })}`);
    await win.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    await delay(30);
    for (let clickCount = 1; clickCount <= count; clickCount++) {
      await win.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", button, clickCount, ...point });
      await win.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", button, clickCount, ...point });
    }
    await delay(60);
  }
  async function hover(win, selector) {
    const point = await evaluate(win, (s) => {
      const r = document.querySelector(s).getBoundingClientRect();
      return { x: Math.round(r.x + Math.min(r.width / 2, 80)), y: Math.round(r.y + Math.min(r.height / 2, 12)) };
    }, selector);
    await win.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    await delay(60);
  }
  async function run() {
    await app.whenReady();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const allowed = details.url.startsWith(`${origin}/`);
      if (!allowed) errors.push(`Blocked external request: ${details.url}`);
      callback({ cancel: !allowed });
    });
    const win = new BrowserWindow({ show: false, width: 1280, height: 850, useContentSize: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
    win.webContents.on("console-message", (_e, level, message) => { if (level >= 3) errors.push(message); });
    win.webContents.debugger.attach("1.3");
    // Seed the retired preference on this isolated origin before DFM boots.
    await win.loadURL(origin);
    await evaluate(win, () => localStorage.setItem("arcrho_dfm_ratio_na_borders", "0"));
    await win.loadURL(`${origin}/ui/method_pages/dfm/dfm.html?inst=guide-e2e&tab=details`);
    await until(win, () => document.getElementById("dfmGuideToggle")?.dataset.guideReady === "true");
    await evaluate(win, () => window.ArcRhoZoomBridge.applyPageZoomValue(100, 24));
    await until(win, () => {
      const button = document.getElementById("dfmGuideToggle");
      const rect = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    });
    verify(await evaluate(win, () => {
      const button = document.getElementById("dfmGuideToggle");
      const frame = button.getBoundingClientRect();
      const icon = button.firstElementChild.getBoundingClientRect();
      return frame.width === frame.height && getComputedStyle(button).borderRadius === "50%"
        && Math.abs(icon.x + icon.width / 2 - frame.x - frame.width / 2) < 0.5
        && Math.abs(icon.y + icon.height / 2 - frame.y - frame.height / 2) < 0.5;
    }), "Question mark is centered in a circular button frame");
    verify(await evaluate(win, () => document.getElementById("dfmGuide").hidden), "Guide starts off");
    const pageWidth = await evaluate(win, () => document.getElementById("dfmDetailsPage").getBoundingClientRect().width);
    await click(win, "#dfmGuideToggle");
    verify(await evaluate(win, () => document.querySelectorAll(".dfmGuideMarker").length === 4), "Details has component help markers");
    verify(await evaluate(win, () => document.getElementById("dfmDetailsPage").getBoundingClientRect().width) === pageWidth, "Guide preserves full page width without a side panel");
    await hover(win, "#triInput");
    verify(await evaluate(win, () => !document.getElementById("dfmGuideTooltip").hidden && document.getElementById("dfmGuideTooltip").textContent.includes("Inputs And Dependencies")), "Component hover shows relevant guidance");
    await evaluate(win, () => document.getElementById("decimalPlaces").focus());
    verify(await evaluate(win, () => document.getElementById("dfmGuideTooltip").textContent.includes("Origin Length groups")), "Keyboard focus shows guidance");

    // Seed a synthetic triangle into the real shared state and use production
    // renderers, so the guide is exercised against actual generated grids.
    await evaluate(win, async () => {
      const { state } = await import("/ui/shared/dataset/dataset_state.js");
      state.model = { kind: "triangle", origin_labels: ["2022", "2023", "2024"], dev_labels: [12, 24, 36],
        values: [[100, 150, 180], [120, 168, null], [130, null, null]],
        mask: [[true, true, true], [true, true, false], [true, false, false]] };
      (await import("/ui/shared/tabs/data/dataset_grid_view.js?v=20260919a")).renderTable();
    });
    const clean = await evaluate(win, async () => (await import("/ui/method_pages/dfm/dfm_state.js")).getDfmIsDirty());
    for (const tab of ["data", "ratios", "curves", "results", "notes", "links", "audit", "details"]) {
      await click(win, `.dfmTab[data-page="${tab}"]`);
      verify(await evaluate(win, (id) => {
        const page = document.querySelector(`div[data-page="${id}"][id]`);
        return !document.getElementById("dfmGuide").hidden && !!page.querySelector(".dfmGuideTarget") || page.classList.contains("dfmGuideTarget");
      }, tab), `${tab}: guide follows tab activation`);
      verify(await evaluate(win, () => [...document.querySelectorAll(".dfmGuideMarker")].some(el => !el.hidden)), `${tab}: help markers stay visible without hover`);
      if (tab === "ratios") {
        verify(await evaluate(win, () => !!document.querySelector(".ratioSummaryTable td")), "Actual Ratios grid rendered");
        verify(await evaluate(win, () => !document.querySelector('[data-action="toggle-na-borders"]')), "N/A border toggle is completely absent");
        for (const style of ["classic", "revolutionary"]) {
          verify(await evaluate(win, (style) => {
            document.documentElement.dataset.arcrhoTableStyle = style;
            const blanks = [...document.querySelectorAll(".ratioMainTable td.na")];
            return blanks.length > 0 && blanks.every(cell => {
              const css = getComputedStyle(cell);
              return (cell.matches(":last-child") || parseFloat(css.borderRightWidth) > 0)
                && (cell.parentElement.matches(":last-child") || parseFloat(css.borderBottomWidth) > 0);
            });
          }, style), `${style}: N/A grid borders stay visible despite the retired hide preference`);
        }
        await hover(win, ".ratioSummaryTable td");
        verify(await evaluate(win, () => document.getElementById("dfmGuideTooltip").textContent.includes("Compare candidate")), "Dynamically rendered average cell shows its hint");
        await hover(win, '.ratioMainTable th[data-col="0"]');
        verify(await evaluate(win, () => document.getElementById("dfmGuideTooltip").textContent.includes("Double-click a development-column header")), "Column-header hover explains the hidden chart gesture");
        verify(await evaluate(win, () => {
          const tooltip = document.getElementById("dfmGuideTooltip");
          return document.querySelectorAll(".dfmGuideTooltip").length === 1 && tooltip.querySelectorAll("li").length <= 4 && tooltip.getBoundingClientRect().height < 240;
        }), "Only one concise tooltip is shown at a time");
        await click(win, '.ratioMainTable th[data-col="0"]', { count: 2 });
        await until(win, () => document.getElementById("dfmRatioChartModal").classList.contains("open"));
        await until(win, () => !!document.querySelector(".dfmRatioChartAverageRow"));
        verify(await evaluate(win, () => !!document.querySelector(".dfmRatioChartAverageRow")), "Double-click opens the actual interactive selection chart");
        await click(win, "#dfmRatioChartClose");
        await click(win, ".ratioMainTable td.ratioCell", { button: "right" });
        verify(await evaluate(win, () => {
          const menu = document.getElementById("dfmRatioMenu");
          return getComputedStyle(menu).display !== "none" && ["toggle-ratio-data", "add-ratio-cell-note", "copy-ratio-patterns", "custom-colors"].every(action => menu.querySelector(`[data-action="${action}"]`).getClientRects().length);
        }), "Observed-ratio context menu exposes the documented actions");
        await click(win, ".dfmTab.active");
        await hover(win, ".ratioSummaryTable th.summaryDragHandle");
        verify(await evaluate(win, () => document.getElementById("dfmGuideTooltip").textContent.includes("Average Row Menu")), "Row-label guidance is distinct from value-cell guidance");
        await click(win, ".ratioSummaryTable th.summaryDragHandle", { button: "right" });
        verify(await evaluate(win, () => {
          const menu = document.getElementById("dfmAvgMenu");
          return ["custom-average", "rename-average", "plot-summary-table"].every(action => menu.querySelector(`[data-action="${action}"]`).getClientRects().length)
            && !menu.querySelector('[data-action="add-summary-cell-note"]').getClientRects().length;
        }), "Average-row menu offers row actions and hides value-cell notes");
        await click(win, ".dfmTab.active");
        await click(win, ".ratioSummaryTable td.summaryCell", { button: "right" });
        verify(await evaluate(win, () => {
          const menu = document.getElementById("dfmAvgMenu");
          return menu.querySelector('[data-action="add-summary-cell-note"]').getClientRects().length
            && !menu.querySelector('[data-action="custom-average"]').getClientRects().length;
        }), "Average-value menu offers cell notes and hides row-only actions");
        await click(win, ".dfmTab.active");
        await click(win, ".ratioSelectedTable td", { button: "right" });
        verify(await evaluate(win, () => [...document.querySelectorAll('[data-action="show-curve"]')].some(el => el.getClientRects().length && el.textContent === "Show Percentage Developed Curve")), "Selected-pattern menu exposes its documented curve command");
        await click(win, ".dfmTab.active");
        await require("./table_appearance_gui_checks.cjs")(win, { evaluate, click, until, verify });
      }
      if (tab === "curves") {
        await hover(win, "#dfmCurvesWrap");
        verify(await evaluate(win, () => document.getElementById("dfmGuideTooltip").textContent.includes("double-click a user-value cell")), "Curves guidance advertises hidden editing gestures");
        await click(win, ".dfmCurvesTable td", { button: "right" });
        verify(await evaluate(win, () => [...document.querySelectorAll('.dfmCtxMenu [role="menuitem"]')].some(el => el.getClientRects().length && el.textContent === "Add User Column")), "Curves context menu exposes Add User Column");
        await click(win, ".dfmTab.active");
      }
    }
    for (const width of [1280, 680, 420]) {
      win.setContentSize(width, 850);
      await until(win, (expected) => innerWidth === expected, width);
      await evaluate(win, () => document.querySelector('.dfmGuideMarker[aria-label="Help: Inputs And Dependencies"]').focus());
      await until(win, () => {
        const rect = document.getElementById("dfmGuideTooltip").getBoundingClientRect();
        return rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
      });
      verify(await evaluate(win, () => {
        const guide = document.getElementById("dfmGuideTooltip").getBoundingClientRect();
        const panel = document.getElementById("dfmDetailsPage").getBoundingClientRect();
        const toggle = document.getElementById("dfmGuideToggle").getBoundingClientRect();
        return guide.left >= 0 && guide.right <= innerWidth && guide.bottom <= innerHeight && toggle.right <= innerWidth
          && panel.width > innerWidth - 30;
      }), `${width}px: tooltip stays in viewport and page retains its width`);
    }
    await evaluate(win, () => document.documentElement.dataset.arcrhoTheme = "dark");
    verify(await evaluate(win, () => getComputedStyle(document.getElementById("dfmGuideTooltip")).backgroundColor !== "rgb(251, 252, 254)"), "Guide inherits shared dark tooltip theme");
    await evaluate(win, () => document.querySelector(".dfmGuideMarker").focus());
    await win.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await win.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await until(win, () => document.getElementById("dfmGuide").hidden);
    verify(await evaluate(win, () => document.activeElement.id === "dfmGuideToggle" && !document.querySelector(".dfmGuideTarget")), "Escape removes highlights and restores focus");
    await click(win, "#dfmGuideToggle");
    verify(await evaluate(win, () => !document.getElementById("dfmGuide").hidden), "Guide can be re-enabled after Escape");
    await click(win, "#dfmGuideToggle");
    verify(await evaluate(win, () => document.getElementById("dfmGuide").hidden && document.getElementById("dfmGuideTooltip").hidden && !document.querySelector(".dfmGuideTarget")), "Toggle removes all markers, highlights and help");
    verify(await evaluate(win, async () => (await import("/ui/method_pages/dfm/dfm_state.js")).getDfmIsDirty()) === clean, "Guide interactions do not change dirty state");
    verify(!requests.some((request) => /\/dfm\/method\/save/.test(request)), "No method saves occurred");
    assert.deepEqual(errors, [], "No browser errors or external requests");
    console.log(`PASS: ${checks} DFM guide GUI checks across all eight tabs, three viewport sizes and dark theme.`);
    win.destroy();
  }
  run().then(() => { server.close(); app.exit(0); }).catch((error) => {
    console.error(error.stack);
    console.error("Browser errors:", errors, "API requests:", [...new Set(requests)]);
    server.close(); app.exit(1);
  });
}
