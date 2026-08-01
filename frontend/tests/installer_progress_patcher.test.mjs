import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  patchCompressorSource,
  patchDetailsSource,
  restoreExtractionSource,
  validateBuiltInInstallerPath,
  findCSharpCompiler,
  compileProgressHelper,
} = require("../build/patch_nsis_installer_progress.js");

const BUILT_IN_COMPRESSOR =
  "const USE_NSIS_BUILT_IN_COMPRESSOR = true;";
const MODE_AWARE_COMPRESSOR =
  'const USE_NSIS_BUILT_IN_COMPRESSOR = process.env.ARCRHO_APP_MODE === "arcode";';
const installerSource = fs.readFileSync(
  new URL("../build/installer.nsh", import.meta.url),
  "utf8"
);
const arcodeInstallerSource = fs.readFileSync(
  new URL("../build/arcode_installer.nsh", import.meta.url),
  "utf8"
);
const helperSource = fs.readFileSync(
  new URL("../build/installer_progress_helper.cs", import.meta.url),
  "utf8"
);
const patcherSource = fs.readFileSync(
  new URL("../build/patch_nsis_installer_progress.js", import.meta.url),
  "utf8"
);
const electronBuilderTargetSource = fs.readFileSync(
  new URL(
    "../node_modules/app-builder-lib/out/targets/nsis/NsisTarget.js",
    import.meta.url
  ),
  "utf8"
);
const electronBuilderInstallerSource = fs.readFileSync(
  new URL(
    "../node_modules/app-builder-lib/templates/nsis/include/installer.nsh",
    import.meta.url
  ),
  "utf8"
);

test("installer preserves native file progress and launches an isolated observer", () => {
  assert.match(
    installerSource,
    /!macro customHeader\s+ShowInstDetails hide\s+!macroend/
  );
  assert.match(
    installerSource,
    /File \/oname=\$PLUGINSDIR\\ArcRhoInstallerProgress\.exe/
  );
  assert.match(
    installerSource,
    /Exec '"\$PLUGINSDIR\\ArcRhoInstallerProgress\.exe" "\$HWNDPARENT" "\$0" "\$1" "\$2" "\$4" "\$5" "\$3"'/
  );
  assert.match(installerSource, /GetDlgItem \$4 \$0 1016/);
  assert.match(installerSource, /GetDlgItem \$5 \$0 1027/);
  assert.match(installerSource, /GetCurrentProcessId\(\) i\.r3/);
  assert.match(
    installerSource,
    /MUI_HEADER_TEXT "" "\$\(MUI_TEXT_INSTALLING_SUBTITLE\)"/
  );
  assert.doesNotMatch(installerSource, /Nsis7z::ExtractWithCallback/);
  assert.doesNotMatch(installerSource, /nsDialogs::(?:Create|Kill)Timer/);
  assert.doesNotMatch(
    installerSource,
    /Function ArcRho_InstFiles_UpdateProgressText/
  );
});

test("Arcode uses the same isolated native progress observer", () => {
  assert.match(
    arcodeInstallerSource,
    /File \/oname=\$PLUGINSDIR\\ArcRhoInstallerProgress\.exe/
  );
  assert.match(
    arcodeInstallerSource,
    /Exec '\"\$PLUGINSDIR\\ArcRhoInstallerProgress\.exe\" \"\$HWNDPARENT\" \"\$0\" \"\$1\" \"\$2\" \"\$4\" \"\$5\" \"\$3\"'/
  );
  assert.match(arcodeInstallerSource, /GetDlgItem \$4 \$0 1016/);
  assert.match(arcodeInstallerSource, /GetDlgItem \$5 \$0 1027/);
  assert.match(arcodeInstallerSource, /GetCurrentProcessId\(\) i\.r3/);
  assert.doesNotMatch(arcodeInstallerSource, /nsDialogs::(?:Create|Kill)Timer/);
  assert.doesNotMatch(
    arcodeInstallerSource,
    /Function Arcode_InstFiles_UpdateProgressText/
  );
  assert.doesNotMatch(arcodeInstallerSource, /StrCpy \$6 10/);
});

