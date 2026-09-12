Option Private Module
Option Explicit

' The add-in's client for the ArcRho Gateway: the user's credential, one
' signed POST, and the two unauthenticated GET routes.
'
' The signature is owned by python-api/src/arcrho_hosted_save_http_contract.py.
' Its message is the lower-cased user name, the Unix timestamp, the method, the
' request path and the hex SHA-256 of the exact bytes sent, joined by line
' feeds and keyed by the user's secret. The server refuses a timestamp more
' than five minutes from its own clock, so the timestamp is UTC seconds.
' Nothing here needs sorted canonical JSON: the digest covers the bytes this
' client sends, whatever their order.
'
' frontend/tests/test_excel_addin_gateway_signing.py derives the vector and the
' route names below from that contract and fails if either side moves.

' The Gateway's routes. The two GET routes are open; every POST route is signed.
Public Const GATEWAY_HEALTH_PATH As String = "/api/health"
Public Const GATEWAY_CAPABILITIES_PATH As String = "/api/capabilities"
Public Const GATEWAY_WORKSPACE_READ_PATH As String = "/api/workspace-reads"
Public Const GATEWAY_ENGINE_CALCULATION_PATH As String = "/api/engine-calculations"
' The capabilities field naming the calculation operations this Gateway serves.
Public Const GATEWAY_OPERATIONS_FIELD As String = "engine_calculation_operations"

' --- begin gateway signing vector ---
' One fixed request signed against sign_request in the contract above.
' "\uXXXX" stands for one character, so that this file stays ASCII.
Private Const VECTOR_SECRET As String = "probe-secret-value"
Private Const VECTOR_USER As String = "XWei"
Private Const VECTOR_TIMESTAMP As String = "1757650000"
Private Const VECTOR_METHOD As String = "POST"
Private Const VECTOR_PATH As String = "/api/workspace-reads"
Private Const VECTOR_BODY As String = "{""Function"":""ArcRhoWorkspaceRead"",""Name"":""Net Loss--Paid \u00e9""}"
Private Const VECTOR_DIGEST As String = "bede0538b3ba1824f3572ce81a492868099b0bfc4ba90b1ce9c105cb3cfc5656"
Private Const VECTOR_SIGNATURE As String = "3a81facfc86c05784d7978f8a2f2de06b6172b513c9f75d496777aff6008d2d0"
' --- end gateway signing vector ---

Private Const HEADER_USER As String = "X-ArcRho-User"
Private Const HEADER_TIMESTAMP As String = "X-ArcRho-Timestamp"
Private Const HEADER_SIGNATURE As String = "X-ArcRho-Signature"
Private Const GATEWAY_CONFIG_FILE As String = "ArcRho\arcrho_gateway.json"

Private gatewayConfigRead As Boolean
Private gatewayEnabled As Boolean
Private gatewayUrl As String
Private gatewayUser As String
Private gatewaySecret As String
Private gatewayRequest As Object
Private gatewayCapabilities As Object

' True when this PC carries a credential the Gateway will accept.
Public Function GatewayIsConfigured() As Boolean
    EnsureGatewayConfig
    GatewayIsConfigured = gatewayEnabled
End Function

Public Function GatewayUserName() As String
    EnsureGatewayConfig
    GatewayUserName = gatewayUser
End Function

' Sign one request and post it. Answers True when the Gateway replied at all,
' with its status and body; False when there is no credential or the request
' never reached it, with the reason in outText.
Public Function GatewayPost(ByVal requestPath As String, ByVal body As String, _
                            ByVal timeoutSeconds As Long, ByRef outStatus As Long, _
                            ByRef outText As String) As Boolean
    Dim bodyBytes As Variant
    Dim stamp As String
    Dim req As Object

    outStatus = 0
    outText = ""
    EnsureGatewayConfig
    If Not gatewayEnabled Then
        outText = "This PC has no ArcRho Gateway credential."
        Exit Function
    End If

    bodyBytes = Utf8Bytes(body)
    stamp = GatewayUnixTimestamp()
    Set req = GatewayRequestObject()

    On Error GoTo Failed
    req.Open "POST", gatewayUrl & requestPath, False
    req.SetTimeouts 5000, 10000, timeoutSeconds * 1000&, timeoutSeconds * 1000&
    req.SetRequestHeader "Content-Type", "application/json; charset=utf-8"
    req.SetRequestHeader HEADER_USER, gatewayUser
    req.SetRequestHeader HEADER_TIMESTAMP, stamp
    req.SetRequestHeader HEADER_SIGNATURE, _
        GatewaySignature(gatewaySecret, gatewayUser, stamp, "POST", requestPath, bodyBytes)
    req.Send bodyBytes
    outStatus = req.Status
    outText = req.ResponseText
    GatewayPost = True
    Exit Function

Failed:
    Set gatewayRequest = Nothing
    outText = Err.Description
