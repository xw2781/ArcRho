import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("Home launches File Explorer as a standard restorable ArcRho tab", async () => {
  const view = await read("../ui/shell/home_view.js");
  const actions = await read("../ui/shell/tab_actions.js");
  const host = await read("../ui/shell/iframe_host.js");
  const content = await read("../ui/shell/shell_content.js");
  const shell = await read("../ui/shell/ui_shell.js");
  const history = await read("../ui/shell/shell_activity_history.js");

  assert.match(view, /id="cardFileExplorer"/u);
  assert.match(view, /id="cardFileExplorer"[\s\S]*?<h3>My Workspace<\/h3>/u);
  assert.match(view, /shell\.openFileExplorerTab/u);
  assert.doesNotMatch(view, /id="homeFoldersNav"/u);
  assert.doesNotMatch(view, /id="homeFoldersPage"/u);
  assert.match(actions, /export function openFileExplorerTab\(options = \{\}\)/u);
  assert.match(actions, /find\(t => t\.type === "file_explorer"\)/u);
  assert.match(actions, /title:\s*"My Workspace"/u);
  assert.match(actions, /type:\s*"file_explorer"/u);
  assert.match(actions, /"file_explorer",\s*\]\)/u);
  assert.match(host, /\/ui\/file_explorer\/file_explorer\.html/u);
  assert.match(content, /type:\s*"arcrho:file-explorer-visibility"/u);
  assert.match(content, /tab\.type !== "file_explorer"/u);
  assert.match(shell, /openFileExplorerTab/u);
  assert.match(history, /\["workflow", "agent_guide", "file_explorer"\]/u);
});

