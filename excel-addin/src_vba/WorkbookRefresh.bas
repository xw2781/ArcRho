Option Private Module
Option Explicit

Private refreshing As Boolean

Public Function WorkbookRefreshRunning() As Boolean
    WorkbookRefreshRunning = refreshing
End Function

' Both ribbon actions and the no-progress option use this same refresh path.
' Explicit refresh replaces saved requests within its workbook/sheet scope.
Public Sub RefreshWorkbookSnapshots(Optional ByVal activeSheetOnly As Boolean = False, Optional ByVal showProgress As Boolean = True)
    Dim book As Workbook, sheet As Worksheet, savedSheet As Object
    Dim blocks As Collection, block As Range
    Dim oldLoading As Boolean, oldScreen As Boolean, oldCancel As XlEnableCancelKey
    Dim index As Long, pass As Long, beforeRequests As Long, maxPasses As Long
    Dim started As Boolean, completed As Boolean, message As String
    If refreshing Or DatasetRefreshRunning() Then Exit Sub
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
    refreshing = True
    Application.EnableCancelKey = xlErrorHandler
    disable_ufLoading = True
    skipDataProcess = False
    cancelUpdate = False
    If showProgress Then
        Show_ufProgressBar
        ufProgressBar.LabelTitle.Caption = "Finding ArcRho formulas ..."
    End If
    Set blocks = FindRefreshBlocks(book, sheet, showProgress)
    If cancelUpdate Then GoTo Finish
    If blocks.Count = 0 Then
        message = "No ArcRho formulas found."
        GoTo Finish
    End If
    If book.ProtectStructure Then Err.Raise 5, , "Unprotect the workbook structure before refreshing ArcRho."
    RefreshProgress showProgress, "Preparing connection ...", book.Name, "", 15
    If cancelUpdate Then GoTo Finish
    EnsureGatewayCredential
    If Not GatewayIsConfigured() Then Err.Raise 5, , "This PC is not set up to refresh ArcRho data."
    If Not GatewayServesDatasetCsv() Then Err.Raise 5, , "Ask the ArcRho team to update the ArcRho Server."
    BeginDatasetRefresh book, sheet
    started = True
    For Each block In blocks
        If cancelUpdate Then GoTo Finish
        RefreshProgress showProgress, "Refreshing ArcRho data ...", _
            block.Worksheet.Name & "!" & block.Address, _
            index & "/" & blocks.Count & " range(s) refreshed", 15 + index / blocks.Count * 70
        If cancelUpdate Then GoTo Finish
        block.Dirty
        block.Calculate
        If Len(DatasetRefreshError()) > 0 Then Err.Raise 5, , DatasetRefreshError()
        index = index + 1
        RefreshProgress showProgress, "Refreshing ArcRho data ...", _
            block.Worksheet.Name & "!" & block.Address, _
            index & "/" & blocks.Count & " range(s) refreshed", 15 + index / blocks.Count * 70
    Next block

    ' Resolve local formulas used as UDF arguments across sheets. The request
    ' dictionary shares repeated requests throughout this refresh, including
    ' these dependency passes. Never calculate another open workbook.
    maxPasses = book.Worksheets.Count + 1
    If activeSheetOnly Then maxPasses = 2
    For pass = 1 To maxPasses
        RefreshProgress showProgress, "Calculating workbook dependencies ...", book.Name, _
            "Pass " & pass & " of " & maxPasses, 85 + (pass - 1) / maxPasses * 10
        If cancelUpdate Then GoTo Finish
        beforeRequests = datasetFetchCount
        CalculateRefreshScope book, sheet
        If cancelUpdate Then GoTo Finish
        If Len(DatasetRefreshError()) > 0 Then Err.Raise 5, , DatasetRefreshError()
        If pass > 1 And beforeRequests = datasetFetchCount Then Exit For
    Next pass
    RefreshProgress showProgress, "Saving refreshed values in the workbook ...", book.Name, "", 95
    If cancelUpdate Then GoTo Finish
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
    If cancelUpdate And Not completed Then message = "Refresh cancelled; the previous snapshot is unchanged."
    If completed Then RefreshProgress showProgress, "Refresh complete", book.Name, "", 100
    If showProgress Then Unload ufProgressBar
    disable_ufLoading = oldLoading
    Application.ScreenUpdating = oldScreen
    Application.EnableCancelKey = oldCancel
    cancelUpdate = False
    refreshing = False
    If Not savedSheet Is Nothing Then savedSheet.Activate
    Application.StatusBar = "ArcRho [" & book.Name & "]: " & message
    If Not completed And Len(message) > 0 Then Debug.Print Application.StatusBar
    Exit Sub
Failed:
    message = "Refresh failed; the previous snapshot is unchanged. " & Err.Description
    If Err.Number = 18 Then cancelUpdate = True
    Resume Finish
End Sub

Private Function FindRefreshBlocks(ByVal book As Workbook, ByVal onlySheet As Worksheet, _
                                   ByVal showProgress As Boolean) As Collection
    Dim result As New Collection, found As Collection, ws As Worksheet, block As Range
    Dim sheetCount As Long, sheetIndex As Long
    sheetCount = book.Worksheets.Count
    If Not onlySheet Is Nothing Then sheetCount = 1
    For Each ws In book.Worksheets
        If ws.Name <> SNAPSHOT_SHEET And (onlySheet Is Nothing Or ws Is onlySheet) Then
            Set found = FindArcRhoFormulaBlocks(ws.UsedRange, showProgress, _
                                                sheetIndex / sheetCount * 15, 15 / sheetCount)
            For Each block In found
                result.Add block
            Next block
            sheetIndex = sheetIndex + 1
        End If
        If cancelUpdate Then Exit For
        DoEvents
    Next ws
    Set FindRefreshBlocks = result
