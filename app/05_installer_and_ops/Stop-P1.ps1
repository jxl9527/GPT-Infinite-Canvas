[CmdletBinding()]
param(
    [string]$RuntimeRoot = ''
)

$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent $PSScriptRoot
$resolvedRuntimeRoot = if ($RuntimeRoot) { [IO.Path]::GetFullPath($RuntimeRoot) } else { Join-Path $appRoot '02_bridge_service/runtime' }
$pidPath = Join-Path $resolvedRuntimeRoot 'service.pid'
if (-not (Test-Path -LiteralPath $pidPath -PathType Leaf)) {
    throw '未找到 P1 服务 PID 文件；没有执行停止操作。'
}

$servicePid = [int](Get-Content -Raw -LiteralPath $pidPath).Trim()
$process = Get-CimInstance Win32_Process -Filter "ProcessId = $servicePid"
if (-not $process) {
    throw "PID $servicePid 已不存在；请人工核对 PID 文件。"
}
if ($process.ExecutablePath -notmatch '[\\/]node\.exe$' -or $process.CommandLine -notmatch 'dist/src/main\.js') {
    throw "PID $servicePid 与预期 P1 Node 服务不符，拒绝停止。"
}

Stop-Process -Id $servicePid -ErrorAction Stop
Write-Output ([pscustomobject]@{ Stopped = $true; Pid = $servicePid; Recoverable = "运行数据仍保留；RuntimeRoot=$resolvedRuntimeRoot" } | ConvertTo-Json)
