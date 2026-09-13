Private mAlertCloseTime As Date

Public Sub CopyActiveRangeAddress()
    Dim selectedRange As Range
    Dim selectedWorkbook As Workbook
    Dim clipboard As MSForms.DataObject
    Dim externalAddress As String

    On Error GoTo ErrorHandler

    If TypeName(Application.Selection) <> "Range" Then
        ufAlert.ShowMessage "Select a worksheet range before copying its address.", "ArcRho"
        Exit Sub
    End If

    Set selectedRange = Application.Selection
    Set selectedWorkbook = selectedRange.Worksheet.Parent

    If Len(selectedWorkbook.Path) = 0 Then
        ufAlert.ShowMessage "Save the workbook before copying a full range address.", "ArcRho"
        Exit Sub
    End If

    externalAddress = "='" & Replace$( _
        selectedWorkbook.Path & Application.PathSeparator & _
        "[" & selectedWorkbook.Name & "]" & selectedRange.Worksheet.Name, _
        "'", "''") & "'!" & selectedRange.Address( _
            RowAbsolute:=True, _
            ColumnAbsolute:=True, _
            ReferenceStyle:=xlA1)

    Set clipboard = New MSForms.DataObject
    clipboard.SetText externalAddress
    clipboard.PutInClipboard

    ufAlert.ShowTimedMessage _
        "Active range address copied to the clipboard.", _
        "ArcRho", _
        2
    Exit Sub

ErrorHandler:
    ufAlert.ShowMessage "The active range address could not be copied: " & Err.Description, "ArcRho"
End Sub

Public Sub ScheduleTimedAlertClose(ByVal delaySeconds As Long)
    CancelTimedAlertClose

    mAlertCloseTime = Now + TimeSerial(0, 0, delaySeconds)
    Application.OnTime _
        EarliestTime:=mAlertCloseTime, _
        Procedure:=TimedAlertCloseProcedureName
End Sub

Public Sub CancelTimedAlertClose()
    If mAlertCloseTime = 0 Then Exit Sub

    On Error Resume Next
    Application.OnTime _
        EarliestTime:=mAlertCloseTime, _
        Procedure:=TimedAlertCloseProcedureName, _
        Schedule:=False
    On Error GoTo 0

    mAlertCloseTime = 0
End Sub

Public Sub CloseTimedAlert()
    mAlertCloseTime = 0
    Unload ufAlert
End Sub

Private Function TimedAlertCloseProcedureName() As String
    TimedAlertCloseProcedureName = "'" & Replace$(ThisWorkbook.Name, "'", "''") & "'!CloseTimedAlert"
End Function

Sub CalculateWorkbook()
    If disableProgressBar Then
        CalculateWorkbookNoUI
    Else
        CalculateWorkbookWithUI
    End If
End Sub

Sub CalculateWorkbookWithUI()
    Dim currentSheet As Worksheet

    On Error GoTo ErrorHandler

    Set currentSheet = ActiveWorkbook.ActiveSheet

    errCount = 0
    disable_ufLoading = True
    skipDataProcess = False
    ' This button brings the workbook up to date with the project, so every
    ' dataset it reaches is produced again rather than read as it stands.
    rebuildDatasets = True

    Show_ufProgressBar
    ufProgressBar.LabelTitle.Caption = "Searching for ArcRho formulas ..."
    DoEvents

    ' Step (1) Count the ranges, touching nothing
    Call SearchArcRhoFormulas

    ' Step (2) Update them one at a time, reporting progress against that count
    UpdateArcRhoBlocks

    ' Anything that reads an ArcRho block is left dirty while the workbook is
    ' manual, so the workbook is finished off here. The blocks are already
    ' calculated by now, and the workbook's own setting is never touched.
    If Not cancelUpdate Then ActiveWorkbook.Calculate

    Application.StatusBar = "[" & ActiveWorkbook.Name & "] - Refreshed at " & Format(Now, "hh:mm:ss")

