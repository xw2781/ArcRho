param(
    [string]$Message = "",
    [switch]$Push,
    [string]$Remote = "origin",
    [string]$Branch = ""
)

$ErrorActionPreference = "Stop"

function Invoke-Git {
    git @args
    if ($LASTEXITCODE -ne 0) {
        throw "git $($args -join ' ') failed with exit code $LASTEXITCODE"
    }
}

$repoRoot = (Invoke-Git rev-parse --show-toplevel).Trim()
Set-Location $repoRoot

$currentBranch = (Invoke-Git branch --show-current).Trim()
if (-not $Branch) {
    $Branch = $currentBranch
}

$stagedNames = git diff --cached --name-only
if ($LASTEXITCODE -ne 0) {
    throw "git diff --cached --name-only failed with exit code $LASTEXITCODE"
}

if (-not $stagedNames) {
    Write-Host "No staged changes found." -ForegroundColor Yellow
    Write-Host "Review the commit workflow, get user approval, then stage only the approved files."
    Write-Host ""
    git status --short
    exit 1
}

if (-not $Message) {
    $Message = Read-Host "Commit message"
}

if (-not $Message.Trim()) {
    Write-Host "Commit cancelled: empty commit message." -ForegroundColor Yellow
    exit 1
}

Write-Host "Repository: $repoRoot"
Write-Host "Branch:     $currentBranch"
Write-Host ""

Write-Host "Staged files:"
git diff --cached --name-status
if ($LASTEXITCODE -ne 0) {
    throw "git diff --cached --name-status failed with exit code $LASTEXITCODE"
}

Write-Host ""
Write-Host "Staged summary:"
git diff --cached --stat
if ($LASTEXITCODE -ne 0) {
    throw "git diff --cached --stat failed with exit code $LASTEXITCODE"
}

Write-Host ""
Write-Host "Commit message:"
Write-Host "  $Message"
Write-Host ""

$confirm = Read-Host "Type COMMIT to run git commit"
if ($confirm -cne "COMMIT") {
    Write-Host "Commit cancelled."
    exit 1
}

Invoke-Git commit -m $Message

if ($Push) {
    Write-Host ""
    Write-Host "Push target: $Remote $Branch"
    $pushConfirm = Read-Host "Type PUSH to run git push $Remote $Branch"
    if ($pushConfirm -cne "PUSH") {
        Write-Host "Push cancelled."
        exit 0
    }

    Invoke-Git push $Remote $Branch
}
