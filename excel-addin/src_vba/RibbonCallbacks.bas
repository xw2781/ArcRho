Attribute VB_Name = "RibbonCallbacks"

'+----------+
'|  Group 1 |
'+----------+

' Connection and Login
Sub uiSetupConnection2(control As IRibbonControl)
    SetupConnection2
End Sub

' Calculate Sheet
Sub uiRefreshSheet(control As IRibbonControl)
    CalculateSheet
End Sub

' Calculate Workbook
Sub uiRefreshWorkbook(control As IRibbonControl)
    CalculateWorkbook
End Sub

'+----------+
'|  Group 2 |
'+----------+

' Insert Function: the Arco function panel, which also edits the Arco formula
' in the selected cell.
Sub uiInsertFunction(control As IRibbonControl)
    If ActiveWorkbook Is Nothing Then Exit Sub
    ufInsertFunction.Show vbModeless
End Sub

' Clear Formulas
Sub uiClearResQFormulae2(control As IRibbonControl)
    MsgBox "NaN"
End Sub

' Load Reserving Classes
Sub uiLoadReservingClasses2(control As IRibbonControl)
    If Len(WorkbookDefaultProject(ActiveWorkbook)) = 0 Then
        WarnNoDefaultProject "Load Reserving Classes"
        Exit Sub
    End If
    ufLoadReservingClasses.Show vbModeless
End Sub

' Select Dataset
Sub uiSelectDatasets(control As IRibbonControl)
    If Len(WorkbookDefaultProject(ActiveWorkbook)) = 0 Then
        WarnNoDefaultProject "Select Datasets"
        Exit Sub
    End If
    ufSelectDataset.Show vbModeless
End Sub

' Copy Active Range Address
Sub uiCopyActiveRangeAddress(control As IRibbonControl)
    CopyActiveRangeAddress
End Sub

'+----------+
'|  Group 3 |
'+----------+

' Reset References: retarget add-in links and rename old formulas to Arco names.
Sub uiResetAddinReferences(control As IRibbonControl)
    If ActiveWorkbook Is Nothing Then Exit Sub
    If ActiveWorkbook.IsAddin Then Exit Sub
    ufAddinReferences.ShowDialog
End Sub

' Load Add-in
Sub uiLoadAddIn(control As IRibbonControl)
    LoadAddIn
End Sub

' Unload Add-in
Sub uiUnloadAddIn(control As IRibbonControl)
    UnloadAddIn
End Sub

'+----------+
'|  Group 4 |
'+----------+

' Check Updates
Sub uiCheckUpdates(control As IRibbonControl)
    ' CheckUpdates
    ufBuildTriangle.Show
End Sub

' User Settings
Sub uiSettings(control As IRibbonControl)
    ufSettings.Show vbModeless
End Sub

' About
Sub uiAbout(control As IRibbonControl)
    ufAbout.Show vbModeless
End Sub

