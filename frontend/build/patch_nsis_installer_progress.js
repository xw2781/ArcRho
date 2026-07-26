const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const projectDir = path.resolve(__dirname, "..");
const progressHelperSourcePath = path.join(
  projectDir,
  "build",
  "installer_progress_helper.cs"
);
const progressHelperOutputPath = path.join(
  projectDir,
  "build",
  "generated",
  "ArcRhoInstallerProgress.exe"
);
const nsisTargetPath = path.join(
  projectDir,
  "node_modules",
  "app-builder-lib",
  "out",
  "targets",
  "nsis",
  "NsisTarget.js"
);
const installSectionPath = path.join(
  projectDir,
  "node_modules",
  "app-builder-lib",
  "templates",
  "nsis",
  "installSection.nsh"
);
const extractAppPackagePath = path.join(
  projectDir,
  "node_modules",
  "app-builder-lib",
  "templates",
  "nsis",
  "include",
  "extractAppPackage.nsh"
);
const installerTemplatePath = path.join(
  projectDir,
  "node_modules",
  "app-builder-lib",
  "templates",
  "nsis",
  "include",
  "installer.nsh"
);

function patchFile(filePath, applyPatch) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`electron-builder file was not found: ${filePath}`);
  }

  const original = fs.readFileSync(filePath, "utf8");
  const updated = applyPatch(original);
  if (updated === original) {
    return false;
  }

  const backupPath = `${filePath}.arcrho-original`;
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(filePath, backupPath);
  }

  fs.writeFileSync(filePath, updated, "utf8");
  return true;
}

function patchCompressorSource(original) {
  const disabled = "const USE_NSIS_BUILT_IN_COMPRESSOR = false;";
  const enabled = "const USE_NSIS_BUILT_IN_COMPRESSOR = true;";
  const modeAware =
    'const USE_NSIS_BUILT_IN_COMPRESSOR = process.env.ARCRHO_APP_MODE === "arcode";';

  if (original.includes(enabled)) {
    return original;
  }

  if (original.includes(modeAware)) {
    return original.replace(modeAware, enabled);
  }

  if (original.includes(disabled)) {
    return original.replace(disabled, enabled);
  }

  throw new Error(
    "electron-builder NSIS target has an unexpected compressor setting; refusing to patch it."
  );
}

function patchDetailsSource(original) {
  const quietBlock = [
    "${IfNot} ${Silent}",
    "  SetDetailsPrint none",
    "${endif}",
  ].join("\n");
  const legacyDetailBlock = [
    "${IfNot} ${Silent}",
    "  SetDetailsPrint both",
    "  SetDetailsView show",
    "  DetailPrint \"Preparing destination and installing ArcRho files...\"",
    "${endif}",
  ].join("\n");
  const forcedOpenDetailBlock = [
    "${IfNot} ${Silent}",
    "  SetDetailsPrint listonly",
    "  SetDetailsView show",
    "${endif}",
  ].join("\n");
  const detailBlock = [
    "${IfNot} ${Silent}",
    "  SetDetailsPrint listonly",
    "${endif}",
  ].join("\n");

  if (original.includes(detailBlock)) {
    return original;
  }

  if (original.includes(forcedOpenDetailBlock)) {
    return original.replace(forcedOpenDetailBlock, detailBlock);
  }

  if (original.includes(legacyDetailBlock)) {
    return original.replace(legacyDetailBlock, detailBlock);
  }

  if (!original.includes(quietBlock)) {
    throw new Error(
      "electron-builder NSIS install section has an unexpected details block; refusing to patch it."
    );
  }

  return original.replace(quietBlock, detailBlock);
}

function restoreExtractionSource(original) {
  const standardExtraction = '  Nsis7z::Extract "${FILE}"';
  const callbackExtraction =
    /  !ifmacrodef ArcRho_ExtractWithProgress\r?\n    !insertmacro ArcRho_ExtractWithProgress "\$\{FILE\}"\r?\n  !else\r?\n    Nsis7z::Extract "\$\{FILE\}"\r?\n  !endif/;
  const newline = original.includes("\r\n") ? "\r\n" : "\n";

  function restoreCallback(source) {
    const restored = source.replace(callbackExtraction, standardExtraction);
    if (restored.includes("ArcRho_ExtractWithProgress")) {
      throw new Error(
        "electron-builder NSIS extraction template still contains an ArcRho callback; refusing to continue."
      );
    }
    return restored;
  }

  // Migrate the incomplete local PowerShell experiment that predated the
  // tracked patcher. Check this first because its retry path still contains
  // a standard Nsis7z call that must not be mistaken for the primary path.
  const legacyStart = original.indexOf("!macro ArcRho_SetProgress VALUE");
  const retryMarker = original.indexOf("  # Retry counter", legacyStart);
  if (legacyStart >= 0 && retryMarker > legacyStart) {
    const callbackPrelude = [
      "!macro extractUsing7za FILE",
      "  Push $OUTDIR",
      '  CreateDirectory "$PLUGINSDIR\\7z-out"',
      "  ClearErrors",
      '  SetOutPath "$PLUGINSDIR\\7z-out"',
      standardExtraction,
      "  Pop $R0",
      "  SetOutPath $R0",
      "",
    ].join(newline);
    const retryTail = restoreCallback(original.slice(retryMarker));
    const restored =
      original.slice(0, legacyStart) +
      callbackPrelude +
      retryTail;
    if (restored.includes("ArcRho_ExtractWithProgress")) {
      throw new Error(
        "electron-builder NSIS extraction template still contains an ArcRho callback; refusing to continue."
      );
    }
    return restored;
  }

  if (callbackExtraction.test(original)) {
    return restoreCallback(original);
  }

  if (original.includes("ArcRho_ExtractWithProgress")) {
    throw new Error(
      "electron-builder NSIS extraction template contains an unrecognized ArcRho callback; refusing to continue."
    );
  }

  if (original.includes(standardExtraction)) {
    return original;
  }

  throw new Error(
    "electron-builder NSIS extraction template has an unexpected extraction block; refusing to restore it."
  );
}

