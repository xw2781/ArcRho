# Closes every process that runs from an installation folder so setup can replace
# its files. electron-builder's own check closes only the main executable; the
# bundled app server and node runtime kept running from the same folder, so setup
# could only report that the app cannot be closed.
#
# Exit code 0: nothing from the folder is running any more. Exit code 1: the
# processes written to stdout are still running (or, with -DetectOnly, were
# found running and left alone).
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallDir,
    [switch]$DetectOnly
)

$ErrorActionPreference = "Continue"

$root = $InstallDir.Trim().TrimEnd('\') + '\'

function Get-InstalledProcesses {
    # Win32_Process reports the image path of a 64-bit process to the 32-bit
    # PowerShell that NSIS runs; Get-Process's MainModule refuses to.
    Get-CimInstance -ClassName Win32_Process | Where-Object {
        $exe = $_.ExecutablePath
        $exe -and $_.ProcessId -ne $PID -and $exe.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)
    }
}

function Wait-ForExit([int]$seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    do {
        $remaining = @(Get-InstalledProcesses)
        if ($remaining.Count -eq 0) { return @() }
        Start-Sleep -Milliseconds 400
    } while ((Get-Date) -lt $deadline)
    return $remaining
}

function Write-ProcessList($processes) {
    $processes | ForEach-Object { "$($_.Name) (PID $($_.ProcessId))" }
}

$found = @(Get-InstalledProcesses)
if ($found.Count -eq 0) { exit 0 }
if ($DetectOnly) {
    Write-ProcessList $found
    exit 1
}

# Ask the windows to close first so the app can shut its own backend down.
foreach ($process in $found) {
    try {
        $null = (Get-Process -Id $process.ProcessId -ErrorAction Stop).CloseMainWindow()
    } catch {}
}
$remaining = Wait-ForExit 3
foreach ($process in $remaining) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}
$remaining = Wait-ForExit 15
if ($remaining.Count -eq 0) { exit 0 }
Write-ProcessList $remaining
exit 1
