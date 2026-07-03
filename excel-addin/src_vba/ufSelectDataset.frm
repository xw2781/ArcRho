VERSION 5.00
Begin {C62A69F0-16DC-11CE-9E98-00AA00574A4F} ufSelectDataset 
   Caption         =   "Load Datasets"
   ClientHeight    =   5355
   ClientLeft      =   195
   ClientTop       =   795
   ClientWidth     =   8805.001
   OleObjectBlob   =   "ufSelectDataset.frx":0000
   StartUpPosition =   1  'CenterOwner
End
Attribute VB_Name = "ufSelectDataset"
Attribute VB_GlobalNameSpace = False
Attribute VB_Creatable = False
Attribute VB_PredeclaredId = True
Attribute VB_Exposed = False

Option Explicit

' in-memory data from dataset_types.json
' mData is a 2D array including headers (row 1)
Private mData As Variant
Private mColCat As Long, mColName As Long, mColFmt As Long
Private mDatasetTypesPath As String

Private Sub UserForm_Initialize()
    Dim oldScr As Boolean, oldEvt As Boolean, oldCalc As XlCalculation
    Dim projectName As String
    
    'Me.lbl1.Font.Size = 12

    projectName = CurrentWorkbookDefaultProject()
    If Len(projectName) = 0 Then
        ShowDefaultProjectWarning
        Unload Me
        Exit Sub
    End If
    mDatasetTypesPath = GetProjectDatasetTypesJsonPath(projectName)
    
    oldScr = Application.ScreenUpdating
    oldEvt = Application.EnableEvents
    oldCalc = Application.Calculation
    Application.ScreenUpdating = False
    Application.EnableEvents = False
    Application.Calculation = xlCalculationManual
    
    On Error GoTo clean_fail
    
    ' Load dataset_types.json to an array compatible with the existing filter code.
    mData = LoadDatasetTypesJsonData(mDatasetTypesPath)
    
    ' Find column indices by header names
    mColCat = FindHeaderCol("Category")
    mColName = FindHeaderCol("Name")
    mColFmt = FindHeaderCol("Data Format")
    
    ' Build filter dropdown lists (with "All" at top)
    PopulateComboFromUnique cboCategory, mColCat
    PopulateComboFromUnique cboFormat, mColFmt
    lstNames.ColumnCount = 3
    lstNames.ColumnWidths = "230 pt;80 pt;70 pt"
    
    ' Empty keyword to start
    txtSearch.text = ""
    
    ' Show full list initially
    ApplyFilters
    
clean_exit:
    Application.Calculation = oldCalc
    Application.EnableEvents = oldEvt
    Application.ScreenUpdating = oldScr
    Exit Sub

clean_fail:
    MsgBox "Unable to load dataset list:" & vbCrLf & mDatasetTypesPath & vbCrLf & Err.Description, vbExclamation
    Resume clean_exit
End Sub

Private Sub UserForm_Activate()
    EnableMouseWheelForListBox lstNames
End Sub

Private Sub UserForm_Deactivate()
    DisableMouseWheelForListBox
End Sub

Private Sub UserForm_QueryClose(Cancel As Integer, CloseMode As Integer)
    DisableMouseWheelForListBox
End Sub

Private Sub UserForm_Terminate()
    DisableMouseWheelForListBox
End Sub

