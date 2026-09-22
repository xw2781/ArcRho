function Compress-XlamPackage(
    [string]$SourceDirectory,
    [string]$DestinationPath
) {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem

    if (-not (Test-Path -LiteralPath $SourceDirectory -PathType Container)) {
        throw "XLAM package source folder not found: $SourceDirectory"
    }

    $sourceRoot = [System.IO.Path]::GetFullPath($SourceDirectory)
    if (-not $sourceRoot.EndsWith([System.IO.Path]::DirectorySeparatorChar.ToString())) {
        $sourceRoot += [System.IO.Path]::DirectorySeparatorChar
    }

    $sourceFiles = @(Get-ChildItem -LiteralPath $sourceRoot -Recurse -File | Sort-Object FullName)
    if ($sourceFiles.Count -eq 0) {
        throw "XLAM package source folder is empty: $SourceDirectory"
    }

    $archive = [System.IO.Compression.ZipFile]::Open(
        $DestinationPath,
        [System.IO.Compression.ZipArchiveMode]::Create
    )
    try {
        foreach ($sourceFile in $sourceFiles) {
            $relativePath = $sourceFile.FullName.Substring($sourceRoot.Length)
            $entryName = $relativePath.Replace(
                [System.IO.Path]::DirectorySeparatorChar,
                [char]'/'
            )

            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $archive,
                $sourceFile.FullName,
                $entryName,
                [System.IO.Compression.CompressionLevel]::Optimal
            ) | Out-Null
        }
    }
    finally {
        $archive.Dispose()
    }
}

function Assert-XlamPackage([string]$WorkbookPath) {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    Add-Type -AssemblyName WindowsBase

    if (-not (Test-Path -LiteralPath $WorkbookPath -PathType Leaf)) {
        throw "XLAM package not found: $WorkbookPath"
    }

    $requiredEntries = @(
        '[Content_Types].xml',
        '_rels/.rels',
        'xl/workbook.xml',
        'xl/vbaProject.bin'
    )

    $zip = [System.IO.Compression.ZipFile]::OpenRead($WorkbookPath)
    try {
        $entryNames = @{}
        foreach ($entry in $zip.Entries) {
            if ($entry.FullName.Contains('\')) {
                throw "XLAM package contains an invalid backslash entry: $($entry.FullName)"
            }
            $entryNames[$entry.FullName] = $true
        }

        foreach ($requiredEntry in $requiredEntries) {
            if (-not $entryNames.ContainsKey($requiredEntry)) {
                throw "XLAM package is missing required entry: $requiredEntry"
            }
        }
    }
    finally {
        $zip.Dispose()
    }

    $package = [System.IO.Packaging.Package]::Open(
        $WorkbookPath,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::Read
    )
    try {
        foreach ($partName in @('/xl/workbook.xml', '/xl/vbaProject.bin')) {
            $partUri = New-Object System.Uri($partName, [System.UriKind]::Relative)
            if (-not $package.PartExists($partUri)) {
                throw "XLAM package reader could not find required part: $partName"
            }
        }

        if (@($package.GetRelationships()).Count -eq 0) {
            throw "XLAM package does not contain a root relationship."
        }
    }
    finally {
        $package.Close()
    }

    Write-Host "Validated XLAM package: $WorkbookPath"
}

function Test-FileInUseError([System.Management.Automation.ErrorRecord]$ErrorRecord) {
    $exception = $ErrorRecord.Exception
    while ($null -ne $exception) {
        if ($exception -is [System.IO.IOException] -or
            $exception -is [System.UnauthorizedAccessException]) {
            return $true
        }
        $exception = $exception.InnerException
    }
    $false
}

function Invoke-FileOperationWithRetry(
    [string]$Description,
    [scriptblock]$Operation,
    [int]$MaxAttempts = 12,
    [int]$InitialDelaySeconds = 1,
    [int]$MaxDelaySeconds = 10
) {
    # A file on the share can stay locked for a few seconds after it was
    # written or replaced (antivirus scan, SMB handle caching, an Excel that
    # is just closing it). Retry "used by another process" style failures
    # with a growing delay instead of failing the release on the first one.
    $delay = $InitialDelaySeconds
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        try {
            return (& $Operation)
        }
        catch {
            $isLastAttempt = ($attempt -ge $MaxAttempts)
            if ($isLastAttempt -or -not (Test-FileInUseError $_)) {
                throw
            }
            Write-Warning ("{0}: {1} (attempt {2} of {3}, retrying in {4}s)" -f
                $Description, $_.Exception.Message, $attempt, $MaxAttempts, $delay)
            Start-Sleep -Seconds $delay
            $delay = [Math]::Min($delay * 2, $MaxDelaySeconds)
        }
    }
}

function Set-FileReadOnlyWithRetry([string]$Path) {
    Invoke-FileOperationWithRetry "Mark read-only: $Path" {
        $item = Get-Item -LiteralPath $Path
        $item.Attributes = $item.Attributes -bor [System.IO.FileAttributes]::ReadOnly
    } | Out-Null
}
function Get-RibbonLabelForWorkbook([string]$WorkbookPath, [string]$RibbonXmlPath) {
    [xml]$ribbon = Get-Content -LiteralPath $RibbonXmlPath -Raw
    $label = $ribbon.SelectSingleNode("//*[local-name()='tab']").GetAttribute('label')
    if ([System.IO.Path]::GetFileNameWithoutExtension($WorkbookPath) -match 'BETA') {
        "$label Beta"
    }
    else {
        $label
    }
}