CleanExit:
    ' Ordinary recalculation must not rebuild anything, so the flag is dropped
    ' here whichever way this pass ended.
    rebuildDatasets = False
    Unload ufProgressBar
    ufProgressBar.ClearText
    disable_ufLoading = False
    cancelUpdate = False
    disableRequest = False
    currentSheet.Activate

    Exit Sub

ErrorHandler:
    Application.StatusBar = "[" & ActiveWorkbook.Name & "] - Workbook not refreshed! Updated @ " & Format(Now, "hh:mm:ss")
    Resume CleanExit

End Sub

Sub CalculateSheet()
    Dim currentSheet As Worksheet

    On Error GoTo ErrorHandler

    Set currentSheet = ActiveWorkbook.ActiveSheet

    errCount = 0
    disable_ufLoading = True
    skipDataProcess = False
    ' This button brings the worksheet up to date with the project, so every
    ' dataset it reaches is produced again rather than read as it stands.
    rebuildDatasets = True

    Show_ufProgressBar
    ufProgressBar.LabelTitle.Caption = "Searching for ArcRho formulas ..."
    DoEvents

    ' Step (1) Count the ranges, touching nothing
    SearchArcRhoFormulas True

    ' Step (2) Update them one at a time, reporting progress against that count
    UpdateArcRhoBlocks

    ' Anything on this sheet that reads an ArcRho block is left dirty while the
    ' workbook is manual, so the sheet is finished off here. The blocks are
    ' already calculated by now, and the workbook's own setting is never touched.
    If Not cancelUpdate Then currentSheet.Calculate

    Application.StatusBar = "[" & currentSheet.Name & "] - Refreshed at " & Format(Now, "hh:mm:ss")

CleanExit:
    ' Ordinary recalculation must not rebuild anything, so the flag is dropped
    ' here whichever way this pass ended.
    rebuildDatasets = False
    Unload ufProgressBar
    ufProgressBar.ClearText
    disable_ufLoading = False
    cancelUpdate = False
    disableRequest = False
    Exit Sub

ErrorHandler:
    Resume CleanExit

End Sub

Sub CalculateWorkbookNoUI()
    On Error GoTo ErrorHandler
    skipDataProcess = False
    disable_ufLoading = True

    ' The same button as CalculateWorkbookWithUI, for a user who turned the
    ' progress window off, so it produces every dataset again in the same way.
    ' One full calculation is enough: the server answers each request with the
    ' figures, and Excel resolves a formula that depends on another itself.
    rebuildDatasets = True
    ClearDatasetResultCache
    Application.CalculateFull

CleanExit:
    rebuildDatasets = False
    disableWaitTime = False
    disable_ufLoading = False
    Exit Sub

ErrorHandler:
    Resume CleanExit

End Sub

