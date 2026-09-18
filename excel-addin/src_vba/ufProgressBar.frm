VERSION 5.00
Begin {C62A69F0-16DC-11CE-9E98-00AA00574A4F} ufProgressBar 
   Caption         =   "Refreshing ArcRho"
   ClientHeight    =   2940
   ClientLeft      =   420
   ClientTop       =   1605
   ClientWidth     =   5505
   OleObjectBlob   =   "ufProgressBar.frx":0000
   StartUpPosition =   1  'CenterOwner
End
Attribute VB_Name = "ufProgressBar"
Attribute VB_GlobalNameSpace = False
Attribute VB_Creatable = False
Attribute VB_PredeclaredId = True
Attribute VB_Exposed = False


Private Sub cmd_Cancel_Click()
    ufProgressBar.LabelTitle.Caption = "Stop updating ... "
    cancelUpdate = True
End Sub

Private Sub UserForm_Initialize()
    Me.Caption = "Refreshing ArcRho"
    Me.LabelProgress.Width = 0
    Me.LabelPct.Caption = "0.0%"
End Sub

Public Sub UpdateProgressBar(PctDone As Double)
    Me.LabelPct.Caption = Format(PctDone, "0.0") & "%"
    Me.LabelProgress.Width = Me.FrameProgress.Width * (PctDone / 100)
    Me.Repaint
    DoEvents
End Sub

Public Sub ClearText()
    Me.LabelTitle.Caption = ""
    Me.LabelBody.Caption = ""
    Me.LabelDetails = ""
End Sub


