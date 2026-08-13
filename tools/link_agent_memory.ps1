# Links the Claude Code project-memory directory to the tracked `agent-memory/` folder.
#
# The agent harness derives its memory path from the repository's absolute path and offers no
# setting to move it, so the only way to keep memories in git is to make that path a directory
# junction pointing back into the working tree. Run this once per machine and per clone path.
# Junctions need no elevation; the script is idempotent and never deletes real memory files.

param(
    [switch]$Force
)

$ErrorActionPreference = "Stop"

$repoRoot = (git rev-parse --show-toplevel)
if ($LASTEXITCODE -ne 0) {
    throw "Not inside a git repository."
}
$repoRoot = (Resolve-Path $repoRoot.Trim()).Path

$target = Join-Path $repoRoot "agent-memory"
if (-not (Test-Path -LiteralPath $target)) {
    New-Item -ItemType Directory -Path $target | Out-Null
}

# Slug rule: drive letter lowercased, then every ':\' and '\' collapsed to '-'.
$slug = $repoRoot.Substring(0, 1).ToLowerInvariant() + $repoRoot.Substring(1)
$slug = $slug -replace ':\\', '--' -replace '\\', '-'

$projectDir = Join-Path $env:USERPROFILE ".claude\projects\$slug"
$link = Join-Path $projectDir "memory"

Write-Host "Repository:  $repoRoot"
Write-Host "Project slug: $slug"
Write-Host "Memory link:  $link"
Write-Host "Link target:  $target"
Write-Host ""

if (-not (Test-Path -LiteralPath $projectDir)) {
    New-Item -ItemType Directory -Path $projectDir -Force | Out-Null
}

$existing = Get-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue
if ($existing) {
    if ($existing.LinkType -eq "Junction") {
        $currentTarget = @($existing.Target) | ForEach-Object { $_.TrimEnd('\') }
        if ($currentTarget -contains $target.TrimEnd('\')) {
            Write-Host "Junction already points at the repository. Nothing to do."
            exit 0
        }
        Write-Host "Replacing a junction that points elsewhere: $currentTarget" -ForegroundColor Yellow
        Remove-Item -LiteralPath $link -Force
    }
    else {
        $contents = @(Get-ChildItem -LiteralPath $link -Force)
        if ($contents.Count -gt 0 -and -not $Force) {
            Write-Host "'$link' is a real directory holding $($contents.Count) file(s)." -ForegroundColor Yellow
            Write-Host "Move anything worth keeping into '$target', then re-run with -Force."
            exit 1
        }
        Remove-Item -LiteralPath $link -Recurse -Force
    }
}

New-Item -ItemType Junction -Path $link -Target $target | Out-Null
Write-Host "Junction created. Memory writes now land in '$target' and show up in git status." -ForegroundColor Green
Write-Host "Restart Claude Code so MEMORY.md is picked up at session start."
