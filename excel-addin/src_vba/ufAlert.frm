VERSION 5.00
Begin {C62A69F0-16DC-11CE-9E98-00AA00574A4F} ufAlert 
   Caption         =   "ArcRho"
   ClientHeight    =   2610
   ClientLeft      =   120
   ClientTop       =   465
   ClientWidth     =   5055
   OleObjectBlob   =   "ufAlert.frx":0000
   StartUpPosition =   1  'CenterOwner
End
Attribute VB_Name = "ufAlert"
Attribute VB_GlobalNameSpace = False
Attribute VB_Creatable = False
Attribute VB_PredeclaredId = True
Attribute VB_Exposed = False

Option Explicit

Private WithEvents mOkButton As MSForms.CommandButton

Public Sub ShowMessage(ByVal messageText As String, Optional ByVal titleText As String = "ArcRho")
    ConfigureMessage messageText, titleText
    Me.Show vbModal
End Sub

Private Sub ConfigureMessage(ByVal messageText As String, ByVal titleText As String)
    Dim titleLabel As MSForms.Label
    Dim bodyLabel As MSForms.Label

    Me.Caption = titleText
    Me.Width = 340
    Me.Height = 205

    Set titleLabel = EnsureLabel("lblAlertTitle")
    With titleLabel
        .Caption = titleText
        .Left = 18
        .Top = 18
        .Width = Me.InsideWidth - 36
        .Height = 22
        .Font.Bold = True
        .Font.Size = 12
    End With

    Set bodyLabel = EnsureLabel("lblAlertBody")
    With bodyLabel
        .Caption = messageText
        .Left = 18
        .Top = 52
        .Width = Me.InsideWidth - 36
        .Height = 70
        .WordWrap = True
    End With

    Set mOkButton = EnsureButton("cmdAlertOK")
    With mOkButton
        .Caption = "OK"
        .Width = 72
        .Height = 26
        .Left = Me.InsideWidth - .Width - 18
        .Top = Me.InsideHeight - .Height - 18
        .Default = True
        .Cancel = True
    End With
End Sub

Private Function EnsureLabel(ByVal controlName As String) As MSForms.Label
    On Error Resume Next
    Set EnsureLabel = Me.Controls(controlName)
    On Error GoTo 0
    If EnsureLabel Is Nothing Then
        Set EnsureLabel = Me.Controls.Add("Forms.Label.1", controlName, True)
    End If
End Function

Private Function EnsureButton(ByVal controlName As String) As MSForms.CommandButton
    On Error Resume Next
    Set EnsureButton = Me.Controls(controlName)
    On Error GoTo 0
    If EnsureButton Is Nothing Then
        Set EnsureButton = Me.Controls.Add("Forms.CommandButton.1", controlName, True)
    End If
End Function

Private Sub mOkButton_Click()
    Unload Me
End Sub
