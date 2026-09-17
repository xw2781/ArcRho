VERSION 1.0 CLASS
BEGIN
  MultiUse = -1
END
Attribute VB_Name = "SnapshotEvents"
Attribute VB_GlobalNameSpace = False
Attribute VB_Creatable = False
Attribute VB_PredeclaredId = False
Attribute VB_Exposed = False
Option Explicit

Public WithEvents App As Excel.Application
Attribute App.VB_VarHelpID = -1

Private Sub App_WorkbookBeforeClose(ByVal Wb As Workbook, Cancel As Boolean)
    If DatasetRefreshOwnsWorkbook(Wb) Then
        Cancel = True
        Exit Sub
    End If
    SnapshotForget Wb
End Sub

Private Sub App_WorkbookBeforeSave(ByVal Wb As Workbook, ByVal SaveAsUI As Boolean, Cancel As Boolean)
    ' Never save partial formula results while a refresh is still in flight.
    If DatasetRefreshOwnsWorkbook(Wb) Then Cancel = True
End Sub
