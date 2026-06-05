param(
    [string]$Remote = "origin",
    [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"

function Run-Git {
    git @args
    if ($LASTEXITCODE -ne 0) {
        throw "git $($args -join ' ') failed with exit code $LASTEXITCODE"
    }
}

$repoRoot = Run-Git rev-parse --show-toplevel
Set-Location $repoRoot

$currentBranch = (Run-Git branch --show-current).Trim()
if ($currentBranch -ne $Branch) {
    Write-Host "Current branch is '$currentBranch', expected '$Branch'." -ForegroundColor Yellow
    $answer = Read-Host "Type YES to push '$currentBranch' to '$Remote/$currentBranch' anyway"
    if ($answer -cne "YES") {
        Write-Host "Push cancelled."
        exit 1
    }
    $Branch = $currentBranch
}

$remoteUrl = (Run-Git remote get-url $Remote).Trim()
Write-Host "Repository: $repoRoot"
Write-Host "Remote:     $Remote ($remoteUrl)"
Write-Host "Branch:     $Branch"
Write-Host ""

Write-Host "Uncommitted files, not included in push:"
git status --short
Write-Host ""

Write-Host "Commits to push:"
git log --oneline "$Remote/$Branch..$Branch"
if ($LASTEXITCODE -ne 0) {
    Write-Host "Could not compare against $Remote/$Branch. The push may create or update the remote branch." -ForegroundColor Yellow
}
Write-Host ""

$confirm = Read-Host "Type YES to run: git push $Remote $Branch"
if ($confirm -cne "YES") {
    Write-Host "Push cancelled."
    exit 1
}

Run-Git push $Remote $Branch
