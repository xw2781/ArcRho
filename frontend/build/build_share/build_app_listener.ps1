[CmdletBinding()]
param(
    [switch]$Check,
    [ValidateRange(1, 60)]
    [int]$PollSeconds = 3
)

$ErrorActionPreference = "Stop"

$buildShareRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourceRepository = if ([string]::IsNullOrWhiteSpace($env:ARCRHO_SOURCE_REPOSITORY)) {
    "E:\XWSpace\Repos\ArcRho"
}
else {
    $env:ARCRHO_SOURCE_REPOSITORY
}
$sourceZipScript = Join-Path $sourceRepository "frontend\build\create_build_source_zip.bat"
$requestsDirectory = Join-Path $buildShareRoot "build_requests"
$responsesDirectory = Join-Path $buildShareRoot "build_responses"
$listenerLogDirectory = Join-Path $buildShareRoot "logs\build_app_listener"
$sourceZip = Join-Path $buildShareRoot "ArcRho.zip"
$sourceZipReady = "$sourceZip.ready"
$sourceZipHash = "$sourceZip.sha256"
$fragmentSnapshotDirectory = Join-Path $buildShareRoot "build_zip_fragments"
$syncScript = Join-Path $sourceRepository "frontend\build\release\sync_published_release.py"
$canonicalListener = Join-Path $sourceRepository "frontend\build\build_share\build_app_listener.ps1"
$mutexName = "Local\ArcRho.BuildAppListener.v1"
$zipFragmentPrefix = "frontend/changes/unreleased/"
$fragmentSnapshotsToKeep = 20