' Find every block of ArcRho formulas on the sheets in scope, without touching
' one. Nothing is re-entered and nothing is calculated here, so the search only
' reads formulas and asks the server for nothing. It ends knowing how many
' ranges there are, which is what the update below reports its progress against.
Public Sub SearchArcRhoFormulas(Optional ByVal ActiveSheetOnly As Boolean = False)

    Dim ws As Worksheet
    Dim cell As Range
    Dim arrCell As Range
    Dim sheetFormulas As Range
    Dim cellKey As String
    Dim arrKey As String
    Dim totalSheets As Long
    Dim countSheets As Long
    Dim totalCells As Long
    Dim countCells As Long

    On Error GoTo ErrorHandler

    ' A new pass starts here, so nothing remembered from the last one is served.
    ClearDatasetResultCache

    Set processedCells = New Collection
    Set processedArrays = New Collection

    ' Decide scope
    If ActiveSheetOnly Then
        totalSheets = 1
    Else
        totalSheets = ActiveWorkbook.Worksheets.Count
    End If

    countSheets = 1

    ' Loop sheets
    For Each ws In ActiveWorkbook.Worksheets

        ' Skip non-active sheets if needed
        If ActiveSheetOnly Then
            If ws.Name <> ActiveSheet.Name Then GoTo ContinueLoop
        End If

        If cancelUpdate Then GoTo CleanExit
        If ws.Name = "ResQ Settings" Then GoTo ContinueLoop

        ufProgressBar.LabelBody.Caption = "Reading worksheet <" & ws.Name & ">"
        DoEvents

        Set sheetFormulas = FormulaCells(ws)
        If sheetFormulas Is Nothing Then GoTo ContinueLoop

        ' One sheet fills the whole bar when the search is scoped to it, so it
        ' moves per formula read rather than jumping from nothing to finished.
        If ActiveSheetOnly Then
            totalCells = sheetFormulas.Count
            countCells = 0
        End If

        For Each cell In sheetFormulas
            If cancelUpdate Then GoTo CleanExit
            cellKey = ws.Name & "!" & cell.Address
            If Not KeyExists(processedCells, cellKey) Then
                If InStr(1, cell.formula, "ADAS", vbTextCompare) > 0 _
                   Or InStr(1, cell.formula, "ArcRho", vbTextCompare) > 0 Then
                    If cell.HasArray Then
                        arrKey = ws.Name & "!" & cell.CurrentArray.Address
                        processedArrays.Add arrKey, arrKey

                        For Each arrCell In cell.CurrentArray
                            cellKey = ws.Name & "!" & arrCell.Address
                            processedCells.Add cellKey, cellKey
                        Next arrCell
                    Else
                        processedCells.Add cellKey, cellKey
                        processedArrays.Add cellKey, cellKey
                    End If
                End If
            End If

            If ActiveSheetOnly Then
                countCells = countCells + 1
                If countCells Mod 20 = 0 Or countCells = totalCells Then
                    ufProgressBar.LabelDetails.Caption = _
                        countCells & "/" & totalCells & " formula(s) read, " & _
                        processedArrays.Count & " ArcRho range(s) found"
                    ufProgressBar.UpdateProgressBar countCells / totalCells * 100
                End If
            End If
        Next cell

        If Not ActiveSheetOnly Then
            ufProgressBar.LabelDetails.Caption = countSheets & "/" & totalSheets & " sheet(s) reviewed"
            ufProgressBar.UpdateProgressBar countSheets / totalSheets * 100
        End If
        countSheets = countSheets + 1
        DoEvents

ContinueLoop:
    Next ws

CleanExit:
    ufProgressBar.ClearText
    Exit Sub

ErrorHandler:
    Resume CleanExit

End Sub

' The formula cells of one worksheet, or Nothing when it holds none. Asking
' Excel for them raises an error rather than answering an empty range, which is
' the only reason this exists.
Private Function FormulaCells(ByVal ws As Worksheet) As Range
    On Error Resume Next
    Set FormulaCells = ws.UsedRange.SpecialCells(xlCellTypeFormulas)
    On Error GoTo 0
End Function

' Work through the ArcRho ranges the search found, one at a time. The count is
' known before the first request goes out, so the window can say how many ranges
' there are and how far along it is, and Cancel can stop between any two.
Public Sub UpdateArcRhoBlocks()
    Dim item As Variant
    Dim totalBlocks As Long
    Dim countBlocks As Long

    If processedArrays Is Nothing Then Exit Sub

    totalBlocks = processedArrays.Count
    If totalBlocks = 0 Then
        ufProgressBar.LabelTitle.Caption = "No ArcRho formulas found"
        ufProgressBar.UpdateProgressBar 100
        Exit Sub
    End If

    ufProgressBar.LabelTitle.Caption = "Updating " & totalBlocks & " ArcRho range(s) ..."
    ufProgressBar.LabelDetails.Caption = "0/" & totalBlocks & " range(s) updated"
    ufProgressBar.UpdateProgressBar 0

    For Each item In processedArrays
        If cancelUpdate Then Exit Sub
        ufProgressBar.LabelBody.Caption = "Updating " & CStr(item)
        RefreshArcRhoBlock CStr(item)

        countBlocks = countBlocks + 1
        ufProgressBar.LabelDetails.Caption = countBlocks & "/" & totalBlocks & " range(s) updated"
        ufProgressBar.UpdateProgressBar countBlocks / totalBlocks * 100
    Next item
