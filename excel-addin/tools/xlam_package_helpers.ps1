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
