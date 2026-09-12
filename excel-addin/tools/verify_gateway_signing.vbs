' Prints the body digest and the signature the add-in produces for one fixed
' Gateway request, without opening Excel. Run it on a Client PC with:
'
'   cscript //nologo excel-addin\tools\verify_gateway_signing.vbs
'
' The two expected values come from sign_request in
' python-api/src/arcrho_hosted_save_http_contract.py, and
' frontend/tests/test_excel_addin_gateway_signing.py derives them from that
' contract again and fails if this block or the same block in
' excel-addin/src_vba/GatewayClient.bas drifts from it. The helpers below are
' the ones GatewayClient.bas uses; VBScript cannot call into a VBA project, so
' this script carries its own copy and the vector keeps the two honest.

Option Explicit

' --- begin gateway signing vector ---
' One fixed request signed against sign_request in the contract above.
' "\uXXXX" stands for one character, so that this file stays ASCII.
Const VECTOR_SECRET = "probe-secret-value"
Const VECTOR_USER = "XWei"
Const VECTOR_TIMESTAMP = "1757650000"
Const VECTOR_METHOD = "POST"
Const VECTOR_PATH = "/api/workspace-reads"
Const VECTOR_BODY = "{""Function"":""ArcRhoWorkspaceRead"",""Name"":""Net Loss--Paid \u00e9""}"
Const VECTOR_DIGEST = "bede0538b3ba1824f3572ce81a492868099b0bfc4ba90b1ce9c105cb3cfc5656"
Const VECTOR_SIGNATURE = "3a81facfc86c05784d7978f8a2f2de06b6172b513c9f75d496777aff6008d2d0"
' --- end gateway signing vector ---

Dim bodyBytes, digest, signature, failures

bodyBytes = Utf8Bytes(UnescapeUnicode(VECTOR_BODY))
digest = Sha256Hex(bodyBytes)
signature = GatewaySignature(VECTOR_SECRET, VECTOR_USER, VECTOR_TIMESTAMP, _
                             VECTOR_METHOD, VECTOR_PATH, bodyBytes)

failures = 0
WScript.Echo "body digest  " & digest
WScript.Echo "expected     " & VECTOR_DIGEST
If digest <> VECTOR_DIGEST Then failures = failures + 1
WScript.Echo "signature    " & signature
WScript.Echo "expected     " & VECTOR_SIGNATURE
If signature <> VECTOR_SIGNATURE Then failures = failures + 1

If failures = 0 Then
    WScript.Echo "match"
Else
    WScript.Echo "MISMATCH"
End If
WScript.Quit failures

Function GatewaySignature(secret, user, stamp, method, requestPath, bodyBytes)
    Dim message
    message = LCase(Trim(user)) & vbLf & Trim(stamp) & vbLf & UCase(Trim(method)) & _
              vbLf & Trim(requestPath) & vbLf & Sha256Hex(bodyBytes)
    GatewaySignature = HmacSha256Hex(Utf8Bytes(secret), Utf8Bytes(message))
End Function

' UTF-8 bytes, without the byte-order mark ADODB.Stream writes ahead of them.
Function Utf8Bytes(text)
    Dim stream
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

Function Sha256Hex(bytes)
    Dim digest
    Set digest = CreateObject("System.Security.Cryptography.SHA256Managed")
    Sha256Hex = HexText(digest.ComputeHash_2((bytes)))
End Function

Function HmacSha256Hex(keyBytes, messageBytes)
    Dim mac
    Set mac = CreateObject("System.Security.Cryptography.HMACSHA256")
    mac.Key = keyBytes
    HmacSha256Hex = HexText(mac.ComputeHash_2((messageBytes)))
End Function

Function HexText(bytes)
    Dim node
    Set node = CreateObject("MSXML2.DOMDocument").createElement("hex")
    node.DataType = "bin.hex"
    node.nodeTypedValue = bytes
    HexText = LCase(node.Text)
End Function

' Turn "\u00e9" and its like into the character it stands for, so that a source
' file carrying a fixed request can stay ASCII.
Function UnescapeUnicode(text)
    Dim result, at
    result = text
    Do
        at = InStr(result, "\u")
        If at = 0 Then Exit Do
        result = Left(result, at - 1) & ChrW(CLng("&H" & Mid(result, at + 2, 4))) & Mid(result, at + 6)
    Loop
    UnescapeUnicode = result
End Function