End Function

' Read formulas in bounded batches. A legacy array repeats its formula in every
' result cell; record its rectangle once instead of resolving CurrentArray for
' every output cell (which becomes quadratic for large worksheet arrays).
Public Function FindArcRhoFormulaBlocks(ByVal scope As Range, Optional ByVal showProgress As Boolean = False, _
                                       Optional ByVal percentStart As Double = 0, Optional ByVal percentSpan As Double = 15) As Collection
    Const BATCH_CELLS As Long = 8192
    Dim result As New Collection, formulas As Range, area As Range, batch As Range
    Dim cell As Range, block As Range, seen As Object, skipRows As Object, spans As Collection
    Dim texts As Variant, span As Variant, text As String, key As String
    Dim firstRow As Long, rowsPerBatch As Long, rowCount As Long, width As Long, batchRow As Long, batchCol As Long
    Dim r As Long, c As Long, sheetRow As Long, sheetCol As Long, lastRow As Long, lastCol As Long
    Dim scanned As Double, total As Double, sinceProgress As Double
    Set seen = CreateObject("Scripting.Dictionary")
    Set skipRows = CreateObject("Scripting.Dictionary")
    On Error Resume Next
    Set formulas = Application.Intersect(scope, scope.SpecialCells(xlCellTypeFormulas))
    On Error GoTo 0
    If formulas Is Nothing Then
        Set FindArcRhoFormulaBlocks = result
        Exit Function
    End If
    total = formulas.CountLarge
    For Each area In formulas.Areas
        width = area.Columns.Count
        rowsPerBatch = BATCH_CELLS \ width
        If rowsPerBatch < 1 Then rowsPerBatch = 1
        For firstRow = 1 To area.Rows.Count Step rowsPerBatch
            rowCount = rowsPerBatch
            If firstRow + rowCount - 1 > area.Rows.Count Then rowCount = area.Rows.Count - firstRow + 1
            Set batch = area.Cells(firstRow, 1).Resize(rowCount, width)
            batchRow = batch.Row
            batchCol = batch.Column
            texts = batch.Formula
            If Not IsArray(texts) Then
                ReDim texts(1 To 1, 1 To 1)
                texts(1, 1) = batch.Formula
            End If
            For r = 1 To rowCount
                sheetRow = batchRow + r - 1
                c = 1
                Do While c <= width
                    sheetCol = batchCol + c - 1
                    If skipRows.Exists(sheetRow) Then
                        For Each span In skipRows(sheetRow)
                            If sheetCol >= span(0) And sheetCol <= span(1) Then
                                c = span(1) - batchCol + 2
                                Exit For
                            End If
                        Next span
                    End If
                    If c > width Then Exit Do
                    If sheetCol <> batchCol + c - 1 Then GoTo NextCell
                    text = CStr(texts(r, c))
                    If InStr(1, text, "ArcRho", vbTextCompare) > 0 Or InStr(1, text, "ADAS", vbTextCompare) > 0 Then
                        Set cell = batch.Cells(r, c)
                        Set block = cell
                        If cell.HasArray Then Set block = cell.CurrentArray
                        key = block.Address
                        If Not seen.Exists(key) Then
                            seen.Add key, True
                            result.Add block
                            If block.CountLarge > 1 Then
                                lastRow = block.Row + block.Rows.Count - 1
                                lastCol = block.Column + block.Columns.Count - 1
                                For sheetRow = block.Row To lastRow
                                    If Not skipRows.Exists(sheetRow) Then
                                        Set spans = New Collection
                                        skipRows.Add sheetRow, spans
                                    End If
                                    skipRows(sheetRow).Add Array(block.Column, lastCol)
                                Next sheetRow
                                sheetRow = batchRow + r - 1
                                c = lastCol - batchCol + 1
                            End If
                        End If
                    End If
                    c = c + 1
NextCell:
                Loop
            Next r
            scanned = scanned + batch.CountLarge
            sinceProgress = sinceProgress + batch.CountLarge
            If sinceProgress >= BATCH_CELLS Or scanned = total Then
                If showProgress Then
                    RefreshProgress True, "Finding ArcRho formulas ...", scope.Worksheet.Name, _
                        result.Count & " ArcRho range(s) found", percentStart + scanned / total * percentSpan
                Else
                    DoEvents
                End If
                sinceProgress = 0
            End If
            If cancelUpdate Then Exit For
        Next firstRow
        If cancelUpdate Then Exit For
    Next area
    Set FindArcRhoFormulaBlocks = result
End Function

Private Sub RefreshProgress(ByVal showProgress As Boolean, ByVal title As String, _
                            ByVal body As String, ByVal details As String, ByVal percent As Double)
    Application.StatusBar = "ArcRho: " & title & " " & body & " " & details
    If showProgress Then
        ufProgressBar.LabelTitle.Caption = title
        ufProgressBar.LabelBody.Caption = body
        ufProgressBar.LabelDetails.Caption = details
        ufProgressBar.UpdateProgressBar percent
    Else
        DoEvents
    End If
End Sub

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
