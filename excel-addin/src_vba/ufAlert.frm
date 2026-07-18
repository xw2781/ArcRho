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
    CancelTimedAlertClose
    ConfigureMessage messageText, titleText
    Me.Show vbModal
End Sub

Public Sub ShowTimedMessage( _
    ByVal messageText As String, _
    Optional ByVal titleText As String = "ArcRho", _
    Optional ByVal displaySeconds As Long = 2)

    CancelTimedAlertClose
    ConfigureMessage messageText, titleText, True
    Me.Show vbModeless
    ScheduleTimedAlertClose displaySeconds
End Sub

Private Sub ConfigureMessage( _
    ByVal messageText As String, _
    ByVal titleText As String, _
    Optional ByVal compact As Boolean = False)

    Dim titleLabel As MSForms.Label
    Dim bodyLabel As MSForms.Label

    Me.Caption = titleText
    If compact Then
        Me.Width = 280
        Me.Height = 135
    Else
        Me.Width = 340
        Me.Height = 205
    End If

    Set titleLabel = EnsureLabel("lblAlertTitle")
    With titleLabel
        .Caption = titleText
        If compact Then
            .Left = 12
            .Top = 10
            .Width = Me.InsideWidth - 24
            .Height = 18
        Else
            .Left = 18
            .Top = 18
            .Width = Me.InsideWidth - 36
            .Height = 22
        End If
        .Font.Bold = True
        .Font.Size = IIf(compact, 11, 12)
    End With

    Set bodyLabel = EnsureLabel("lblAlertBody")
    With bodyLabel
        .Caption = messageText
        If compact Then
            .Left = 12
            .Top = 34
            .Width = Me.InsideWidth - 24
            .Height = 34
        Else
            .Left = 18
            .Top = 52
            .Width = Me.InsideWidth - 36
            .Height = 70
        End If
        .WordWrap = True
    End With

    Set mOkButton = EnsureButton("cmdAlertOK")
    With mOkButton
        .Caption = "OK"
        If compact Then
            .Width = 56
            .Height = 22
            .Left = Me.InsideWidth - .Width - 12
            .Top = Me.InsideHeight - .Height - 10
        Else
            .Width = 72
            .Height = 26
            .Left = Me.InsideWidth - .Width - 18
            .Top = Me.InsideHeight - .Height - 18
        End If
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
    CancelTimedAlertClose
    Unload Me
End Sub

Private Sub UserForm_QueryClose(Cancel As Integer, CloseMode As Integer)
    CancelTimedAlertClose
End Sub
