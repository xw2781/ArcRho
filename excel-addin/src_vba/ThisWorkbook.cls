
Private Sub Workbook_Open()

    ' UDF help metadata is registered during the XLAM build.
    ' RegisterArcoFunctionHelp
    
    InitializeSnapshotEvents
    LoadConfig
    
    triangle_tool_row = 10
    triangle_tool_col = 10
    
    ' Default Internal Control
    disableRequest = False
    disableWaitTime = False
    skipDataProcess = False
    cancelUpdate = False
    lastRequestInfo = "N"
    errCount = 0
    
    Set processedCells = New Collection
    Set processedArrays = New Collection

    ' Saved workbook snapshots can be read without contacting the server.
    ' Entering formulas or explicitly refreshing can enroll credentials.
    
    ' StartPendingWatcher
    
End Sub


Sub SetValue()
    lastRequestInfo = "N"
End Sub


Sub trest()
    Debug.Print lastRequestInfo
End Sub