Private Function CurrentWorkbookDefaultProject() As String
    Dim ws As Worksheet
    Dim projectValue As String

    On Error Resume Next
    Set ws = ActiveWorkbook.Worksheets("ResQ Settings")
    On Error GoTo 0
    If ws Is Nothing Then Exit Function

    projectValue = Trim$(CStr(ws.Range("B7").Value))
    If Len(projectValue) = 0 Then Exit Function

    CurrentWorkbookDefaultProject = Mid$(projectValue, InStrRev(projectValue, "\") + 1)
End Function

Private Sub ShowDefaultProjectWarning()
    Dim msg As String

    msg = "Please connect and log in, then select a default project before using Select Datasets."
    On Error Resume Next
    ufAlert.ShowMessage msg, "ArcRho"
    If Err.Number <> 0 Then
        Err.Clear
        MsgBox msg, vbExclamation, "ArcRho"
    End If
    On Error GoTo 0
End Sub

Private Function LoadDatasetTypesJsonData(ByVal filePath As String) As Variant
    Dim root As Object
    Dim columns As Collection
    Dim rows As Collection
    Dim outData() As Variant
    Dim row As Collection
    Dim r As Long, c As Long
    Dim rowCount As Long, colCount As Long

    If Len(Dir$(filePath, vbNormal Or vbReadOnly Or vbHidden Or vbSystem)) = 0 Then
        Err.Raise 53, , "File not found."
    End If

    Set root = JsonParse(ReadUtf8Text(filePath))
    If Not root.Exists("columns") Or Not root.Exists("rows") Then
        Err.Raise 5, , "dataset_types.json must contain columns and rows."
    End If

    Set columns = root("columns")
    Set rows = root("rows")
    colCount = columns.Count
    rowCount = rows.Count
    If colCount = 0 Then Err.Raise 5, , "dataset_types.json has no columns."

    ReDim outData(1 To rowCount + 1, 1 To colCount)

    For c = 1 To colCount
        outData(1, c) = CStr(columns.Item(c))
    Next c

    For r = 1 To rowCount
        If IsObject(rows.Item(r)) Then
            Set row = rows.Item(r)
            For c = 1 To colCount
                If row.Count >= c Then
                    If IsObject(row.Item(c)) Then
                        outData(r + 1, c) = vbNullString
                    ElseIf IsEmpty(row.Item(c)) Or IsNull(row.Item(c)) Then
                        outData(r + 1, c) = vbNullString
                    Else
                        outData(r + 1, c) = CStr(row.Item(c))
                    End If
                Else
                    outData(r + 1, c) = vbNullString
                End If
            Next c
        End If
    Next r

    LoadDatasetTypesJsonData = outData
End Function

Private Function ReadUtf8Text(ByVal filePath As String) As String
    Dim stream As Object

    Set stream = CreateObject("ADODB.Stream")
    stream.Type = 2
    stream.Charset = "utf-8"
    stream.Open
    stream.LoadFromFile filePath
    ReadUtf8Text = stream.ReadText(-1)
    stream.Close
End Function
' ==== Filtering ====

Private Sub ApplyFilters()
    ' Applies Category, Data Format, and keyword filters; repopulates lstNames
    Dim r As Long, lastRow As Long
    Dim cat As String, fmt As String, kw As String
    Dim nm As String
    Dim bag As Object ' Scripting.Dictionary to keep names unique (optional)
    
    If IsEmpty(mData) Then Exit Sub
    lastRow = UBound(mData, 1)
    
    cat = Trim$(cboCategory.text)
    fmt = Trim$(cboFormat.text)
    kw = LCase$(Trim$(txtSearch.text))
    
    Set bag = CreateObject("Scripting.Dictionary")
    
    lstNames.Clear
    
    For r = 2 To lastRow ' skip header row
        nm = CStr(mData(r, mColName))
        If Len(nm) > 0 Then
            If MatchOrAll(mData(r, mColCat), cat) _
               And MatchOrAll(mData(r, mColFmt), fmt) _
               And ContainsCI(nm, kw) Then
                   
                   If Not bag.Exists(nm) Then
                       bag.Add nm, True
                       AddDatasetListItem nm, CStr(mData(r, mColCat)), CStr(mData(r, mColFmt))
                   End If
            End If
        End If
    Next r
End Sub

Private Sub AddDatasetListItem(ByVal datasetName As String, ByVal category As String, ByVal dataFormat As String)
    Dim rowIndex As Long

    lstNames.AddItem datasetName
    rowIndex = lstNames.ListCount - 1

    On Error Resume Next
    lstNames.List(rowIndex, 1) = category
    lstNames.List(rowIndex, 2) = dataFormat
    On Error GoTo 0
End Sub

Private Function MatchOrAll(ByVal Value As Variant, ByVal sel As String) As Boolean
    ' True if filter is blank/"All" or Value equals selection (case-insensitive)
    Dim v As String: v = CStr(Value)
    If Len(sel) = 0 Or LCase$(sel) = "all" Then
        MatchOrAll = True
    Else
        MatchOrAll = (StrComp(v, sel, vbTextCompare) = 0)
    End If
End Function

Private Function ContainsCI(ByVal hay As String, ByVal needle As String) As Boolean
    ' Case-insensitive "contains". Empty needle means True.
    If Len(needle) = 0 Then
        ContainsCI = True
    Else
        ContainsCI = (InStr(1, LCase$(hay), needle, vbTextCompare) > 0)
    End If
End Function

' ==== Populate filter combos with unique values (+ "All") ====

Private Sub PopulateComboFromUnique(cb As MSForms.ComboBox, ByVal colIdx As Long)
    Dim dict As Object, r As Long, lastRow As Long, v As String
    Set dict = CreateObject("Scripting.Dictionary")
    
    lastRow = UBound(mData, 1)
    For r = 2 To lastRow
        v = CStr(mData(r, colIdx))
        If Len(v) > 0 Then
            If Not dict.Exists(v) Then dict.Add v, True
        End If
    Next r
    
    cb.Clear
    cb.AddItem "All"
    
    Dim k As Variant
    For Each k In dict.Keys
        cb.AddItem CStr(k)
    Next k
    
    cb.ListIndex = 0 ' default to "All"
End Sub

Private Function FindHeaderCol(ByVal headerName As String) As Long
    ' Finds zero-based header by exact match (case-insensitive) in row 1 of mData
    Dim c As Long, lastCol As Long
    lastCol = UBound(mData, 2)
    For c = 1 To lastCol
        If StrComp(CStr(mData(1, c)), headerName, vbTextCompare) = 0 Then
            FindHeaderCol = c
            Exit Function
        End If
    Next c
    Err.Raise 5, , "Header not found: " & headerName
End Function

' ==== Events: whenever a filter changes, re-apply filters ====

Private Sub cboCategory_Change()
    ApplyFilters
End Sub

Private Sub cboFormat_Change()
    ApplyFilters
End Sub

Private Sub txtSearch_Change()
    ' Live keyword filtering as the user types (initial Value is empty)
    ApplyFilters
End Sub

' Optional: double-click on a name to select immediately
Private Sub lstNames_DblClick(ByVal Cancel As MSForms.ReturnBoolean)
    cmdSelect_Click
End Sub

' ==== Buttons ====

Private Sub cmdSelect_Click()
    Dim picked As String
    If lstNames.ListIndex >= 0 Then
        picked = CStr(lstNames.List(lstNames.ListIndex))
    Else
        picked = Trim$(txtSearch.text) ' or however you want to fall back
    End If
    If Len(picked) = 0 Then Exit Sub

    Dim tgt As Range, owner As Range
    Set tgt = ActiveCell

    ' 1) If active cell itself is ArcRho or legacy alias formula -> update its second arg
    If tgt.HasFormula And IsArcRhoFormula(tgt.Formula2) Then
        If UpdateArcRhoArg(2, tgt, picked) Then Exit Sub
    End If

    ' 2) If active cell is inside a spill from an ArcRho or legacy alias formula -> update that owner
    Set owner = FindArcRhoOwnerForCell(tgt)
    If Not owner Is Nothing Then
        If UpdateArcRhoArg(2, owner, picked) Then Exit Sub
    End If

    ' 3) Otherwise just write the Value to the active cell
    tgt.Value = picked
    
    Me.lstNames.SetFocus

End Sub


Private Sub cmdCancel_Click()
    Unload Me
End Sub




