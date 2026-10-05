// Manual GUI regression fixture. Run with Electron; all persistent state is
// under test/arcbot-gui. The CLI and project are simulated, the widget is real.
const { app, BrowserWindow, ipcMain } = require("electron");
const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");
const http = require("http");
const root = path.resolve(__dirname, "..");
const scratch = path.resolve(root, "../test/arcbot-gui");
fs.mkdirSync(scratch, { recursive: true });
app.setPath("userData", path.join(scratch, "profile"));
app.setPath("appData", scratch);
app.setPath("logs", path.join(scratch, "logs"));
app.setPath("crashDumps", path.join(scratch, "crashes"));
process.env.ARCRHO_CODEX_CMD = process.execPath;
app.disableHardwareAcceleration();
let starts = 0;
const fakeProcess = () => {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
  proc.exitCode = null; proc.killed = false;
  proc.kill = () => { proc.killed = true; };
  const emit = value => proc.stdout.emit("data", Buffer.from(JSON.stringify(value) + "\n"));
  proc.stdin = new EventEmitter();
  proc.stdin.write = function(line, callback) {
    const message = JSON.parse(line), { id, method, params } = message;
    const respond = result => queueMicrotask(() => emit({ id, result }));
    if (method === "initialize") respond({});
    if (method === "model/list") respond({ data: [{ id: "gpt-5.6-sol", model: "gpt-5.6-sol", displayName: "GUI fixture", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "high" }] }] });
    if (method === "thread/start") { starts++; respond({ thread: { id: `fixture-${starts}` } }); }
    if (method === "thread/unsubscribe") respond({ status: "unsubscribed" });
    if (method === "turn/start") {
      const threadId = params.threadId, turnId = `turn-${starts}`;
      respond({ turn: { id: turnId, status: "inProgress" } });
      const notice = (method, extra) => emit({ method, params: { threadId, turnId, ...extra } });
      setTimeout(() => notice("item/started", { item: { id: "cmd", type: "commandExecution", command: 'python -c "print(\'Read 3 fake project methods\')"' } }), 400);
      setTimeout(() => notice("item/commandExecution/outputDelta", { itemId: "cmd", delta: "\nPaid DFM: ready\nIncurred BF: ready\nSelected RS: review needed\n" }), 900);
      setTimeout(() => notice("item/completed", { item: { id: "cmd", type: "commandExecution", command: 'python -c "print(\'Read 3 fake project methods\')"', aggregatedOutput: "Paid DFM: ready\nIncurred BF: ready\nSelected RS: review needed", exitCode: 0 } }), 1500);
      setTimeout(() => {
        notice("item/started", { item: { id: "answer", type: "agentMessage", phase: "final_answer" } });
        const text = "Reviewed **3 methods** in the fake project.\n\n- Paid DFM and Incurred BF are ready.\n- Selected RS needs review.\n\nNo project data was changed.";
        notice("item/agentMessage/delta", { itemId: "answer", delta: text });
        notice("item/completed", { item: { id: "answer", type: "agentMessage", text, phase: "final_answer" } });
        notice("turn/completed", { turn: { id: turnId, status: "completed" } });
      }, 5000);
    }
    if (method === "turn/interrupt") respond({});
    callback?.();
  };
  return proc;
};
let host, server;
app.whenReady().then(() => {
  host = require("../electron/arcbot_host").registerArcBotIpc({
    ipcMain, app: { isPackaged: false, getPath: () => scratch }, APP_ROOT: root,
    REPO_ROOT: path.dirname(root), PYTHON_EXE: "python", getPrefsDir: () => scratch,
    getWorkspacePathsPath: () => path.join(scratch, "workspace_paths.json"), homeDir: path.join(scratch, "home"),
    findExecutableOnPath: () => process.execPath, spawnProcess: fakeProcess,
    runHostCommand: async (_command, args) => ({ ok: true, stdout: args.includes("--version") ? "codex-cli 0.146.0" : "Logged in using ChatGPT", stderr: "", code: 0 }),
  });
  ipcMain.handle("gui-fixture-stats", () => ({ starts }));
  ipcMain.handle("get-windows-user-name", () => "GUI Tester");
  server = http.createServer((req, res) => {
    const requested = decodeURIComponent(req.url.split("?")[0]);
    const file = path.resolve(root, `.${requested === "/" ? "/tests/arcbot_gui_harness.html" : requested}`);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (error, data) => {
      if (error) { res.writeHead(404).end(); return; }
      res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".png") ? "image/png" : "text/html");
      res.end(data);
    });
  }).listen(0, "127.0.0.1", () => {
    const win = new BrowserWindow({ width: 1150, height: 850, title: "ArcBot GUI - Fake Project", webPreferences: { preload: path.join(root, "electron/preload.js") } });
    win.once("ready-to-show", () => { win.show(); win.focus(); });
    win.loadURL(`http://127.0.0.1:${server.address().port}`);
  });
});
app.on("window-all-closed", () => { host?.stop(); server?.close(); app.quit(); });
