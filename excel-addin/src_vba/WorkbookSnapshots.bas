Option Private Module
Option Explicit

Public Const SNAPSHOT_SHEET As String = "_ArcRhoCache"
Public Const SNAPSHOT_REFRESH_REQUIRED As String = "(ArcRho: Refresh Worksheet or Refresh Workbook to load saved data.)"
Private Const SNAPSHOT_SIGNATURE As String = "ArcRho workbook snapshot"
Private Const SNAPSHOT_VERSION As Long = 1
Private snapshotBooks As Collection
Private snapshotEntries As Collection
Private snapshotEvents As SnapshotEvents

Public Function CallerWorkbook() As Workbook
    Dim caller As Object
    On Error Resume Next
    Set caller = Application.Caller
    On Error GoTo 0
    If TypeOf caller Is Excel.Range Then
        Set CallerWorkbook = caller.Worksheet.Parent
    Else
        Set CallerWorkbook = ActiveWorkbook
    End If
End Function

' Keep names case-sensitive, normalize pair whitespace, and omit only the
' triangle/vector transpose performed locally after GetDataset. Header shape
' fields remain distinct because the server owns their output orientation.
Public Function SnapshotRequestKey(ByVal funcArgs As String) As String
    Dim pair As Variant, parts As Variant, pos As Long
    Dim key As String, value As String, result As String, functionName As String
    functionName = LCase$(GetParamValue(funcArgs, "Function"))
    parts = Split(Replace$(Replace$(Replace$(funcArgs, vbCrLf, "#"), vbCr, "#"), vbLf, "#"), "#")
    For Each pair In parts
        pos = InStr(1, pair, "=", vbBinaryCompare)
        If pos > 1 Then
            key = LCase$(Trim$(Left$(pair, pos - 1)))
            value = Trim$(Mid$(pair, pos + 1))
            If key <> "transposed" Or (functionName <> "arcrhotri" And functionName <> "arcrhovec") Then
                If key = "datasetname" Then value = NormalizeDatasetName(value)
                result = result & Len(key) & ":" & key & Len(value) & ":" & value
            End If
        End If
    Next pair
    SnapshotRequestKey = result
End Function

Public Function SnapshotRead(ByVal book As Workbook, ByVal requestKey As String, ByRef values As Variant) As Boolean
    Dim entries As Object, entry As Variant
    Set entries = EntriesForBook(book)
    If Not entries.Exists(requestKey) Then Exit Function
    entry = entries(requestKey)
    values = entry(1)
    SnapshotRead = True
End Function

Public Sub SnapshotPrepare(ByVal book As Workbook)
    Dim entries As Object
    Set entries = EntriesForBook(book)
End Sub

Public Sub SnapshotForget(ByVal book As Workbook)
    Dim i As Long
    If snapshotBooks Is Nothing Then Exit Sub
    For i = snapshotBooks.Count To 1 Step -1
        If snapshotBooks(i) Is book Then
            snapshotBooks.Remove i
            snapshotEntries.Remove i
        End If
    Next i
End Sub

Private Function EntriesForBook(ByVal book As Workbook) As Object
    Dim i As Long, entries As Object
    If book Is Nothing Then Err.Raise 5, , "No workbook is available for the ArcRho snapshot."
    If snapshotBooks Is Nothing Then
        Set snapshotBooks = New Collection
        Set snapshotEntries = New Collection
        Set snapshotEvents = New SnapshotEvents
        Set snapshotEvents.App = Application
    End If
    For i = 1 To snapshotBooks.Count
        If snapshotBooks(i) Is book Then
            Set EntriesForBook = snapshotEntries(i)
            Exit Function
        End If
    Next i
    Set entries = ReadSnapshot(book)
    snapshotBooks.Add book
    snapshotEntries.Add entries
    Set EntriesForBook = entries
End Function

Private Function CacheSheet(ByVal book As Workbook) As Worksheet
    On Error Resume Next
    Set CacheSheet = book.Worksheets(SNAPSHOT_SHEET)
    On Error GoTo 0
End Function

Private Function ReadSnapshot(ByVal book As Workbook) As Object
    Dim ws As Worksheet, entries As Object, block As Variant, values As Variant
    Dim row As Long, count As Long, rows As Long, cols As Long, r As Long, c As Long
    Dim requestKey As String, refreshed As String, lowerRow As Long, lowerCol As Long
    Set entries = CreateObject("Scripting.Dictionary")
    Set ws = CacheSheet(book)
    If Not ws Is Nothing Then
        If ws.Cells(1, 1).Value2 <> SNAPSHOT_SIGNATURE Or ws.Cells(1, 2).Value2 <> SNAPSHOT_VERSION Then
            Err.Raise 5, , "The workbook's ArcRho snapshot has an unsupported format."
        End If
        count = CLng(ws.Cells(2, 2).Value2)
        row = 4
        Do While count > 0
            block = ws.Cells(row, 1).Resize(1, 6).Value2
            requestKey = CStr(block(1, 1))
            rows = CLng(block(1, 2)): cols = CLng(block(1, 3))
            refreshed = CStr(block(1, 4))
            lowerRow = CLng(block(1, 5)): lowerCol = CLng(block(1, 6))
            If rows < 1 Or cols < 1 Or row + rows > ws.Rows.Count Or cols > ws.Columns.Count Then
                Err.Raise 5, , "The workbook's ArcRho snapshot is incomplete."
            End If
            block = ws.Cells(row + 1, 1).Resize(rows, cols).Value2
            ReDim values(lowerRow To lowerRow + rows - 1, lowerCol To lowerCol + cols - 1)
            For r = 1 To rows
                For c = 1 To cols
                    If rows = 1 And cols = 1 Then
                        values(lowerRow + r - 1, lowerCol + c - 1) = DecodeSnapshotValue(block)
                    Else
                        values(lowerRow + r - 1, lowerCol + c - 1) = DecodeSnapshotValue(block(r, c))
                    End If
                Next c
            Next r
            entries(requestKey) = Array(refreshed, values)
            row = row + rows + 2
            count = count - 1
        Loop
    End If
    Set ReadSnapshot = entries
