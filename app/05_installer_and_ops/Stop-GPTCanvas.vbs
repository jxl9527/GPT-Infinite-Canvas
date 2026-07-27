Option Explicit

Dim files, scriptRoot, appRoot, pidFile, pidText, servicePid, wmi, processes, process, commandLine, stopped

Set files = CreateObject("Scripting.FileSystemObject")
scriptRoot = files.GetParentFolderName(WScript.ScriptFullName)
appRoot = files.GetParentFolderName(scriptRoot)
pidFile = files.BuildPath(appRoot, "02_bridge_service\runtime\service.pid")

If Not files.FileExists(pidFile) Then
  MsgBox "GPT Canvas is not running.", vbInformation, "GPT Canvas"
  WScript.Quit 0
End If

pidText = Trim(files.OpenTextFile(pidFile, 1, False).ReadAll)
If Not IsNumeric(pidText) Then
  MsgBox "The service PID file is invalid. Nothing was stopped.", vbExclamation, "GPT Canvas"
  WScript.Quit 1
End If

servicePid = CLng(pidText)
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set processes = wmi.ExecQuery("SELECT ProcessId, Name, CommandLine FROM Win32_Process WHERE ProcessId = " & servicePid)
stopped = False

For Each process In processes
  commandLine = Replace(LCase(process.CommandLine), "/", "\")
  If LCase(process.Name) = "node.exe" And InStr(commandLine, "dist\src\main.js") > 0 Then
    process.Terminate
    stopped = True
  End If
Next

If stopped Then
  WScript.Sleep 500
  MsgBox "GPT Canvas stopped safely.", vbInformation, "GPT Canvas"
Else
  MsgBox "No matching GPT Canvas service was found. No other process was stopped.", vbExclamation, "GPT Canvas"
End If