End Function

' The open GET routes: health and capabilities carry no signature.
Public Function GatewayGet(ByVal requestPath As String, ByVal timeoutSeconds As Long, _
                           ByRef outStatus As Long, ByRef outText As String) As Boolean
    Dim req As Object

    outStatus = 0
    outText = ""
    EnsureGatewayConfig
    If Not gatewayEnabled Then
        outText = "This PC has no ArcRho Gateway credential."
        Exit Function
    End If

    Set req = GatewayRequestObject()
    On Error GoTo Failed
    req.Open "GET", gatewayUrl & requestPath, False
    req.SetTimeouts 5000, 10000, timeoutSeconds * 1000&, timeoutSeconds * 1000&
    req.Send
    outStatus = req.Status
    outText = req.ResponseText
    GatewayGet = True
    Exit Function

Failed:
    Set gatewayRequest = Nothing
    outText = Err.Description
End Function

Public Function GatewayIsHealthy() As Boolean
    Dim replyStatus As Long
    Dim replyText As String
    If Not GatewayGet(GATEWAY_HEALTH_PATH, 10, replyStatus, replyText) Then Exit Function
    GatewayIsHealthy = (replyStatus = 200)
End Function

' The capabilities document, read once per Excel session.
Public Function GatewayCapabilityDocument() As Object
    Dim replyStatus As Long
    Dim replyText As String

    If Not gatewayCapabilities Is Nothing Then
        Set GatewayCapabilityDocument = gatewayCapabilities
        Exit Function
    End If
    If Not GatewayGet(GATEWAY_CAPABILITIES_PATH, 10, replyStatus, replyText) Then Exit Function
    If replyStatus <> 200 Then Exit Function
    Set gatewayCapabilities = JsonParse(replyText)
    Set GatewayCapabilityDocument = gatewayCapabilities
End Function

' True when the Gateway advertises value in one of its capability lists, so a
' caller can ask before using an operation this server may be too old to serve.
Public Function GatewayAdvertises(ByVal fieldName As String, ByVal value As String) As Boolean
    Dim document As Object
    Dim items As Collection
    Dim i As Long

    Set document = GatewayCapabilityDocument()
    If document Is Nothing Then Exit Function
    If Not document.Exists(fieldName) Then Exit Function
    If Not IsObject(document(fieldName)) Then Exit Function

    Set items = document(fieldName)
    For i = 1 To items.Count
        If StrComp(Trim$(CStr(items.Item(i))), value, vbTextCompare) = 0 Then
            GatewayAdvertises = True
            Exit Function
        End If
    Next i
End Function

' Sign the fixed vector, then talk to the Gateway this PC is pointed at.
' Run it from the Immediate window with CheckArcRhoGateway.
Public Function ArcRhoGatewayCheckReport() As String
    Dim report As String
    Dim bodyBytes As Variant
    Dim digest As String
    Dim signature As String
    Dim replyStatus As Long
    Dim replyText As String

    bodyBytes = Utf8Bytes(UnescapeUnicode(VECTOR_BODY))
    digest = Sha256Hex(bodyBytes)
    signature = GatewaySignature(VECTOR_SECRET, VECTOR_USER, VECTOR_TIMESTAMP, _
                                 VECTOR_METHOD, VECTOR_PATH, bodyBytes)

    report = "ArcRho Gateway check, add-in " & ARCRHO_VERSION
    report = report & vbLf & "vector digest    " & Verdict(digest = VECTOR_DIGEST) & " " & digest
    report = report & vbLf & "vector signature " & Verdict(signature = VECTOR_SIGNATURE) & " " & signature

    EnsureGatewayConfig
    If Not gatewayEnabled Then
        ArcRhoGatewayCheckReport = report & vbLf & "credential       none on this PC"
        Exit Function
    End If
    report = report & vbLf & "credential       " & gatewayUser & " at " & gatewayUrl

    GatewayGet GATEWAY_HEALTH_PATH, 10, replyStatus, replyText
    report = report & vbLf & "health           " & replyStatus & " " & OneLine(replyText)
    GatewayGet GATEWAY_CAPABILITIES_PATH, 10, replyStatus, replyText
    report = report & vbLf & "capabilities     " & replyStatus & " " & OneLine(replyText)
    ' A signed POST the server cannot read: 400 means it accepted the signature
    ' and then refused the payload, 401 means it refused the signature.
    GatewayPost GATEWAY_WORKSPACE_READ_PATH, "{}", 10, replyStatus, replyText
    report = report & vbLf & "signed request   " & replyStatus & " " & OneLine(replyText)

    ArcRhoGatewayCheckReport = report
End Function

Public Sub CheckArcRhoGateway()
    Debug.Print ArcRhoGatewayCheckReport()
End Sub

