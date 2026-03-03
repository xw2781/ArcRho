
Public Function ADASTri( _
    Path As String, TriangleName As String, _
    Optional Cumulative As Boolean = True, _
    Optional Transposed As Boolean = False, _
    Optional Calendar As Boolean = False, _
    Optional ProjectName As String = "Default", _
    Optional OriginLength As Integer = 12, _
    Optional DevelopmentLength As Integer = 12, _
    Optional ByTypeName, _
    Optional SuppressWarnings _
) As Variant

    Dim v As Variant   ' <-- can hold array OR string OR error, etc.

    On Error GoTo ErrorHandler

    v = GetDataset( _
        "Function = ADASTri" & "#" & _
        "Path = " & Path & "#" & _
        "DatasetName = " & TriangleName & "#" & _
        "Cumulative = " & Cumulative & "#" & _
        "Transposed = " & Transposed & "#" & _
        "Calendar = " & Calendar & "#" & _
        "ProjectName = " & SetDefaultProject(ProjectName) & "#" & _
        "OriginLength = " & OriginLength & "#" & _
        "DevelopmentLength = " & DevelopmentLength)

    ' If GetDataset returned an error value, just pass it through
    If IsError(v) Then
        ADASTri = v
        Exit Function
    End If

    ' If GetDataset returned an array, you may transpose it
    If IsArray(v) Then
        If Transposed Then
            ADASTri = TransposeArray(v)
        Else
            ADASTri = v
        End If
    Else
        ' Scalar (string/number/etc.) -> just return it directly
        ADASTri = v
    End If

    Exit Function

ErrorHandler:
    Debug.Print "UDF error: "; Err.Number; Err.Description
    ADASTri = "(dataset needs to be updated)"
End Function

Public Function ADASTriDiag( _
    Path As String, TriangleName As String, _
    Optional DiagonalIndex As Long = 0, _
    Optional Cumulative As Boolean = True, _
    Optional Transposed As Boolean = False, _
    Optional ProjectName As String = "Default", _
    Optional OriginLength As Integer = 12, _
    Optional DevelopmentLength As Integer = 12, _
    Optional ByTypeName, _
    Optional SuppressWarnings _
  ) As Variant
  
    Dim tri() As Variant
    Dim outArr() As Variant
    
    On Error Resume Next
    
    tri = ADASTri( _
              Path, TriangleName, _
              Cumulative, Transposed = 1, Calendar = 0, _
              ProjectName, OriginLength, DevelopmentLength, _
              ByTypeName, SuppressWarnings)
    
    outArr = GetDiagonal(tri, -DiagonalIndex)
    
    If Transposed Then outArr = TransposeArray(outArr)
   
    ADASTriDiag = outArr
    
End Function

Public Function ADASTriCell( _
    Path As String, TriangleName As String, _
    OriginPeriod As Long, DevelopmentPeriod As Long, _
    Optional Cumulative As Boolean = True, _
    Optional ProjectName As String = "Default", _
    Optional OriginLength As Integer = 12, _
    Optional DevelopmentLength As Integer = 12, _
    Optional ByTypeName, _
    Optional SuppressWarnings _
) As Variant

    Dim tri As Variant
    On Error Resume Next
    
    tri = ADASTri( _
              Path, TriangleName, _
              Cumulative, Transposed = False, Calendar = False, _
              ProjectName, OriginLength, DevelopmentLength, _
              ByTypeName, SuppressWarnings)
    
    ADASTriCell = tri(DevelopmentPeriod, OriginPeriod)
    
End Function

Public Function ADASHeaders( _
    periodType As Integer, _
    Transposed As Boolean, _
    Optional PeriodLength As Integer = 12, _
    Optional ProjectName As String = "Default", _
    Optional StoredPeriodLength As Integer = -1 _
  ) As Variant
  
    Dim outArr() As Variant
    On Error Resume Next
    
    outArr = GetDataset( _
      "Function = ADASHeaders" & "#" & _
      "periodType = " & periodType & "#" & _
      "Transposed = " & Transposed & "#" & _
      "PeriodLength = " & PeriodLength & "#" & _
      "ProjectName = " & SetDefaultProject(ProjectName) & "#" & _
      "StoredPeriodLength = " & StoredPeriodLength _
    )
    
    outArr = FormatYYYYMM_ToMmmYYYY(outArr)
    
    If Transposed Then
        ADASHeaders = outArr
    Else
        ADASHeaders = TransposeArray(outArr)
    End If
    
End Function

