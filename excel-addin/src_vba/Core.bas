
Option Private Module
Option Explicit

Public Const ARCRHO_VERSION As String = "2.1.0"

' User-specific config (C:\Users\...\AppData\Local\ArcRho\config.txt)
Public configDir As String
Public configPath As String
Public removeData As Boolean
Public disable_ufLoading As Boolean
Public teamProfile As String
Public debugMode As Boolean
Public disableProgressBar As Boolean

' Internal Controls
Public disableRequest As Boolean
Public disableWaitTime As Boolean
Public skipDataProcess As Boolean
Public maxWaitTime As Single
Public errCount As Integer
Public lastRequestInfo As String

Public processedCells As New Collection
Public processedArrays As New Collection
Public cancelUpdate As Boolean
Public pendingUpdate As Boolean
Public doubleRefresh As Boolean
Public disableWatcher As Boolean

Public triangle_tool_row As Long
Public triangle_tool_col As Long

Private Const DATA_STORAGE_GENERATED As String = "generated"
Private Const DATA_STORAGE_MANUAL As String = "manual"

Private Type DatasetRequestSpec
    FunctionName As String
    ProjectName As String
    ReservingClassPath As String
    DatasetName As String
    ProjectDataPath As String
    DataPath As String
    StorageKind As String
End Type

Private datasetTypesCache As Object
Private datasetTypesStampCache As Object

Public Function FirstExistingPath(ParamArray paths() As Variant) As String
    Dim i As Long
    For i = LBound(paths) To UBound(paths)
        If Len(Dir$(CStr(paths(i)), vbNormal Or vbReadOnly Or vbHidden Or vbSystem Or vbDirectory)) > 0 Then
            FirstExistingPath = CStr(paths(i))
            Exit Function
        End If
    Next i
    FirstExistingPath = CStr(paths(LBound(paths)))
End Function

Private Function FileExists(ByVal filePath As String) As Boolean
    FileExists = (Len(Dir$(filePath, vbNormal Or vbReadOnly Or vbHidden Or vbSystem)) > 0)
End Function

Private Function NormalizeDatasetKey(ByVal value As String) As String
    NormalizeDatasetKey = LCase$(Trim$(value))
End Function

