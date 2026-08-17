import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const CONSOLE_PAGES = [
  { name: "snowflake", html: "../ui/arcode/snowflake-console/index.html", js: "../ui/arcode/snowflake-console/index.js" },
  { name: "sql-server", html: "../ui/arcode/sql-server-console/index.html", js: "../ui/arcode/sql-server-console/index.js" },
];

// Every id the shared runtime binds. A console page that omits one silently
// loses a command, so the page markup is checked against this list instead of
// each console repeating the runtime's knowledge of its own DOM.
const SHARED_CONSOLE_ELEMENT_IDS = [
  "connectionSelect",
  "testConnectionBtn",
  "saveBtn",
  "formatBtn",
  "runBtn",
  "editorHost",
  "messageBox",
  "tableWrap",
  "queryInfo",
];

test("both SQL consoles run the one shared console runtime", () => {
  const core = read("../ui/arcode/shared/sql_console.js");
  assert.match(core, /export function createSqlConsole\(engine\)/);

  for (const page of CONSOLE_PAGES) {
    const source = read(page.js);
    assert.match(
      source,
      /import \{ createSqlConsole \} from "\.\.\/shared\/sql_console\.js\?v=/,
      `${page.name} imports the shared console runtime`,
    );
    assert.match(source, /createSqlConsole\(/, `${page.name} boots through the shared runtime`);
    // The engine descriptor is the only thing a console page may vary.
    assert.doesNotMatch(source, /monaco\.editor\.create/, `${page.name} does not create its own editor`);
    assert.doesNotMatch(source, /requestSqlFormatPreview/, `${page.name} does not restate the Format flow`);
  }
});

test("every SQL console page provides the elements the shared runtime binds", () => {
  for (const page of CONSOLE_PAGES) {
    const html = read(page.html);
    for (const id of SHARED_CONSOLE_ELEMENT_IDS) {
      assert.ok(
        html.includes(`id="${id}"`),
        `${page.name} console defines #${id} for the shared runtime`,
      );
    }
    // Connection details are labeled in markup and filled from the profile.
    assert.match(html, /data-profile-field="[^"]+" data-label="[^"]+"/);
    assert.match(html, /shared\/sql_console\.css\?v=/);
  }
});

test("the SQL Server console owns connection profile editing", () => {
  const html = read("../ui/arcode/sql-server-console/index.html");
  const dialog = read("../ui/arcode/sql-server-console/connections.js");
  const snowflakeHtml = read("../ui/arcode/snowflake-console/index.html");

  for (const id of [
    "manageConnectionsBtn",
    "connectionsBackdrop",
    "connectionList",
    "newConnectionBtn",
    "fieldName",
    "fieldServer",
    "fieldDatabase",
    "fieldAuthentication",
    "fieldDefault",
    "saveConnectionBtn",
    "deleteConnectionBtn",
  ]) {
    assert.ok(html.includes(`id="${id}"`), `SQL Server console defines #${id}`);
  }

  // Windows authentication is the only wired-up mode, so the form offers no other.
  const authSelect = html.match(/<select id="fieldAuthentication"[\s\S]*?<\/select>/)?.[0] || "";
  assert.match(authSelect, /value="windows"/);
  assert.equal((authSelect.match(/<option/g) || []).length, 1);

  // No credential field exists anywhere on the page or in its client.
  assert.doesNotMatch(html, /type="password"/);
  assert.doesNotMatch(dialog, /password/i);

  assert.match(dialog, /"\/sqlserver\/connections"/);
  assert.match(dialog, /"\/sqlserver\/connections\/delete"/);
  // An edit posts the profile it started from, so a rename moves it in place.
  assert.match(dialog, /connection: editingName/);

  // Snowflake profiles stay read-only in this change.
  assert.doesNotMatch(snowflakeHtml, /id="manageConnectionsBtn"/);
});

test("the Arcode shell routes engine-named .sql files to their console", () => {
  const shell = read("../ui/arcode/main.js");

  assert.match(shell, /function isSqlServerSqlPath\(pathLike\)/);
  assert.match(shell, /name\.includes\("sql_server"\)/);
  assert.match(shell, /name\.includes\("mssql"\)/);
  assert.match(shell, /name\.endsWith\("\.ms\.sql"\)/);
  // Snowflake still wins for a file that names both engines.
  assert.match(shell, /if \(getPathExtension\(pathLike\) !== "\.sql" \|\| isSnowflakeSqlPath\(pathLike\)\) return false;/);
  assert.match(shell, /if \(isSnowflakeSqlPath\(filePath\)\) return "snowflake";\s*\n\s*if \(isSqlServerSqlPath\(filePath\)\) return "sqlserver";/);

  // Both console tab types share one frame builder and one open-path message.
  assert.match(shell, /function isSqlConsoleTabType\(tabType\)/);
  assert.match(shell, /tab\.type === "sqlserver" \? "sql-server-console" : "snowflake-console"/);
  assert.match(shell, /type: "arcode:sql-console-open-path"/);
  assert.doesNotMatch(shell, /arcode:snowflake-open-path/);

  const core = read("../ui/arcode/shared/sql_console.js");
  assert.match(core, /msg\.type === "arcode:sql-console-open-path"/);
});
