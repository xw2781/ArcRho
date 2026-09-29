// Run with node-portable/node.exe tests/arcode_notebook_search.cjs.
const electron = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const testRoot = path.resolve(root, "../test");
fs.mkdirSync(testRoot, { recursive: true });
if (typeof electron === "string") {
  const scratch = fs.mkdtempSync(path.join(testRoot, "notebook-search-"));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let success = false;
  try {
    const child = require("node:child_process").spawnSync(electron, [__filename, scratch], {
      env, windowsHide: true, timeout: 60000, stdio: "inherit",
    });
    const result = JSON.parse(fs.readFileSync(path.join(scratch, "result.json"), "utf8"));
    console.log(result.message);
    success = child.status === 0 && result.success;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  process.exit(success ? 0 : 1);
}
const { app, BrowserWindow } = electron;
const scratch = process.argv[2];
app.setPath("userData", scratch);
app.setPath("sessionData", scratch);
app.setPath("crashDumps", scratch);
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");

// Serve only repository UI assets. All API calls use inert local responses.
const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  if (pathname === "/scripting/run-stream") {
    const chunks = ["Processing: 0%", "\rProcessing: 50%", "\rProcessing: 100%\n"];
    response.setHeader("Content-Type", "application/x-ndjson");
    response.end([...chunks.map((text) => ({ type: "stderr", text })), {
      type: "done", success: true, output: "", error: chunks.join(""), execution_count: 1,
    }].map((event) => JSON.stringify(event)).join("\n") + "\n");
    return;
  }
  if (!pathname.startsWith("/ui/")) {
    response.setHeader("Content-Type", "application/json");
    const signature = {
      signature: "len(obj, /)", docstring: "Return the number of items in a container.",
      parameters: [{ name: "obj", label: "obj", kind: "POSITIONAL_ONLY" }],
    };
    const data = pathname === "/scripting/complete" ? {
      signature, active_parameter: 0,
      suggestions: Array.from({ length: 20 }, (_, i) => ({ label: `length_${i}`, insert_text: `length_${i}`, kind: "name", expression: `length_${i}` })),
    } : pathname === "/scripting/inspect" ? { ...signature, found: true, name: "len", type: "builtin_function_or_method" } : {};
    response.end(JSON.stringify(data));
    return;
  }
  const filename = path.resolve(root, `.${pathname}`);
  if (!filename.startsWith(path.join(root, "ui") + path.sep)) {
    response.writeHead(403).end();
    return;
  }
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
  response.setHeader("Content-Type", types[path.extname(filename)] || "application/octet-stream");
  fs.createReadStream(filename).on("error", () => response.writeHead(404).end()).pipe(response);
});