Private Function IsGeneratedDataPath(ByVal filePath As String) As Boolean
    IsGeneratedDataPath = (InStr(1, filePath, "\data\generated\", vbTextCompare) > 0)
End Function

Private Sub DeleteFileIfExists(ByVal filePath As String)
    If FileExists(filePath) Then Kill filePath
End Sub

Private Sub DeleteGeneratedDatasetCache(ByVal csvPath As String)
    Dim jsonPath As String
    If Not IsGeneratedDataPath(csvPath) Then Exit Sub
    DeleteFileIfExists csvPath
    If LCase$(Right$(csvPath, 4)) = ".csv" Then
        jsonPath = Left$(csvPath, Len(csvPath) - 4) & ".json"
        DeleteFileIfExists jsonPath
    End If
End Sub

Public Function ProductRootPath() As String
    Dim addinDir As String
    addinDir = ThisWorkbook.Path

    If EndsWithText(addinDir, "\Excel Add-ins\beta") Then
        ProductRootPath = Left$(addinDir, Len(addinDir) - Len("\Excel Add-ins\beta"))
        Exit Function
    End If

    If EndsWithText(addinDir, "\Excel Add-ins") Then
        ProductRootPath = Left$(addinDir, Len(addinDir) - Len("\Excel Add-ins"))
        Exit Function
    End If

    ProductRootPath = "\\Ne7saswpn02\e\ArcRho Server"
End Function

Private Function EndsWithText(ByVal value As String, ByVal suffix As String) As Boolean
    If Len(value) < Len(suffix) Then
        EndsWithText = False
    Else
        EndsWithText = (StrComp(Right$(value, Len(suffix)), suffix, vbTextCompare) = 0)
    End If
End Function

Public Function ProductPath(ByVal relativePath As String) As String
    If Left$(relativePath, 1) = "\" Then relativePath = Mid$(relativePath, 2)
    ProductPath = ProductRootPath() & "\" & relativePath
End Function

Private Sub InitConfigPaths()
    configDir = Environ$("LOCALAPPDATA") & "\ArcRho"
    configPath = configDir & "\config.txt"
End Sub

Public Function GetDataset(funcArgs As String)
' +---------------+
' | Main Function |
' +---------------+
    Dim spec As DatasetRequestSpec
    Dim dataPath As String
    Dim projectDataDir As String
    Dim t1 As Double, t2 As Double
    Dim requestInfo As String
    Const MAX_WAIT_SEC As Double = 5
    On Error GoTo ErrHandler

    If skipDataProcess Then
        Exit Function
    End If

    ' t1 = Timer
    ' Debug.Print "Time - Start: " & TimeMS()

    spec = BuildDatasetRequestSpec(funcArgs)
    dataPath = spec.DataPath
    If InStrRev(dataPath, "\") > 0 Then
        projectDataDir = GetProjectDataRootFromDataPath(dataPath)
        If Len(projectDataDir) > 0 And Dir(projectDataDir, vbDirectory) = "" Then
            GetDataset = "(project not defined: " & projectDataDir & ")"
            GoTo CleanExit
        End If
    End If
    requestInfo = funcArgs & "#DataPath = " & dataPath

    ' Manual datasets are read-only from Excel. Missing manual datasets should
    ' not create request files or clear files under data\manual.
    If spec.StorageKind = DATA_STORAGE_MANUAL Then
        If FileExists(dataPath) Then
            GetDataset = GetDataArray(dataPath)
            errCount = 0
        Else
            Debug.Print "[error] - manual dataset file not found: "; dataPath
            GetDataset = "(manual dataset not found)"
        End If
        GoTo CleanExit
    End If

    ' --- Case 1: reuse existing generated/runtime data if allowed ---
    If (Dir(dataPath) <> "") And (removeData = False) Then
        GetDataset = GetDataArray(dataPath)
        errCount = 0
        GoTo CleanExit
    End If

    ' --- Case 2: need fresh data ---
    ufLoading.UpdateText "Updating [" & GetParamValue(requestInfo, "DatasetName") & "]"

    DeleteGeneratedDatasetCache dataPath

    If InStrRev(dataPath, "\") > 0 Then
        projectDataDir = Left$(dataPath, InStrRev(dataPath, "\") - 1)
        If Dir(projectDataDir, vbDirectory) = "" Then
            EnsureFolderPath projectDataDir
        End If
    End If

    ' Send Request
    SendRequest requestInfo
    doubleRefresh = True

    ' Waiting for data...
    If disableWaitTime Then
        GetDataset = "(waiting for data)"
        Exit Function
    End If

    If Not WaitForFileReady(dataPath, MAX_WAIT_SEC) Then
        GetDataset = "request time out"
        GoTo CleanExit
    End If

    ' t2 = Timer
    ' Debug.Print "Time - End  : " & TimeMS()
    ' Debug.Print "Time - Spent: " & Format(t2 - t1, "0.000")

    If Dir(dataPath) <> "" Then
        GetDataset = GetDataArray(dataPath)
    Else
        Debug.Print "[error] - data path not found"
        GetDataset = "data path not found"
        GoTo CleanExit
    End If

    errCount = 0

CleanExit:
    Unload ufLoading
    ufLoading.Reset
    Exit Function

ErrHandler:
    Debug.Print "GetDataset error: "; Err.Number; Err.Description
    Debug.Print "ProductRootPath: "; ProductRootPath()
    Debug.Print "DataPath: "; dataPath
    Debug.Print "RequestDir: "; ProductPath("requests")
    GetDataset = "ArcRho file access error " & Err.Number & ": " & Err.Description
    Resume CleanExit

End Function


Private Function FolderExists(ByVal folderPath As String) As Boolean
    On Error GoTo Missing
    FolderExists = ((GetAttr(folderPath) And vbDirectory) = vbDirectory)
    Exit Function
Missing:
    FolderExists = False
End Function
Private Sub EnsureFolderPath(ByVal folderPath As String)
    Dim parts() As String
    Dim currentPath As String
    Dim i As Long
    Dim mkdirErr As Long
    Dim mkdirDesc As String

    If Len(Trim$(folderPath)) = 0 Then Exit Sub
    If FolderExists(folderPath) Then Exit Sub

    parts = Split(folderPath, "\")
    If UBound(parts) < 0 Then Exit Sub

    If Left$(folderPath, 2) = "\\" Then
        If UBound(parts) < 3 Then Exit Sub
        currentPath = "\\" & parts(2) & "\" & parts(3)
        i = 4
    Else
        currentPath = parts(0)
        i = 1
    End If

    For i = i To UBound(parts)
        If Len(parts(i)) > 0 Then
            currentPath = currentPath & "\" & parts(i)
            If Not FolderExists(currentPath) Then
                On Error Resume Next
                MkDir currentPath
                mkdirErr = Err.Number
                mkdirDesc = Err.Description
                Err.Clear
                On Error GoTo 0
                If mkdirErr <> 0 And Not FolderExists(currentPath) Then
                    Err.Raise mkdirErr, "EnsureFolderPath", "Could not create folder: " & currentPath & " - " & mkdirDesc
                End If
            End If
        End If
    Next i
End Sub

Private Function GetProjectDataRootFromDataPath(ByVal dataPath As String) As String
    Dim marker As String
    Dim pos As Long
    marker = "\data\"
    pos = InStr(1, dataPath, marker, vbTextCompare)
    If pos > 0 Then
        GetProjectDataRootFromDataPath = Left$(dataPath, pos + Len("\data") - 1)
    ElseIf InStrRev(dataPath, "\") > 0 Then
        GetProjectDataRootFromDataPath = Left$(dataPath, InStrRev(dataPath, "\") - 1)
    Else
        GetProjectDataRootFromDataPath = vbNullString
    End If
End Function
Public Sub LoadConfig()
    Dim line As String, parts As Variant
    Dim fileVersion As String
    Dim f As Integer

    InitConfigPaths

    ' Ensure config dir
    If Dir(configDir, vbDirectory) = "" Then
        MkDir configDir
    End If

    ' -------------------------
    ' Check existing config version
    ' -------------------------
    If Dir(configPath) <> "" Then
        f = FreeFile
        Open configPath For Input As #f

        Do While Not EOF(f)
            Line Input #f, line
            line = Trim$(line)

            If InStr(line, "=") > 0 Then
                parts = Split(line, "=")
                If LCase$(Trim$(parts(0))) = "version" Then
                    fileVersion = Trim$(parts(1))
                    Exit Do
                End If
            End If
        Loop

        Close #f

        ' Version mismatch ? delete config
        If fileVersion <> ARCRHO_VERSION Then
            Kill configPath
        End If
    End If

    ' -------------------------
    ' Create config if missing
    ' -------------------------
    If Dir(configPath) = "" Then
        f = FreeFile
        Open configPath For Output As #f
        Print #f, "version = " & ARCRHO_VERSION
        Print #f, "removeData = False"
        Print #f, "disable_ufLoading = False"
        Print #f, "teamProfile = Default"
        Print #f, "debugMode = False"
        Print #f, "disableProgressBar = False"
        Close #f
    End If

    ' -------------------------
    ' Load config values
    ' -------------------------
    f = FreeFile
    Open configPath For Input As #f

    Do While Not EOF(f)
        Line Input #f, line
        line = Trim$(line)

        If InStr(line, "=") > 0 Then
            parts = Split(line, "=")

            Select Case LCase$(Trim$(parts(0)))
                Case "version"
                    ' ignore, already handled

                Case "removedata"
                    removeData = CBool(Trim$(parts(1)))

                Case "disable_ufLoading", "disable_ufLoading"
                    disable_ufLoading = CBool(Trim$(parts(1)))

                Case "teamprofile"
                    teamProfile = Trim$(parts(1))

                Case "debugMode"
                    debugMode = CBool(Trim$(parts(1)))

                Case "disableProgressBar"
                    disableProgressBar = CBool(Trim$(parts(1)))

            End Select
        End If
    Loop

    Close #f

End Sub

Public Sub UpdateConfigValue(ByVal keyName As String, ByVal newValue As String)
    Dim lines() As String, temp As String
    Dim f As Integer, i As Long

    InitConfigPaths

    ' Read all lines
    f = FreeFile()
    Open configPath For Input As #f
    lines = Split(Input$(LOF(f), f), vbCrLf)
    Close #f

    ' Modify the specific key
    For i = LBound(lines) To UBound(lines)
        temp = Trim(lines(i))
        If InStr(temp, "=") > 0 Then
            If LCase$(Trim$(Split(temp, "=")(0))) = LCase$(keyName) Then
                lines(i) = keyName & " = " & newValue
            End If
        End If
    Next i

    ' Rewrite file
    f = FreeFile()
    Open configPath For Output As #f
    For i = LBound(lines) To UBound(lines)
        Print #f, lines(i)
    Next i
    Close #f
End Sub

Public Function SetDataPath(inputString As String) As String
    Dim spec As DatasetRequestSpec
    spec = BuildDatasetRequestSpec(inputString)
    SetDataPath = spec.DataPath
End Function

Private Function BuildDatasetRequestSpec(inputString As String) As DatasetRequestSpec
    Dim s As String, proj As String
    Dim lines() As String, parts() As String
    Dim i As Long
    Dim key As String, val As String
    Dim fullName As String
    Dim basePath As String
    Dim functionName As String
    Dim reservingClassPath As String
    Dim datasetName As String
    Dim originLength As String
    Dim developmentLength As String
    Dim cumulativeMode As String
    Dim calendarMode As String
    Dim projectDataPath As String
    Dim generatedDataPath As String
    Dim manualDataPath As String
    Dim storageKind As String
    Dim rcFolder As String
    Dim datasetFile As String
    Dim spec As DatasetRequestSpec

    ' Normalize delimiters: allow either "#" or newlines between pairs
    s = inputString
    s = Replace(s, vbCrLf, "#")
    s = Replace(s, vbCr, "#")
    s = Replace(s, vbLf, "#")
    lines = Split(s, "#")
    cumulativeMode = "True"
    calendarMode = "False"

    ' Build the @-joined Value list for legacy flat caches while also capturing
    ' the project, reserving class path, and dataset name for the new ArcRho
    ' project data layout.
    For i = LBound(lines) To UBound(lines)
        If Len(Trim$(lines(i))) > 0 Then
            If InStr(1, lines(i), "=", vbTextCompare) > 0 Then
                parts = Split(lines(i), "=")
                key = Trim$(parts(0))
                val = Trim$(Mid$(lines(i), InStr(1, lines(i), "=", vbTextCompare) + 1))

                Select Case LCase$(key)
                    Case "projectname"
                        proj = val
                    Case "function"
                        functionName = val
                        If Len(fullName) > 0 Then fullName = fullName & "@"
                        fullName = fullName & val
                    Case "path"
                        reservingClassPath = val
                        If Len(fullName) > 0 Then fullName = fullName & "@"
                        fullName = fullName & val
                    Case "datasetname", "trianglename"
                        datasetName = val
                        If Len(fullName) > 0 Then fullName = fullName & "@"
                        fullName = fullName & val
                    Case "originlength"
                        originLength = val
                        If Len(fullName) > 0 Then fullName = fullName & "@"
                        fullName = fullName & val
                    Case "developmentlength"
                        developmentLength = val
                        If Len(fullName) > 0 Then fullName = fullName & "@"
                        fullName = fullName & val
                    Case "cumulative"
                        cumulativeMode = val
                        If Len(fullName) > 0 Then fullName = fullName & "@"
                        fullName = fullName & val
                    Case "calendar"
                        calendarMode = val
                        If Len(fullName) > 0 Then fullName = fullName & "@"
                        fullName = fullName & val
                    Case Else
                        If Len(fullName) > 0 Then fullName = fullName & "@"
                        fullName = fullName & val
                End Select
            End If
        End If
    Next i

    basePath = ProductPath("projects\")

    If Len(proj) > 0 Then
        proj = SanitizeProjectFolderName(proj)
        projectDataPath = basePath & proj & "\data"
    Else
        projectDataPath = basePath & "data"
    End If
    generatedDataPath = projectDataPath & "\generated"
    manualDataPath = projectDataPath & "\manual"
    storageKind = ResolveDatasetStorageKind(proj, datasetName, functionName)

    ' New storage contract: dataset CSV files live under one sanitized
    ' reserving-class folder and no longer repeat the reserving class path in
    ' the filename. Dataset Types "Generated" controls generated/manual
    ' placement; missing dataset types are treated as manual instances.
    If Len(reservingClassPath) > 0 And Len(datasetName) > 0 Then
        rcFolder = SanitizeReservingClassFolderName(reservingClassPath)
        datasetFile = SanitizeDataFileName(datasetName)
        If storageKind = DATA_STORAGE_MANUAL Then
            spec.DataPath = manualDataPath & "\" & rcFolder & "\" & datasetFile & ".csv"
        Else
            If LCase$(Trim$(functionName)) = "arcrhotri" _
                    And Len(Trim$(originLength)) > 0 _
                    And Len(Trim$(developmentLength)) > 0 Then
                datasetFile = datasetFile & "@" & Trim$(originLength) & "@" & Trim$(developmentLength) _
                    & "@" & RequestBoolSuffix(cumulativeMode, "cum", "inc") _
                    & "@" & RequestBoolSuffix(calendarMode, "cal", "dev")
            End If
            spec.DataPath = generatedDataPath & "\" & rcFolder & "\" & datasetFile & ".csv"
        End If
    Else
        ' Fallback for requests that are not scoped by reserving class and dataset
        ' name, such as ArcRhoHeaders and ArcRhoProjectSettings.
        fullName = EncodeFileNameSegment(fullName)
        spec.DataPath = generatedDataPath & "\" & fullName & ".csv"
    End If

    spec.FunctionName = functionName
    spec.ProjectName = proj
    spec.ReservingClassPath = reservingClassPath
    spec.DatasetName = datasetName
    spec.ProjectDataPath = projectDataPath
    spec.StorageKind = storageKind
    BuildDatasetRequestSpec = spec
End Function

Private Function RequestBoolSuffix(ByVal value As String, ByVal trueSuffix As String, ByVal falseSuffix As String) As String
    Select Case LCase$(Trim$(value))
        Case "true", "yes", "1"
            RequestBoolSuffix = trueSuffix
        Case Else
            RequestBoolSuffix = falseSuffix
    End Select
End Function

Private Function ResolveDatasetStorageKind(ByVal projectName As String, ByVal datasetName As String, ByVal functionName As String) As String
    Dim generatedMap As Object
    Dim key As String

    If Len(Trim$(datasetName)) = 0 Then
        ResolveDatasetStorageKind = DATA_STORAGE_GENERATED
        Exit Function
    End If

    Set generatedMap = GetDatasetTypesGeneratedMap(projectName)
    key = NormalizeDatasetKey(datasetName)
    If generatedMap.Exists(key) Then
        If CBool(generatedMap(key)) Then
            ResolveDatasetStorageKind = DATA_STORAGE_GENERATED
        Else
            ResolveDatasetStorageKind = DATA_STORAGE_MANUAL
        End If
    Else
        ResolveDatasetStorageKind = DATA_STORAGE_MANUAL
    End If
End Function

Private Function GetDatasetTypesGeneratedMap(ByVal projectName As String) As Object
    Dim datasetTypesPath As String
    Dim cacheKey As String
    Dim stamp As String
    Dim generatedMap As Object

    EnsureDatasetTypesCache

    datasetTypesPath = GetProjectDatasetTypesJsonPath(projectName)
    cacheKey = LCase$(datasetTypesPath)
    If FileExists(datasetTypesPath) Then
        stamp = CStr(FileDateTime(datasetTypesPath))
    Else
        stamp = "<missing>"
    End If

    If datasetTypesCache.Exists(cacheKey) Then
        If datasetTypesStampCache.Exists(cacheKey) Then
            If CStr(datasetTypesStampCache(cacheKey)) = stamp Then
                Set GetDatasetTypesGeneratedMap = datasetTypesCache(cacheKey)
                Exit Function
            End If
        End If
    End If

    If FileExists(datasetTypesPath) Then
        Set generatedMap = LoadDatasetTypesGeneratedMap(datasetTypesPath)
    Else
        Set generatedMap = CreateObject("Scripting.Dictionary")
        generatedMap.CompareMode = vbTextCompare
    End If

    If datasetTypesCache.Exists(cacheKey) Then datasetTypesCache.Remove cacheKey
    If datasetTypesStampCache.Exists(cacheKey) Then datasetTypesStampCache.Remove cacheKey
    datasetTypesCache.Add cacheKey, generatedMap
    datasetTypesStampCache.Add cacheKey, stamp

    Set GetDatasetTypesGeneratedMap = generatedMap
End Function

Private Function LoadDatasetTypesGeneratedMap(ByVal datasetTypesPath As String) As Object
    Dim generatedMap As Object
    Dim root As Object
    Dim columns As Collection
    Dim rows As Collection
    Dim row As Collection
    Dim nameIndex As Long
    Dim generatedIndex As Long
    Dim i As Long
    Dim datasetName As String
    Dim key As String
    Dim generated As Boolean

    Set generatedMap = CreateObject("Scripting.Dictionary")
    generatedMap.CompareMode = vbTextCompare

    On Error GoTo LoadFailed
    Set root = JsonParse(ReadUtf8TextFile(datasetTypesPath))
    If Not root.Exists("columns") Or Not root.Exists("rows") Then GoTo LoadFinished

    Set columns = root("columns")
    Set rows = root("rows")
    nameIndex = JsonColumnIndex(columns, "Name")
    generatedIndex = JsonColumnIndex(columns, "Generated")
    If nameIndex <= 0 Or generatedIndex <= 0 Then GoTo LoadFinished

    For i = 1 To rows.Count
        Set row = rows.Item(i)
        If row.Count >= nameIndex Then
            datasetName = Trim$(CStr(row.Item(nameIndex)))
            If Len(datasetName) > 0 Then
                generated = False
                If row.Count >= generatedIndex Then
                    generated = BoolLike(row.Item(generatedIndex), False)
                End If
                key = NormalizeDatasetKey(datasetName)
                If generatedMap.Exists(key) Then
                    generatedMap(key) = generated
                Else
                    generatedMap.Add key, generated
                End If
            End If
        End If
    Next i

LoadFinished:
    Set LoadDatasetTypesGeneratedMap = generatedMap
    Exit Function

LoadFailed:
    Debug.Print "Failed to load dataset_types.json: "; datasetTypesPath; " - "; Err.Description
    Set LoadDatasetTypesGeneratedMap = generatedMap
End Function

Private Sub EnsureDatasetTypesCache()
    If datasetTypesCache Is Nothing Then
        Set datasetTypesCache = CreateObject("Scripting.Dictionary")
        datasetTypesCache.CompareMode = vbTextCompare
    End If
    If datasetTypesStampCache Is Nothing Then
        Set datasetTypesStampCache = CreateObject("Scripting.Dictionary")
        datasetTypesStampCache.CompareMode = vbTextCompare
    End If
End Sub

Private Function GetProjectDatasetTypesJsonPath(ByVal projectName As String) As String
    Dim projectFolder As String
    If Len(Trim$(projectName)) > 0 Then
        projectFolder = SanitizeProjectFolderName(projectName)
        GetProjectDatasetTypesJsonPath = ProductPath("projects\" & projectFolder & "\dataset_types.json")
    Else
        GetProjectDatasetTypesJsonPath = ProductPath("projects\dataset_types.json")
    End If
End Function

Private Function JsonColumnIndex(ByVal columns As Collection, ByVal columnName As String) As Long
    Dim i As Long
    For i = 1 To columns.Count
        If StrComp(Trim$(CStr(columns.Item(i))), columnName, vbTextCompare) = 0 Then
            JsonColumnIndex = i
            Exit Function
        End If
    Next i
    JsonColumnIndex = 0
End Function

Private Function BoolLike(ByVal value As Variant, ByVal defaultValue As Boolean) As Boolean
    Dim text As String
    If IsEmpty(value) Or IsNull(value) Then
        BoolLike = defaultValue
        Exit Function
    End If
    If VarType(value) = vbBoolean Then
        BoolLike = CBool(value)
        Exit Function
    End If
    text = LCase$(Trim$(CStr(value)))
    Select Case text
        Case "true", "yes", "y", "1", "generated"
            BoolLike = True
        Case "false", "no", "n", "0", "manual"
            BoolLike = False
        Case Else
            BoolLike = defaultValue
    End Select
End Function

Private Function ReadUtf8TextFile(ByVal filePath As String) As String
    Dim stream As Object
    Set stream = CreateObject("ADODB.Stream")
    stream.Type = 2
    stream.Charset = "utf-8"
    stream.Open
    stream.LoadFromFile filePath
    ReadUtf8TextFile = stream.ReadText(-1)
    stream.Close
End Function

Private Sub WriteUtf8TextFile(ByVal filePath As String, ByVal text As String)
    Dim stream As Object
    Set stream = CreateObject("ADODB.Stream")
    stream.Type = 2
    stream.Charset = "utf-8"
    stream.Open
    stream.WriteText text
    stream.SaveToFile filePath, 2
    stream.Close
End Sub

' Keep this mapping in sync with data-engine/docs/filename-escaping-rules.md.
Private Function EncodeFileNameSegment(ByVal value As String) As String
    EncodeFileNameSegment = value
    EncodeFileNameSegment = Replace(EncodeFileNameSegment, "\", "_%5C_")
    EncodeFileNameSegment = Replace(EncodeFileNameSegment, "/", "_%2F_")
    EncodeFileNameSegment = Replace(EncodeFileNameSegment, ":", "_%3A_")
    EncodeFileNameSegment = Replace(EncodeFileNameSegment, "*", "_%2A_")
    EncodeFileNameSegment = Replace(EncodeFileNameSegment, "?", "_%3F_")
    EncodeFileNameSegment = Replace(EncodeFileNameSegment, """", "_%22_")
    EncodeFileNameSegment = Replace(EncodeFileNameSegment, "<", "_%3C_")
    EncodeFileNameSegment = Replace(EncodeFileNameSegment, ">", "_%3E_")
    EncodeFileNameSegment = Replace(EncodeFileNameSegment, "|", "_%7C_")
End Function

Private Function SanitizeProjectFolderName(ByVal value As String) As String
    SanitizeProjectFolderName = EncodeFileNameSegment(Trim$(value))
End Function

Private Function SanitizeReservingClassFolderName(ByVal value As String) As String
    SanitizeReservingClassFolderName = EncodeFileNameSegment(Trim$(value))
    Do While Right$(SanitizeReservingClassFolderName, 1) = " " Or Right$(SanitizeReservingClassFolderName, 1) = "."
        SanitizeReservingClassFolderName = Left$(SanitizeReservingClassFolderName, Len(SanitizeReservingClassFolderName) - 1) & "^"
    Loop
    If Len(SanitizeReservingClassFolderName) = 0 Then SanitizeReservingClassFolderName = "ReservingClass"
End Function

Private Function SanitizeDataFileName(ByVal value As String) As String
    SanitizeDataFileName = EncodeFileNameSegment(Trim$(value))
    If Len(SanitizeDataFileName) = 0 Then SanitizeDataFileName = "Dataset"
End Function

Public Function SetDefaultProject(ByVal ProjectName As String)
    Dim tmpName As String
    ' SetProjectName
    If ProjectName = "Default" Then
        tmpName = ActiveWorkbook.Sheets("ResQ Settings").Range("B7").Value
    Else
        tmpName = ProjectName
    End If
    SetDefaultProject = Mid(tmpName, InStrRev(tmpName, "\") + 1)
End Function

Public Sub SendRequest(requestInfo As String)
    Dim lines() As String
    Dim currentTime As String
    Dim requestDir As String
    Dim tempPath As String, finalPath As String
    Dim phase As String
    Dim i As Long
    Dim jsonText As String

    On Error GoTo ErrHandler

    If disableRequest Then Exit Sub

    lines = Split(requestInfo, "#")

    currentTime = Format(Now, "yyyy-mm-dd_hh-mm-ss") & Format(Timer - Int(Timer), ".000")
    requestDir = ProductPath("requests")
    phase = "ensure request folder"
    If Not FolderExists(requestDir) Then
        On Error Resume Next
        EnsureFolderPath requestDir
        Err.Clear
        On Error GoTo ErrHandler
    End If

    tempPath = requestDir & "\request-" & currentTime & ".tmp"
    finalPath = requestDir & "\request-" & currentTime & ".json"

    phase = "build JSON request file"
    jsonText = RequestLinesToJson(lines, Environ$("USERNAME"))

    phase = "write temp request file"
    WriteUtf8TextFile tempPath, jsonText

    phase = "remove existing final request file"
    If Dir(finalPath, vbNormal) <> "" Then
        Kill finalPath
    End If

    phase = "publish final request file"
    On Error Resume Next
    Name tempPath As finalPath
    If Err.Number <> 0 Then
        Err.Clear
        FileCopy tempPath, finalPath
        Kill tempPath
    End If
    On Error GoTo 0
    Exit Sub

ErrHandler:
    Err.Raise Err.Number, "SendRequest", phase & " failed. RequestDir=" & requestDir & "; TempPath=" & tempPath & "; FinalPath=" & finalPath & "; " & Err.Description
End Sub

Private Function RequestLinesToJson(ByRef lines() As String, ByVal userName As String) As String
    Dim json As String
    Dim i As Long
    Dim line As String
    Dim key As String
    Dim val As String
    Dim sepPos As Long
    Dim firstField As Boolean

    json = "{" & vbCrLf
    firstField = True

    For i = LBound(lines) To UBound(lines)
        line = Trim$(lines(i))
        If Len(line) > 0 Then
            sepPos = InStr(1, line, "=", vbTextCompare)
            If sepPos > 0 Then
                key = Trim$(Left$(line, sepPos - 1))
                val = Trim$(Mid$(line, sepPos + 1))
                If Len(key) > 0 Then
                    AppendJsonField json, firstField, key, val
                End If
            End If
        End If
    Next i

    AppendJsonField json, firstField, "UserName", userName
    json = json & vbCrLf & "}" & vbCrLf
    RequestLinesToJson = json
End Function

Private Sub AppendJsonField(ByRef json As String, ByRef firstField As Boolean, ByVal key As String, ByVal value As String)
    If Not firstField Then json = json & "," & vbCrLf
    json = json & "  " & JsonQuote(key) & ": " & JsonScalar(key, value)
    firstField = False
End Sub

Private Function JsonScalar(ByVal key As String, ByVal value As String) As String
    Dim normalizedKey As String
    Dim trimmed As String
    normalizedKey = LCase$(Trim$(key))
    trimmed = Trim$(value)

    Select Case normalizedKey
        Case "cumulative", "transposed", "calendar", "rpcserverwriteconfirmed"
            Select Case LCase$(trimmed)
                Case "true", "yes", "1"
                    JsonScalar = "true"
                    Exit Function
                Case "false", "no", "0"
                    JsonScalar = "false"
                    Exit Function
            End Select
        Case "originlength", "developmentlength", "periodlength", "storedperiodlength", "decimalplaces"
            If IsJsonInteger(trimmed) Then
                JsonScalar = trimmed
                Exit Function
            End If
    End Select

    JsonScalar = JsonQuote(value)
End Function

Private Function IsJsonInteger(ByVal value As String) As Boolean
    Dim i As Long
    Dim ch As String

    If Len(value) = 0 Then Exit Function
    If Left$(value, 1) = "-" Then
        If Len(value) = 1 Then Exit Function
        i = 2
    Else
        i = 1
    End If

    For i = i To Len(value)
        ch = Mid$(value, i, 1)
        If ch < "0" Or ch > "9" Then Exit Function
    Next i
    IsJsonInteger = True
End Function

Private Function JsonQuote(ByVal value As String) As String
    Dim i As Long
    Dim ch As String
    Dim code As Long
    Dim out As String

    out = """"
    For i = 1 To Len(value)
        ch = Mid$(value, i, 1)
        code = AscW(ch)
        Select Case ch
            Case """"
                out = out & "\"""
            Case "\"
                out = out & "\\"
            Case vbBack
                out = out & "\b"
            Case vbFormFeed
                out = out & "\f"
            Case vbCr
                out = out & "\r"
            Case vbLf
                out = out & "\n"
            Case vbTab
                out = out & "\t"
            Case Else
                If code >= 0 And code < 32 Then
                    out = out & "\u" & Right$("0000" & Hex$(code), 4)
                Else
                    out = out & ch
                End If
        End Select
    Next i
    JsonQuote = out & """"
End Function

Public Function GetDataArray(dataPath As String)
' *----------------------------------------------*
' | Get the data array from an external csv file |
' *----------------------------------------------*
    Dim outputArray() As Variant
    Dim lines() As String
    Dim aFile As Integer
    Dim dateTimeString As String
    Dim data() As String
    Dim fileContent As String
    Dim normalizedContent As String
    Dim i As Long, j As Long

    aFile = FreeFile
    Open dataPath For Input As #aFile
    fileContent = Input$(LOF(aFile), #aFile)
    Close #aFile

    normalizedContent = Replace(fileContent, vbCrLf, vbLf)
    normalizedContent = Replace(normalizedContent, vbCr, vbLf)
    Do While Right$(normalizedContent, 1) = vbLf
        normalizedContent = Left$(normalizedContent, Len(normalizedContent) - 1)
    Loop

    If Len(normalizedContent) = 0 Then
        ReDim outputArray(0 To 0, 0 To 0)
        GetDataArray = outputArray
        Exit Function
    End If

    lines = Split(normalizedContent, vbLf)
    ReDim outputArray(LBound(lines) To UBound(lines), 0)

    For i = LBound(lines) To UBound(lines)
        data = Split(lines(i), ",")
        If UBound(data) > UBound(outputArray, 2) Then
            ReDim Preserve outputArray(LBound(lines) To UBound(lines), LBound(data) To UBound(data))
        End If
        For j = LBound(data) To UBound(data)

            dateTimeString = data(j)
            If InStr(dateTimeString, "+") > 0 Then
                dateTimeString = Left(dateTimeString, InStr(dateTimeString, "+") - 1)
            End If

            If IsNumeric(data(j)) Then
                outputArray(i, j) = CDbl(data(j))
            ElseIf IsDate(dateTimeString) Then
                outputArray(i, j) = CDbl(CDate(dateTimeString))
            Else
                outputArray(i, j) = data(j)
            End If
        Next j
    Next i

    GetDataArray = outputArray
End Function











