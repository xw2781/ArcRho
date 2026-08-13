[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$LogPath,

    [Parameter(Mandatory = $true)]
    [string]$CommandPath,

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$CommandArgs
)

$ErrorActionPreference = "Stop"

$logDirectory = Split-Path -Parent $LogPath
if ($logDirectory) {
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
}

$resolvedLogPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($LogPath)
$commandLine = @($CommandPath) + $CommandArgs | ForEach-Object {
    if ($_ -match "\s") {
        '"' + ($_ -replace '"', '\"') + '"'
    } else {
        $_
    }
}
$commandLine = $commandLine -join " "

$env:ARCRHO_BUILD_LOG_ACTIVE = "1"
$env:ARCRHO_BUILD_LOG_FILE = $resolvedLogPath

$productName = if ($env:ARCRHO_BUILD_PRODUCT -eq "arcode") { "Arcode" } else { "ArcRho" }

@(
    "$productName build log",
    "Started: $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))",
    "Command: $commandLine",
    "Working directory: $((Get-Location).Path)",
    ""
) | Tee-Object -FilePath $resolvedLogPath

$ErrorActionPreference = "Continue"
& $CommandPath @CommandArgs 2>&1 | ForEach-Object {
    "$_"
} | Tee-Object -FilePath $resolvedLogPath -Append
$exitCode = $LASTEXITCODE
if ($null -eq $exitCode) {
    $exitCode = 0
}

@(
    "",
    "Finished: $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))",
    "Exit code: $exitCode"
) | Tee-Object -FilePath $resolvedLogPath -Append

exit $exitCode
