Option Explicit

Dim shell, files, scriptRoot, launcherScript, pwshExe, command, lookup

Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
scriptRoot = files.GetParentFolderName(WScript.ScriptFullName)
launcherScript = files.BuildPath(scriptRoot, "Start-GPTInfiniteCanvas-Chrome.ps1")
pwshExe = ""

If Not files.FileExists(launcherScript) Then
  MsgBox "Chrome launcher script is missing: " & launcherScript, vbCritical, "GPT Infinite Canvas"
  WScript.Quit 1
End If

On Error Resume Next
Set lookup = shell.Exec("where.exe pwsh.exe")
If Err.Number = 0 Then
  pwshExe = Trim(Split(lookup.StdOut.ReadAll, vbCrLf)(0))
End If
Err.Clear
On Error GoTo 0

If pwshExe = "" Or Not files.FileExists(pwshExe) Then
  pwshExe = files.BuildPath(shell.ExpandEnvironmentStrings("%SystemRoot%"), "System32\WindowsPowerShell\v1.0\powershell.exe")
End If

If Not files.FileExists(pwshExe) Then
  MsgBox "PowerShell was not found.", vbCritical, "GPT Infinite Canvas"
  WScript.Quit 2
End If

command = Quote(pwshExe) & " -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Quote(launcherScript)
shell.Run command, 0, False
WScript.Quit 0

Function Quote(value)
  Quote = Chr(34) & value & Chr(34)
End Function
