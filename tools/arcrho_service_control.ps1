# Stop or start the deployed ArcRho services on the Server PC.
#
# The persisted JSON conversion (tools/migrate_persisted_json_v4.py) rewrites
# files the Engine, Bridge and Gateway also write, so they have to be down
# while it runs -- and they must not come back up until a build that reads the
# new format is deployed. This is the one place that happens, so the operation
# is narrow enough to grant on its own rather than allowing process control in
# general.
#
#   .\tools\arcrho_service_control.ps1 -Action status
#   .\tools\arcrho_service_control.ps1 -Action stop
#   .\tools\arcrho_service_control.ps1 -Action start

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('status', 'stop', 'start')]
    [string]$Action,

    [string]$Root = 'E:\ArcRho Server\apps'
)

$ErrorActionPreference = 'Stop'

# Stop order is the reverse of start order: the Orchestrator supervises the
# rest, so it goes down first and comes up last.
$Components = @(
    @{ Name = 'ArcRho Orchestrator'; Exe = 'ArcRho Orchestrator\ArcRho Orchestrator.exe' },
    @{ Name = 'ArcRho Gateway';      Exe = 'ArcRho Gateway\ArcRho Gateway.exe' },
    @{ Name = 'ArcRho Bridge';       Exe = 'ArcRho Bridge\ArcRho Bridge.exe' },
    @{ Name = 'ArcRho Engine';       Exe = 'ArcRho Engine\ArcRho Engine.exe' }
)

function Get-Running($name) {
    return @(Get-Process -Name $name -ErrorAction SilentlyContinue)
}

function Show-Status {
    foreach ($component in $Components) {
        $running = Get-Running $component.Name
        if ($running.Count -gt 0) {
            $ids = ($running | ForEach-Object { $_.Id }) -join ', '
            Write-Output ("{0,-22} running  (pid {1})" -f $component.Name, $ids)
        }
        else {
            Write-Output ("{0,-22} stopped" -f $component.Name)
        }
    }
}

switch ($Action) {
    'status' {
        Show-Status
    }

    'stop' {
        foreach ($component in $Components) {
            $running = Get-Running $component.Name
            if ($running.Count -eq 0) {
                Write-Output ("{0,-22} already stopped" -f $component.Name)
                continue
            }
            foreach ($process in $running) {
                Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
            }
            Write-Output ("{0,-22} stopped {1} process(es)" -f $component.Name, $running.Count)
        }
        Start-Sleep -Seconds 3
        Write-Output ''
        Write-Output '--- after stop ---'
        Show-Status
    }

    'start' {
        # Reverse of the stop order, and only the Orchestrator is launched --
        # it brings up the components it supervises itself.
        $orchestrator = $Components | Where-Object { $_.Name -eq 'ArcRho Orchestrator' }
        $path = Join-Path $Root $orchestrator.Exe
        if (-not (Test-Path $path)) {
            Write-Error ("Not found: {0}" -f $path)
            exit 1
        }
        if ((Get-Running $orchestrator.Name).Count -gt 0) {
            Write-Output 'ArcRho Orchestrator is already running.'
        }
        else {
            Start-Process -FilePath $path | Out-Null
            Write-Output ("Started {0}" -f $path)
        }
        Start-Sleep -Seconds 5
        Write-Output ''
        Write-Output '--- after start ---'
        Show-Status
    }
}