test("File Explorer renders Favorites beside a persistent details-style file list", async () => {
  const html = await read("../ui/file_explorer/file_explorer.html");
  const explorer = await read("../ui/file_explorer/file_explorer.js");
  const styles = await read("../ui/file_explorer/file_explorer.css");

  assert.match(html, /id="fileExplorerApp"/u);
  assert.match(html, /id="homeFoldersNav"/u);
  assert.match(html, /id="homeFoldersPage"/u);
  assert.match(html, /context_menu\/context_menu\.css/u);
  assert.match(html, /file_explorer\.js/u);
  assert.match(styles, /\.fileExplorerLayout\s*\{[^}]*grid-template-columns:\s*var\(--file-explorer-sidebar-width, 220px\) 6px minmax\(0, 1fr\)/su);
  assert.match(html, /id="homeSidebarResizeHandle"[^>]*role="separator"/u);
  assert.match(styles, /\.fileExplorerSidebar\s*\{[^}]*overflow-y:\s*auto/su);
  assert.match(styles, /\.homeExplorerTable\s*\{[^}]*border-collapse:\s*separate/su);
  assert.match(styles, /\.homeExplorerTable th\s*\{[^}]*position:\s*sticky/su);
  assert.match(styles, /\.homeExplorerTable tbody tr:not\(\.homeExplorerStateRow\)\s*\{[^}]*height:\s*31px/su);
  assert.match(styles, /\.homeFolderDialogOverlay\[hidden\]\s*\{[^}]*display:\s*none/su);

  assert.match(explorer, /loadHomeFolderPreferences/u);
  assert.match(explorer, /saveHomeFolderPreferences/u);
  assert.match(explorer, /Add favorite folder/u);
  assert.match(explorer, /id="homeExplorerAddress"/u);
  assert.match(explorer, /id="homeExplorerSearch"/u);
  assert.match(explorer, /data-sort-key="name"/u);
  assert.match(explorer, /data-sort-key="date"/u);
  assert.match(explorer, /data-sort-key="type"/u);
  assert.match(explorer, /data-sort-key="size"/u);
  assert.match(explorer, /includeHidden:\s*true,\s*includeMetadata:\s*true/u);
  assert.match(explorer, /startArcodeFolderWatch/u);
  assert.match(explorer, /if \(!state\.hostVisible/u);
  assert.match(explorer, /void stopFolderWatch\(\)/u);
  assert.match(explorer, /Open Read-Only/u);
  assert.match(explorer, /isExcelWorkbookPath\(entry\.path\)/u);
  assert.match(explorer, /openPath\(\{ path: entry\.path, readOnly: !!options\.readOnly \}\)/u);
  assert.match(explorer, /if \(event\.target !== table\) return;/u);
  assert.match(explorer, /event\.key === "ContextMenu" \|\| \(event\.shiftKey && event\.key === "F10"\)/u);
  assert.match(explorer, /function ensureExplorerRowVisible\(row\)/u);
  assert.match(explorer, /arcrho:file-explorer-visibility/u);
  assert.match(explorer, /function wireSidebarResize\(\)/u);
  assert.doesNotMatch(explorer, /homeFolderShortcutMenuButton/u);
  assert.match(explorer, /type:\s*"arcrho:update-active-tab-title"/u);
  assert.match(explorer, /folderForPath\(state\.currentPath\)\?\.nickname \|\| defaultHomeFolderNickname\(state\.currentPath\)/u);
  assert.doesNotMatch(explorer, /scrollIntoView/u);
  assert.doesNotMatch(explorer, /\(xlsx\|xlsm\|xlsb\|xls\)/u);
});

test("Electron persists favorite folders and enriches listings only when requested", async () => {
  const main = await read("../electron/main.js");
  const preload = await read("../electron/preload.js");

  assert.match(preload, /loadHomeFolderPreferences:\s*\(\)\s*=>\s*invoke\("home-folders-preferences-load"\)/u);
  assert.match(preload, /saveHomeFolderPreferences:\s*\(preferences\)\s*=>\s*invoke\("home-folders-preferences-save"/u);
  assert.match(main, /const HOME_FOLDERS_PREFS_FILE = "home_folders\.json"/u);
  assert.match(main, /ipcMain\.handle\("home-folders-preferences-load"/u);
  assert.match(main, /ipcMain\.handle\("home-folders-preferences-save"/u);
  assert.match(main, /const includeMetadata = !!payload\?\.includeMetadata/u);
  assert.match(main, /if \(includeMetadata\)/u);
  assert.match(main, /mtimeMs:\s*Number\.isFinite\(entryStat\?\.mtimeMs\)/u);
  assert.match(main, /openExcelWorkbookReadOnly\(targetPath\)/u);
  assert.match(main, /spawnDetachedOpen\(excelCommand, \["\/r", targetPath\]\)/u);
});

test("File Explorer and Arcode consume one shared file-icon package", async () => {
  const resolverSource = await read("../ui/shared/file-icons/fileIconResolver.js");
  const iconMap = JSON.parse(await read("../ui/shared/file-icons/file-icon-map.json"));
  const arcode = await read("../ui/arcode/main.js");
  const explorer = await read("../ui/file_explorer/file_explorer.js");
  const arcodeServer = await read("../app_server/arcode_main.py");
  const arcodeSpec = await read("../build/arcode_server.spec");
  const resolverModule = await import(
    `data:text/javascript;base64,${Buffer.from(resolverSource).toString("base64")}`
  );
  const resolveIcon = resolverModule.createFileIconResolver(iconMap);

  assert.equal(resolveIcon("report.pdf"), "icons/pdf.svg");
  assert.equal(resolveIcon("model.py"), "icons/python.svg");
  assert.equal(resolveIcon("folder", { isDirectory: true }), "icons/folder-base.svg");
  assert.equal(resolveIcon("C:\\", { isDirectory: true }), "icons/folder-base.svg");
  assert.equal(resolveIcon("book.xlsx"), "icons/document.svg");
  assert.match(arcode, /\/ui\/shared\/file-icons\/fileIconResolver\.js/u);
  assert.match(explorer, /\/ui\/shared\/file-icons\/fileIconResolver\.js/u);
  assert.doesNotMatch(arcode, /\/ui\/arcode\/shared\/file-icons/u);
  assert.doesNotMatch(explorer, /\/ui\/arcode\/shared\/file-icons/u);
  assert.match(arcodeServer, /shared_ui = ui_root \/ "shared"/u);
  assert.match(arcodeServer, /app\.mount\("\/ui\/shared"/u);
  assert.match(arcodeSpec, /repo_root \/ "ui" \/ "shared"/u);
});