function validateBuiltInInstallerPath(nsisTargetSource, installerSource) {
  const normalizedTarget = nsisTargetSource.replace(/\r\n/g, "\n");
  const normalizedInstaller = installerSource.replace(/\r\n/g, "\n");
  const appBuildDirBranch = [
    "else if (USE_NSIS_BUILT_IN_COMPRESSOR && archs.size === 1) {",
    "            defines.APP_BUILD_DIR = archs.get(archs.keys().next().value);",
  ].join("\n");
  const nativeFileBranch = [
    "  !ifdef APP_BUILD_DIR",
    '    File /r "${APP_BUILD_DIR}\\*.*"',
  ].join("\n");

  if (
    !normalizedTarget.includes(
      "const USE_NSIS_BUILT_IN_COMPRESSOR = true;"
    )
    || !normalizedTarget.includes(appBuildDirBranch)
    || !normalizedInstaller.includes(nativeFileBranch)
  ) {
    throw new Error(
      "electron-builder no longer exposes the expected APP_BUILD_DIR / File /r installation path; refusing to build an installer with unverified progress behavior."
    );
  }
}

function findCSharpCompiler() {
  const windowsDirectory = process.env.WINDIR || process.env.SystemRoot;
  if (!windowsDirectory) {
    throw new Error("Windows directory is unavailable; cannot locate csc.exe.");
  }

  const candidates = [
    path.join(
      windowsDirectory,
      "Microsoft.NET",
      "Framework",
      "v4.0.30319",
      "csc.exe"
    ),
    path.join(
      windowsDirectory,
      "Microsoft.NET",
      "Framework64",
      "v4.0.30319",
      "csc.exe"
    ),
  ];
  const compilerPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!compilerPath) {
    throw new Error(
      "The .NET Framework 4 C# compiler was not found; cannot build the installer progress observer."
    );
  }
  return compilerPath;
}

function compileProgressHelper(outputPath = progressHelperOutputPath) {
  if (!fs.existsSync(progressHelperSourcePath)) {
    throw new Error(
      `Installer progress observer source was not found: ${progressHelperSourcePath}`
    );
  }

  const compilerPath = findCSharpCompiler();
  const outputDirectory = path.dirname(outputPath);
  const temporaryDirectory = path.join(
    outputDirectory,
    `.csc-temp-${process.pid}`
  );
  const temporaryOutputPath = path.join(
    outputDirectory,
    `.ArcRhoInstallerProgress-${process.pid}.exe`
  );

  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.rmSync(outputPath, { force: true });
  fs.rmSync(temporaryOutputPath, { force: true });
  fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  fs.mkdirSync(temporaryDirectory, { recursive: true });

  let result;
  try {
    result = spawnSync(
      compilerPath,
      [
        "/nologo",
        "/target:winexe",
        "/platform:x86",
        "/optimize+",
        "/debug-",
        `/out:${temporaryOutputPath}`,
        progressHelperSourcePath,
      ],
      {
        cwd: projectDir,
        encoding: "utf8",
        env: {
          ...process.env,
          TEMP: temporaryDirectory,
          TMP: temporaryDirectory,
        },
        shell: false,
        windowsHide: true,
      }
    );
  } finally {
    fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  }

  if (
    result.error ||
    result.status !== 0 ||
    !fs.existsSync(temporaryOutputPath) ||
    fs.statSync(temporaryOutputPath).size === 0
  ) {
    fs.rmSync(temporaryOutputPath, { force: true });
    const compilerOutput = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(
      `Failed to compile the installer progress observer.${
        compilerOutput ? `\n${compilerOutput}` : ""
      }`,
      { cause: result.error }
    );
  }

  fs.renameSync(temporaryOutputPath, outputPath);
  return outputPath;
}

function main() {
  let helperPath = null;
  if (process.env.ARCRHO_APP_MODE !== "arcode") {
    helperPath = compileProgressHelper();
  }

  const compressorPatched = patchFile(nsisTargetPath, patchCompressorSource);
  const detailsPatched = patchFile(installSectionPath, patchDetailsSource);
  const extractionRestored = patchFile(
    extractAppPackagePath,
    restoreExtractionSource
  );
  validateBuiltInInstallerPath(
    fs.readFileSync(nsisTargetPath, "utf8"),
    fs.readFileSync(installerTemplatePath, "utf8")
  );

  if (compressorPatched) {
    console.log("Restored ArcRho NSIS built-in installer progress.");
  } else {
    console.log("ArcRho NSIS built-in installer progress is already enabled.");
  }

  if (detailsPatched) {
    console.log("Kept NSIS install details separate from the progress caption.");
  } else {
    console.log("NSIS install details are already separate from the progress caption.");
  }

  if (extractionRestored) {
    console.log("Removed the obsolete ArcRho 7-Zip progress callback.");
  } else {
    console.log("Electron-builder's standard extraction fallback is intact.");
  }

  if (helperPath) {
    console.log(`Built the native-bar progress observer: ${helperPath}`);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  patchCompressorSource,
  patchDetailsSource,
  restoreExtractionSource,
  validateBuiltInInstallerPath,
  findCSharpCompiler,
  compileProgressHelper,
};
