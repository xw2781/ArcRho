VERSION 5.00
Begin {C62A69F0-16DC-11CE-9E98-00AA00574A4F} ufSettings 
   Caption         =   "User Settings - ArcRho"
   ClientHeight    =   7230
   ClientLeft      =   195
   ClientTop       =   795
   ClientWidth     =   6180
   OleObjectBlob   =   "ufSettings.frx":0000
   StartUpPosition =   1  'CenterOwner
End
Attribute VB_Name = "ufSettings"
Attribute VB_GlobalNameSpace = False
Attribute VB_Creatable = False
Attribute VB_PredeclaredId = True
Attribute VB_Exposed = False
Option Explicit

Private Sub UserForm_Initialize()
  ' Get Initial Values
    LoadConfig
    On Error Resume Next
    ComboBox1.Visible = False
    CommandButton1.Visible = False
    On Error GoTo 0
    ComboBox2.Value = ProductPath("Team Profile\Actuarial_NJ.xlsm")
    
    ' The build preserves the existing form designer, so hide these obsolete
    ' refresh-policy controls even in an add-in built from an older template.
    OptionButton1.Visible = False
    OptionButton2.Visible = False
    OptionButton1.Parent.Caption = "Saved workbook data"
    Label1.Caption = "ArcRho uses saved values until you click Refresh. Save after refreshing to share the updated values."
    Label1.Left = 10
    Label1.Top = 18
    Label1.Width = OptionButton1.Parent.Width - 20
    Label1.Height = 42
    Label1.WordWrap = True
    Label1.Visible = True
    CheckBox7.Visible = False
    If disableProgressBar Then
        CheckBox5.Value = True
    Else
        CheckBox5.Value = False
    End If
End Sub

' +--------+
' | Page 1 |
' +--------+
Private Sub cmdb2_Click()
    Unload ufSettings
End Sub

' Disable UI Animations for Better Performance
Private Sub CheckBox5_Click()
    disableProgressBar = CheckBox5.Value
    UpdateConfigValue "disableProgressBar", CheckBox5.Value
End Sub

' +--------+
' | Page 2 |
' +--------+

' Team Profile

Private Sub CommandButton2_Click()
    OpenFileFromCombo Me.ComboBox2
End Sub

' +--------+
' | Helper |
' +--------+

Public Sub LoadFilePaths(cb As MSForms.ComboBox, ByVal folderPath As String)
    Dim fileName As String
    
    ' Ensure trailing slash
    If Right(folderPath, 1) <> "\" Then
        folderPath = folderPath & "\"
    End If
    
    cb.Clear
    
    fileName = Dir(folderPath & "*.*")
    Do While fileName <> ""
        cb.AddItem folderPath & fileName
        fileName = Dir
    Loop

End Sub


Public Sub OpenFileFromCombo(cb As MSForms.ComboBox)
    Dim f As String
    
    f = Trim(cb.Value)    ' selected file path
    
    If f = "" Then
        MsgBox "Please select a file first.", vbExclamation, "No File Selected"
        Exit Sub
    End If
    
    If Dir(f) = "" Then
        MsgBox "File not found:" & vbCrLf & f, vbCritical, "Error"
        Exit Sub
    End If
    
    ' Open using default associated application
    ThisWorkbook.FollowHyperlink f
    
End Sub



