VERSION 5.00
Begin {C62A69F0-16DC-11CE-9E98-00AA00574A4F} ufInsertFunction
   Caption         =   "Insert Arco Function"
   ClientHeight    =   6156
   ClientLeft      =   108
   ClientTop       =   456
   ClientWidth     =   8544.001
   OleObjectBlob   =   "ufInsertFunction.frx":0000
   StartUpPosition =   1  'CenterOwner
End
Attribute VB_Name = "ufInsertFunction"
Attribute VB_GlobalNameSpace = False
Attribute VB_Creatable = False
Attribute VB_PredeclaredId = True
Attribute VB_Exposed = False
Option Explicit

' The Insert Function panel: pick an Arco function on the left, fill in its
' arguments on the right, and insert the formula into the selected cell. Each
' function has its own page of arguments, built from ArcoFunctionCatalog.
' Paths, dataset names, and projects are offered from the lists ArcoChoices
' reads from the Arco Server. Opened on a cell that already holds an Arco
' formula, the panel loads that formula so it can be changed.

Private Const RIGHT_X As Single = 196
Private Const RIGHT_W As Single = 506
Private Const ROW_PITCH As Single = 40
Private Const BOX_X As Single = 130
Private Const BOX_W As Single = 350
Private Const HINT_COLOR As Long = &H707070
Private Const ERROR_COLOR As Long = &H1C1CB0
' A fixed choice reads "12 - Annual"; the formula takes the part before this.
Private Const CHOICE_SEPARATOR As String = " - "
' The first entry of every argument's list, which takes the value from a cell.
Private Const PICK_CELL_ITEM As String = "Select a cell..."

Private WithEvents App As Excel.Application
Private WithEvents functionList As MSForms.ListBox
Private WithEvents insertButton As MSForms.CommandButton
Private WithEvents closeButton As MSForms.CommandButton
Private WithEvents refreshButton As MSForms.CommandButton
Private WithEvents loadButton As MSForms.CommandButton
Private titleLabel As MSForms.Label
Private signatureLabel As MSForms.Label
Private summaryLabel As MSForms.Label
Private listsLabel As MSForms.Label
Private targetLabel As MSForms.Label
Private statusLabel As MSForms.Label
Private formulaBox As MSForms.TextBox
Private pages As Object          ' function name -> its Frame
Private pageInputs As Object     ' function name -> Collection of ArcoArgumentInput, one per argument
Private currentFunction As String
Private updating As Boolean
Private loadedProject As String  ' the project the lists were last read for
Private statusIsResult As Boolean

Private Function AddControl(ByVal container As Object, ByVal kind As String, ByVal controlName As String, _
                            ByVal left As Single, ByVal top As Single, _
                            ByVal width As Single, ByVal height As Single, _
                            Optional ByVal caption As String = "") As Object
    Dim control As Object
    Set control = container.Controls.Add("Forms." & kind & ".1", controlName, True)
    control.left = left
    control.top = top
    control.width = width
    control.height = height
    If Len(caption) > 0 Then control.caption = caption
    Set AddControl = control
End Function

Private Function AddHint(ByVal container As Object, ByVal controlName As String, _
                         ByVal left As Single, ByVal top As Single, _
                         ByVal width As Single, ByVal height As Single, _
                         ByVal caption As String) As MSForms.Label
    Set AddHint = AddControl(container, "Label", controlName, left, top, width, height, caption)
    AddHint.Font.Size = 8
    AddHint.ForeColor = HINT_COLOR
    AddHint.WordWrap = True
End Function

Private Sub UserForm_Initialize()
    Dim fn As Object, owner As Range

    Me.caption = "Insert Arco Function"
    Me.width = 720
    Me.height = 520 + (Me.height - Me.InsideHeight)
    Set pages = CreateObject("Scripting.Dictionary")
    Set pageInputs = CreateObject("Scripting.Dictionary")
    BuildLayout
    For Each fn In ArcoFunctions()
        BuildPage fn
    Next fn

    Set owner = ArcoFormulaOwner(ActiveCell)
    If owner Is Nothing Then
        ShowFunction "ArcoTri"
    Else
        LoadFormula owner
    End If
    EnsureLists
    Set App = Application
    UpdateTarget
End Sub

Private Sub UserForm_QueryClose(Cancel As Integer, CloseMode As Integer)
    Set App = Nothing
