<#
.SYNOPSIS
Deploys the build-share launcher scripts from the repository to the build share.

.DESCRIPTION
`frontend\build\build_share` is the canonical copy of the scripts that live in the
build share and are launched by hand on the source PC and the build PC. They cannot
run from the repository: the build share is the one path both PCs agree on, and the
listener resolves its request folders from its own location. So the repository holds
the source of truth and this script publishes it.

Deploying copies only what differs. A share file that differs and is newer than the
repository copy is treated as an edit made directly in the share: it is reported and
left alone unless -Force is given, so local work is never silently overwritten.

Use -Verify in a check to detect drift without writing anything. Files in the share
that this script does not own, such as the build artifacts, logs, and request folders,
are never touched or removed.
#>
[CmdletBinding()]
param(
    [string]$ShareRoot = "E:\XWSpace\Build ArcRho App",

    [switch]$Verify,

    [switch]$Force
)

$ErrorActionPreference = "Stop"

$sourceDirectory = Join-Path $PSScriptRoot "build_share"
if (-not (Test-Path -LiteralPath $sourceDirectory -PathType Container)) {
    throw "Canonical build-share directory not found: $sourceDirectory"
}

$sourceFiles = @(Get-ChildItem -LiteralPath $sourceDirectory -File | Sort-Object Name)
if ($sourceFiles.Count -eq 0) {
    throw "No launcher scripts found in $sourceDirectory."
}

if (-not (Test-Path -LiteralPath $ShareRoot -PathType Container)) {
    if ($Verify) {
        throw "Build share not found: $ShareRoot"
    }
    New-Item -ItemType Directory -Path $ShareRoot -Force | Out-Null
}

Write-Host "Canonical source: $sourceDirectory"
Write-Host "Build share:      $ShareRoot"
Write-Host ""

$driftCount = 0
$updatedCount = 0
$blockedCount = 0

foreach ($sourceFile in $sourceFiles) {
    $targetPath = Join-Path $ShareRoot $sourceFile.Name
    $sourceHash = (Get-FileHash -LiteralPath $sourceFile.FullName -Algorithm SHA256).Hash

    if (-not (Test-Path -LiteralPath $targetPath -PathType Leaf)) {
        $driftCount++
        if ($Verify) {
            Write-Host ("  missing   {0}" -f $sourceFile.Name)
            continue
        }
        Copy-Item -LiteralPath $sourceFile.FullName -Destination $targetPath -Force
        $updatedCount++
        Write-Host ("  deployed  {0}" -f $sourceFile.Name)
        continue
    }

    $targetFile = Get-Item -LiteralPath $targetPath
    if ((Get-FileHash -LiteralPath $targetPath -Algorithm SHA256).Hash -eq $sourceHash) {
        Write-Host ("  current   {0}" -f $sourceFile.Name)
        continue
    }

    $driftCount++
    $shareIsNewer = $targetFile.LastWriteTimeUtc -gt $sourceFile.LastWriteTimeUtc

    if ($Verify) {
        $reason = if ($shareIsNewer) { "differs, and the share copy is newer" } else { "differs" }
        Write-Host ("  drift     {0} ({1})" -f $sourceFile.Name, $reason)
        continue
    }

    if ($shareIsNewer -and -not $Force) {
        $blockedCount++
        Write-Warning ("Skipped {0}: the share copy is newer than the repository copy. Copy that edit back into build_share, or rerun with -Force to overwrite it." -f $sourceFile.Name)
        continue
    }

    Copy-Item -LiteralPath $sourceFile.FullName -Destination $targetPath -Force
    $updatedCount++
    Write-Host ("  deployed  {0}" -f $sourceFile.Name)
}

Write-Host ""

if ($Verify) {
    if ($driftCount -gt 0) {
        throw "$driftCount build-share script(s) differ from the repository. Run deploy_build_share.bat to publish them."
    }
    Write-Host "The build share matches the repository."
    exit 0
}

if ($blockedCount -gt 0) {
    throw "$blockedCount build-share script(s) were left alone because the share copy is newer."
}

if ($updatedCount -eq 0) {
    Write-Host "The build share already matches the repository. Nothing to deploy."
    exit 0
}

Write-Host "Deployed $updatedCount build-share script(s)."
Write-Host "Restart build_app_listener.bat if the listener script changed; it loads its script once at start."
exit 0
