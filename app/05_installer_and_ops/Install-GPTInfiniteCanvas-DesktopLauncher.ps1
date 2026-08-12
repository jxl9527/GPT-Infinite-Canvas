[CmdletBinding()]
param(
  [string]$ShortcutName = 'GPT 无限画布',
  [switch]$SkipCodexPlugin
)

$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $PSCommandPath
$appRoot = Split-Path -Parent $scriptRoot
$launcherPath = Join-Path $scriptRoot 'Start-GPTInfiniteCanvas-Chrome.vbs'
$serviceLauncherPath = Join-Path $scriptRoot 'Start-GPTInfiniteCanvas-Chrome.ps1'
$iconPath = Join-Path $scriptRoot 'assets\launcher\GPT-Infinite-Canvas.ico'
$desktopPath = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktopPath "$ShortcutName.lnk"
$runtimeRoot = Join-Path $appRoot '02_bridge_service\runtime'
$logPath = Join-Path $runtimeRoot 'desktop-launcher-install.log'

foreach ($requiredPath in @($launcherPath, $serviceLauncherPath, $iconPath)) {
  if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
    throw "桌面启动器文件缺失：$requiredPath"
  }
}

New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null

if (Test-Path -LiteralPath $shortcutPath -PathType Leaf) {
  $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backupPath = Join-Path $desktopPath "$ShortcutName.backup-$timestamp.lnk"
  Copy-Item -LiteralPath $shortcutPath -Destination $backupPath
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
$shortcut.Arguments = "//nologo `"$launcherPath`""
$shortcut.WorkingDirectory = $scriptRoot
$shortcut.IconLocation = "$iconPath,0"
$shortcut.Description = 'GPT Infinite Canvas 0.5.3｜浏览器人工批量／Codex 自动运行'
$shortcut.Save()

if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) {
  throw "桌面快捷方式创建失败：$shortcutPath"
}

& $serviceLauncherPath -SkipBrowser

if (-not $SkipCodexPlugin) {
  $pluginInstaller = Join-Path $scriptRoot 'Install-D5AICanvas-CodexPlugin.ps1'
  if ((Test-Path -LiteralPath $pluginInstaller -PathType Leaf) -and (Get-Command codex -ErrorAction SilentlyContinue)) {
    & $pluginInstaller
  }
  else {
    Write-Warning '未检测到 Codex CLI 或插件安装脚本；浏览器人工批量可正常使用，稍后可单独安装 Codex 自动运行插件。'
  }
}

$logLine = '{0} version="0.5.3" installed="{1}" launcher="{2}"' -f (Get-Date -Format o), $shortcutPath, $launcherPath
Add-Content -LiteralPath $logPath -Value $logLine -Encoding utf8
Write-Output $shortcutPath
