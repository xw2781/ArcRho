Option Private Module
Option Explicit

' Both ribbon actions and the no-progress option use this same refresh path.
' Only an explicit refresh opens network access, scoped to its workbook/sheet.
Public Sub RefreshWorkbookSnapshots(Optional ByVal activeSheetOnly As Boolean = False, Optional ByVal showProgress As Boolean = True)
    Dim book As Workbook, sheet As Worksheet, savedSheet As Object
    Dim blocks As Collection, block As Range, ws As Worksheet
    Dim oldLoading As Boolean, oldScreen As Boolean, oldCancel As XlEnableCancelKey
    Dim index As Long, pass As Long, beforeRequests As Long, maxPasses As Long
    Dim started As Boolean, completed As Boolean, message As String
    If DatasetRefreshRunning() Then Exit Sub
    oldLoading = disable_ufLoading
    oldScreen = Application.ScreenUpdating
    oldCancel = Application.EnableCancelKey
    On Error GoTo Failed
    Set book = ActiveWorkbook
    If book Is Nothing Then Exit Sub
    If book Is ThisWorkbook Then Exit Sub
    Set savedSheet = book.ActiveSheet
    If activeSheetOnly Then
        If Not TypeOf savedSheet Is Excel.Worksheet Then Exit Sub
        Set sheet = savedSheet
    End If
    Application.EnableCancelKey = xlErrorHandler
    disable_ufLoading = True
    skipDataProcess = False
    cancelUpdate = False
    If showProgress Then
        Show_ufProgressBar
        ufProgressBar.LabelTitle.Caption = "Finding ArcRho formulas ..."
    End If
    Set blocks = FindRefreshBlocks(book, sheet)
    If cancelUpdate Then GoTo Finish
    If blocks.Count = 0 Then
        message = "No ArcRho formulas found."
        GoTo Finish
    End If
    If book.ProtectStructure Then Err.Raise 5, , "Unprotect the workbook structure before refreshing ArcRho."
    EnsureGatewayCredential
    If Not GatewayIsConfigured() Then Err.Raise 5, , "This PC is not set up to refresh ArcRho data."
    If Not GatewayServesDatasetCsv() Then Err.Raise 5, , "Ask the ArcRho team to update the ArcRho Server."
    BeginDatasetRefresh book, sheet
    started = True
    If showProgress Then ufProgressBar.LabelTitle.Caption = "Refreshing " & blocks.Count & " ArcRho range(s)"
    For Each block In blocks
        If cancelUpdate Then GoTo Finish
        block.Dirty
        block.Calculate
        If Len(DatasetRefreshError()) > 0 Then Err.Raise 5, , DatasetRefreshError()
        index = index + 1
        Application.StatusBar = "ArcRho: " & index & "/" & blocks.Count & " range(s) refreshed"
        If showProgress Then
            ufProgressBar.LabelBody.Caption = block.Worksheet.Name & "!" & block.Address
            ufProgressBar.LabelDetails.Caption = index & "/" & blocks.Count & " range(s) refreshed"
            ufProgressBar.UpdateProgressBar index / blocks.Count * 100
        Else
            DoEvents
        End If
    Next block

    ' Resolve local formulas used as UDF arguments across sheets. The request
    ' dictionary shares repeated requests throughout this refresh, including
    ' these dependency passes. Never calculate another open workbook.
    maxPasses = book.Worksheets.Count + 1
    If activeSheetOnly Then maxPasses = 2
    For pass = 1 To maxPasses
        beforeRequests = datasetFetchCount
        CalculateRefreshScope book, sheet
        If cancelUpdate Then GoTo Finish
        If Len(DatasetRefreshError()) > 0 Then Err.Raise 5, , DatasetRefreshError()
        If pass > 1 And beforeRequests = datasetFetchCount Then Exit For
    Next pass
    Application.ScreenUpdating = False
    ' Keep requests belonging to formulas behind IF branches or workbook names
    ' that Excel did not evaluate during this pass.
    CommitDatasetRefresh
    completed = True
    message = "Refreshed at " & Format$(Now, "hh:nn:ss") & ". Save the workbook to share these values."
Finish:
    If started Then
        EndDatasetRefresh
        ' A failed or cancelled pass restores cells from the saved snapshot.
        ' A successful pass also finishes with exactly what will be saved.
        On Error Resume Next
        For Each block In blocks
            block.Dirty
            block.Calculate
        Next block
        CalculateRefreshScope book, sheet
        On Error GoTo 0
    End If
    If cancelUpdate Then message = "Refresh cancelled; the previous snapshot is unchanged."
    If showProgress Then Unload ufProgressBar
    disable_ufLoading = oldLoading
    Application.ScreenUpdating = oldScreen
    Application.EnableCancelKey = oldCancel
    cancelUpdate = False
    If Not savedSheet Is Nothing Then savedSheet.Activate
    Application.StatusBar = "ArcRho [" & book.Name & "]: " & message
    If Not completed And Len(message) > 0 Then Debug.Print Application.StatusBar
    Exit Sub
Failed:
    message = "Refresh failed; the previous snapshot is unchanged. " & Err.Description
    If Err.Number = 18 Then cancelUpdate = True
    Resume Finish
End Sub

Private Function FindRefreshBlocks(ByVal book As Workbook, ByVal onlySheet As Worksheet) As Collection
    Dim result As New Collection, seen As Object, ws As Worksheet
    Dim formulas As Range, cell As Range, block As Range, key As String
    Set seen = CreateObject("Scripting.Dictionary")
    For Each ws In book.Worksheets
        If ws.Name <> SNAPSHOT_SHEET Then
            If onlySheet Is Nothing Then
                Set formulas = FormulaCells(ws)
            ElseIf ws Is onlySheet Then
                Set formulas = FormulaCells(ws)
            Else
                Set formulas = Nothing
            End If
            If Not formulas Is Nothing Then
                For Each cell In formulas
                    If cancelUpdate Then Exit For
                    If InStr(1, cell.Formula, "ArcRho", vbTextCompare) > 0 Or _
                       InStr(1, cell.Formula, "ADAS", vbTextCompare) > 0 Then
                        If cell.HasArray Then
                            Set block = cell.CurrentArray
                        Else
                            Set block = cell
                        End If
                        key = ws.Index & "!" & block.Address
                        If Not seen.Exists(key) Then
                            result.Add block
                            seen.Add key, True
                        End If
                    End If
                Next cell
            End If
        End If
        If cancelUpdate Then Exit For
        DoEvents
    Next ws
    Set FindRefreshBlocks = result
End Function

Private Function FormulaCells(ByVal ws As Worksheet) As Range
    On Error Resume Next
    Set FormulaCells = ws.UsedRange.SpecialCells(xlCellTypeFormulas)
    On Error GoTo 0
End Function

Private Sub CalculateRefreshScope(ByVal book As Workbook, ByVal onlySheet As Worksheet)
    Dim ws As Worksheet
    If Not onlySheet Is Nothing Then
        onlySheet.Calculate
    Else
        For Each ws In book.Worksheets
            If ws.Name <> SNAPSHOT_SHEET Then ws.Calculate
        Next ws
    End If
End Sub
