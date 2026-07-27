[CmdletBinding()]
param(
  [string]$CanvasUrl = 'http://127.0.0.1:3230/'
)

$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $PSCommandPath
$appRoot = Split-Path -Parent $scriptRoot
$serviceRunner = Join-Path $scriptRoot 'Run-GPTCanvas-Service.cmd'
$healthUrl = 'http://127.0.0.1:3220/health'

function Show-LauncherError {
  param([Parameter(Mandatory)][string]$Message)
  try {
    $shell = New-Object -ComObject WScript.Shell
    [void]$shell.Popup($Message, 0, 'GPT Infinite Canvas', 16)
  } catch {
    Write-Error $Message
  }
}

function Test-CanvasService {
  try {
    $health = Invoke-RestMethod -Method Get -Uri $healthUrl -TimeoutSec 2
    return $health.ok -eq $true
  } catch {
    return $false
  }
}

function Find-GoogleChrome {
  $knownPaths = @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe' }),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
  ) | Where-Object { $_ }

  foreach ($candidate in $knownPaths) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }

  $command = Get-Command chrome.exe -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  return $null
}

try {
  $chromePath = Find-GoogleChrome
  if (-not $chromePath) {
    throw '未找到 Google Chrome。请先安装 Chrome；系统默认浏览器仍可继续保留 Microsoft Edge。'
  }

  if (-not (Test-CanvasService)) {
    if (-not (Test-Path -LiteralPath $serviceRunner -PathType Leaf)) {
      throw "未找到本地服务启动程序：$serviceRunner"
    }

    $runnerArgument = "/d /c `"`"$serviceRunner`"`""
    Start-Process -FilePath $env:ComSpec `
      -ArgumentList $runnerArgument `
      -WorkingDirectory $scriptRoot `
      -WindowStyle Hidden | Out-Null

    $serviceReady = $false
    for ($attempt = 0; $attempt -lt 80; $attempt += 1) {
      Start-Sleep -Milliseconds 250
      if (Test-CanvasService) {
        $serviceReady = $true
        break
      }
    }

    if (-not $serviceReady) {
      $logPath = Join-Path $appRoot '02_bridge_service\runtime\launcher.log'
      throw "本地画布服务未能在 20 秒内启动。请检查日志：$logPath"
    }
  }

  Start-Process -FilePath $chromePath `
    -ArgumentList @('--new-window', '--no-first-run', $CanvasUrl) `
    -WorkingDirectory (Split-Path -Parent $chromePath) | Out-Null
} catch {
  Show-LauncherError -Message $_.Exception.Message
  exit 1
}
