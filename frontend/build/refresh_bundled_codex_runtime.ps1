[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$frontendRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $frontendRoot "node-portable"
$npmCommand = Join-Path $runtimeRoot "npm.cmd"
$nodeCommand = Join-Path $runtimeRoot "node.exe"
$contractPath = Join-Path $frontendRoot "electron\arcbot_runtime_contract.json"
$validatorPath = Join-Path $PSScriptRoot "validate_bundled_codex_runtime.js"

foreach ($requiredPath in @($npmCommand, $nodeCommand, $contractPath, $validatorPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Required bundled runtime file is missing: $requiredPath"
    }
}

$contract = Get-Content -Raw -LiteralPath $contractPath | ConvertFrom-Json
$codexVersion = [string]$contract.minimumCodexCliVersion
if ($codexVersion -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
    throw "Invalid minimumCodexCliVersion in ${contractPath}: $codexVersion"
}

Write-Host "Refreshing bundled Codex CLI to $codexVersion..."
& $npmCommand install --global --prefix $runtimeRoot "@openai/codex@$codexVersion"
if ($LASTEXITCODE -ne 0) {
    throw "Bundled Codex CLI refresh failed with exit code $LASTEXITCODE."
}

& $nodeCommand $validatorPath --runtime-root $runtimeRoot --cwd $frontendRoot --timeout-ms 30000
if ($LASTEXITCODE -ne 0) {
    throw "Refreshed bundled Codex CLI failed validation."
}

Write-Host "Bundled Codex CLI $codexVersion is ready for packaging."
