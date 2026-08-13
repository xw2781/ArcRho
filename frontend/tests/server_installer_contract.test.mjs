import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";


const frontendInstaller = fs.readFileSync(
  new URL("../build/installer.nsh", import.meta.url),
  "utf8"
);
const detector = fs.readFileSync(
  new URL("../build/detect_arcrho_server_root.ps1", import.meta.url),
  "utf8"
);
const serverInstaller = fs.readFileSync(
  new URL("../../data-engine/server-installer/server_installer.nsi", import.meta.url),
  "utf8"
);
const releaseBuilder = fs.readFileSync(
  new URL("../../data-engine/server-installer/build_release.py", import.meta.url),
  "utf8"
);


test("desktop setup reads the configured workspace before drive-name scanning", () => {
  const configuredCall = frontendInstaller.indexOf(
    "Call ArcRho_DetectConfiguredServerRoot"
  );
  const driveScan = frontendInstaller.indexOf(
    '!insertmacro ArcRho_CheckServerRoot "C:"',
    configuredCall
  );
  assert.ok(configuredCall >= 0);
  assert.ok(driveScan > configuredCall);
  assert.match(
    frontendInstaller,
    /SetOutPath "\$PLUGINSDIR"[\s\S]*File \/oname=detect_arcrho_server_root\.ps1/
  );
  assert.match(detector, /workspace_paths\.json/);
  assert.match(detector, /\.workspace_root/);
  assert.match(detector, /Test-Path -LiteralPath \$root -PathType Container/);
});


test("desktop setup starts only an already-installed local deployment", () => {
  assert.match(
    frontendInstaller,
    /Function ArcRho_DetectDataEngineInstalled[\s\S]*ArcRho Launcher\\ArcRho Launcher\.exe/
  );
  assert.match(
    frontendInstaller,
    /\$ArcRhoServerRootIsLocal == "1"[\s\S]*\$ArcRhoDataEngineInstalled == "1"[\s\S]*NSD_Check/
  );
  assert.match(frontendInstaller, /Use ArcRho Server Components Setup on the host PC/);
  assert.match(frontendInstaller, /Server binaries are delivered separately/);
  assert.doesNotMatch(frontendInstaller, /ArcRhoServerPayload|payload-manifest\.json/);
});


test("server setup delegates mutation to the frozen transactional helper", () => {
  assert.match(releaseBuilder, /ArcRho-Server-Setup-\{version\}\.exe/);
  assert.match(
    serverInstaller,
    /\\d\\d\.exe" auto --root "\$WorkspaceRoot" --payload/
  );
  assert.match(
    serverInstaller,
    /\\d\\d\.exe" uninstall --root "\$WorkspaceRoot"/
  );
  assert.match(serverInstaller, /WriteUninstaller/);
  assert.match(serverInstaller, /Shared workspace data was preserved/);
  assert.doesNotMatch(serverInstaller, /RMDir \/r "\$WorkspaceRoot/);
});


test("server release staging builds every component without live deployment", () => {
  assert.match(releaseBuilder, /environment\["ARCRHO_STAGE_ONLY"\] = "1"/);
  assert.match(releaseBuilder, /build_manifest\(version, component_roots\)/);
  assert.match(releaseBuilder, /ArcRho-Server-Setup-\{version\}\.exe/);
  assert.match(releaseBuilder, /version != current_version/);
  assert.match(releaseBuilder, /payload_copy_ignore/);
  assert.match(releaseBuilder, /__pycache__/);
  assert.match(releaseBuilder, /migration/);
});
