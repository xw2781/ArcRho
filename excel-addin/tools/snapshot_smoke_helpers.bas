Attribute VB_Name = "SnapshotSmokeHelpers"
Option Explicit

' Imported only into the isolated smoke-test runtime. No live Gateway calls.
Private calls As Long
Private offset As Double
Private failureMode As String
Private progressCalls As Long
Private firstProgress As Double
Private credentialCalls As Long

Public Function SmokeBasic() As String
    SmokeBasic = "ready"
End Function

Public Sub EnsureGatewayCredential()
    credentialCalls = credentialCalls + 1
End Sub

Public Function SmokeCredentialCalls() As Long
    SmokeCredentialCalls = credentialCalls
End Function

Public Function GatewayIsConfigured() As Boolean
    GatewayIsConfigured = True
End Function

Public Function GatewayServesDatasetCsv() As Boolean
    GatewayServesDatasetCsv = True
End Function

Public Sub Show_ufProgressBar()
    ufProgressBar.Show vbModeless
    DoEvents
End Sub

Public Function GatewayDatasetCsv(ByVal request As String, ByRef csv As String, ByRef message As String) As Boolean
    Dim form As Object
    calls = calls + 1
    For Each form In VBA.UserForms
        If TypeName(form) = "ufProgressBar" And form.Visible Then
            If progressCalls = 0 Then firstProgress = Val(form.LabelPct.Caption)
            progressCalls = progressCalls + 1
        End If
    Next form
    If failureMode = "fail" Then
        message = "Simulated Gateway failure"
        Exit Function
    End If
    If failureMode = "cancel" Then cancelUpdate = True
    Select Case GetParamValue(request, "DatasetName")
        Case "Single": csv = CStr(7 + offset)
        Case "Blank": csv = ""
        Case "Vertical": csv = "10" & vbLf & "20" & vbLf & "30"
        Case "Horizontal": csv = "10,20,30"
        Case "VectorSingle": csv = "42"
        Case "ProjectVector"
            If GetParamValue(request, "ProjectName") = "Beta" Then
                csv = "200" & vbLf & "210" & vbLf & "220"
            Else
                csv = "100" & vbLf & "110" & vbLf & "120"
            End If
        Case Else
            If GetParamValue(request, "ProjectName") = "Beta" Then
                csv = CStr(200 + offset) & ",210" & vbLf & "220,"
            Else
                csv = CStr(100 + offset) & ",110" & vbLf & "120,"
            End If
    End Select
    GatewayDatasetCsv = True
End Function

Public Function SmokeCalls() As Long
    SmokeCalls = calls
End Function

Public Sub SmokeResponse(ByVal newOffset As Double, Optional ByVal mode As String = "")
    offset = newOffset
    failureMode = mode
End Sub

Public Sub SmokeRefresh(Optional ByVal sheetOnly As Boolean = False, Optional ByVal showProgress As Boolean = False)
    RefreshWorkbookSnapshots sheetOnly, showProgress
End Sub

Public Function SmokeProgressCalls() As Long
    SmokeProgressCalls = progressCalls
End Function

Public Function SmokeFirstProgress() As Double
    SmokeFirstProgress = firstProgress
End Function

Public Function SmokeProgressVisible() As Boolean
    Dim form As Object
    For Each form In VBA.UserForms
        If TypeName(form) = "ufProgressBar" And form.Visible Then SmokeProgressVisible = True
    Next form
End Function

Public Function SmokeFailedRefresh(ByVal mode As String, Optional ByVal showProgress As Boolean = False) As Boolean
    On Error GoTo ExpectedFailure
    failureMode = mode
    RefreshWorkbookSnapshots False, showProgress
    SmokeFailedRefresh = InStr(1, CStr(Application.StatusBar), "unchanged", vbTextCompare) > 0
    failureMode = ""
    Exit Function
ExpectedFailure:
    failureMode = ""
    SmokeFailedRefresh = True
End Function

Public Sub SmokeBegin(ByVal bookName As String, Optional ByVal sheetName As String = "")
    cancelUpdate = False
    If Len(sheetName) > 0 Then
        BeginDatasetRefresh Workbooks(bookName), Workbooks(bookName).Worksheets(sheetName)
    Else
        BeginDatasetRefresh Workbooks(bookName)
    End If
End Sub

Public Sub SmokeEnd()
    CommitDatasetRefresh
    EndDatasetRefresh
End Sub

Public Sub SmokeAbort()
    EndDatasetRefresh
End Sub

Public Sub SmokeForget(ByVal bookName As String)
    SnapshotForget Workbooks(bookName)
End Sub

Public Sub SmokePrepare(ByVal bookName As String)
    SnapshotPrepare Workbooks(bookName)
End Sub

Public Function SmokeBlocks(ByVal bookName As String, ByVal address As String) As String
    Dim block As Range, blocks As Collection
    Set blocks = FindArcRhoFormulaBlocks(Workbooks(bookName).Worksheets(1).Range(address))
    For Each block In blocks
        If Len(SmokeBlocks) > 0 Then SmokeBlocks = SmokeBlocks & "|"
        SmokeBlocks = SmokeBlocks & block.Address
    Next block
End Function

Public Sub SmokeSeedTypes(ByVal bookName As String)
    Dim updates As Object, values As Variant
    Set updates = CreateObject("Scripting.Dictionary")
    ReDim values(1 To 2, 1 To 4)
    values(1, 1) = "": values(1, 2) = "00123"
    values(1, 3) = "=1+1": values(1, 4) = "~literal"
    values(2, 1) = 4.5: values(2, 2) = True
    values(2, 3) = CVErr(xlErrNA): values(2, 4) = Empty
    updates("type-check") = values
    ReDim values(1 To 1, 1 To 1)
    values(1, 1) = ""
    updates("single-blank") = values
    SnapshotCommit Workbooks(bookName), updates
End Sub

Public Function SmokeSnapshotCell(ByVal bookName As String, ByVal key As String, ByVal row As Long, ByVal col As Long) As Variant
    Dim values As Variant
    If Not SnapshotRead(Workbooks(bookName), key, values) Then Err.Raise 5, , "Missing smoke snapshot entry"
    SmokeSnapshotCell = values(row, col)
End Function

Public Function SmokeSnapshotType(ByVal bookName As String, ByVal key As String, ByVal row As Long, ByVal col As Long) As Long
    Dim values As Variant
    If Not SnapshotRead(Workbooks(bookName), key, values) Then Err.Raise 5, , "Missing smoke snapshot entry"
    SmokeSnapshotType = VarType(values(row, col))
End Function

Public Function SmokeSnapshotSheet() As String
    SmokeSnapshotSheet = SNAPSHOT_SHEET
End Function

Public Function SmokeRequiredMessage() As String
    SmokeRequiredMessage = SNAPSHOT_REFRESH_REQUIRED
End Function

Public Function SmokeRequestKeys() As Boolean
    Dim triangle As String, headers As String
    triangle = "Function = ArcRhoTri#DatasetName = Paid#Transposed = "
    headers = "Function = ArcRhoHeaders#periodType = 1#Transposed = "
    SmokeRequestKeys = (SnapshotRequestKey(triangle & "True") = SnapshotRequestKey(triangle & "False")) And _
                       (SnapshotRequestKey(headers & "True") <> SnapshotRequestKey(headers & "False"))
End Function