End Sub

Private Sub BuildLayout()
    Dim fn As Object

    AddControl Me, "Label", "lblFunctions", 12, 10, 170, 14, "Function"
    ' One column only: a list or dropdown given a second column at run time is
    ' drawn with a stray white block when Excel runs under display scaling.
    Set functionList = AddControl(Me, "ListBox", "lstFunctions", 12, 28, 172, 112)
    For Each fn In ArcoFunctions()
        functionList.AddItem fn("Name")
    Next fn

    Set listsLabel = AddHint(Me, "lblLists", 12, 150, 172, 52, "")
    Set refreshButton = AddControl(Me, "CommandButton", "cmdRefresh", 12, 204, 96, 22, "Refresh lists")
    refreshButton.ControlTipText = "Read the projects, reserving classes, and datasets from the Arco Server again"
    AddHint Me, "lblTip", 12, 240, 172, 150, _
        "Pick from a list or type a value. To take a value from the worksheet, type a cell such as B2 " & _
        "or choose " & PICK_CELL_ITEM & " at the top of the list. Start with = to type any other " & _
        "expression." & vbLf & vbLf & _
        "Load from cell reads the Arco formula in the selected cell, so you can change it and insert " & _
        "it again." & vbLf & vbLf & _
        "Arguments in bold are required; a blank optional argument uses its default."

    Set titleLabel = AddControl(Me, "Label", "lblTitle", RIGHT_X, 8, RIGHT_W, 20)
    titleLabel.Font.Size = 12
    titleLabel.Font.Bold = True
    Set signatureLabel = AddHint(Me, "lblSignature", RIGHT_X, 29, RIGHT_W, 14, "")
    Set summaryLabel = AddControl(Me, "Label", "lblSummary", RIGHT_X, 45, RIGHT_W, 28)
    summaryLabel.WordWrap = True

    AddControl Me, "Label", "lblFormula", RIGHT_X, 416, 80, 14, "Formula"
    Set loadButton = AddControl(Me, "CommandButton", "cmdLoad", RIGHT_X + RIGHT_W - 110, 412, 110, 18, "Load from cell")
    loadButton.ControlTipText = "Read the Arco formula in the selected cell into the panel"
    loadButton.TakeFocusOnClick = False
    Set formulaBox = AddControl(Me, "TextBox", "txtFormula", RIGHT_X, 431, RIGHT_W, 34)
    formulaBox.MultiLine = True
    formulaBox.WordWrap = True
    formulaBox.Locked = True
    formulaBox.BackColor = Me.BackColor
    formulaBox.TabStop = False

    Set targetLabel = AddControl(Me, "Label", "lblTarget", RIGHT_X, 474, 316, 14)
    Set statusLabel = AddHint(Me, "lblStatus", RIGHT_X, 490, 316, 26, "")
    Set insertButton = AddControl(Me, "CommandButton", "cmdInsert", 526, 476, 84, 26, "Insert")
    insertButton.Default = True
    Set closeButton = AddControl(Me, "CommandButton", "cmdClose", 618, 476, 84, 26, "Close")
    closeButton.Cancel = True
End Sub

' One page per function: a row for every argument a user sets, in the
' function's own order. Hidden arguments keep their place without a row.
Private Sub BuildPage(ByVal fn As Object)
    Dim page As MSForms.Frame, arg As Object, argInput As ArcoArgumentInput
    Dim items As New Collection, nameLabel As MSForms.Label
    Dim top As Single, i As Long, prefix As String

    prefix = fn("Name") & "_"
    Set page = AddControl(Me, "Frame", "fra" & fn("Name"), RIGHT_X, 78, RIGHT_W, 332, "Arguments")
    page.Visible = False
    top = 6
    For Each arg In fn("Args")
        i = i + 1
        Set argInput = New ArcoArgumentInput
        Set argInput.Arg = arg
        Set argInput.Panel = Me
        If arg("Kind") <> "hidden" Then
            Set nameLabel = AddControl(page, "Label", "lbl" & prefix & i, 8, top + 3, 118, 14, arg("Name"))
            nameLabel.Font.Bold = arg("Required")
            Set argInput.Box = AddControl(page, "ComboBox", "cbo" & prefix & i, BOX_X, top, BOX_W, 18)
            ConfigureBox argInput
            AddHint page, "hint" & prefix & i, BOX_X, top + 20, BOX_W, 18, HintText(arg)
            top = top + ROW_PITCH
        End If
        items.Add argInput
    Next arg
    pages.Add fn("Name"), page
    pageInputs.Add fn("Name"), items