(async () => {
  await app.whenReady();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const window = new BrowserWindow({ show: false, width: 1100, height: 850, webPreferences: { offscreen: true } });
  const run = async (code) => {
    const result = await window.webContents.executeJavaScript(`(async () => {
      try { return JSON.parse(JSON.stringify({ value: await eval(${JSON.stringify(code)}) })); }
      catch (error) { return { error: error.stack }; }
    })()`);
    if (result.error) throw new Error(result.error);
    return result.value;
  };
  try {
    await window.loadURL(`http://127.0.0.1:${server.address().port}/ui/arcode/notebook-editor/index.html?fresh=1&skipLast=1`);
    await run(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 15000;
      const timer = setInterval(() => {
        if (monacoReady && cells.length) { clearInterval(timer); resolve(); }
        else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('Monaco startup timed out')); }
      }, 25);
    })`);
    await run(`
      cells[0].editor.setValue('alpha Alpha alpha');
      addCell('# alpha', null, 'after', CELL_TYPES.MARKDOWN);
      setMarkdownRenderedState(cells[1], true);
      clearNotebookUndoHistory();
      markNotebookSavedBaseline('', null);
      window.key = (key, options = {}) => document.activeElement.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }));
      window.input = (id, value) => {
        const element = document.getElementById(id);
        element.value = value;
        element.dispatchEvent(new Event('input', { bubbles: true }));
      };
      window.click = (id) => document.getElementById(id).click();
      key('h', { ctrlKey: true });
      input('notebookSearchQuery', 'alpha');
    `);
    assert.equal(await run(`document.getElementById('notebookSearchCount').textContent`), "1 of 4");
    assert.equal(await run(`editingCellId`), null, "revealing a result stays in command mode");
    await run(`key('Enter', { shiftKey: true })`);
    assert.equal(await run(`focusedCellId === cells[1].id && !cells[1].markdownRendered`), true);
    await run(`input('notebookReplaceText', '$literal'); click('notebookReplaceAll')`);
    assert.deepEqual(await run(`cells.map(c => c.editor.getValue())`), ["$literal $literal $literal", "# $literal"]);
    assert.equal(await run(`notebookUndoStack.length`), 1, "Replace All is one notebook undo step");
    await run(`key('Escape'); undoNotebookChange()`);
    assert.deepEqual(await run(`cells.map(c => c.editor.getValue())`), ["alpha Alpha alpha", "# alpha"]);

    await run(`key('f', { ctrlKey: true }); input('notebookSearchQuery', 'alpha'); click('notebookSearchCase')`);
    assert.equal(await run(`document.getElementById('notebookSearchCount').textContent`), "1 of 3");
    await run(`click('notebookSearchToggleReplace'); input('notebookReplaceText', 'beta'); click('notebookReplaceOne')`);
    assert.deepEqual(await run(`cells.map(c => c.editor.getValue())`), ["beta Alpha alpha", "# alpha"]);
    await run(`input('notebookSearchQuery', 'missing')`);
    assert.equal(await run(`document.getElementById('notebookReplaceAll').disabled`), true);
    await run(`input('notebookSearchQuery', ''); click('notebookReplaceAll')`);
    assert.deepEqual(await run(`cells.map(c => c.editor.getValue())`), ["beta Alpha alpha", "# alpha"]);

    // Scope changes only when a search is invoked in a different notebook mode.
    await run(`key('Escape'); enterCellEditMode(cells[0].id); key('h', { ctrlKey: true })`);
    assert.equal(await run(`document.getElementById('notebookSearch').hidden`), true);
    assert.equal(await run(`cells[0].editor.getContribution('editor.contrib.findController').getState().isReplaceRevealed`), true);
    await run(`
      const find = cells[0].editor.getContribution('editor.contrib.findController');
      find.getState().change({ searchString: 'alpha', replaceString: 'cellOnly', matchCase: false }, false);
      find.replaceAll();
    `);
    assert.deepEqual(await run(`cells.map(c => c.editor.getValue())`), ["beta cellOnly cellOnly", "# alpha"]);
    await run(`key('Escape')`);
    assert.equal(await run(`editingCellId === cells[0].id`), true, "Escape closes cell search before leaving edit mode");
    await run(`key('Escape'); key('f', { ctrlKey: true })`);
    assert.equal(await run(`document.getElementById('notebookSearch').hidden`), false);
    await run(`input('notebookSearchQuery', 'alpha'); void addCell('alpha')`);
    assert.equal(await run(`document.getElementById('notebookSearchCount').textContent`), "1 of 2", "new cells join open search");
    await run(`cells[2].editor.setValue('changed')`);
    assert.equal(await run(`document.getElementById('notebookSearchCount').textContent`), "1 of 1", "source changes refresh results");
    await run(`
      window.waitFor = (selector) => new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const timer = setInterval(() => {
          if (document.querySelector(selector)) { clearInterval(timer); resolve(); }
          else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('Missing widget: ' + selector)); }
        }, 25);
      });
      key('Escape');
      cells[0].editor.setValue('len');
      enterCellEditMode(cells[0].id);
      cells[0].editor.setPosition({ lineNumber: 1, column: 4 });
      cells[0].editor.trigger('test', 'editor.action.triggerSuggest', {});
      waitFor('#notebookEditorWidgets .suggest-widget.visible');
    `);
    await run(`new Promise(resolve => setTimeout(resolve, 250))`);
    assert.equal(await run(`(() => {
      const widget = document.querySelector('#notebookEditorWidgets .suggest-widget.visible');
      const rect = widget.getBoundingClientRect();
      const editorRect = cells[0].editorEl.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + 20, Math.min(rect.bottom - 10, rect.top + 120));
      return rect.bottom > editorRect.bottom && widget.contains(hit);
    })()`), true, "completion popup extends beyond the cell and is not clipped or covered");
    await run(`document.querySelector('#notebookEditorWidgets .suggest-widget').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
    assert.equal(await run(`editingCellId === cells[0].id`), true, "popup clicks retain edit mode");
    await run(`key('Escape')`);
    assert.equal(await run(`editingCellId === cells[0].id`), true, "Escape dismisses completion before leaving edit mode");
    await run(`
      cells[0].editor.setValue('len(');
      cells[0].editor.setPosition({ lineNumber: 1, column: 5 });
      cells[0].editor.trigger('test', 'editor.action.triggerParameterHints', {});
      waitFor('#notebookEditorWidgets .parameter-hints-widget.visible');
    `);
    assert.match(await run(`document.querySelector('#notebookEditorWidgets .parameter-hints-widget').textContent`), /number of items/);
    await run(`key('Escape')`);
    assert.equal(await run(`editingCellId === cells[0].id`), true, "Escape dismisses hints before leaving edit mode");
    await run(`void cells[0].editor.setValue('progress_fixture()'); runCell(cells[0].id)`);
    assert.equal(await run(`cells[0].outputEl.querySelector('.out-error').textContent`), "Processing: 100%\n",
      "streamed carriage returns replace the progress line without duplicating the final stderr payload");
    assert.equal(await run(`cells[0].outputs[0].text`), "Processing: 0%\rProcessing: 50%\rProcessing: 100%\n",
      "persisted output retains its original stream");
    console.log("PASS: notebook/cell scope, navigation, Markdown, literal replacement, case matching, undo, empty results, Escape, live updates");
  } finally {
    window.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
})().then(() => finish(true, "Notebook search integration checks passed."), (error) => finish(false, error.stack));

function finish(success, message) {
  fs.writeFileSync(path.join(scratch, "result.json"), JSON.stringify({ success, message }));
  app.exit(success ? 0 : 1);
}