End Function

Private Function DecodeSnapshotValue(ByVal value As Variant) As Variant
    If VarType(value) = vbString Then
        If Left$(value, 1) <> "~" Then Err.Raise 5, , "The workbook's ArcRho snapshot contains invalid text."
        DecodeSnapshotValue = Mid$(value, 2)
    Else
        DecodeSnapshotValue = value
    End If
End Function

' Called only by a macro after calculation finishes. Build a new hidden sheet
' before swapping it into place, so failed/cancelled refreshes retain good data.
Public Sub SnapshotCommit(ByVal book As Workbook, ByVal updates As Object, Optional ByVal replaceAll As Boolean = False)
    Dim previous As Object, merged As Object, key As Variant, refreshed As String
    Dim oldSheet As Worksheet, newSheet As Worksheet, savedSheet As Object
    Dim oldName As String, oldAlerts As Boolean, oldEvents As Boolean
    Dim errorNumber As Long, errorText As String
    On Error GoTo Failed
    oldAlerts = Application.DisplayAlerts
    oldEvents = Application.EnableEvents
    If book.ProtectStructure Then Err.Raise 5, , "Unprotect the workbook structure before refreshing ArcRho."
    Set savedSheet = book.ActiveSheet
    Set previous = EntriesForBook(book)
    Set merged = CreateObject("Scripting.Dictionary")
    If Not replaceAll Then
        For Each key In previous.Keys
            merged(key) = previous(key)
        Next key
    End If
    refreshed = Format$(Now, "yyyy-mm-dd hh:nn:ss")
    For Each key In updates.Keys
        merged(key) = Array(refreshed, updates(key))
    Next key
    Application.EnableEvents = False
    Set oldSheet = CacheSheet(book)
    Set newSheet = book.Worksheets.Add(After:=book.Sheets(book.Sheets.Count))
    WriteSnapshot newSheet, merged, refreshed
    savedSheet.Activate
    newSheet.Visible = xlSheetVeryHidden
    If Not oldSheet Is Nothing Then
        oldName = SNAPSHOT_SHEET & "_previous"
        oldSheet.Name = oldName
    End If
    newSheet.Name = SNAPSHOT_SHEET
    If Not oldSheet Is Nothing Then
        Application.DisplayAlerts = False
        oldSheet.Visible = xlSheetVisible
        oldSheet.Delete
    End If
    SnapshotForget book
    snapshotBooks.Add book
    snapshotEntries.Add merged
    Application.DisplayAlerts = oldAlerts
    Application.EnableEvents = oldEvents
    Exit Sub
Failed:
    errorNumber = Err.Number: errorText = Err.Description
    On Error Resume Next
    If Not newSheet Is Nothing Then
        Application.DisplayAlerts = False
        newSheet.Delete
    End If
    If Not oldSheet Is Nothing Then
        oldSheet.Name = SNAPSHOT_SHEET
        oldSheet.Visible = xlSheetVeryHidden
    End If
    If Not savedSheet Is Nothing Then savedSheet.Activate
    Application.DisplayAlerts = oldAlerts
    Application.EnableEvents = oldEvents
    On Error GoTo 0
    Err.Raise errorNumber, "SnapshotCommit", errorText
End Sub

Private Sub WriteSnapshot(ByVal ws As Worksheet, ByVal entries As Object, ByVal refreshed As String)
    Dim key As Variant, entry As Variant, values As Variant, encoded As Variant
    Dim row As Long, rows As Long, cols As Long, r As Long, c As Long, value As Variant
    Dim lowerRow As Long, lowerCol As Long
    ws.Cells(1, 1).Value2 = SNAPSHOT_SIGNATURE
    ws.Cells(1, 2).Value2 = SNAPSHOT_VERSION
    ws.Cells(2, 1).Value2 = "Requests"
    ws.Cells(2, 2).Value2 = entries.Count
    ws.Cells(2, 3).Value2 = "Last refreshed"
    ws.Cells(2, 4).Value2 = refreshed
    row = 4
    For Each key In entries.Keys
        entry = entries(key): values = entry(1)
        lowerRow = LBound(values, 1): lowerCol = LBound(values, 2)
        rows = UBound(values, 1) - lowerRow + 1
        cols = UBound(values, 2) - lowerCol + 1
        If row + rows > ws.Rows.Count Or cols > ws.Columns.Count Or Len(key) > 32767 Then
            Err.Raise 5, , "The ArcRho snapshot exceeds Excel's worksheet limits."
        End If
        ws.Cells(row, 1).Value2 = key
        ws.Cells(row, 2).Value2 = rows
        ws.Cells(row, 3).Value2 = cols
        ws.Cells(row, 4).Value2 = entry(0)
        ws.Cells(row, 5).Value2 = lowerRow
        ws.Cells(row, 6).Value2 = lowerCol
        ReDim encoded(1 To rows, 1 To cols)
        For r = 1 To rows
            For c = 1 To cols
                value = values(lowerRow + r - 1, lowerCol + c - 1)
                If VarType(value) = vbString Then
                    If Len(value) > 32766 Then Err.Raise 5, , "ArcRho snapshot text exceeds Excel's cell limit."
                    encoded(r, c) = "~" & value
                Else
                    encoded(r, c) = value
                End If
            Next c
        Next r
        ws.Cells(row + 1, 1).Resize(rows, cols).Value2 = encoded
        row = row + rows + 2
    Next key
End Sub