Private Function Verdict(ByVal matched As Boolean) As String
    If matched Then
        Verdict = "match   "
    Else
        Verdict = "MISMATCH"
    End If
End Function

Private Function OneLine(ByVal text As String) As String
    OneLine = Replace(Replace(text, vbCr, " "), vbLf, " ")
    If Len(OneLine) > 200 Then OneLine = Left$(OneLine, 200) & "..."
End Function

Private Sub EnsureGatewayConfig()
    Dim credentialPath As String
    Dim credential As Object

    If gatewayConfigRead Then Exit Sub
    gatewayConfigRead = True

    credentialPath = Environ$("APPDATA") & "\" & GATEWAY_CONFIG_FILE
    If Len(Dir$(credentialPath)) = 0 Then Exit Sub
    Set credential = JsonParse(ReadUtf8TextFile(credentialPath))
    If Not credential("enabled") = True Then Exit Sub

    gatewayUrl = TrimTrailing(Trim$(CStr(credential("url"))), "/")
    gatewayUser = Trim$(CStr(credential("user")))
    gatewaySecret = Trim$(CStr(credential("secret")))
    gatewayEnabled = (Len(gatewayUrl) > 0 And Len(gatewayUser) > 0 And Len(gatewaySecret) > 0)
End Sub

' One request object for the session, so a formula does not rebuild the
' connection the previous formula just used.
Private Function GatewayRequestObject() As Object
    If gatewayRequest Is Nothing Then
        Set gatewayRequest = CreateObject("WinHttp.WinHttpRequest.5.1")
    End If
    Set GatewayRequestObject = gatewayRequest
End Function

Private Function GatewaySignature(ByVal secret As String, ByVal user As String, _
                                  ByVal stamp As String, ByVal method As String, _
                                  ByVal requestPath As String, ByVal bodyBytes As Variant) As String
    Dim message As String
    message = LCase$(Trim$(user)) & vbLf & Trim$(stamp) & vbLf & UCase$(Trim$(method)) & _
              vbLf & Trim$(requestPath) & vbLf & Sha256Hex(bodyBytes)
    GatewaySignature = HmacSha256Hex(Utf8Bytes(secret), Utf8Bytes(message))
End Function

' The Unix second the server compares against its own clock.
Private Function GatewayUnixTimestamp() As String
    Dim clock As Object
    Dim utcNow As Date

    Set clock = CreateObject("WbemScripting.SWbemDateTime")
    clock.SetVarDate Now, True
    utcNow = clock.GetVarDate(False)
    GatewayUnixTimestamp = Format$(Int((CDbl(utcNow) - CDbl(DateSerial(1970, 1, 1))) * 86400#), "0")
End Function

' UTF-8 bytes, without the byte-order mark ADODB.Stream writes ahead of them.
Private Function Utf8Bytes(ByVal text As String) As Variant
    Dim stream As Object

    Set stream = CreateObject("ADODB.Stream")
    stream.Type = 2
    stream.Charset = "utf-8"
    stream.Open
    stream.WriteText text
    stream.Position = 0
    stream.Type = 1
    stream.Position = 3
    Utf8Bytes = stream.Read
    stream.Close
End Function

Private Function Sha256Hex(ByVal bytes As Variant) As String
    Dim digest As Object
    Set digest = CreateObject("System.Security.Cryptography.SHA256Managed")
    Sha256Hex = HexText(digest.ComputeHash_2((bytes)))
End Function

Private Function HmacSha256Hex(ByVal keyBytes As Variant, ByVal messageBytes As Variant) As String
    Dim mac As Object
    Set mac = CreateObject("System.Security.Cryptography.HMACSHA256")
    mac.Key = keyBytes
    HmacSha256Hex = HexText(mac.ComputeHash_2((messageBytes)))
End Function

Private Function HexText(ByVal bytes As Variant) As String
    Dim node As Object
    Set node = CreateObject("MSXML2.DOMDocument").createElement("hex")
    node.DataType = "bin.hex"
    node.nodeTypedValue = bytes
    HexText = LCase$(node.Text)
End Function

' Turn "\u00e9" and its like into the character it stands for, so that a source
' file carrying a fixed request can stay ASCII.
Private Function UnescapeUnicode(ByVal text As String) As String
    Dim result As String
    Dim at As Long

    result = text
    Do
        at = InStr(result, "\u")
        If at = 0 Then Exit Do
        result = Left$(result, at - 1) & ChrW$(CLng("&H" & Mid$(result, at + 2, 4))) & Mid$(result, at + 6)
    Loop
    UnescapeUnicode = result
End Function

Private Function TrimTrailing(ByVal text As String, ByVal character As String) As String
    TrimTrailing = text
    Do While Len(TrimTrailing) > 0 And Right$(TrimTrailing, 1) = character
        TrimTrailing = Left$(TrimTrailing, Len(TrimTrailing) - 1)
    Loop
End Function
