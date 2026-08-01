import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const readText = (relativePath) => fs.readFileSync(
  new URL(relativePath, import.meta.url),
  "utf8"
);

test("Arcode packaging derives every Windows icon from the canonical v8 SVG", () => {
  const config = JSON.parse(readText("../electron-builder.arcode.json"));
  const expectedIcon = "build/generated/arcode-icons/icon.ico";

  assert.equal(config.win.icon, expectedIcon);
  assert.equal(config.nsis.installerIcon, expectedIcon);
  assert.equal(config.nsis.uninstallerIcon, expectedIcon);
  assert.equal(config.nsis.installerHeaderIcon, expectedIcon);

  const packageJson = JSON.parse(readText("../package.json"));
  for (const scriptName of ["build:arcode:icons", "build:arcode:electron", "build:arcode"]) {
    assert.match(
      packageJson.scripts[scriptName],
      /convert_icon\.js icons\/icon_wing_geo_v8\.svg build\/generated\/arcode-icons/
    );
  }
});

test("standalone Arcode selects its existing branded splash", () => {
  const mainSource = readText("../electron/main.js");
  const splashSource = readText("../ui/arcode/splash.html");

  assert.match(
    mainSource,
    /APP_MODE === "arcode"[\s\S]*path\.join\(APP_ROOT, "ui", "arcode", "splash\.html"\)/
  );
  assert.match(splashSource, /\.\.\/\.\.\/icons\/icon_wing_geo_v8\.svg/);
  assert.match(splashSource, /<h1 class="app-title">Arcode<\/h1>/);
  assert.match(
    splashSource,
    /new URLSearchParams\(window\.location\.search\)\.get\('version'\)/
  );
});
