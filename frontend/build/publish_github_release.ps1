param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath,

    [string]$ReleaseNotes = "",

    [string]$ReleaseNotesPath = "",

    [ValidateSet("ArcRho", "Arcode")]
    [string]$ProductName = "ArcRho",

    [string]$Repo = "xw2781/ArcRho",

    [switch]$Mandatory,

    [switch]$Prerelease
)

$ErrorActionPreference = "Stop"

Get-Command gh -ErrorAction Stop | Out-Null

$resolvedInstaller = Resolve-Path -LiteralPath $InstallerPath
$installerFile = Get-Item -LiteralPath $resolvedInstaller.Path
if (-not $installerFile.Name.StartsWith("$ProductName-Setup-") -or -not $installerFile.Name.EndsWith(".exe")) {
    throw "Installer must be named like $ProductName-Setup-<version>.exe."
}

$escapedProductName = [regex]::Escape($ProductName)
$versionMatch = [regex]::Match($installerFile.Name, "^$escapedProductName-Setup-(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)\.exe$")
if (-not $versionMatch.Success) {
    throw "Could not infer a semantic version from $($installerFile.Name)."
}

$version = $versionMatch.Groups[1].Value
$tag = "$ProductName-v$version"

if ($ReleaseNotesPath) {
    $resolvedReleaseNotes = Resolve-Path -LiteralPath $ReleaseNotesPath
    $ReleaseNotes = Get-Content -LiteralPath $resolvedReleaseNotes.Path -Raw
}

$hash = (Get-FileHash -LiteralPath $installerFile.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
$hashFile = Join-Path ([System.IO.Path]::GetTempPath()) "$($installerFile.Name).sha256"
"$hash  $($installerFile.Name)" | Set-Content -LiteralPath $hashFile -Encoding ASCII

$notesFile = Join-Path ([System.IO.Path]::GetTempPath()) "$($installerFile.Name).notes.md"
$notesBody = if ($ReleaseNotes) { $ReleaseNotes } else { "$ProductName $version" }
if ($Mandatory) {
    $notesBody = "$notesBody`n`nmandatory: true"
}
$notesBody | Set-Content -LiteralPath $notesFile -Encoding UTF8

Write-Host "Publishing $ProductName $version to GitHub Releases:"
Write-Host "  Repo:      $Repo"
Write-Host "  Tag:       $tag"
Write-Host "  Installer: $($installerFile.FullName)"
Write-Host "  Checksum:  $hashFile"

$releaseExists = $true
try {
    gh release view $tag --repo $Repo | Out-Null
} catch {
    $releaseExists = $false
}

if (-not $releaseExists) {
    $createArgs = @(
        "release", "create", $tag,
        $installerFile.FullName, $hashFile,
        "--repo", $Repo,
        "--title", "$ProductName $version",
        "--notes-file", $notesFile
    )
    if ($Prerelease) { $createArgs += "--prerelease" }
    gh @createArgs
    if ($LASTEXITCODE -ne 0) { throw "gh release create failed with exit code $LASTEXITCODE." }
} else {
    gh release upload $tag $installerFile.FullName $hashFile --repo $Repo --clobber
    if ($LASTEXITCODE -ne 0) { throw "gh release upload failed with exit code $LASTEXITCODE." }
    gh release edit $tag --repo $Repo --title "$ProductName $version" --notes-file $notesFile
    if ($LASTEXITCODE -ne 0) { throw "gh release edit failed with exit code $LASTEXITCODE." }
}

Remove-Item -LiteralPath $hashFile, $notesFile -Force -ErrorAction SilentlyContinue

Write-Host "Published $ProductName $version to https://github.com/$Repo/releases/tag/$tag"