End Sub

Private Function HintText(ByVal arg As Object) As String
    HintText = arg("Hint")
    If Len(arg("Default")) > 0 And arg("Kind") <> "project" Then HintText = HintText & " Default: " & Replace(arg("Default"), """", "") & "."
End Function

' Fixed choices are filled once; server lists are filled as the list opens.
' Every list starts with the entry that takes the value from a cell.
Private Sub ConfigureBox(ByVal argInput As ArcoArgumentInput)
    With argInput.Box
        .Style = fmStyleDropDownCombo
        .MatchEntry = fmMatchEntryNone
        .ListRows = 12
        .ControlTipText = argInput.Arg("Hint")
        .AddItem PICK_CELL_ITEM
        Select Case argInput.Arg("Kind")
            Case "bool"
                .AddItem "TRUE"
                .AddItem "FALSE"
            Case "length"
                .AddItem "12" & CHOICE_SEPARATOR & "Annual"
                .AddItem "6" & CHOICE_SEPARATOR & "Half-year"
                .AddItem "3" & CHOICE_SEPARATOR & "Quarterly"
                .AddItem "1" & CHOICE_SEPARATOR & "Monthly"
            Case "period_type"
                .AddItem "0" & CHOICE_SEPARATOR & "Origin periods"
                .AddItem "1" & CHOICE_SEPARATOR & "Development ages"
        End Select
    End With
End Sub

Private Function IsServerList(ByVal kind As String) As Boolean
    IsServerList = (kind = "path" Or kind = "triangle" Or kind = "vector" Or kind = "project")
End Function

' ---- Pages ----

Private Sub ShowFunction(ByVal functionName As String)
    Dim fn As Object, arg As Object, signature As String, i As Long
    Dim previous As String

    Set fn = ArcoFunctionByName(functionName)
    previous = currentFunction
    If Len(previous) > 0 Then pages(previous).Visible = False
    currentFunction = fn("Name")
    pages(currentFunction).Visible = True

    For Each arg In fn("Args")
        If arg("Kind") <> "hidden" Then
            If Len(signature) > 0 Then signature = signature & ", "
            If arg("Required") Then signature = signature & arg("Name") Else signature = signature & "[" & arg("Name") & "]"
        End If
    Next arg
    titleLabel.caption = currentFunction
    signatureLabel.caption = currentFunction & "(" & signature & ")"
    summaryLabel.caption = fn("Summary")

    updating = True
    For i = 0 To functionList.ListCount - 1
        If functionList.List(i, 0) = currentFunction Then functionList.ListIndex = i
    Next i
    If Len(previous) > 0 And previous <> currentFunction Then CarryValues previous, currentFunction
    updating = False
    EnsureLists
    UpdateFormula
End Sub

' Keep what was typed on the previous page for the arguments both share.
Private Sub CarryValues(ByVal fromFunction As String, ByVal toFunction As String)
    Dim source As ArcoArgumentInput, target As ArcoArgumentInput
    For Each target In pageInputs(toFunction)
        If Not target.Box Is Nothing Then
            If Len(target.Box.text) = 0 Then
                For Each source In pageInputs(fromFunction)
                    If Not source.Box Is Nothing Then
                        If source.Arg("Name") = target.Arg("Name") Then target.Box.text = source.Box.text
                    End If
                Next source
            End If
        End If
    Next target
End Sub

Private Sub functionList_Click()
    If updating Or functionList.ListIndex < 0 Then Exit Sub
    statusIsResult = False
    ShowFunction functionList.List(functionList.ListIndex, 0)
End Sub

' ---- Argument events, raised by ArcoArgumentInput ----

Public Sub ArgumentChanged(ByVal argInput As ArcoArgumentInput)
    If argInput.Box.text = PICK_CELL_ITEM Then Exit Sub
    argInput.LastText = argInput.Box.text
    If updating Then Exit Sub
    If argInput.Typed And IsServerList(argInput.Arg("Kind")) Then FilterList argInput
    If argInput.Arg("Kind") = "project" Then EnsureLists
    statusIsResult = False
    UpdateFormula
End Sub

Public Sub ArgumentDropDown(ByVal argInput As ArcoArgumentInput)
    If Not IsServerList(argInput.Arg("Kind")) Then Exit Sub
    EnsureLists
    FillList argInput, ""
End Sub

' Choosing the cell entry puts back what the box held, then asks for the cell.
Public Sub ArgumentClicked(ByVal argInput As ArcoArgumentInput)
    If argInput.Box.text <> PICK_CELL_ITEM Then Exit Sub
    updating = True
    argInput.Box.text = argInput.LastText
    updating = False
    PickCell argInput
End Sub

Private Sub PickCell(ByVal argInput As ArcoArgumentInput)
    Dim picked As Variant
    On Error Resume Next
    Set picked = Application.InputBox("Select the cell that holds " & argInput.Arg("Name") & ".", _
                                      "Arco - " & argInput.Arg("Name"), Type:=8)
    On Error GoTo 0
    If Not IsObject(picked) Then Exit Sub
    If picked Is Nothing Then Exit Sub
    argInput.Box.text = ReferenceText(picked.Cells(1, 1))
    argInput.Box.SetFocus
End Sub

' The address a formula in the target cell's sheet uses for another cell.
Private Function ReferenceText(ByVal cell As Range) As String
    Dim target As Range
    Set target = TargetCell()
    If Not target Is Nothing Then
        If cell.Worksheet Is target.Worksheet Then
            ReferenceText = cell.Address
            Exit Function
        End If
        If cell.Worksheet.Parent Is target.Worksheet.Parent Then
            ReferenceText = "'" & Replace(cell.Worksheet.Name, "'", "''") & "'!" & cell.Address
            Exit Function
        End If
    End If
    ReferenceText = cell.Address(External:=True)
End Function

' ---- Lists from the Arco Server ----

' Offer the server list items containing what was typed, and open the list.
Private Sub FilterList(ByVal argInput As ArcoArgumentInput)
    Dim typed As String
    typed = argInput.Box.text
    EnsureLists
    FillList argInput, typed
    If argInput.Box.ListCount > 0 Then argInput.Box.DropDown
End Sub

Private Sub FillList(ByVal argInput As ArcoArgumentInput, ByVal typed As String)
    Dim items As Variant, i As Long, keep As String
    items = ServerList(argInput.Arg("Kind"))
    keep = argInput.Box.text
    updating = True
    argInput.Box.Clear
    argInput.Box.AddItem PICK_CELL_ITEM
    If IsArray(items) Then
        For i = LBound(items) To UBound(items)
            If Len(typed) = 0 Or InStr(1, items(i), typed, vbTextCompare) > 0 Then argInput.Box.AddItem items(i)
        Next i
    End If
    argInput.Box.text = keep
    argInput.Box.SelStart = Len(keep)
    updating = False
End Sub

Private Function ServerList(ByVal kind As String) As Variant
    Dim project As String, names As Variant, out() As String, i As Long
    project = loadedProject
    Select Case kind
        Case "path"
            ServerList = ChoiceReservingClasses(project)
        Case "triangle"
            ServerList = ChoiceDatasetNames(project, "Triangle")
        Case "vector"
            ServerList = ChoiceDatasetNames(project, "Vector")
        Case "project"
            names = ChoiceProjectNames()
            If IsArray(names) Then
                ReDim out(0 To UBound(names))
                For i = 1 To UBound(names)
                    out(i) = names(i)
                Next i
            Else
                ReDim out(0 To 0)
            End If
            out(0) = "Default"
            ServerList = out
    End Select
End Function

' Read the lists for the project the current page names, once per project;
' force reads them again. The label beside the function list says what the
' lists hold, or why there are none.
Private Sub EnsureLists(Optional ByVal force As Boolean = False)
    Dim project As String, message As String

    project = PageProject()
    If Not force And Len(project) > 0 And StrComp(project, loadedProject, vbTextCompare) = 0 Then Exit Sub
    loadedProject = ""
    If Not LoadChoices("", message, force) Then
        ShowLists "Lists unavailable: " & message, True
        Exit Sub
    End If
    If Len(project) = 0 Then
        ShowLists "Choose a project to list its reserving classes and datasets.", False
        Exit Sub
    End If
    If Not IsKnownProject(project) Then
        ShowLists project & " is not on the Arco Server's project list.", True
        Exit Sub
    End If
    If Not LoadChoices(project, message, force) Then
        ShowLists "Lists unavailable: " & message, True
        Exit Sub
    End If
    loadedProject = project
    ShowLists "Lists for " & project & ": " & CountOf(ChoiceReservingClasses(project)) & _
              " reserving classes, " & CountOf(ChoiceDatasetNames(project, "Triangle")) & " triangles, " & _
              CountOf(ChoiceDatasetNames(project, "Vector")) & " vectors.", False
End Sub

Private Sub ShowLists(ByVal text As String, ByVal isProblem As Boolean)
    listsLabel.caption = text
    listsLabel.ForeColor = IIf(isProblem, ERROR_COLOR, HINT_COLOR)
End Sub

Private Function CountOf(ByVal items As Variant) As Long
    If IsArray(items) Then CountOf = UBound(items) - LBound(items) + 1
End Function

Private Function IsKnownProject(ByVal project As String) As Boolean
    Dim names As Variant, i As Long
    names = ChoiceProjectNames()
    If Not IsArray(names) Then Exit Function
    For i = LBound(names) To UBound(names)
        If StrComp(names(i), project, vbTextCompare) = 0 Then
            IsKnownProject = True
            Exit Function
        End If
    Next i
End Function

' The project the current page's formula reads: its ProjectName, or the
' workbook's default project when that is blank or Default.
Private Function PageProject() As String
    Dim argInput As ArcoArgumentInput, text As String, value As Variant
    For Each argInput In pageInputs(currentFunction)
        If argInput.Arg("Kind") = "project" Then text = Trim$(argInput.Box.text)
    Next argInput
    If Len(text) = 0 Or StrComp(text, "Default", vbTextCompare) = 0 Then
        PageProject = WorkbookDefaultProject(ActiveWorkbook)
        Exit Function
    End If
    If Left$(text, 1) = "=" Or IsReferenceText(text) Then
        On Error Resume Next
        value = ActiveSheet.Evaluate(IIf(Left$(text, 1) = "=", Mid$(text, 2), text))
        On Error GoTo 0
        If IsError(value) Or IsObject(value) Then Exit Function
        text = Trim$(CStr(value))
    End If
    PageProject = Mid$(text, InStrRev(text, "\") + 1)
End Function

Private Sub refreshButton_Click()
    EnsureLists True
End Sub

' ---- The formula ----

Private Sub UpdateFormula()
    Dim problem As String
    formulaBox.text = BuildFormula(problem)
    insertButton.Enabled = (Len(problem) = 0) And Not TargetCell() Is Nothing
    If Len(problem) > 0 Then
        SetStatus problem, False
    ElseIf Not statusIsResult Then
        SetStatus "", False
    End If
End Sub

' The formula the current page describes. Blank optional arguments after the
' last one set are left out; blank ones before it are written as their
' defaults, so every argument keeps its position.
Private Function BuildFormula(ByRef problem As String) As String
    Dim items As Collection, argInput As ArcoArgumentInput
    Dim texts() As String, i As Long, lastSet As Long, missing As String
    Dim formulaText As String, invalid As String

    Set items = pageInputs(currentFunction)
    ReDim texts(1 To items.Count)
    For i = 1 To items.Count
        Set argInput = items(i)
        If Not argInput.Box Is Nothing Then texts(i) = Trim$(argInput.Box.text)
        If Len(texts(i)) > 0 Then lastSet = i
    Next i

    For i = 1 To items.Count
        Set argInput = items(i)
        If Len(texts(i)) = 0 Then
            If argInput.Arg("Required") Then
                If Len(missing) > 0 Then missing = missing & ", "
                missing = missing & argInput.Arg("Name")
                If i > lastSet Then lastSet = i
            ElseIf i < lastSet Then
                texts(i) = argInput.Arg("Default")
            End If
        ElseIf Not EncodeArgument(argInput.Arg("Kind"), texts(i)) Then
            If Len(invalid) = 0 Then invalid = argInput.Arg("Name")
        End If
    Next i

    formulaText = "=" & currentFunction & "("
    For i = 1 To lastSet
        If i > 1 Then formulaText = formulaText & ", "
        formulaText = formulaText & texts(i)
    Next i
    BuildFormula = formulaText & ")"

    If Len(missing) > 0 Then
        problem = "Fill in " & missing & "."
    ElseIf Len(invalid) > 0 Then
        problem = invalid & " needs a value from its list, a number, or a cell."
    End If
End Function

' Turn what was typed into formula text. False when a TRUE/FALSE or number
' argument holds something that is neither.
Private Function EncodeArgument(ByVal kind As String, ByRef text As String) As Boolean
    EncodeArgument = True
    If Left$(text, 1) = "=" Then
        text = Mid$(text, 2)
    ElseIf IsReferenceText(text) Then
        ' a cell address, used as typed
    ElseIf IsServerList(kind) Then
        text = """" & Replace(text, """", """""") & """"
    ElseIf kind = "bool" Then
        EncodeArgument = (StrComp(text, "TRUE", vbTextCompare) = 0 Or StrComp(text, "FALSE", vbTextCompare) = 0)
        text = UCase$(text)
    Else
        If InStr(text, CHOICE_SEPARATOR) > 0 Then text = Left$(text, InStr(text, CHOICE_SEPARATOR) - 1)
        EncodeArgument = IsNumeric(text)
    End If
End Function

' A cell or range address such as B2, $B$2:$C$4, Sheet1!B2, or 'My Sheet'!B2.
Private Function IsReferenceText(ByVal text As String) As Boolean
    Static pattern As Object
    If pattern Is Nothing Then
        Set pattern = CreateObject("VBScript.RegExp")
        pattern.Pattern = "^((\[[^\]]+\])?('[^']+'|[A-Za-z0-9_.]+)!)?\$?[A-Za-z]{1,3}\$?[0-9]{1,7}(:\$?[A-Za-z]{1,3}\$?[0-9]{1,7})?$"
    End If
    IsReferenceText = pattern.Test(text)
End Function

' ---- Editing an existing formula ----

' The cell holding the Arco formula a cell belongs to: the cell itself, or the
' formula whose results spill over it.
Private Function ArcoFormulaOwner(ByVal cell As Range) As Range
    Dim parent As Range
    If cell Is Nothing Then Exit Function
    On Error Resume Next
    If cell.HasFormula Then
        If Len(ArcoFormulaFunction(cell.Formula2)) > 0 Then Set ArcoFormulaOwner = cell
        Exit Function
    End If
    Set parent = cell.SpillParent
    If parent Is Nothing Then Exit Function
    If Len(ArcoFormulaFunction(parent.Formula2)) > 0 Then Set ArcoFormulaOwner = parent
End Function

Private Sub LoadFormula(ByVal owner As Range)
    Dim functionName As String, formulaText As String, body As String
    Dim args As Collection, items As Collection, i As Long, closing As Long

    formulaText = Trim$(owner.Formula2)
    functionName = ArcoFormulaFunction(formulaText)
    ShowFunction functionName
    body = Mid$(formulaText, Len(functionName) + 3)
    closing = ClosingParen(body)
    If closing = 0 Then Exit Sub
    Set args = SplitArgs(Left$(body, closing - 1))
    Set items = pageInputs(functionName)

    updating = True
    For i = 1 To items.Count
        If Not items(i).Box Is Nothing Then items(i).Box.text = ""
    Next i
    For i = 1 To args.Count
        If i > items.Count Then Exit For
        If Not items(i).Box Is Nothing Then items(i).Box.text = DisplayText(args(i))
    Next i
    updating = False
    UpdateFormula
    If closing < Len(body) Then
        SetStatus "The formula in " & owner.Address(False, False) & " does more than call " & functionName & _
                  "; Insert replaces all of it.", True
    Else
        SetStatus "Loaded the formula in " & owner.Address(False, False) & ".", False
    End If
    statusIsResult = True
End Sub

' Where the argument list that starts a text closes, or 0.
Private Function ClosingParen(ByVal text As String) As Long
    Dim i As Long, depth As Long, inQuotes As Boolean, ch As String
    For i = 1 To Len(text)
        ch = Mid$(text, i, 1)
        If ch = """" Then
            inQuotes = Not inQuotes
        ElseIf Not inQuotes Then
            If ch = "(" Then
                depth = depth + 1
            ElseIf ch = ")" Then
                If depth = 0 Then
                    ClosingParen = i
                    Exit Function
                End If
                depth = depth - 1
            End If
        End If
    Next i
End Function

' What a box shows for one argument of a loaded formula: a quoted text without
' its quotes, and an expression that is not a plain value behind an =.
Private Function DisplayText(ByVal raw As String) As String
    raw = Trim$(raw)
    If Len(raw) >= 2 And Left$(raw, 1) = """" And Right$(raw, 1) = """" Then
        DisplayText = Replace(Mid$(raw, 2, Len(raw) - 2), """""", """")
    ElseIf Len(raw) = 0 Or IsNumeric(raw) Or IsReferenceText(raw) Or _
           StrComp(raw, "TRUE", vbTextCompare) = 0 Or StrComp(raw, "FALSE", vbTextCompare) = 0 Then
        DisplayText = raw
    Else
        DisplayText = "=" & raw
    End If
End Function

' ---- The target cell ----

' The selected cell, or the Arco formula whose results cover it.
Private Function TargetCell() As Range
    Dim cell As Range
    On Error Resume Next
    If TypeName(Selection) <> "Range" Then Exit Function
    Set cell = ActiveCell
    On Error GoTo 0
    If cell Is Nothing Then Exit Function
    Set TargetCell = ArcoFormulaOwner(cell)
    If TargetCell Is Nothing Then Set TargetCell = cell
End Function

Private Sub UpdateTarget()
    Dim target As Range, note As String
    Set target = TargetCell()
    loadButton.Enabled = False
    If target Is Nothing Then
        targetLabel.caption = "Select a worksheet cell to insert into."
    Else
        If Not ArcoFormulaOwner(target) Is Nothing Then
            loadButton.Enabled = True
            note = " - replaces its Arco formula"
        ElseIf Not IsEmpty(target.Value) Or target.HasFormula Then
            note = " - replaces what it holds"
        End If
        targetLabel.caption = "Insert into " & target.Worksheet.Name & "!" & target.Address(False, False) & note
    End If
    UpdateFormula
End Sub

' Read the Arco formula in the selected cell, replacing what the panel holds.
Private Sub loadButton_Click()
    Dim owner As Range
    Set owner = ArcoFormulaOwner(TargetCell())
    If owner Is Nothing Then
        SetStatus "The selected cell holds no Arco formula.", True
        Exit Sub
    End If
    LoadFormula owner
    EnsureLists
End Sub

Private Sub App_SheetSelectionChange(ByVal Sh As Object, ByVal Target As Range)
    statusIsResult = False
    UpdateTarget
End Sub

Private Sub App_SheetActivate(ByVal Sh As Object)
    UpdateTarget
End Sub

Private Sub App_WorkbookActivate(ByVal Wb As Workbook)
    UpdateTarget
End Sub

' ---- Buttons ----

Private Sub insertButton_Click()
    Dim target As Range, formulaText As String, problem As String

    formulaText = BuildFormula(problem)
    If Len(problem) > 0 Then
        SetStatus problem, True
        Exit Sub
    End If
    Set target = TargetCell()
    If target Is Nothing Then
        SetStatus "Select a worksheet cell first.", True
        Exit Sub
    End If

    On Error GoTo Failed
    SetStatus "Inserting and loading data ...", False
    DoEvents
    If target.HasArray Then
        target.CurrentArray.FormulaArray = formulaText
    Else
        target.Formula2 = formulaText
    End If
    On Error GoTo 0
    SetStatus ResultText(target), False
    statusIsResult = True
    UpdateTarget
    Exit Sub
Failed:
    SetStatus "Excel did not accept the formula: " & Err.Description, True
End Sub

' What the inserted formula shows, when that needs the user's attention.
Private Function ResultText(ByVal target As Range) As String
    Dim value As Variant, where As String
    where = target.Address(False, False)
    value = target.Value
    If IsError(value) Then
        If CLng(value) = 2045 Then
            ResultText = "Inserted in " & where & ", but it cannot spill: clear the cells below and to the right."
        Else
            ResultText = "Inserted in " & where & ". It shows " & target.text & "."
        End If
    ElseIf VarType(value) = vbString And Left$(CStr(value), 1) = "(" Then
        ResultText = "Inserted in " & where & ". It shows " & CStr(value)
    Else
        ResultText = "Inserted in " & where & "."
    End If
End Function

Private Sub SetStatus(ByVal text As String, ByVal isProblem As Boolean)
    statusLabel.caption = text
    statusLabel.ForeColor = IIf(isProblem, ERROR_COLOR, HINT_COLOR)
End Sub

Private Sub closeButton_Click()
    Unload Me
End Sub
