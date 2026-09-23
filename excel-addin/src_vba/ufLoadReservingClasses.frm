VERSION 5.00
Begin {C62A69F0-16DC-11CE-9E98-00AA00574A4F} ufLoadReservingClasses 
   Caption         =   "Load Reserving Classes"
   ClientHeight    =   2520
   ClientLeft      =   300
   ClientTop       =   1155
   ClientWidth     =   8865.001
   OleObjectBlob   =   "ufLoadReservingClasses.frx":0000
   StartUpPosition =   1  'CenterOwner
End
Attribute VB_Name = "ufLoadReservingClasses"
Attribute VB_GlobalNameSpace = False
Attribute VB_Creatable = False
Attribute VB_PredeclaredId = True
Attribute VB_Exposed = False
Option Explicit

Private mClasses As Variant       ' the project's class paths, 1-based, or Empty
Private mUpdating As Boolean
Private mFilteringEnabled As Boolean
Private mUIReady As Boolean

' The default project's reserving classes, from the list the pickers share.
' Each level offers only the values found under the levels chosen above it.
Private Sub UserForm_Initialize()
    Dim projectName As String, message As String
    Dim d(1 To 5) As String
    Dim i As Long
    Dim activeRng As Range
    Dim arr As Variant

    mFilteringEnabled = False ' start disabled
    mUIReady = False          ' form not ready yet

    projectName = WorkbookDefaultProject(ActiveWorkbook)
    If Not LoadChoices(projectName, message) Then
        MsgBox "Unable to load reserving classes:" & vbCrLf & message, vbExclamation
    End If
    mClasses = ChoiceReservingClasses(projectName)
    Me.Caption = "Load Reserving Classes - " & projectName

    For i = 1 To 5
        Me.Controls("lbl" & i).Caption = "Level " & i
    Next i

    ' Defaults: the path in the active cell, else the project's first class.
    Set activeRng = GetSafeActiveCell()
    If Not activeRng Is Nothing And ActiveCellHasRsvCls(activeRng) Then
        arr = GetActiveCellParts(activeRng)
        For i = 1 To 5: d(i) = arr(i): Next i
    ElseIf IsArray(mClasses) Then
        arr = Split(mClasses(LBound(mClasses)), "\")
        For i = 1 To 5
            If i - 1 <= UBound(arr) Then d(i) = arr(i - 1)
        Next i
    End If

    InitCombo cbo1, 1, d(1)
    InitCombo cbo2, 2, d(2)
    InitCombo cbo3, 3, d(3)
    InitCombo cbo4, 4, d(4)
    InitCombo cbo5, 5, d(5)

    UpdatePreview
End Sub

' The distinct values at one level among the classes under the levels chosen
' above it. A level above whose text matches no class is passed over, so a
' half-typed or stale choice never empties the lists below it.
Private Function LevelValues(ByVal level As Long) As Variant
    Dim bag As Object, candidates As Collection, narrowed As Collection
    Dim path As Variant, parts As Variant, up As Long

    Set bag = CreateObject("Scripting.Dictionary")
    bag.CompareMode = vbTextCompare
    Set candidates = New Collection
    If IsArray(mClasses) Then
        For Each path In mClasses
            candidates.Add Split(path, "\")
        Next path
    End If
    For up = 1 To level - 1
        Set narrowed = New Collection
        For Each parts In candidates
            If UBound(parts) >= up - 1 Then
                If StrComp(Trim$(parts(up - 1)), Trim$(Me.Controls("cbo" & up).text), vbTextCompare) = 0 Then narrowed.Add parts
            End If
        Next parts
        If narrowed.Count > 0 Then Set candidates = narrowed
    Next up
    For Each parts In candidates
        If UBound(parts) >= level - 1 Then
            If Not bag.Exists(parts(level - 1)) Then bag.Add parts(level - 1), True
        End If
    Next parts
    LevelValues = bag.Keys
End Function

Private Sub UserForm_Activate()
    mUIReady = True
End Sub

Private Sub UpdatePreview()
    lblPreview.Caption = Trim$(cbo1.text) & "\" & Trim$(cbo2.text) & "\" & _
                         Trim$(cbo3.text) & "\" & Trim$(cbo4.text) & "\" & _
                         Trim$(cbo5.text)
End Sub

'---- Initialize one combo: full list + default text
Private Sub InitCombo(ByRef cb As MSForms.ComboBox, ByVal colIdx As Long, ByVal defaultText As String)
    cb.MatchEntry = fmMatchEntryNone
    cb.Style = fmStyleDropDownCombo
    cb.ListRows = 12
    
    cb.Clear
    SetList cb, LevelValues(colIdx)
    
    If Len(defaultText) > 0 Then
        cb.text = defaultText
        cb.SelStart = Len(cb.text)
        cb.SelLength = 0
    Else
        cb.text = vbNullString
    End If
End Sub

'---- Filtering helper

Private Sub FilterCombo(ByRef cb As MSForms.ComboBox, ByVal colIdx As Long)
    If mUpdating Then Exit Sub
    mUpdating = True
    
    Dim txt As String: txt = cb.text
    Dim src As Variant: src = LevelValues(colIdx) ' 0-based
    
    If Not mFilteringEnabled Then
        cb.Clear
        SetList cb, src
        cb.text = txt         ' preserve visible text (defaults)
        cb.SelStart = Len(txt)
        cb.SelLength = 0
        mUpdating = False
        Exit Sub
    End If
    
    Dim filtered As Variant, hasAny As Boolean
    If Len(txt) = 0 Then
        cb.Clear
        SetList cb, src
    Else
        filtered = Filter(src, txt, True, vbTextCompare)
        On Error Resume Next
        hasAny = (UBound(filtered) >= LBound(filtered))
        On Error GoTo 0
        cb.Clear
        If hasAny Then SetList cb, filtered
    End If
    
    cb.text = txt
    cb.SelStart = Len(txt)
    cb.SelLength = 0
    cb.DropDown
    
    mUpdating = False
End Sub

'---- Fill a combo's list; a combo cannot be handed an empty array
Private Sub SetList(ByRef cb As MSForms.ComboBox, ByVal values As Variant)
    values = ToOneBased(values)
    If UBound(values) < LBound(values) Then
        cb.Clear
    Else
        cb.List = values
    End If
End Sub

'---- 0-based -> 1-based for ComboBox.List
Private Function ToOneBased(v As Variant) As Variant
    Dim lb As Long, ub As Long, i As Long
    If Not IsArray(v) Then ToOneBased = Array(): Exit Function
    lb = LBound(v): ub = UBound(v)
    If ub < lb Then ToOneBased = Array(): Exit Function
    Dim out() As String
    ReDim out(1 To ub - lb + 1)
    For i = lb To ub
        out(i - lb + 1) = CStr(v(i))
    Next
    ToOneBased = out
End Function

'=================
' Event procedures
'=================

'-----------
' Key Change
'-----------

Private Sub cbo1_Change()
    FilterCombo cbo1, 1
    If mUIReady Then mFilteringEnabled = True
    UpdatePreview
End Sub

Private Sub cbo2_Change()
    FilterCombo cbo2, 2
    If mUIReady Then mFilteringEnabled = True
    UpdatePreview
End Sub

Private Sub cbo3_Change()
    FilterCombo cbo3, 3
    If mUIReady Then mFilteringEnabled = True
    UpdatePreview
End Sub

Private Sub cbo4_Change()
    FilterCombo cbo4, 4
    If mUIReady Then mFilteringEnabled = True
    UpdatePreview
End Sub

Private Sub cbo5_Change()
    FilterCombo cbo5, 5
    If mUIReady Then mFilteringEnabled = True
    UpdatePreview
End Sub

'----------
' CBO Click
'----------

Private Sub cbo1_Click()
    If cbo1.ListIndex >= 0 Then cbo1.text = cbo1.List(cbo1.ListIndex)
    mFilteringEnabled = False
    UpdatePreview
End Sub

Private Sub cbo2_Click()
    If cbo2.ListIndex >= 0 Then cbo2.text = cbo2.List(cbo2.ListIndex)
    UpdatePreview
End Sub

Private Sub cbo3_Click()
    If cbo3.ListIndex >= 0 Then cbo3.text = cbo3.List(cbo3.ListIndex)
    UpdatePreview
End Sub

Private Sub cbo4_Click()
    If cbo4.ListIndex >= 0 Then cbo4.text = cbo4.List(cbo4.ListIndex)
    UpdatePreview
End Sub

Private Sub cbo5_Click()
    If cbo5.ListIndex >= 0 Then cbo5.text = cbo5.List(cbo5.ListIndex)
    UpdatePreview
End Sub

'----------
' Key Press
'----------

Private Sub cbo1_KeyPress(ByVal KeyAscii As MSForms.ReturnInteger)
    mFilteringEnabled = True
End Sub

Private Sub cbo2_KeyPress(ByVal KeyAscii As MSForms.ReturnInteger)
    mFilteringEnabled = True
End Sub

Private Sub cbo3_KeyPress(ByVal KeyAscii As MSForms.ReturnInteger)
    mFilteringEnabled = True
End Sub

Private Sub cbo4_KeyPress(ByVal KeyAscii As MSForms.ReturnInteger)
    mFilteringEnabled = True
End Sub

Private Sub cbo5_KeyPress(ByVal KeyAscii As MSForms.ReturnInteger)
    mFilteringEnabled = True
End Sub

' The arrow shows the level's whole list under the levels chosen above

Private Sub cbo1_DropButtonClick()
    
    mUpdating = True
    SetList cbo1, LevelValues(1)
    mUpdating = False
End Sub

Private Sub cbo2_DropButtonClick()
    mUpdating = True
    SetList cbo2, LevelValues(2)
    mUpdating = False
End Sub

Private Sub cbo3_DropButtonClick()
    mUpdating = True
    SetList cbo3, LevelValues(3)
    mUpdating = False
End Sub

Private Sub cbo4_DropButtonClick()
    mUpdating = True
    SetList cbo4, LevelValues(4)
    mUpdating = False
End Sub

Private Sub cbo5_DropButtonClick()
    mUpdating = True
    SetList cbo5, LevelValues(5)
    mUpdating = False
End Sub

'========
' Buttons
'========

Private Sub cmdSelect_Click()
    Dim parts(1 To 5) As String
    parts(1) = Trim$(cbo1.text)
    parts(2) = Trim$(cbo2.text)
    parts(3) = Trim$(cbo3.text)
    parts(4) = Trim$(cbo4.text)
    parts(5) = Trim$(cbo5.text)
    
    Dim result As String
    result = parts(1) & "\" & parts(2) & "\" & parts(3) & "\" & parts(4) & "\" & parts(5)
    
    ' Unload Me
    
    Dim tgt As Range, owner As Range
    Set tgt = GetSafeActiveCell()
    If tgt Is Nothing Then
        MsgBox "Select a worksheet cell before loading reserving classes.", vbExclamation
        Exit Sub
    End If

    ' 1) If active cell itself is an Arco formula -> update its second arg
    If tgt.HasFormula And IsArcRhoFormula(tgt.Formula2) Then
        If UpdateArcRhoArg(1, tgt, result) Then Exit Sub
    End If

    ' 2) If active cell is inside a spill from an Arco formula -> update that owner
    Set owner = FindArcRhoOwnerForCell(tgt)
    If Not owner Is Nothing Then
        If UpdateArcRhoArg(1, owner, result) Then Exit Sub
    End If

    ' 3) Otherwise just write the Value to the active cell
    tgt.Value = result
End Sub

Private Sub cmdCancel_Click()
    Unload Me
End Sub

Private Function GetSafeActiveCell() As Range
    On Error Resume Next
    Set GetSafeActiveCell = ActiveCell
    On Error GoTo 0
End Function

Public Function ActiveCellHasRsvCls(ByVal cell As Range) As Boolean
    If cell Is Nothing Then Exit Function

    Dim s As String
    s = CStr(cell.Value)
    
    ' Count "\" occurrences
    If (Len(s) - Len(Replace$(s, "\", ""))) = 4 Then
        ActiveCellHasRsvCls = True
    Else
        ActiveCellHasRsvCls = False
    End If
End Function

Public Function GetActiveCellParts(ByVal cell As Range) As Variant
    Dim s As String
    Dim parts As Variant
    Dim arr(1 To 5) As String
    Dim i As Long
    
    If cell Is Nothing Then
        GetActiveCellParts = arr
        Exit Function
    End If

    s = CStr(cell.Value)
    parts = Split(s, "\")   ' 0-based array (0 to 4)
    
    For i = 0 To 4
        arr(i + 1) = Trim$(CStr(parts(i)))
    Next i
    
    GetActiveCellParts = arr   ' return 1-based array
End Function









