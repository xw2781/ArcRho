Attribute VB_Name = "ReferenceFormulaRepair"
Option Private Module
Option Explicit

' Only supported worksheet functions are migrated. This list owns the rename
' rule; the COM check pins its targets to ArcRhoFunctions' public functions.
Public Function CurrentArcoFunction(ByVal oldName As String) As String
    Dim prefix As Variant, suffix As String, candidate As String
    candidate = oldName
    Do
        If LCase$(Left$(candidate, 6)) = "_xlfn." Then
            candidate = Mid$(candidate, 7)
        ElseIf LCase$(Left$(candidate, 7)) = "_xludf." Then
            candidate = Mid$(candidate, 8)
        Else
            Exit Do
        End If
    Loop
    For Each prefix In Array("ArcRho", "ResQ", "ADAS", "Arco")
        If StrComp(Left$(candidate, Len(prefix)), prefix, vbTextCompare) = 0 Then
            suffix = Mid$(candidate, Len(prefix) + 1)
            Select Case LCase$(suffix)
                Case "tri": suffix = "Tri"
                Case "tridiag": suffix = "TriDiag"
                Case "tricell": suffix = "TriCell"
                Case "triorigin": suffix = "TriOrigin"
                Case "vec": suffix = "Vec"
                Case "veccell": suffix = "VecCell"
                Case "headers": suffix = "Headers"
                Case "projectsettings": suffix = "ProjectSettings"
                Case "reservingclasses": suffix = "ReservingClasses"
                Case "nodecontents": suffix = "NodeContents"
                Case Else: Exit Function
            End Select
            CurrentArcoFunction = "Arco" & suffix
            Exit Function
        End If
    Next prefix
End Function

Private Function IdentifierChar(ByVal ch As String) As Boolean
    If Len(ch) = 0 Then Exit Function
    IdentifierChar = ch Like "[A-Za-z0-9_.\]" Or AscW(ch) < 0 Or AscW(ch) > 127
End Function

Private Function TokenEnd(ByVal text As String, ByVal start As Long) As Long
    TokenEnd = start
    Do While TokenEnd <= Len(text)
        If Not IdentifierChar(Mid$(text, TokenEnd, 1)) Then Exit Do
        TokenEnd = TokenEnd + 1
    Loop
End Function

Private Function QuoteEnd(ByVal text As String, ByVal start As Long, ByVal quote As String) As Long
    Dim i As Long
    i = start + 1
    Do While i <= Len(text)
        If Mid$(text, i, 1) = quote Then
            If Mid$(text, i + 1, 1) <> quote Then
                QuoteEnd = i + 1
                Exit Function
            End If
            i = i + 1
        End If
        i = i + 1
    Loop
    QuoteEnd = Len(text) + 1
End Function

Private Function IsOldAddin(ByVal qualifier As String) As Boolean
    Dim name As String, bracket As Long
    name = Replace$(qualifier, "'", "")
    bracket = InStrRev(name, "[")
    If bracket > 0 Then name = Mid$(name, bracket + 1)
    name = Replace$(name, "]", "")
    name = Mid$(name, InStrRev(name, "\") + 1)
    Select Case LCase$(name)
        Case "resq.xlam", "resq.xla", "arcrho.xlam", "arcrho_beta.xlam", "arco.xlam"
            IsOldAddin = True
    End Select
End Function

' Parse function calls, leaving quoted strings, sheet names and table columns
' alone. A function belonging to any other workbook is never retargeted.
Public Function RepairReferenceFormula(ByVal text As String, ByVal targetPath As String, _
                                       ByVal fixPath As Boolean, ByVal rename As Boolean, _
                                       Optional ByVal targetLoaded As Boolean = False, _
                                       Optional ByVal functionPrefix As String = "Arco") As String
    Dim i As Long, finish As Long, callStart As Long, callEnd As Long, paren As Long
    Dim ch As String, qualifier As String, oldName As String, newName As String
    Dim replacement As String, depth As Long, eligible As Boolean
    i = 1
    Do While i <= Len(text)
        ch = Mid$(text, i, 1)
        finish = i + 1
        qualifier = ""
        callStart = i
        eligible = True
        If ch = """" Then
            finish = QuoteEnd(text, i, ch)
            eligible = False
        ElseIf ch = "'" Then
            finish = QuoteEnd(text, i, ch)
            If Mid$(text, finish, 1) = "!" Then
                qualifier = Mid$(text, i, finish - i)
                callStart = finish + 1
            Else
                eligible = False
            End If
        ElseIf ch = "[" Then
            depth = 1
            Do While finish <= Len(text) And depth > 0
                If Mid$(text, finish, 1) = "[" Then depth = depth + 1
                If Mid$(text, finish, 1) = "]" Then depth = depth - 1
                finish = finish + 1
            Loop
            If Mid$(text, finish, 1) = "!" Then
                qualifier = Mid$(text, i, finish - i)
                callStart = finish + 1
            Else
                eligible = False
            End If
        ElseIf IdentifierChar(ch) Then
            finish = TokenEnd(text, i)
            If Mid$(text, finish, 1) = "!" Then
                qualifier = Mid$(text, i, finish - i)
                callStart = finish + 1
            ElseIf i > 1 Then
                eligible = Mid$(text, i - 1, 1) <> "!"
            End If
        Else
            eligible = False
        End If
        If eligible Then
            callEnd = TokenEnd(text, callStart)
            paren = callEnd
            Do While Mid$(text, paren, 1) = " "
                paren = paren + 1
            Loop
            oldName = Mid$(text, callStart, callEnd - callStart)
            newName = CurrentArcoFunction(oldName)
            If Len(newName) > 0 And functionPrefix = "ResQ" Then newName = "ResQ" & Mid$(newName, 5)
            If Len(qualifier) > 0 Then eligible = IsOldAddin(qualifier)
            If eligible And Len(newName) > 0 And Mid$(text, paren, 1) = "(" Then
                If Not rename Then newName = oldName
                replacement = newName
                If fixPath And Not (targetLoaded And Len(qualifier) = 0 And oldName = newName) Then
                    If Len(targetPath) > 0 Then
                        replacement = "'" & Replace$(targetPath, "'", "''") & "'!" & newName
                        If InStr(targetPath, "\") = 0 And InStr(targetPath, " ") = 0 And InStr(targetPath, "'") = 0 Then
                            replacement = targetPath & "!" & newName
                        End If
                    End If
                ElseIf Len(qualifier) > 0 Then
                    replacement = qualifier & "!" & newName
                End If
                RepairReferenceFormula = RepairReferenceFormula & replacement
                i = callEnd
                GoTo NextToken
            End If
            If Len(qualifier) > 0 Then finish = callEnd
        End If
        RepairReferenceFormula = RepairReferenceFormula & Mid$(text, i, finish - i)
        i = finish
NextToken:
    Loop
End Function