function Write-Response {
    param(
        [Parameter(Mandatory = $true)][string]$RequestId,
        [Parameter(Mandatory = $true)][string]$Status,
        [string]$Message = "",
        [string]$ReadySignal = "",
        [string]$Sha256 = ""
    )

    $responsePath = Join-Path $responsesDirectory "$RequestId.json"
    $temporaryPath = "$responsePath.$([Guid]::NewGuid().ToString('N')).tmp"
    $payload = [ordered]@{
        schemaVersion = 1
        requestId = $RequestId
        status = $Status
        completedAtUtc = [DateTime]::UtcNow.ToString("o")
        readySignal = $ReadySignal
        sha256 = $Sha256
        message = $Message
    }
    $json = ($payload | ConvertTo-Json -Depth 3 -Compress) + [Environment]::NewLine
    [System.IO.File]::WriteAllText($temporaryPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temporaryPath -Destination $responsePath -Force
}

function Test-DeployedListenerIsCurrent {
    <#
        PowerShell loads this script once at start, so a listener left running after a
        deploy keeps serving the previous version. Comparing the deployed copy with the
        repository copy at startup surfaces that instead of letting it cause confusion
        later. This only warns: a listener that is out of date is still usable.
    #>
    $deployedPath = $MyInvocation.ScriptName
    if ([string]::IsNullOrWhiteSpace($deployedPath)) {
        $deployedPath = $PSCommandPath
    }
    if (-not (Test-Path -LiteralPath $canonicalListener -PathType Leaf) -or
        -not (Test-Path -LiteralPath $deployedPath -PathType Leaf)) {
        return
    }
    if ([System.IO.Path]::GetFullPath($deployedPath) -eq [System.IO.Path]::GetFullPath($canonicalListener)) {
        return
    }

    $deployedHash = (Get-FileHash -LiteralPath $deployedPath -Algorithm SHA256).Hash
    $canonicalHash = (Get-FileHash -LiteralPath $canonicalListener -Algorithm SHA256).Hash
    if ($deployedHash -eq $canonicalHash) {
        Write-Host "Listener script matches the repository copy."
        return
    }

    Write-Warning "This listener does not match $canonicalListener."
    Write-Warning "Run frontend\build\deploy_build_share.bat on the source PC, then restart this listener."
}

function Save-ZipFragmentSnapshot {
    <#
        Records the changelog fragments this ZIP carries, keyed by its ready signal.
        The release that gets built from this ZIP consumes exactly these fragments, so
        capturing them now keeps a later sync correct even if another build has already
        replaced the ZIP by the time the sync runs.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$ReadySignal
    )

    if ($ReadySignal -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$') {
        Write-Warning "Skipping the fragment snapshot for an unusable ready signal."
        return
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $names = New-Object 'System.Collections.Generic.List[string]'
    $archive = [System.IO.Compression.ZipFile]::OpenRead($sourceZip)
    try {
        foreach ($entry in $archive.Entries) {
            $normalized = $entry.FullName.Replace("\", "/")
            $index = $normalized.IndexOf($zipFragmentPrefix)
            if ($index -lt 0) { continue }
            $name = $normalized.Substring($index + $zipFragmentPrefix.Length)
            if ($name -and $name -notmatch '/' -and $name.EndsWith(".json")) {
                $names.Add($name) | Out-Null
            }
        }
    }
    finally {
        $archive.Dispose()
    }

    New-Item -ItemType Directory -Force -Path $fragmentSnapshotDirectory | Out-Null
    $snapshotPath = Join-Path $fragmentSnapshotDirectory "$ReadySignal.json"
    $json = (ConvertTo-Json -InputObject @($names) -Depth 2) + [Environment]::NewLine
    [System.IO.File]::WriteAllText($snapshotPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "Captured $($names.Count) changelog fragment(s) for ZIP signal $ReadySignal."

    $stale = @(Get-ChildItem -LiteralPath $fragmentSnapshotDirectory -Filter "*.json" -File |
        Sort-Object LastWriteTimeUtc -Descending | Select-Object -Skip $fragmentSnapshotsToKeep)
    foreach ($file in $stale) {
        Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
    }
}

function Resolve-PythonExecutable {
    if (-not [string]::IsNullOrWhiteSpace($env:PYTHON_EXE)) {
        return $env:PYTHON_EXE
    }
    try {
        $resolved = & py -3.10 -c "import sys; print(sys.executable)"
        if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($resolved)) {
            return $resolved.Trim()
        }
    }
    catch {
        # Fall through to the plain interpreter below.
    }
    return "python"
}

function Invoke-ReleaseSync {
    <#
        Records a published release in the source repository. The build PC cannot do this
        itself: it builds from a disposable local workspace and the repository lives here.
    #>
    param(
        [Parameter(Mandatory = $true)]$Request
    )

    $version = [string]$Request.version
    if ($version -notmatch '^\d+\.\d+\.\d+$') {
        throw "Sync request carried an invalid version: '$version'."
    }
    $product = [string]$Request.product
    if ([string]::IsNullOrWhiteSpace($product)) { $product = "ArcRho" }
    if ($product -notin @("ArcRho", "Arcode")) {
        throw "Sync request carried an unsupported product: '$product'."
    }
    if (-not (Test-Path -LiteralPath $syncScript -PathType Leaf)) {
        throw "Repository sync script not found: $syncScript"
    }

    $arguments = @($syncScript, $version, "--product", $product, "--commit")

    $readySignal = [string]$Request.readySignal
    if ($readySignal -match '^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$') {
        $snapshotPath = Join-Path $fragmentSnapshotDirectory "$readySignal.json"
        if (Test-Path -LiteralPath $snapshotPath -PathType Leaf) {
            $arguments += @("--fragment-list", $snapshotPath)
        }
        else {
            Write-Warning "No fragment snapshot for ZIP signal $readySignal; falling back to the current ZIP."
        }
    }

    $pythonExecutable = Resolve-PythonExecutable
    Write-Host "Syncing the repository to $product $version."

    # Merging a native command's stderr while ErrorActionPreference is Stop turns every
    # stderr line into a terminating error, so the exit code below would never be read.
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $output = & $pythonExecutable @arguments 2>&1 | ForEach-Object { [string]$_ }
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }

    foreach ($line in $output) { Write-Host "  $line" }
    if ($LASTEXITCODE -ne 0) {
        $detail = ($output | Select-Object -Last 5) -join " "
        throw "The repository sync failed with exit code ${LASTEXITCODE}: $detail"
    }
    return "Repository synced to $product $version."
}

function Test-ListenerPrerequisites {
    $missing = @()
    if (-not (Test-Path -LiteralPath $sourceZipScript -PathType Leaf)) {
        $missing += "ZIP creator: $sourceZipScript"
    }
    if (-not (Test-Path -LiteralPath $sourceRepository -PathType Container)) {
        $missing += "source repository: $sourceRepository"
    }
    if ($missing.Count -gt 0) {
        throw "Missing listener prerequisite(s): $($missing -join '; ')"
    }
}

Test-ListenerPrerequisites

if ($Check) {
    Write-Host "ArcRho build-app listener prerequisites passed."
    Write-Host "Build share:        $buildShareRoot"
    Write-Host "Source repository:  $sourceRepository"
    Write-Host "Request directory:  $requestsDirectory"
    Write-Host "Response directory: $responsesDirectory"
    Write-Host "Canonical listener: $canonicalListener"
    Test-DeployedListenerIsCurrent
    exit 0
}

New-Item -ItemType Directory -Force -Path $requestsDirectory, $responsesDirectory, $listenerLogDirectory | Out-Null
$mutex = New-Object System.Threading.Mutex($false, $mutexName)
if (-not $mutex.WaitOne(0)) {
    Write-Host "An ArcRho build-app listener is already running on this PC."
    exit 0
}

$logPath = Join-Path $listenerLogDirectory ("listener_" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".log")
$transcriptStarted = $false
try {
    Start-Transcript -LiteralPath $logPath -Force | Out-Null
    $transcriptStarted = $true
    Write-Host "ArcRho build-app listener started."
    Test-DeployedListenerIsCurrent
    Write-Host "Listening for requests in: $requestsDirectory"
    Write-Host "Listener log: $logPath"

    while ($true) {
        $requestFiles = @(Get-ChildItem -LiteralPath $requestsDirectory -Filter "*.request" -File -ErrorAction Stop |
            Sort-Object LastWriteTimeUtc, Name)

        foreach ($requestFile in $requestFiles) {
            $requestId = [System.IO.Path]::GetFileNameWithoutExtension($requestFile.Name)
            if ($requestId -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$') {
                Write-Warning "Ignoring request with an invalid file name: $($requestFile.Name)"
                continue
            }

            $processingPath = Join-Path $requestsDirectory "$requestId.processing"
            try {
                Move-Item -LiteralPath $requestFile.FullName -Destination $processingPath -ErrorAction Stop
            }
            catch {
                continue
            }

            try {
                $request = Get-Content -LiteralPath $processingPath -Raw | ConvertFrom-Json
                if ($request.schemaVersion -ne 1 -or $request.requestId -ne $requestId) {
                    throw "Request payload is invalid or does not match its file name."
                }

                $kind = [string]$request.kind
                if ([string]::IsNullOrWhiteSpace($kind)) { $kind = "sourceZip" }

                if ($kind -eq "syncRelease") {
                    Write-Host "Processing release sync request $requestId from $($request.requestedBy)."
                    $syncMessage = Invoke-ReleaseSync -Request $request
                    Write-Response -RequestId $requestId -Status "succeeded" -Message $syncMessage
                    Write-Host "Release sync request $requestId completed successfully."
                    continue
                }
                if ($kind -ne "sourceZip") {
                    throw "Unsupported request kind: '$kind'."
                }

                Write-Host "Processing build request $requestId from $($request.requestedBy)."
                & $sourceZipScript
                if ($LASTEXITCODE -ne 0) {
                    throw "The source ZIP creator failed with exit code $LASTEXITCODE."
                }
                if (-not (Test-Path -LiteralPath $sourceZip -PathType Leaf) -or
                    -not (Test-Path -LiteralPath $sourceZipReady -PathType Leaf) -or
                    -not (Test-Path -LiteralPath $sourceZipHash -PathType Leaf)) {
                    throw "The source ZIP creator completed without publishing all required ZIP artifacts."
                }

                $readySignal = (Get-Content -LiteralPath $sourceZipReady -Raw).Trim()
                $sha256 = (Get-Content -LiteralPath $sourceZipHash -Raw).Trim()
                if ([string]::IsNullOrWhiteSpace($readySignal) -or [string]::IsNullOrWhiteSpace($sha256)) {
                    throw "The source ZIP creator published an empty completion signal or checksum."
                }

                # A snapshot failure must not fail a valid ZIP; the sync falls back to
                # reading the ZIP itself when no snapshot is available.
                try {
                    Save-ZipFragmentSnapshot -ReadySignal $readySignal
                }
                catch {
                    Write-Warning "Could not capture the changelog fragment snapshot: $($_.Exception.Message)"
                }

                Write-Response -RequestId $requestId -Status "succeeded" -Message "Source ZIP is ready." -ReadySignal $readySignal -Sha256 $sha256
                Write-Host "Build request $requestId completed successfully."
            }
            catch {
                # Write-Error is terminating while ErrorActionPreference is Stop, which
                # would kill the listener loop before the failure response is written and
                # leave the requester waiting on a response that never arrives.
                $message = $_.Exception.Message
                Write-Warning "Build request $requestId failed: $message"
                try {
                    Write-Response -RequestId $requestId -Status "failed" -Message $message
                }
                catch {
                    Write-Warning "Could not publish the failure response for request ${requestId}: $($_.Exception.Message)"
                }
            }
            finally {
                Remove-Item -LiteralPath $processingPath -Force -ErrorAction SilentlyContinue
            }
        }

        Start-Sleep -Seconds $PollSeconds
    }
}
finally {
    if ($transcriptStarted) {
        Stop-Transcript | Out-Null
    }
    if ($mutex) {
        $mutex.ReleaseMutex()
        $mutex.Dispose()
    }
}
