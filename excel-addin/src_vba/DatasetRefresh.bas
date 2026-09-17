Option Private Module
Option Explicit

Private refreshBook As Workbook
Private refreshSheet As Worksheet
Private refreshResults As Object
Private refreshFailure As String
Private committing As Boolean

Public Sub BeginDatasetRefresh(ByVal book As Workbook, Optional ByVal sheet As Worksheet)
    If Not refreshBook Is Nothing Then Err.Raise 5, , "An ArcRho refresh is already running."
    SnapshotPrepare book
    Set refreshBook = book
    Set refreshSheet = sheet
    Set refreshResults = CreateObject("Scripting.Dictionary")
    refreshFailure = ""
    committing = False
    datasetRequestCount = 0
    datasetFetchCount = 0
    datasetHitCount = 0
End Sub

Public Sub EndDatasetRefresh()
    Set refreshBook = Nothing
    Set refreshSheet = Nothing
    Set refreshResults = Nothing
    committing = False
End Sub

Public Function DatasetRefreshError() As String
    DatasetRefreshError = refreshFailure
End Function

Public Function DatasetRefreshRunning() As Boolean
    DatasetRefreshRunning = Not refreshBook Is Nothing
End Function

Public Function DatasetRefreshOwnsWorkbook(ByVal book As Workbook) As Boolean
    If refreshBook Is Nothing Then Exit Function
    DatasetRefreshOwnsWorkbook = (book Is refreshBook)
End Function

Public Function DatasetRefreshInScope(ByVal book As Workbook) As Boolean
    Dim caller As Object
    If refreshBook Is Nothing Then Exit Function
    If committing Then Exit Function
    If Not book Is refreshBook Then Exit Function
    If Not refreshSheet Is Nothing Then
        On Error Resume Next
        Set caller = Application.Caller
        On Error GoTo 0
        If TypeOf caller Is Excel.Range Then
            If Not caller.Worksheet Is refreshSheet Then Exit Function
        End If
    End If
    DatasetRefreshInScope = True
End Function

Public Function RefreshDataset(ByVal funcArgs As String, ByVal requestKey As String) As Variant
    Dim values As Variant, csvText As String, message As String
    On Error GoTo Failed
    If refreshResults.Exists(requestKey) Then
        datasetHitCount = datasetHitCount + 1
        RefreshDataset = refreshResults(requestKey)
        Exit Function
    End If
    If cancelUpdate Then
        RefreshDataset = "(ArcRho refresh cancelled.)"
        Exit Function
    End If
    If Len(refreshFailure) > 0 Then
        RefreshDataset = "(" & refreshFailure & ")"
        Exit Function
    End If
    datasetFetchCount = datasetFetchCount + 1
    If GatewayDatasetCsv(funcArgs, csvText, message) Then
        values = DataArrayFromText(csvText)
        If IsArray(values) Then
            refreshResults(requestKey) = values
            RefreshDataset = values
            Exit Function
        End If
        message = "ArcRho Server answered without a data array."
    End If
    refreshFailure = message
    RefreshDataset = "(" & message & ")"
    Exit Function
Failed:
    refreshFailure = "ArcRho refresh failed: " & Err.Description
    RefreshDataset = "(" & refreshFailure & ")"
End Function

Public Sub CommitDatasetRefresh(Optional ByVal replaceAll As Boolean = False)
    Dim number As Long, description As String
    If refreshBook Is Nothing Then Err.Raise 5, , "No ArcRho refresh is running."
    If cancelUpdate Or Len(refreshFailure) > 0 Then Err.Raise 5, , "The ArcRho refresh did not finish."
    On Error GoTo Failed
    committing = True
    SnapshotCommit refreshBook, refreshResults, replaceAll
    committing = False
    Exit Sub
Failed:
    number = Err.Number: description = Err.Description
    committing = False
    Err.Raise number, "CommitDatasetRefresh", description
End Sub
