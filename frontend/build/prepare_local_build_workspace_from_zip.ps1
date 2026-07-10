param(
    [Parameter(Mandatory = $true)]
    [string]$SourceZip,

    [Parameter(Mandatory = $true)]
    [string]$Destination
)

$ErrorActionPreference = "Stop"

function Resolve-FullPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $executionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
}

function Expand-BuildArchive {
    param(
        [Parameter(Mandatory = $true)][string]$ArchivePath,
        [Parameter(Mandatory = $true)][string]$DestinationPath
    )

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem

    $destinationRoot = [System.IO.Path]::GetFullPath($DestinationPath).TrimEnd("\", "/") + [System.IO.Path]::DirectorySeparatorChar
    $archive = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
    $skippedEntryCount = 0

    try {
        foreach ($entry in $archive.Entries) {
            $normalizedEntryPath = $entry.FullName.Replace("\", "/")
            $entryPath = $normalizedEntryPath.Replace("/", "\")

            # Build workspaces do not need repository or agent metadata. In
            # particular, Codex checkpoint refs under .git can exceed the
            # Windows PowerShell 5.1 path-length limit.
            if ($normalizedEntryPath -match '^(?:[^/]+/)?\.(?:git|agents|codex)(?:/|$)') {
                $skippedEntryCount++
                continue
            }

            $targetPath = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($destinationRoot, $entryPath))
            if (-not $targetPath.StartsWith($destinationRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "Archive entry escapes the extraction directory: $($entry.FullName)"
            }

            if ($normalizedEntryPath.EndsWith("/")) {
                [System.IO.Directory]::CreateDirectory($targetPath) | Out-Null
                continue
            }

            $parentDirectory = [System.IO.Path]::GetDirectoryName($targetPath)
            [System.IO.Directory]::CreateDirectory($parentDirectory) | Out-Null
            [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $targetPath, $false)
        }
    }
    finally {
        $archive.Dispose()
    }

    Write-Host "Skipped $skippedEntryCount repository metadata ZIP entries."
}

$SourceZip = Resolve-FullPath $SourceZip
$Destination = Resolve-FullPath $Destination

if (-not (Test-Path -LiteralPath $SourceZip -PathType Leaf)) {
    throw "Source ZIP not found: $SourceZip"
}

if (Test-Path -LiteralPath $Destination) {
    $destinationInfo = Get-Item -LiteralPath $Destination -Force
    if (-not $destinationInfo.PSIsContainer) {
        throw "Destination exists but is not a directory: $Destination"
    }

    $destinationRoot = [System.IO.Path]::GetPathRoot($destinationInfo.FullName).TrimEnd("\", "/")
    $destinationFullName = $destinationInfo.FullName.TrimEnd("\", "/")
    if (
        $destinationFullName.Equals($destinationRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
        $destinationFullName.Length -lt 10
    ) {
        throw "Refusing to clean unsafe destination: $Destination"
    }

    Write-Host "Deleting existing local build workspace: $Destination"
    Remove-Item -LiteralPath $Destination -Recurse -Force
}

Write-Host "Preparing local ArcRho build workspace from ZIP"
Write-Host "Source ZIP:  $SourceZip"
Write-Host "Destination: $Destination"
Write-Host ""

New-Item -ItemType Directory -Force -Path $Destination | Out-Null

$localZip = Join-Path $Destination ([System.IO.Path]::GetFileName($SourceZip))
Write-Host "Copying $SourceZip -> $localZip"
Copy-Item -LiteralPath $SourceZip -Destination $localZip -Force

$extractDir = Join-Path $Destination "_zip_extract"
New-Item -ItemType Directory -Force -Path $extractDir | Out-Null

Write-Host "Expanding $localZip -> $extractDir"
Expand-BuildArchive -ArchivePath $localZip -DestinationPath $extractDir

$candidates = @($extractDir) + @(Get-ChildItem -LiteralPath $extractDir -Directory -Force | ForEach-Object { $_.FullName })
$repoRoot = $candidates |
    Where-Object { Test-Path -LiteralPath (Join-Path $_ "frontend\build\build_app.bat") -PathType Leaf } |
    Select-Object -First 1

if (-not $repoRoot) {
    throw "Extracted ZIP does not look like the ArcRho repository root."
}

Write-Host "Using extracted repository root: $repoRoot"
Get-ChildItem -LiteralPath $repoRoot -Force | Move-Item -Destination $Destination -Force
Remove-Item -LiteralPath $extractDir -Recurse -Force

if (-not (Test-Path -LiteralPath (Join-Path $Destination "frontend\build\build_app.bat") -PathType Leaf)) {
    throw "Local build script was not found after extracting the ZIP."
}

Write-Host ""
Write-Host "Local build workspace is ready."
