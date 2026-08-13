<#
.SYNOPSIS
Asks the source-PC listener to sync the repository to a release this build published.

.DESCRIPTION
The build runs from a disposable workspace on the build PC and cannot write to the
source repository, so the sync has to happen where the repository lives. The listener
is already running there and already owns a request/response protocol, so this sends
it a syncRelease request and waits for the outcome.

Failing to sync does not invalidate the installer that was already published, so the
caller is expected to treat a failure here as a warning with a manual fallback rather
than a failed build.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Version,

    [Parameter(Mandatory = $true)]
    [string]$BuildShareRoot,

    [ValidateSet("ArcRho", "Arcode")]
    [string]$ProductName = "ArcRho",

    [string]$ReadySignal = "",

    [ValidateRange(30, 3600)]
    [int]$TimeoutSeconds = 600,

    [ValidateRange(1, 60)]
    [int]$PollSeconds = 3
)

$ErrorActionPreference = "Stop"

if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    throw "Version must be a semantic version like 1.2.6, not '$Version'."
}

$requestsDirectory = Join-Path $BuildShareRoot "build_requests"
$responsesDirectory = Join-Path $BuildShareRoot "build_responses"
foreach ($directory in @($requestsDirectory, $responsesDirectory)) {
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
}

$requestId = [Guid]::NewGuid().ToString('N')
$requestPath = Join-Path $requestsDirectory "$requestId.request"
$temporaryPath = "$requestPath.tmp"
$responsePath = Join-Path $responsesDirectory "$requestId.json"

$payload = [ordered]@{
    schemaVersion  = 1
    kind           = "syncRelease"
    requestId      = $requestId
    requestedAtUtc = [DateTime]::UtcNow.ToString('o')
    requestedBy    = $env:COMPUTERNAME
    product        = $ProductName
    version        = $Version
    readySignal    = $ReadySignal
}
$json = ($payload | ConvertTo-Json -Compress) + [Environment]::NewLine
[System.IO.File]::WriteAllText($temporaryPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Move-Item -LiteralPath $temporaryPath -Destination $requestPath -Force

Write-Host "Requested a repository sync for $ProductName $Version."
Write-Host "Request ID: $requestId"

$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
while (-not (Test-Path -LiteralPath $responsePath -PathType Leaf)) {
    if ([DateTime]::UtcNow -gt $deadline) {
        throw "The source-PC listener did not answer the sync request within $TimeoutSeconds seconds. Confirm build_app_listener.bat is running on the source PC."
    }
    Start-Sleep -Seconds $PollSeconds
}

$response = Get-Content -LiteralPath $responsePath -Raw | ConvertFrom-Json
if ($response.schemaVersion -ne 1 -or $response.requestId -ne $requestId) {
    throw "The listener response does not match this sync request."
}
if ($response.status -ne "succeeded") {
    throw "Repository sync failed: $($response.message)"
}

Remove-Item -LiteralPath $responsePath -Force -ErrorAction SilentlyContinue
Write-Host "Repository synced to $ProductName $Version. $($response.message)"
