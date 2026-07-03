
Private Sub Workbook_Open()

    ' UDF help metadata is registered during the XLAM build.
    ' Register_ArcRhoTri_Help_Safe
    
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
    
    ' StartPendingWatcher
    
End Sub


Sub SetValue()
    lastRequestInfo = "N"
End Sub


Sub trest()
    Debug.Print lastRequestInfo
End Sub

