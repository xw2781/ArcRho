param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath,

    [string]$FeedDir = "E:\ArcRho Server\installer",

    [string]$ReleaseNotes = "",

    [switch]$Mandatory
)

$ErrorActionPreference = "Stop"

$resolvedInstaller = Resolve-Path -LiteralPath $InstallerPath
$installerFile = Get-Item -LiteralPath $resolvedInstaller.Path
if (-not $installerFile.Name.StartsWith("ArcRho-Setup-") -or -not $installerFile.Name.EndsWith(".exe")) {
    throw "Installer must be named like ArcRho-Setup-<version>.exe."
}

$versionMatch = [regex]::Match($installerFile.Name, '^ArcRho-Setup-(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)\.exe$')
if (-not $versionMatch.Success) {
    throw "Could not infer a semantic version from $($installerFile.Name)."
}

$version = $versionMatch.Groups[1].Value
New-Item -ItemType Directory -Path $FeedDir -Force | Out-Null

$targetInstaller = Join-Path $FeedDir $installerFile.Name
Copy-Item -LiteralPath $installerFile.FullName -Destination $targetInstaller -Force

$hash = (Get-FileHash -LiteralPath $targetInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
$hashFile = "$targetInstaller.sha256"
"$hash  $($installerFile.Name)" | Set-Content -LiteralPath $hashFile -Encoding ASCII

$manifest = [ordered]@{
    version = $version
    installer = $installerFile.Name
    sha256 = $hash
    releaseNotes = $ReleaseNotes
    mandatory = [bool]$Mandatory
    publishedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
}

$manifestPath = Join-Path $FeedDir "latest.json"
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

Write-Host "Published ArcRho $version update feed:"
Write-Host "  $targetInstaller"
Write-Host "  $hashFile"
Write-Host "  $manifestPath"
