Option Explicit

Dim shell, files, scriptRoot, appRoot, bridgeRoot, serviceEntry, serviceRunner, nodeExe, healthUrl, canvasUrl
Dim index, healthy

Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
scriptRoot = files.GetParentFolderName(WScript.ScriptFullName)
appRoot = files.GetParentFolderName(scriptRoot)
bridgeRoot = files.BuildPath(appRoot, "02_bridge_service")
serviceEntry = files.BuildPath(bridgeRoot, "dist\src\main.js")
serviceRunner = files.BuildPath(scriptRoot, "Run-GPTCanvas-Service.cmd")
nodeExe = "C:\Program Files\nodejs\node.exe"
healthUrl = "http://127.0.0.1:3220/health"
canvasUrl = "http://127.0.0.1:3230/"

If Not files.FileExists(nodeExe) Then
  MsgBox "Node.js was not found: " & nodeExe & vbCrLf & "Please install the required Node.js 24 runtime.", vbCritical, "GPT Canvas"
  WScript.Quit 1
End If

If Not files.FileExists(serviceEntry) Then
  MsgBox "Service build is missing: " & serviceEntry & vbCrLf & "Please rebuild or extract the release again.", vbCritical, "GPT Canvas"
  WScript.Quit 1
End If

If Not files.FileExists(serviceRunner) Then
  MsgBox "Background service runner is missing: " & serviceRunner, vbCritical, "GPT Canvas"
  WScript.Quit 1
End If

healthy = IsHealthy(healthUrl)
If Not healthy Then
  shell.CurrentDirectory = bridgeRoot
  shell.Run Quote(serviceRunner), 0, False
  For index = 1 To 80
    WScript.Sleep 250
    If IsHealthy(healthUrl) Then
      healthy = True
      Exit For
    End If
  Next
End If

If Not healthy Then
  MsgBox "The local service did not start within 20 seconds." & vbCrLf & "Check runtime\launcher.log for details.", vbCritical, "GPT Canvas"
  WScript.Quit 2
End If

shell.Run canvasUrl, 1, False
WScript.Quit 0

Function IsHealthy(url)
  Dim request
  On Error Resume Next
  Set request = CreateObject("MSXML2.XMLHTTP.6.0")
  request.Open "GET", url, False
  request.Send
  IsHealthy = (Err.Number = 0 And request.Status = 200)
  Err.Clear
  On Error GoTo 0
End Function

Function Quote(value)
  Quote = Chr(34) & value & Chr(34)
End Function
