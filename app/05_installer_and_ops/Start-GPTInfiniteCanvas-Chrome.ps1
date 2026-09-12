[CmdletBinding()]
param(
  [string]$CanvasUrl = 'http://127.0.0.1:3230/',
  [switch]$SkipBrowser
)

$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $PSCommandPath
$appRoot = Split-Path -Parent $scriptRoot
$serviceRunner = Join-Path $scriptRoot 'Run-GPTCanvas-Service.cmd'
$healthUrl = 'http://127.0.0.1:3220/health'
$runtimeRoot = Join-Path $appRoot '02_bridge_service\runtime'
$servicePidPath = Join-Path $runtimeRoot 'service.pid'
$expectedReleaseVersion = '0.6.0'

function Show-LauncherError {
  param([Parameter(Mandatory)][string]$Message)
  try {
    $shell = New-Object -ComObject WScript.Shell
    [void]$shell.Popup($Message, 0, 'GPT Infinite Canvas', 16)
  } catch {
    Write-Error $Message
  }
}

function Get-CanvasHealth {
  try {
    return Invoke-RestMethod -Method Get -Uri $healthUrl -TimeoutSec 2
  } catch {
    return $null
  }
}

function Stop-ManagedCanvasService {
  if (-not (Test-Path -LiteralPath $servicePidPath -PathType Leaf)) {
    throw "检测到旧画布服务，但未找到本项目的 PID 文件：$servicePidPath"
  }

  $serviceProcessId = 0
  $pidText = (Get-Content -LiteralPath $servicePidPath -Raw).Trim()
  if (-not [int]::TryParse($pidText, [ref]$serviceProcessId)) {
    throw "本项目服务 PID 无效，未停止任何进程：$pidText"
  }

  $managedProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $serviceProcessId" -ErrorAction SilentlyContinue
  if (-not $managedProcess) { return }
  $commandLine = ([string]$managedProcess.CommandLine).Replace('/', '\').ToLowerInvariant()
  if ($managedProcess.Name -ne 'node.exe' -or -not $commandLine.Contains('dist\src\main.js')) {
    throw "PID $serviceProcessId 不是本画布桥接服务，未停止任何进程。"
  }

  Stop-Process -Id $serviceProcessId -Force
  for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
    Start-Sleep -Milliseconds 100
    if (-not (Get-Process -Id $serviceProcessId -ErrorAction SilentlyContinue)) { return }
  }
  throw "旧画布服务未能安全停止：PID $serviceProcessId"
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

  $health = Get-CanvasHealth
  if ($health -and $health.ok -eq $true -and $health.releaseVersion -ne $expectedReleaseVersion) {
    if ($health.activeTaskId) {
      throw "检测到旧版画布服务且任务 $($health.activeTaskId) 仍在运行。请先结束任务，再更新桌面启动器。"
    }
    Stop-ManagedCanvasService
    $health = $null
  }

  if (-not $health -or $health.ok -ne $true -or $health.releaseVersion -ne $expectedReleaseVersion) {
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
      $health = Get-CanvasHealth
      if ($health -and $health.ok -eq $true -and $health.releaseVersion -eq $expectedReleaseVersion) {
        $serviceReady = $true
        break
      }
    }

    if (-not $serviceReady) {
      $logPath = Join-Path $appRoot '02_bridge_service\runtime\launcher.log'
      throw "本地画布服务未能在 20 秒内启动。请检查日志：$logPath"
    }
  }

  if (-not $SkipBrowser) {
    Start-Process -FilePath $chromePath `
      -ArgumentList @('--new-window', '--no-first-run', $CanvasUrl) `
      -WorkingDirectory (Split-Path -Parent $chromePath) | Out-Null
  }
} catch {
  if ($SkipBrowser) { throw }
  Show-LauncherError -Message $_.Exception.Message
  exit 1
}
