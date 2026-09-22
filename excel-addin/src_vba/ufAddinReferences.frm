VERSION 5.00
Begin {C62A69F0-16DC-11CE-9E98-00AA00574A4F} ufAddinReferences
   Caption         =   "Reset Add-in References - Arco"
   ClientHeight    =   6156
   ClientLeft      =   108
   ClientTop       =   456
   ClientWidth     =   8544.001
   OleObjectBlob   =   "ufAddinReferences.frx":0000
   StartUpPosition =   1  'CenterOwner
End
Attribute VB_Name = "ufAddinReferences"
Attribute VB_GlobalNameSpace = False
Attribute VB_Creatable = False
Attribute VB_PredeclaredId = True
Attribute VB_Exposed = False
Option Explicit

Private book As Workbook
Private requested As Boolean
Private selectedTarget As Long
Private WithEvents targetButton As MSForms.CommandButton
Private WithEvents targetArrow As MSForms.Label
Private WithEvents arcoOption As MSForms.CommandButton
Private WithEvents resqOption As MSForms.CommandButton
Private targetMenu As MSForms.Frame
Private WithEvents applyButton As MSForms.CommandButton
Private pathLabel As MSForms.Label
Private summary As MSForms.TextBox

Private Function AddControl(ByVal kind As String, ByVal controlName As String, _
                            ByVal left As Single, ByVal top As Single, _
                            ByVal width As Single, ByVal height As Single, _
                            Optional ByVal caption As String = "") As Object
    Dim control As Object
    Set control = Me.Controls.Add("Forms." & kind & ".1", controlName, True)
    control.left = left
    control.top = top
    control.width = width
    control.height = height
    If Len(caption) > 0 Then control.caption = caption
    Set AddControl = control
End Function

Private Sub UserForm_Initialize()
    Me.width = 510
    Me.height = 268
    Me.caption = "Reset Add-in References - Arco"
    Set book = ActiveWorkbook
    AddControl "Label", "lblWorkbook", 12, 12, 474, 18, "Workbook: " & book.Name
    AddControl "Label", "lblTarget", 12, 42, 474, 18, "Target Add-in"
    ' MSForms ComboBox cannot disable a single item. This small dropdown uses
    ' native disabled buttons so the unavailable ResQ choice stays muted.
    Set targetButton = AddControl("CommandButton", "cmdTarget", 12, 62, 474, 24)
    targetButton.BackColor = vbWhite
    Set targetArrow = AddControl("Label", "lblTargetArrow", 470, 67, 12, 14, ChrW(&H25BE))
    targetArrow.BackColor = vbWhite
    Set pathLabel = AddControl("Label", "lblPath", 12, 92, 474, 30)
    pathLabel.WordWrap = True
    Set summary = AddControl("TextBox", "txtSummary", 12, 128, 474, 52)
    summary.MultiLine = True
    summary.Locked = True
    summary.WordWrap = True
    summary.ScrollBars = fmScrollBarsVertical
    summary.BorderStyle = fmBorderStyleNone
    summary.BackColor = Me.BackColor
    summary.TabStop = False
    Set applyButton = AddControl("CommandButton", "cmdApply", 352, 192, 134, 26, "Update workbook")
    applyButton.Default = True
    Set targetMenu = AddControl("Frame", "fraTargets", 12, 87, 474, 78)
    targetMenu.BackColor = vbWhite
    Set arcoOption = targetMenu.Controls.Add("Forms.CommandButton.1", "cmdArco", True)
    Set resqOption = targetMenu.Controls.Add("Forms.CommandButton.1", "cmdResQ", True)
    With arcoOption
        .Caption = "Arco Excel add-in"
        .Left = 3: .Top = 3: .Width = 466: .Height = 24
    End With
    With resqOption
        .Caption = "64-bit ResQ add-in"
        .Left = 3: .Top = 29: .Width = 466: .Height = 24
        .Enabled = CanUseResQ()
    End With
    With targetMenu.Controls.Add("Forms.Label.1", "lblResQHint", True)
        .Caption = "Only available on " & RESQ_COMPUTER
        .Left = 8: .Top = 57: .Width = 450: .Height = 16
        .ForeColor = &H808080
        .BackColor = vbWhite
        .Visible = Not CanUseResQ()
    End With
    targetMenu.Visible = False
    SelectTarget 0
End Sub

Private Sub SelectTarget(ByVal index As Long)
    If index = 1 And Not CanUseResQ() Then Exit Sub
    selectedTarget = index
    targetMenu.Visible = False
    pathLabel.caption = ReferenceTargetPath(index)
    If index = 1 Then
        targetButton.Caption = resqOption.Caption
        summary.Value = "Updates paths and function names to ResQ. ResQ formulas run only on " & RESQ_COMPUTER & "."
    Else
        targetButton.Caption = arcoOption.Caption
        summary.Value = "Updates paths and function names to Arco. Save the workbook after updating."
    End If
End Sub

Private Sub targetButton_Click()
    targetMenu.Visible = Not targetMenu.Visible
    If targetMenu.Visible Then
        targetMenu.ZOrder 0
        arcoOption.SetFocus
    End If
End Sub

Private Sub targetArrow_Click()
    targetButton_Click
End Sub

Private Sub arcoOption_Click()
    SelectTarget 0
End Sub

Private Sub resqOption_Click()
    SelectTarget 1
End Sub

Private Sub UserForm_Click()
    targetMenu.Visible = False
End Sub

' Run the update outside the modal Show call so ufProgressBar can be modeless.
Public Sub ShowDialog()
    Do
        requested = False
        Me.Show vbModal
        If Not requested Then Exit Do
        UpdateWorkbook
    Loop
    Unload Me
End Sub

Private Sub applyButton_Click()
    requested = True
    Me.Hide
End Sub

Public Sub UpdateWorkbook()
    Dim prefix As String
    On Error GoTo Failed
    prefix = "Arco"
    If selectedTarget = 1 Then prefix = "ResQ"
    summary.Value = UpdateWorkbookReferences(book, ReferenceTargetPath(selectedTarget), prefix)
    Exit Sub
Failed:
    summary.Value = Err.Description
End Sub

Private Sub UserForm_QueryClose(Cancel As Integer, CloseMode As Integer)
    If CloseMode = vbFormControlMenu Then
        Cancel = True
        requested = False
        Me.Hide
    End If
End Sub
