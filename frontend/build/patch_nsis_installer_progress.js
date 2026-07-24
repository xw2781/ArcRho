const fs = require("fs");
const path = require("path");

const projectDir = path.resolve(__dirname, "..");
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

const compressorPatched = patchFile(nsisTargetPath, (original) => {
  const disabled = "const USE_NSIS_BUILT_IN_COMPRESSOR = false;";
  const enabled = "const USE_NSIS_BUILT_IN_COMPRESSOR = true;";

  if (original.includes(enabled)) {
    return original;
  }

  if (!original.includes(disabled)) {
    throw new Error(
      "electron-builder NSIS target has an unexpected compressor setting; refusing to patch it."
    );
  }

  return original.replace(disabled, enabled);
});

const detailsPatched = patchFile(installSectionPath, (original) => {
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
});

if (compressorPatched) {
  console.log("Enabled ArcRho NSIS built-in installer progress.");
} else {
  console.log("ArcRho NSIS built-in installer progress is already enabled.");
}

if (detailsPatched) {
  console.log("Kept NSIS install details separate and user-expandable.");
} else {
  console.log("NSIS install details are already separate and user-expandable.");
}