Public Function ADASTriOrigin( _
    Path As String, TriangleName As String, _
    OriginPeriod As Long, _
    Optional Cumulative As Boolean = True, _
    Optional Transposed As Boolean = False, _
    Optional ProjectName As String = "Default", _
    Optional OriginLength As Integer = 12, _
    Optional DevelopmentLength As Integer = 12, _
    Optional ByTypeName, _
    Optional SuppressWarnings _
) As Variant

    Dim tri As Variant
    Dim outArr() As Variant
    Dim lb1 As Long, ub1 As Long
    Dim lb2 As Long, ub2 As Long
    Dim r As Long, c As Long
    On Error Resume Next
    
    tri = ADASTri( _
            Path, TriangleName, _
            Cumulative, 0, Calendar, _
            ProjectName, OriginLength, DevelopmentLength, _
            ByTypeName, SuppressWarnings)

    lb1 = LBound(tri, 1)
    ub1 = UBound(tri, 1)
    lb2 = LBound(tri, 2)
    ub2 = UBound(tri, 2)

    If lb1 = 0 Then
        r = OriginPeriod - 1
    Else
        r = OriginPeriod
    End If

    ReDim outArr(1 To 1, 1 To ub2 - lb2 + 1)
    For c = lb2 To ub2
        outArr(1, c - lb2 + 1) = tri(r, c)
    Next c

    If Transposed Then
        ADASTriOrigin = TransposeArray(outArr)
    Else
        ADASTriOrigin = outArr
    End If
    
End Function

Public Function ADASVec( _
    Path As String, VectorName As String, _
    Optional Transposed As Boolean = False, _
    Optional ProjectName As String = "Default", _
    Optional PeriodLength As Integer = 12, _
    Optional ByTypeName, _
    Optional SuppressWarnings _
  ) As Variant
  
    Dim outArr() As Variant
    On Error Resume Next
    
    outArr = GetDataset( _
        "Function = ADASVec" & "#" & _
        "Path = " & Path & "#" & _
        "DatasetName = " & VectorName & "#" & _
        "Cumulative = True" & "#" & _
        "Transposed = " & Transposed & "#" & _
        "ProjectName = " & SetDefaultProject(ProjectName) & "#" & _
        "OriginLength = " & PeriodLength & "#" & _
        "DevelopmentLength = " & PeriodLength)
        
    If Transposed Then
        ADASVec = TransposeArray(outArr)
    Else
        ADASVec = outArr
    End If
    
End Function

Public Function ADASVecCell( _
    Path As String, VectorName As String, Index As Integer, _
    Optional ProjectName As String = "Default", _
    Optional PeriodLength As Integer = 12, _
    Optional ByTypeName, _
    Optional SuppressWarnings _
) As Variant

    Dim vec As Variant
    On Error GoTo ErrorHandler

    vec = ADASVec( _
              Path, VectorName, _
              Transposed:=False, _
              ProjectName:=ProjectName, _
              PeriodLength:=PeriodLength, _
              ByTypeName:=ByTypeName, _
              SuppressWarnings:=SuppressWarnings)

    If IsError(vec) Then
        ADASVecCell = vec
        Exit Function
    End If

    If Not IsArray(vec) Then
        ADASVecCell = vec
        Exit Function
    End If

    ' Convert 1-based Index to array's actual lower bound
    Dim lb1 As Long, lb2 As Long
    Dim ub1 As Long, ub2 As Long

    On Error Resume Next
    lb2 = LBound(vec, 2)
    If Err.Number <> 0 Then
        ' 1D array
        Err.Clear
        On Error GoTo ErrorHandler
        lb1 = LBound(vec, 1)
        ADASVecCell = vec(lb1 + Index - 1)
    Else
        ' 2D array — index along whichever dimension has length > 1
        On Error GoTo ErrorHandler
        lb1 = LBound(vec, 1): ub1 = UBound(vec, 1)
        ub2 = UBound(vec, 2)
        If (ub2 - lb2) > 0 Then
            ' Multiple columns (1 row x N cols) — index along dim 2
            ADASVecCell = vec(lb1, lb2 + Index - 1)
        Else
            ' Multiple rows (N rows x 1 col) — index along dim 1
            ADASVecCell = vec(lb1 + Index - 1, lb2)
        End If
    End If

    Exit Function

ErrorHandler:
    ADASVecCell = 0
End Function

Public Function ADASProjectSettings(Optional ProjectName As String = "Default")
    On Error Resume Next
    ADASProjectSettings = GetDataset( _
        "Function = ADASProjectSettings" & "#" & _
        "ProjectName = " & SetDefaultProject(ProjectName))
        
End Function

Function ADASReservingClasses(Optional Level, Optional WithDataOnly, Optional ProjectName) As Variant
    ADASReservingClasses = ""
End Function

Function ADASNodeContents(Path As String, Optional ContentType, Optional ProjectName) As Variant
    ADASNodeContents = ""
End Function

