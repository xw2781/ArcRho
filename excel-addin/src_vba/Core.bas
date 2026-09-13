
Option Private Module
Option Explicit

Public Const ARCRHO_VERSION As String = "2.6.0"

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

' One recalculation pass fetches a dataset once. The dictionary is keyed by the
' request text GetDataset receives and holds the array that request returned, so
' every later formula asking for the same dataset in the same pass is answered
' from memory. It is dropped at each pass boundary.
Private datasetResults As Object

' Counts the dataset requests formulas make and the reads GetDataset actually
' performs, for the check in excel-addin\tools\check_dataset_cache.md.
Public datasetRequestCount As Long
Public datasetFetchCount As Long
Public datasetHitCount As Long

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

Public Function NormalizeDatasetName(ByVal value As String) As String
    NormalizeDatasetName = Trim$(value)
    Do While InStr(1, NormalizeDatasetName, "  ", vbBinaryCompare) > 0
        NormalizeDatasetName = Replace$(NormalizeDatasetName, "  ", " ")
    Loop
End Function

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

Public Sub ClearDatasetResultCache()
    Set datasetResults = Nothing
End Sub

Private Sub StoreDatasetResult(ByVal requestText As String, ByRef values As Variant)
    ' "Always refresh" means every formula reads the dataset again, so nothing is
    ' remembered while it is on. Only a real dataset array is worth keeping; a
    ' message such as "request time out" must be retried by the next formula.
    If removeData Then Exit Sub
    If Not IsArray(values) Then Exit Sub
    If datasetResults Is Nothing Then Set datasetResults = CreateObject("Scripting.Dictionary")
    datasetResults(requestText) = values
End Sub

Private Function TryDatasetResult(ByVal requestText As String, ByRef values As Variant) As Boolean
    If datasetResults Is Nothing Then Exit Function
    If Not datasetResults.Exists(requestText) Then Exit Function
    values = datasetResults(requestText)
    TryDatasetResult = True
End Function

Private Sub InitConfigPaths()
    configDir = Environ$("LOCALAPPDATA") & "\ArcRho"
    configPath = configDir & "\config.txt"
End Sub

Public Function GetDataset(funcArgs As String)
' +---------------+
' | Main Function |
' +---------------+
' Every worksheet function funnels through here, and the ArcRho Server answers
' every one of them. One signed call carries only the logical pairs the formula
' asked with; the server owns where the dataset lives, who is asking, and how a
' coarser shape is built, so nothing about a path is ever sent or received.
    Dim datasetValues As Variant
    Dim refusal As String
    On Error GoTo ErrHandler

    If skipDataProcess Then
        Exit Function
    End If

    datasetRequestCount = datasetRequestCount + 1

    ' --- Case 0: this pass already fetched the same dataset ---
    If removeData Then
        ClearDatasetResultCache
    ElseIf TryDatasetResult(funcArgs, datasetValues) Then
        datasetHitCount = datasetHitCount + 1
        GetDataset = datasetValues
        errCount = 0
        GoTo CleanExit
    End If

    ' --- Case 1: this PC cannot ask the server at all ---
    refusal = DatasetGatewayRefusal()
    If Len(refusal) > 0 Then
        GetDataset = refusal
        GoTo CleanExit
    End If

    ' --- Case 2: ask the server for the figures ---
    ufLoading.UpdateText "Updating [" & DatasetRequestLabel(funcArgs) & "]"
    datasetFetchCount = datasetFetchCount + 1
    datasetValues = GetDatasetFromGateway(funcArgs)
    If IsArray(datasetValues) Then
        StoreDatasetResult funcArgs, datasetValues
        errCount = 0
    End If
    GetDataset = datasetValues

CleanExit:
    Unload ufLoading
    ufLoading.Reset
    Exit Function

ErrHandler:
    Debug.Print "GetDataset error: "; Err.Number; Err.Description
    GetDataset = "ArcRho error " & Err.Number & ": " & Err.Description
    Resume CleanExit

End Function


' Empty when this PC can ask the ArcRho Server for project data. Otherwise the
' one line a cell shows in place of its figures, saying what to do about it
' rather than naming a file, a folder or a server.
Private Function DatasetGatewayRefusal() As String
    If Not GatewayIsConfigured() Then
        DatasetGatewayRefusal = "(this PC is not set up to read ArcRho data. " & _
            "Ask the ArcRho team to give you access, then restart Excel.)"
        Exit Function
    End If
    If Not GatewayServesDatasetCsv() Then
        DatasetGatewayRefusal = "(ArcRho is not ready to answer this yet. " & _
            "Ask the ArcRho team to update the ArcRho Server.)"
    End If
End Function

' What the loading window names while the server answers.
Private Function DatasetRequestLabel(ByVal funcArgs As String) As String
    DatasetRequestLabel = GetParamValue(funcArgs, "DatasetName")
    If Len(DatasetRequestLabel) > 0 Then Exit Function
    DatasetRequestLabel = GetParamValue(funcArgs, "Function")
End Function

' The dataset as the server sees it, or the reason it could not answer. The
' server's own message is passed through, so a user is never told a file is
' missing when the real cause was a refusal or an unreachable server.
Private Function GetDatasetFromGateway(ByVal funcArgs As String)
    Dim csvText As String
    Dim message As String

    If GatewayDatasetCsv(funcArgs, removeData, csvText, message) Then
        GetDatasetFromGateway = DataArrayFromText(csvText)
    Else
        Debug.Print "[error] - ArcRho Server: "; message
        GetDatasetFromGateway = "(" & message & ")"
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

Public Function ReadUtf8TextFile(ByVal filePath As String) As String
    Dim stream As Object
    Set stream = CreateObject("ADODB.Stream")
    stream.Type = 2
    stream.Charset = "utf-8"
    stream.Open
    stream.LoadFromFile filePath
    ReadUtf8TextFile = stream.ReadText(-1)
    stream.Close
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

Public Function JsonQuote(ByVal value As String) As String
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

Public Function DataArrayFromText(ByVal fileContent As String)
' *-------------------------------------------------------------*
' | Turn the CSV text the ArcRho Server answered with into the   |
' | array a worksheet formula returns. Every number a formula    |
' | shows is parsed here and nowhere else.                       |
' *-------------------------------------------------------------*
    Dim outputArray() As Variant
    Dim lines() As String
    Dim dateTimeString As String
    Dim data() As String
    Dim normalizedContent As String
    Dim i As Long, j As Long

    normalizedContent = Replace(fileContent, vbCrLf, vbLf)
    normalizedContent = Replace(normalizedContent, vbCr, vbLf)
    Do While Right$(normalizedContent, 1) = vbLf
        normalizedContent = Left$(normalizedContent, Len(normalizedContent) - 1)
    Loop

    If Len(normalizedContent) = 0 Then
        ReDim outputArray(0 To 0, 0 To 0)
        DataArrayFromText = outputArray
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

    DataArrayFromText = outputArray
End Function







