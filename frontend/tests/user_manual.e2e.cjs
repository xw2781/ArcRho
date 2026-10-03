/* Run: frontend/node-portable/node.exe frontend/tests/user_manual.e2e.cjs
 * Add --base-url=https://your-gateway/user-guide/ to check a deployed guide.
 * Exercises every actual guide chapter in hidden Chromium windows.
 * Visible desktop verification and screenshot provenance are separate checks.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL, fileURLToPath } = require("node:url");

const repository = path.resolve(__dirname, "../..");
const guideRoot = path.join(repository, "frontend/user-manual");
const electron = require("electron");
const baseArgument = process.argv.find((arg) => arg.startsWith("--base-url="));
const base = baseArgument ? new URL(baseArgument.slice("--base-url=".length)) : null;
if (base) assert.ok(/^https?:$/.test(base.protocol) && base.pathname === "/user-guide/"
  && !base.username && !base.password && !base.search && !base.hash, "base URL must be an unauthenticated /user-guide/ URL");
const inGuide = (url) => base && url.origin === base.origin && url.pathname.startsWith(base.pathname);
const pageUrl = (file) => base ? new URL(file, base).href : pathToFileURL(path.join(guideRoot, file)).href;

if (typeof electron === "string") {
  const testRoot = path.join(repository, "test");
  const existed = fs.existsSync(testRoot);
  fs.mkdirSync(testRoot, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(testRoot, "user-manual-"));
  try {
    const env = { ...process.env, TEMP: scratch, TMP: scratch, APPDATA: scratch, LOCALAPPDATA: scratch };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(electron, [
      "--disable-gpu", `--user-data-dir=${scratch}`, __filename, `--manual-test-root=${scratch}`, ...(baseArgument ? [baseArgument] : []),
    ], { cwd: repository, env, windowsHide: true, encoding: "utf8", timeout: 120000 });
    process.stdout.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    assert.equal(path.dirname(scratch), testRoot, "cleanup remains inside the repository test folder");
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    if (!existed && fs.readdirSync(testRoot).length === 0) fs.rmdirSync(testRoot);
  }
} else {
  const { app, BrowserWindow, session } = electron;
  const scratch = process.argv.find((arg) => arg.startsWith("--manual-test-root="))?.split("=").slice(1).join("=");
  assert.ok(scratch && path.dirname(scratch) === path.join(repository, "test"));
  for (const key of ["appData", "userData", "sessionData", "temp", "logs", "crashDumps"]) app.setPath(key, scratch);
  app.disableHardwareAcceleration();
  // Closing one case must not end Electron before the next hidden window loads.
  app.on("window-all-closed", () => {});
  const pages = ["index.html", ...fs.readdirSync(path.join(guideRoot, "pages"))
    .filter((file) => file.endsWith(".html")).sort().map((file) => `pages/${file}`)]
    .map((file) => [file, fs.readFileSync(path.join(guideRoot, file), "utf8").match(/\bdata-page=["']([^"']+)["']/)?.[1]]);
  const errors = [];
  const blockedRequests = [];
  const referencesRead = new Map();
  let checks = 0;
  const verify = (condition, message) => { assert.ok(condition, message); checks += 1; };
  const evaluate = async (win, fn, value) => {
    const expression = `(${fn.toString()})(${JSON.stringify(value)})`;
    if (win.webContents.getLastWebPreferences().javascript !== false) return win.webContents.executeJavaScript(expression, true);
    // DevTools can inspect a document even when its own JavaScript is disabled.
    if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach("1.3");
    const out = await win.webContents.debugger.sendCommand("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text);
    return out.result.value;
  };

  function makeWindow(javascript = true) {
    const win = new BrowserWindow({
      show: false, width: 1440, height: 1100, useContentSize: true,
      webPreferences: { javascript, sandbox: true, contextIsolation: true, nodeIntegration: false,
        backgroundThrottling: false, session: session.defaultSession },
    });
    win.webContents.on("console-message", (_event, level, message) => {
      if (level >= 3) errors.push(message);
    });
    win.webContents.on("render-process-gone", (_event, details) => errors.push(`Renderer exited: ${details.reason}`));
    return win;
  }

  async function validateReferences(win, label) {
    const references = await evaluate(win, () => Array.from(document.querySelectorAll("a[href],img[src],script[src],link[href]"), (el) => ({
      url: el.href || el.src, tag: el.tagName,
    })));
    for (const { url, tag } of references) {
      const target = new URL(url);
      if (tag === "A" && /^https?:$/.test(target.protocol) && !inGuide(target)) continue;
      let html;
      if (base) {
        verify(inGuide(target), `${label}: ${tag} resource is outside the hosted guide: ${url}`);
        const resource = new URL(target); resource.hash = "";
        if (!referencesRead.has(resource.href)) referencesRead.set(resource.href, await evaluate(win, async (href) => {
          const response = await fetch(href, { credentials: "omit", redirect: "error" });
          return { status: response.status, text: response.headers.get("content-type")?.includes("text/html") ? await response.text() : "" };
        }, resource.href));
        const response = referencesRead.get(resource.href);
        verify(response.status === 200, `${label}: HTTP ${response.status} for ${url}`);
        html = response.text;
      } else {
        if (target.protocol !== "file:") continue;
        const file = fileURLToPath(target);
        verify(fs.existsSync(file), `${label}: missing ${tag} target ${file}`);
        if (/\.html?$/i.test(file)) html = fs.readFileSync(file, "utf8");
      }
      if (tag === "A" && target.hash && html) {
        const found = await evaluate(win, ({ html, id, url }) => {
          const current = new URL(location.href);
          const linked = new URL(url);
          return !!(current.pathname === linked.pathname ? document : new DOMParser().parseFromString(html, "text/html")).getElementById(id);
        }, {
          html, id: decodeURIComponent(target.hash.slice(1)), url,
        });
        verify(found, `${label}: missing anchor ${target.hash} in ${url}`);
      }
    }
  }
  async function checkLayout(win, label, width) {
    win.setContentSize(width, 1000);
    const deadline = Date.now() + 3000;
    while (await evaluate(win, () => innerWidth) !== width && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const dimensions = await evaluate(win, () => {
      const main = document.querySelector("main.guide-content");
      return { width: innerWidth, scroll: document.documentElement.scrollWidth, mainWidth: main.getBoundingClientRect().width };
    });
    verify(dimensions.width === width, `${label}: browser viewport resized to ${width}px`);
    verify(dimensions.scroll <= dimensions.width + 1, `${label}: ${width}px viewport overflows to ${dimensions.scroll}px`);
    verify(dimensions.mainWidth > 200, `${label}: content is unreadably narrow at ${width}px`);
  }
  async function checkMobileNavigation(win, label) {
    const navigation = await evaluate(win, () => {
      const button = document.querySelector(".guide-menu-toggle");
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
      const scrolled = scrollY > 0;
      button.focus();
      button.click();
      const expanded = button.getAttribute("aria-expanded") === "true";
      const sidebar = document.querySelector(".guide-sidebar");
      const visible = getComputedStyle(sidebar).display !== "none";
      const bounds = sidebar.getBoundingClientRect();
      const toggle = button.getBoundingClientRect();
      const link = sidebar.querySelector(".guide-toc a");
      link.scrollIntoView({ block: "nearest", behavior: "instant" });
      const linkBounds = link.getBoundingClientRect();
      const hit = document.elementFromPoint(linkBounds.x + linkBounds.width / 2, linkBounds.y + linkBounds.height / 2);
      const usable = hit?.closest("a") === link;
      const hash = link.hash;
      link.click();
      const followed = location.hash === hash;
      window.scrollTo({ top: 0, behavior: "instant" });
      return { expanded, visible, scrolled: scrolled || document.documentElement.scrollHeight <= innerHeight, usable, followed,
        inViewport: toggle.top >= -1 && bounds.top >= toggle.bottom - 1 && bounds.bottom <= innerHeight + 1,
        collapsed: button.getAttribute("aria-expanded") === "false" };
    });
    verify(navigation.expanded && navigation.visible && navigation.collapsed, `${label}: mobile navigation opens and closes`);
    verify(navigation.scrolled && navigation.inViewport, `${label}: navigation remains inside the viewport after scrolling`);
    verify(navigation.usable && navigation.followed, `${label}: a visible mobile section link can be activated`);
  }
  async function checkWalkthrough(win, label) {
    const state = () => evaluate(win, () => Array.from(document.querySelectorAll("[data-walkthrough]"), (host) => ({
      count: host.querySelectorAll("figure[data-step]").length,
      visible: Array.from(host.querySelectorAll("figure[data-step]")).map((frame, index) =>
        getComputedStyle(frame).display !== "none" && frame.getClientRects().length ? index : -1).filter((index) => index >= 0),
      status: host.querySelector("[data-step-status]")?.textContent.trim(),
      previousDisabled: host.querySelector("[data-previous]")?.disabled,
      nextDisabled: host.querySelector("[data-next]")?.disabled,
    })));
    const initial = await state();
    for (let index = 0; index < initial.length; index += 1) {
      verify(initial[index].count >= 2, `${label}: walkthrough needs multiple recorded frames`);
      assert.deepEqual(initial[index].visible, [0], `${label}: first walkthrough frame starts visible`);
      verify(initial[index].previousDisabled, `${label}: Previous is disabled on the first step`);
      let status = initial[index].status;
      for (let step = 1; step < initial[index].count; step += 1) {
        await evaluate(win, (i) => document.querySelectorAll("[data-walkthrough]")[i].querySelector("[data-next]").click(), index);
        const next = (await state())[index];
        assert.deepEqual(next.visible, [step], `${label}: Next shows only frame ${step + 1}`);
        verify(next.status && next.status !== status, `${label}: Next updates the step status`);
        status = next.status;
        checks += 1;
      }
      verify((await state())[index].nextDisabled, `${label}: Next is disabled on the final step`);
      for (let step = initial[index].count - 2; step >= 0; step -= 1) {
        await evaluate(win, (i) => document.querySelectorAll("[data-walkthrough]")[i].querySelector("[data-previous]").click(), index);
        assert.deepEqual((await state())[index].visible, [step], `${label}: Previous restores frame ${step + 1}`);
        checks += 1;
      }
      checks += 1;
    }
  }
  async function checkWalkthroughControlPosition(win, label) {
    const positions = await evaluate(win, () => Array.from(document.querySelectorAll("[data-walkthrough]"), (host) => {
      const next = host.querySelector("[data-next]");
      const previous = host.querySelector("[data-previous]");
      const tops = [next.getBoundingClientRect().top];
      while (!next.disabled) {
        next.click();
        tops.push(next.getBoundingClientRect().top);
      }
      while (!previous.disabled) previous.click();
      return tops;
    }));
    for (const tops of positions) {
      verify(tops.every((top) => Math.abs(top - tops[0]) < 1), `${label}: walkthrough controls moved between frames: ${tops.join(", ")}`);
    }
  }
  async function checkEnlargement(win, label) {
    const opened = await evaluate(win, () => {
      const image = Array.from(document.querySelectorAll("figure.screenshot img")).find((img) => img.getClientRects().length);
      if (!image) return null;
      const opener = image.closest("button,a") || image;
      opener.focus();
      window.__manualTestOpener = opener;
      opener.click();
      const dialog = document.querySelector("dialog[open]");
      return { open: !!dialog, source: image.currentSrc, expanded: dialog?.querySelector("img")?.src,
        focusInside: !!dialog?.contains(document.activeElement) };
    });
    verify(opened?.open, `${label}: clicking a screenshot opens its native dialog`);
    verify(opened.source === opened.expanded, `${label}: enlargement shows the same real screenshot`);
    verify(opened.focusInside, `${label}: focus enters the screenshot dialog`);
    await evaluate(win, () => document.querySelector("dialog[open] button").click());
    const closed = await evaluate(win, () => ({
      open: !!document.querySelector("dialog[open]"), restored: document.activeElement === window.__manualTestOpener,
    }));
    verify(!closed.open && closed.restored, `${label}: closing the screenshot restores opener focus`);
  }

  async function checkAllFramesVisible(win, label) {
    const frames = await evaluate(win, () => Array.from(document.querySelectorAll("figure.screenshot"), (figure) => ({
      visible: getComputedStyle(figure).display !== "none" && figure.getClientRects().length > 0,
      caption: figure.querySelector("figcaption")?.textContent.trim(),
    })));
    verify(frames.every((frame) => frame.visible && frame.caption), `${label}: every screenshot and caption remains available`);
  }

  app.whenReady().then(async () => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (details, callback) => {
      const allowed = !!inGuide(new URL(details.url));
      if (!allowed) blockedRequests.push(details.url);
      callback({ cancel: !allowed });
    });
    for (const [file, pageId] of pages) {
      const win = makeWindow();
      try {
        await win.loadURL(pageUrl(file));
        const content = await evaluate(win, async () => {
          const images = Array.from(document.querySelectorAll("main img"));
          for (const image of images) image.loading = "eager";
          await Promise.all(images.map((image) => image.decode()));
          return { page: document.body.dataset.page, title: document.querySelector("h1")?.textContent.trim(),
            main: !!document.querySelector("main.guide-content"), images: images.length,
            screenshots: document.querySelectorAll("figure.screenshot").length,
            oldMock: !!document.querySelector(".manual-page,.manual-cursor,.pi-demo,.dfm-demo,.ar-app-window,[data-replay],[src$='manual.js'],[href$='manual.css']"),
            oldName: /\bProject\s+Instance\b/i.test([document.title, document.body.innerText, ...images.map((image) => image.alt)].join("\n")),
            navigation: Array.from(document.querySelectorAll(".guide-nav a"), (link) => link.href).sort(),
            described: images.every((image) => image.naturalWidth > 0 && image.alt.trim()) };
        });
        verify(pageId && content.page === pageId && content.main && content.title, `${file}: document identity and main heading`);
        verify(!content.oldMock && !content.oldName, `${file}: real screenshot guide uses Project Page terminology`);
        assert.deepEqual(content.navigation, pages.map(([name]) => pageUrl(name)).sort(), `${file}: navigation reaches every chapter`); checks += 1;
        verify(content.images > 0 && content.described, `${file}: actual images decode and have alternative text`);
        await validateReferences(win, file);
        await checkLayout(win, file, 1440);
        await checkWalkthroughControlPosition(win, `${file} at 1440px`);
        if (pageId === "dfm") {
          await checkLayout(win, file, 1500);
          await checkWalkthroughControlPosition(win, `${file} at 1500px`);
        }
        await checkLayout(win, file, 390);
        await checkMobileNavigation(win, file);
        await checkWalkthrough(win, file);
        if (content.screenshots) await checkEnlargement(win, file);
        win.webContents.debugger.attach("1.3");
        await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { media: "print" });
        await checkAllFramesVisible(win, `${file} print`);
        win.webContents.debugger.detach();
      } finally { win.destroy(); }

      const plain = makeWindow(false);
      try {
        await plain.loadURL(pageUrl(file));
        verify(await evaluate(plain, () => !document.documentElement.classList.contains("guide-enhanced")), `${file}: page scripts are disabled`);
        await checkAllFramesVisible(plain, `${file} without JavaScript`);
        await checkLayout(plain, `${file} without JavaScript`, 390);
      } finally { plain.destroy(); }
      console.log(`PASS ${file}: links/images, desktop/mobile, interactions, print, no JavaScript`);
    }
    assert.deepEqual(errors, [], "guide produces no browser console errors");
    assert.deepEqual(blockedRequests, [], "guide makes no requests outside its allowed documentation origin/path");
    console.log(`PASS user manual (${base ? "hosted" : "offline"}): ${checks} browser assertions across ${pages.length} pages`);
    app.exit(0);
  }).catch((error) => {
    console.error(error.stack || error);
    if (errors.length) console.error(errors.join("\n"));
    app.exit(1);
  });
}
