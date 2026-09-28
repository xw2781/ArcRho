VERSION 5.00
Begin {C62A69F0-16DC-11CE-9E98-00AA00574A4F} ufAbout 
   Caption         =   "Arco Excel Add-in"
   ClientHeight    =   2415
   ClientLeft      =   255
   ClientTop       =   1020
   ClientWidth     =   4560
   OleObjectBlob   =   "ufAbout.frx":0000
   StartUpPosition =   1  'CenterOwner
End
Attribute VB_Name = "ufAbout"
Attribute VB_GlobalNameSpace = False
Attribute VB_Creatable = False
Attribute VB_PredeclaredId = True
Attribute VB_Exposed = False

Private Sub UserForm_Initialize()
    Label2.Caption = "Version: " & ARCRHO_VERSION
    Label3.Caption = "Release notes"
    Label3.ForeColor = RGB(100, 100, 100)
End Sub

' The release puts "<add-in name> Release Notes.md" beside the add-in.
Private Sub Label3_Click()
    Dim notesPath As String
    notesPath = ThisWorkbook.Path & "\" & Left$(ThisWorkbook.Name, InStrRev(ThisWorkbook.Name, ".") - 1) & " Release Notes.md"
    If Len(Dir(notesPath)) = 0 Then
        MsgBox "Release notes not found:" & vbCrLf & notesPath, vbExclamation
        Exit Sub
    End If
    Shell "notepad.exe """ & notesPath & """", vbNormalFocus
End Sub


Private Sub Label3_MouseMove(ByVal Button As Integer, ByVal Shift As Integer, ByVal X As Single, ByVal Y As Single)
    Label3.ForeColor = vbBlue
    ' Label3.Font.Name = "Aptos Display"
    Me.MousePointer = fmMousePointerHand   ' ? not available!
End Sub

Private Sub UserForm_MouseMove(ByVal Button As Integer, ByVal Shift As Integer, ByVal X As Single, ByVal Y As Single)
    Label3.ForeColor = RGB(100, 100, 100)
    ' Label3.Font.Name = "Aptos Narrow"
    Me.MousePointer = fmMousePointerDefault
End Sub


