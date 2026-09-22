VERSION 1.0 CLASS
BEGIN
  MultiUse = -1
END
Attribute VB_Name = "ReferenceEdit"
Attribute VB_GlobalNameSpace = False
Attribute VB_Creatable = False
Attribute VB_PredeclaredId = False
Attribute VB_Exposed = False
Option Explicit

Public Target As Object
Public Location As String
Public After As String
Public IsName As Boolean
Public IsArray As Boolean
Public Status As String

Public Function Apply() As Boolean
    If Status <> "Ready" Then Exit Function
    On Error GoTo Failed
    If IsName Then
        Target.RefersTo = After
    ElseIf IsArray Then
        Target.FormulaArray = After
    Else
        Target.Formula2 = After
    End If
    Status = "Updated"
    Apply = True
    Exit Function
Failed:
    Status = "Not updated: " & Err.Description
End Function
