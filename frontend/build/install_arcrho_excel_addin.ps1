param(
    [string]$AddInPath = "E:\ArcRho Server\Excel Add-ins\ArcRho.xlam"
)

$ErrorActionPreference = "Stop"

function Release-ComObject($Object) {
    if ($null -ne $Object -and [System.Runtime.InteropServices.Marshal]::IsComObject($Object)) {
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($Object)
    }
}

function Get-ExcelApplication {
    try {
        return [System.Runtime.InteropServices.Marshal]::GetActiveObject("Excel.Application")
    }
    catch {
        return $null
    }
}

if (-not (Test-Path -LiteralPath $AddInPath -PathType Leaf)) {
    throw "ArcRho Excel add-in was not found: $AddInPath"
}

$resolvedAddInPath = [System.IO.Path]::GetFullPath($AddInPath)
$excel = $null
$addIns = $null
$addin = $null
$createdExcel = $false
$previousDisplayAlerts = $null

try {
    $excel = Get-ExcelApplication
    if ($null -eq $excel) {
        $excel = New-Object -ComObject Excel.Application
        $createdExcel = $true
        $excel.Visible = $false
    }

    $previousDisplayAlerts = $excel.DisplayAlerts
    $excel.DisplayAlerts = $false
    $addIns = $excel.AddIns

    foreach ($candidate in @($addIns)) {
        try {
            $candidateFullName = [System.IO.Path]::GetFullPath($candidate.FullName)
            if ([string]::Equals($candidateFullName, $resolvedAddInPath, [System.StringComparison]::OrdinalIgnoreCase)) {
                $addin = $candidate
                break
            }

            if (
                [string]::Equals($candidate.Name, "ArcRho.xlam", [System.StringComparison]::OrdinalIgnoreCase) -and
                $candidate.Installed
            ) {
                $candidate.Installed = $false
            }
        }
        catch {
            Write-Warning "Skipped an Excel add-in entry that could not be inspected: $($_.Exception.Message)"
        }
    }

    if ($null -eq $addin) {
        $addin = $addIns.Add($resolvedAddInPath, $false)
    }

    if (-not $addin.Installed) {
        $addin.Installed = $true
    }

    Write-Host "Installed ArcRho Excel add-in: $($addin.FullName)"
}
finally {
    if ($null -ne $excel -and $null -ne $previousDisplayAlerts) {
        try {
            $excel.DisplayAlerts = $previousDisplayAlerts
        }
        catch {
            Write-Warning "Could not restore Excel DisplayAlerts: $($_.Exception.Message)"
        }
    }

    if ($createdExcel -and $null -ne $excel) {
        try {
            $excel.Quit()
        }
        catch {
            Write-Warning "Could not close the installer-created Excel instance: $($_.Exception.Message)"
        }
    }

    Release-ComObject $addin
    Release-ComObject $addIns
    Release-ComObject $excel
    [System.GC]::Collect()
    [System.GC]::WaitForPendingFinalizers()
}