Sub ADASMetadata()
    qqq ActiveSheet.Name & "--" & ActiveCell.formula
End Sub

' --- Arc wrapper functions (aliases for ADAS functions) ---

Public Function ArcTri( _
    Path As String, TriangleName As String, _
    Optional Cumulative As Boolean = True, _
    Optional Transposed As Boolean = False, _
    Optional Calendar As Boolean = False, _
    Optional ProjectName As String = "Default", _
    Optional OriginLength As Integer = 12, _
    Optional DevelopmentLength As Integer = 12, _
    Optional ByTypeName, _
    Optional SuppressWarnings _
) As Variant
    ArcTri = ADASTri(Path, TriangleName, Cumulative, Transposed, Calendar, _
                     ProjectName, OriginLength, DevelopmentLength, ByTypeName, SuppressWarnings)
End Function

Public Function ArcTriDiag( _
    Path As String, TriangleName As String, _
    Optional DiagonalIndex As Long = 0, _
    Optional Cumulative As Boolean = True, _
    Optional Transposed As Boolean = False, _
    Optional ProjectName As String = "Default", _
    Optional OriginLength As Integer = 12, _
    Optional DevelopmentLength As Integer = 12, _
    Optional ByTypeName, _
    Optional SuppressWarnings _
) As Variant
    ArcTriDiag = ADASTriDiag(Path, TriangleName, DiagonalIndex, Cumulative, Transposed, _
                             ProjectName, OriginLength, DevelopmentLength, ByTypeName, SuppressWarnings)
End Function

Public Function ArcTriCell( _
    Path As String, TriangleName As String, _
    OriginPeriod As Long, DevelopmentPeriod As Long, _
    Optional Cumulative As Boolean = True, _
    Optional ProjectName As String = "Default", _
    Optional OriginLength As Integer = 12, _
    Optional DevelopmentLength As Integer = 12, _
    Optional ByTypeName, _
    Optional SuppressWarnings _
) As Variant
    ArcTriCell = ADASTriCell(Path, TriangleName, OriginPeriod, DevelopmentPeriod, Cumulative, _
                             ProjectName, OriginLength, DevelopmentLength, ByTypeName, SuppressWarnings)
End Function

Public Function ArcHeaders( _
    periodType As Integer, _
    Transposed As Boolean, _
    Optional PeriodLength As Integer = 12, _
    Optional ProjectName As String = "Default", _
    Optional StoredPeriodLength As Integer = -1 _
) As Variant
    ArcHeaders = ADASHeaders(periodType, Transposed, PeriodLength, ProjectName, StoredPeriodLength)
End Function

Public Function ArcTriOrigin( _
    Path As String, TriangleName As String, _
    OriginPeriod As Long, _
    Optional Cumulative As Boolean = True, _
    Optional Transposed As Boolean = False, _
    Optional ProjectName As String = "Default", _
    Optional OriginLength As Integer = 12, _
    Optional DevelopmentLength As Integer = 12, _
    Optional ByTypeName, _
    Optional SuppressWarnings _
) As Variant
    ArcTriOrigin = ADASTriOrigin(Path, TriangleName, OriginPeriod, Cumulative, Transposed, _
                                 ProjectName, OriginLength, DevelopmentLength, ByTypeName, SuppressWarnings)
End Function

Public Function ArcVec( _
    Path As String, VectorName As String, _
    Optional Transposed As Boolean = False, _
    Optional ProjectName As String = "Default", _
    Optional PeriodLength As Integer = 12, _
    Optional ByTypeName, _
    Optional SuppressWarnings _
) As Variant
    ArcVec = ADASVec(Path, VectorName, Transposed, ProjectName, PeriodLength, ByTypeName, SuppressWarnings)
End Function

Public Function ArcVecCell( _
    Path As String, VectorName As String, Index As Integer, _
    Optional ProjectName As String = "Default", _
    Optional PeriodLength As Integer = 12, _
    Optional ByTypeName, _
    Optional SuppressWarnings _
) As Variant
    ArcVecCell = ADASVecCell(Path, VectorName, Index, ProjectName, PeriodLength, ByTypeName, SuppressWarnings)
End Function

Public Function ArcProjectSettings(Optional ProjectName As String = "Default")
    ArcProjectSettings = ADASProjectSettings(ProjectName)
End Function

Function ArcReservingClasses(Optional Level, Optional WithDataOnly, Optional ProjectName) As Variant
    ArcReservingClasses = ADASReservingClasses(Level, WithDataOnly, ProjectName)
End Function

Function ArcNodeContents(Path As String, Optional ContentType, Optional ProjectName) As Variant
    ArcNodeContents = ADASNodeContents(Path, ContentType, ProjectName)
End Function