test("observer reads the native bar without re-entering the NSIS interpreter", () => {
  assert.match(helperSource, /PBM_GETRANGE = 0x0407/);
  assert.match(helperSource, /PBM_GETPOS = 0x0408/);
  assert.match(helperSource, /WM_SETTEXT = 0x000C/);
  assert.match(helperSource, /WM_GETTEXT = 0x000D/);
  assert.match(helperSource, /WM_NEXTDLGCTL = 0x0028/);
  assert.match(helperSource, /SendMessageTimeoutW/);
  assert.match(helperSource, /SendBufferMessageTimeout/);
  assert.match(helperSource, /PostWindowMessage/);
  assert.match(helperSource, /GetWindowThreadProcessId/);
  assert.match(helperSource, /IsChild\(installerWindow, pageWindow\)/);
  assert.match(helperSource, /MaximumConsecutiveMessageFailures = 20/);
  assert.match(helperSource, /consecutiveReadFailures/);
  assert.match(helperSource, /consecutiveWriteFailures/);
  assert.match(helperSource, /EtaUpdateIntervalSeconds = 5\.0/);
  assert.match(helperSource, /MaximumDisplayedEtaSeconds = 5\.0 \* 60\.0/);
  assert.match(
    helperSource,
    /HideDetailsText = "Hide details"/
  );
  assert.match(
    helperSource,
    /showDetailsText = ReadWindowText\(nativeDetailsButton\)/
  );
  assert.match(
    helperSource,
    /TrySetWindowText\(\s*nativeDetailsButton,\s*HideDetailsText\s*\)/
  );
  assert.match(
    helperSource,
    /TrySetWindowText\(\s*nativeDetailsButton,\s*showDetailsText\s*\)/
  );
  assert.match(helperSource, /ShouldExpandDetails\(/);
  assert.match(helperSource, /ShouldCollapseDetails\(/);
  assert.match(
    helperSource,
    /!IsWindowVisible\(nativeDetailsButton\)[\s\S]*RollBackExpansion\(\)/
  );
  assert.match(
    helperSource,
    /PostWindowMessage\(\s*installerWindow,\s*WM_NEXTDLGCTL,\s*nativeDetailsButton,\s*new IntPtr\(1\)/
  );
  assert.match(
    helperSource,
    /listRectangle\.Bottom\s+- collapsedButtonRectangle\.Height\s+- ListPadding/
  );
  assert.match(
    helperSource,
    /nativeDetailsButton,\s+IntPtr\.Zero,\s+listRectangle\.Left,\s+adjustedBottom \+ ListPadding/
  );
  assert.match(helperSource, /ShowWindow\(detailsListWindow, SW_HIDE\)/);
  assert.match(helperSource, /TryParsePointer\("-2147483648"/);
  assert.doesNotMatch(
    helperSource,
    /System\.Windows\.Forms|new Button|SetParent\(|Application\.DoEvents|GetWindowTextW/
  );
  assert.doesNotMatch(helperSource, /System\.Net|Http|WebClient/);
});

test("ArcRho and Arcode retain the built-in NSIS file installation path", () => {
  for (const currentValue of [
    "const USE_NSIS_BUILT_IN_COMPRESSOR = false;",
    BUILT_IN_COMPRESSOR,
    MODE_AWARE_COMPRESSOR,
  ]) {
    assert.equal(
      patchCompressorSource(currentValue),
      BUILT_IN_COMPRESSOR
    );
  }

  assert.doesNotThrow(() =>
    validateBuiltInInstallerPath(
      electronBuilderTargetSource,
      electronBuilderInstallerSource
    )
  );
  assert.throws(
    () =>
      validateBuiltInInstallerPath(
        electronBuilderTargetSource,
        electronBuilderInstallerSource.replace(
          'File /r "${APP_BUILD_DIR}\\*.*"',
          'File "${APP_BUILD_DIR}\\app.7z"'
        )
      ),
    /APP_BUILD_DIR \/ File \/r/
  );
});

test("install details remain list-only unless the user opens the panel", () => {
  const source = [
    "${IfNot} ${Silent}",
    "  SetDetailsPrint none",
    "${endif}",
  ].join("\n");
  const patched = patchDetailsSource(source);

  assert.match(patched, /SetDetailsPrint listonly/);
  assert.doesNotMatch(patched, /SetDetailsView show/);
  assert.equal(patchDetailsSource(patched), patched);
});

test("obsolete 7-Zip callback wrappers are restored to standard extraction", () => {
  for (const newline of ["\n", "\r\n"]) {
    const source = [
      "!macro extractUsing7za FILE",
      "  SetOutPath \"$PLUGINSDIR\\7z-out\"",
      "  !ifmacrodef ArcRho_ExtractWithProgress",
      "    !insertmacro ArcRho_ExtractWithProgress \"${FILE}\"",
      "  !else",
      "    Nsis7z::Extract \"${FILE}\"",
      "  !endif",
      "  Pop $R0",
      "",
      "  # Retry counter",
      "  Nsis7z::Extract \"${FILE}\"",
      "!macroend",
    ].join(newline);
    const restored = restoreExtractionSource(source);

    assert.doesNotMatch(restored, /ArcRho_ExtractWithProgress/);
    assert.equal(
      restored.match(/Nsis7z::Extract "\$\{FILE\}"/g)?.length,
      2
    );
    assert.equal(restoreExtractionSource(restored), restored);
  }
});

test("the incomplete legacy extraction experiment is removed", () => {
  const source = [
    "!macro ArcRho_SetProgress VALUE",
    "  DetailPrint \"legacy\"",
    "!macroend",
    "",
    "!macro extractUsing7za FILE",
    "  File \"installer_progress_extract.ps1\"",
    "  ArcRhoExtractProgressLoop:",
    "    Sleep 500",
    "",
    "  # Retry counter",
    "  StrCpy $R1 0",
    "  Nsis7z::Extract \"${FILE}\"",
    "!macroend",
  ].join("\n");
  const restored = restoreExtractionSource(source);

  assert.doesNotMatch(restored, /installer_progress_extract\.ps1/);
  assert.doesNotMatch(restored, /ArcRhoExtractProgressLoop/);
  assert.doesNotMatch(restored, /ArcRho_SetProgress/);
  assert.match(restored, /# Retry counter/);
});

test("observer compiler integration is available without running on import", () => {
  assert.equal(typeof findCSharpCompiler, "function");
  assert.equal(typeof compileProgressHelper, "function");
  assert.match(patcherSource, /const helperPath = compileProgressHelper\(\)/);
  assert.doesNotMatch(
    patcherSource,
    /ARCRHO_APP_MODE !== "arcode"[\s\S]*compileProgressHelper/
  );
});
