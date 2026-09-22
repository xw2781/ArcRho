Attribute VB_Name = "ReferenceRepairSmokeHelpers"
Option Explicit

Private scan As Collection
Private scanFailure As String
Private progressLog As String
Private cancelStage As String
Private cancelAfter As Double
Private dialogActivations As Long
Private dialogResult As String

Public Function Rewrite(ByVal text As String, ByVal target As String, ByVal fixPath As Boolean, ByVal rename As Boolean) As String
    Rewrite = RepairReferenceFormula(text, target, fixPath, rename)
End Function

Public Function MapFunction(ByVal text As String) As String
    MapFunction = CurrentArcoFunction(text)
End Function

Public Function ScanRepair(ByVal bookName As String, ByVal target As String, Optional ByVal prefix As String = "Arco") As Long
    On Error GoTo Failed
    scanFailure = ""
    Set scan = FindReferenceEdits(Workbooks(bookName), target, True, True, False, prefix)
    ScanRepair = scan.Count
    Exit Function
Failed:
    scanFailure = Err.Description
    ScanRepair = -1
End Function

Public Function ScanError() As String
    ScanError = scanFailure
End Function

Public Function ApplyRepair(ByVal bookName As String) As Long
    ApplyRepair = ApplyReferenceEdits(Workbooks(bookName), scan)
End Function

Public Function RepairStatuses() As String
    Dim entry As ReferenceEdit
    For Each entry In scan
        RepairStatuses = RepairStatuses & entry.Location & ": " & entry.Status & vbLf
    Next entry
End Function

Public Function ShowRepairForm() As String
    On Error GoTo Failed
    Load ufAddinReferences
    ufAddinReferences.Show vbModeless
    ShowRepairForm = ufAddinReferences.Controls("cmdTarget").Caption & "|" & _
                     ufAddinReferences.Controls("cmdApply").Enabled
    Exit Function
Failed:
    ShowRepairForm = "Error: " & Err.Description
End Function

Public Sub CloseRepairForm()
    Unload ufAddinReferences
End Sub

Public Function FormApply(ByVal targetIndex As Long) As String
    SelectFormTarget targetIndex
    ufAddinReferences.Controls("cmdApply").Value = True
    ufAddinReferences.UpdateWorkbook
    FormApply = ufAddinReferences.Controls("txtSummary").Value
End Function

Public Function FormControls() As String
    Dim control As Object
    For Each control In ufAddinReferences.Controls
        FormControls = FormControls & control.Name & "|"
    Next control
End Function

Public Function FormTarget(ByVal index As Long) As String
    SelectFormTarget index
    FormTarget = ufAddinReferences.Controls("cmdTarget").Caption & "|" & _
                 ufAddinReferences.Controls("lblPath").Caption & "|" & _
                 ufAddinReferences.Controls("txtSummary").Value
End Function

Private Sub SelectFormTarget(ByVal index As Long)
    Dim buttonName As String
    buttonName = "cmdArco"
    If index = 1 Then buttonName = "cmdResQ"
    ufAddinReferences.Controls("cmdTarget").Value = True
    ufAddinReferences.Controls("fraTargets").Controls(buttonName).Value = True
End Sub

Public Function RunRepairDialog() As String
    dialogActivations = 0
    dialogResult = ""
    ufAddinReferences.ShowDialog
    RunRepairDialog = dialogResult
End Function

Public Sub DriveRepairDialog(ByVal form As Object)
    dialogActivations = dialogActivations + 1
    If dialogActivations = 1 Then
        form.Controls("cmdApply").Value = True
    Else
        dialogResult = form.Controls("txtSummary").Value
        form.Hide
    End If
End Sub

Public Function FormResQEnabled() As Boolean
    FormResQEnabled = ufAddinReferences.Controls("fraTargets").Controls("cmdResQ").Enabled
End Function

Public Function FormResQHint() As String
    FormResQHint = ufAddinReferences.Controls("fraTargets").Controls("lblResQHint").Caption
End Function

Public Function HostAllowsResQ() As Boolean
    HostAllowsResQ = CanUseResQ()
End Function

Public Function FormFits() As Boolean
    Dim control As Object
    FormFits = True
    For Each control In ufAddinReferences.Controls
        If control.Left < 0 Or control.Top < 0 Or _
           control.Left + control.Width > ufAddinReferences.InsideWidth Or _
           control.Top + control.Height > ufAddinReferences.InsideHeight Then FormFits = False
    Next control
End Function

Public Function RewriteForResQ(ByVal text As String, ByVal target As String) As String
    RewriteForResQ = RepairReferenceFormula(text, target, True, True, False, "ResQ")
End Function

Public Function UpdateReferences(ByVal bookName As String, ByVal target As String, ByVal prefix As String) As String
    On Error GoTo Failed
    UpdateReferences = UpdateWorkbookReferences(Workbooks(bookName), target, prefix)
    Exit Function
Failed:
    UpdateReferences = "Error: " & Err.Description
End Function

Public Sub ObserveReferenceProgress(ByVal form As Object)
    progressLog = progressLog & form.LabelTitle.Caption & "|" & form.LabelBody.Caption & "|" & _
                  form.LabelDetails.Caption & "|" & form.LabelPct.Caption & vbLf
    If Len(cancelStage) > 0 And InStr(form.LabelTitle.Caption, cancelStage) > 0 Then
        If CDbl(Replace(form.LabelPct.Caption, "%", "")) > cancelAfter Then form.Controls("cmd_Cancel").Value = True
    End If
End Sub

Public Sub StartProgressCheck(Optional ByVal stage As String = "", Optional ByVal afterPercent As Double = 0)
    progressLog = ""
    cancelStage = stage
    cancelAfter = afterPercent
End Sub

Public Function ReadProgressLog() As String
    ReadProgressLog = progressLog
End Function

Public Function RepairIdle() As Boolean
    Dim form As Object
    RepairIdle = Not cancelUpdate
    For Each form In VBA.UserForms
        If TypeName(form) = "ufProgressBar" Then RepairIdle = False
    Next form
End Function