End Sub

Function KeyExists(coll As Collection, key As String) As Boolean
    Dim item As Variant
    On Error Resume Next
    item = coll(key)
    KeyExists = (Err.Number = 0)
    On Error GoTo 0
End Function

Function SheetExists(sheetName As String) As Boolean
    Dim ws As Worksheet
    On Error Resume Next
        Set ws = ActiveWorkbook.Sheets(sheetName)
    On Error GoTo 0
    If ws Is Nothing Then
        SheetExists = False
    Else
        SheetExists = True
    End If
End Function

Public Sub SetupConnection2()
    Dim sheet1 As Worksheet
    Dim Sheet2 As Worksheet
        
    If Not SheetExists("ResQ Settings") Then
        Set sheet1 = ActiveWorkbook.Worksheets.Add(Before:=ActiveWorkbook.Sheets(1))
        sheet1.Name = "ResQ Settings"
    End If
    
    If Not SheetExists("Project Details") Then
        Set Sheet2 = ActiveWorkbook.Worksheets.Add(Before:=ActiveWorkbook.Sheets(2))
        Sheet2.Name = "Project Details"
    End If
    
    Set sheet1 = ActiveWorkbook.Sheets("ResQ Settings")
        sheet1.Columns("A").ColumnWidth = 72.71
        sheet1.Columns("B").ColumnWidth = 44.71
        
        sheet1.Range("A1").Value = "Connection Name"
        sheet1.Range("A2").Value = "Windows Authentication"
        sheet1.Range("A3").Value = "User Name"
        sheet1.Range("A7").Value = "Default Project Name"
        sheet1.Range("A9").Value = "Project Names"
        If sheet1.Range("B7").Value = "" Then sheet1.Range("B7").Value = "NJ_Annual_Prod_2025 Q4-Nov"
    
    Set Sheet2 = ActiveWorkbook.Sheets("Project Details")
        Sheet2.Columns("B").ColumnWidth = 22.14
        Sheet2.Columns("C").ColumnWidth = 39.43
        
        Sheet2.Range("B4:C11").FormulaArray = "=ArcRhoProjectSettings()"
        Sheet2.Range("C4:C11").Interior.Color = 10092543
        Sheet2.Range("C4:C11").HorizontalAlignment = xlCenter
        Sheet2.Range("C4:C11").Font.Color = 255 ' Red
        Sheet2.Range("C4:C11").Font.Bold = True
        
        Dim borders() As Variant
        borders = Array(xlEdgeLeft, xlEdgeTop, xlEdgeBottom, xlEdgeRight, xlInsideVertical)
        For i = LBound(borders) To UBound(borders)
            With Sheet2.Range("B4:C11").borders(borders(i))
                .LineStyle = xlContinuous
                .Weight = xlMedium
            End With
        Next i
        
        Sheet2.Range("C6:C8").NumberFormat = "m/d/yy"
        
    On Error Resume Next
    
    On Error GoTo 0
End Sub

Sub LoadAddIn()
    errCount = 0
    skipDataProcess = False
    pendingUpdate = False
    Application.StatusBar = "Calculation Resumed"
End Sub

Sub UnloadAddIn()
    On Error GoTo ErrorHandler
    Dim addIn As addIn
    
    For Each addIn In AddIns
        If StrComp(addIn.Name, "ArcRho.xlam", vbTextCompare) = 0 _
           Or StrComp(addIn.Name, "ARCRHO_BETA.xlam", vbTextCompare) = 0 Then
            addIn.Installed = False
            Exit For
        End If
    Next addIn
    
ErrorHandler:
    ' MsgBox "An error occurred: " & Err.Description
    ' MsgBox "An error occurred when unloading the add-in"
    Err.Clear
    On Error GoTo 0
End Sub

Sub CheckUpdates()
    Dim exePath As String
    Dim retVal As Long
    
    exePath = "\\Ne7saswpn02\e\ResQ\Excel Add-ins\Update\dist\AutoUpdate.exe"
    
    ' Run the executable
    retVal = Shell(exePath, vbNormalFocus)
    
    ' Check the return Value
End Sub

Sub ReplaceInWorkbook(findText As String, replaceText As String)
    Dim ws As Worksheet
    
    For Each ws In ActiveWorkbook.Worksheets
        ws.Cells.Replace What:=findText, Replacement:=replaceText, _
            LookAt:=xlPart, SearchOrder:=xlByRows, _
            MatchCase:=False, SearchFormat:=False, ReplaceFormat:=False
    Next ws
    
End Sub

Sub ResetAddinReferences()

    Dim link As Variant
    Dim book As Workbook
    Dim oldCalcMode As XlCalculation
    Dim hasOldLink As Boolean
    Dim hasArcRhoLink As Boolean
    Dim hasBetaLink As Boolean
    Dim TextArcRho As String
    Dim TextArcRhoBeta As String
    Dim TextResQ As String
    
    On Error GoTo CleanExit
    
    oldCalcMode = Application.Calculation
    Application.Calculation = xlCalculationManual
    
    Set book = ActiveWorkbook
    
    TextArcRho = "='" & ProductPath("Excel Add-ins\ArcRho.xlam") & "'!ArcRho"
    TextArcRhoBeta = "='" & ProductPath("Excel Add-ins\beta\ARCRHO_BETA.xlam") & "'!ArcRho"
    TextResQ = "='C:\Program Files\Willis Towers Watson\ResQ\Addins\ResQ.xlam'!ResQ"
    
    ' Check all links in the workbook
    If Not IsEmpty(book.linkSources()) Then
        For Each link In book.linkSources()
            If InStr(link, "ResQ.xlam") > 0 Then hasOldLink = True
            If InStr(1, link, "ArcRho", vbTextCompare) > 0 Then hasArcRhoLink = True
            If InStr(1, link, "ARCRHO_BETA.xlam", vbTextCompare) > 0 Then hasBetaLink = True
        Next link
    End If
    
    If hasOldLink Then ' Change to ArcRho
        skipDataProcess = True
        ReplaceInWorkbook "='C:\Program Files (x86)\Willis Towers Watson\ResQ\Addins\ResQ.xlam'!ResQ", "=ArcRho"
        ReplaceInWorkbook TextResQ, "=ArcRho"
        ReplaceInWorkbook "=ResQ", "=ArcRho"
        Application.StatusBar = "ArcRho Excel Add-in activated."
        
    ElseIf Not hasOldLink And hasArcRhoLink Then ' Change to ResQ
        If Dir("C:\Program Files\Willis Towers Watson\ResQ\Addins\ResQ.xlam") <> "" Then
            If hasBetaLink Then
                ReplaceInWorkbook TextArcRhoBeta, TextResQ
            Else
                ReplaceInWorkbook TextArcRho, TextResQ
            End If
            ReplaceInWorkbook "=ArcRho", TextResQ
            Application.StatusBar = "ResQ Excel Add-in activated."
        Else
            Application.StatusBar = "Error: ResQ Excel Add-in can only be activated on Remote Desktop!"
        End If
    End If
    
    If StrComp(ThisWorkbook.Name, "ArcRho.xlam", vbTextCompare) = 0 _
        And hasBetaLink Then
        Application.StatusBar = ""
        ReplaceInWorkbook ProductPath("Excel Add-ins\beta\ARCRHO_BETA.xlam"), ProductPath("Excel Add-ins\ArcRho.xlam")
        Application.StatusBar = "ArcRho - Update Completed!"
    End If
    
CleanExit:
    Application.Calculation = oldCalcMode
    skipDataProcess = False
    
End Sub
