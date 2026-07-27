[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $PSScriptRoot 'runtime'
$logRoot = Join-Path $runtimeRoot 'logs'
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null

$nodeCommand = Get-Command node -ErrorAction Stop
$nodeVersion = [version]((& $nodeCommand.Source --version).Trim().TrimStart('v'))
if ($nodeVersion.Major -lt 24) {
    throw "P1 需要 Node.js 24 或更高版本，当前为 $nodeVersion"
}
if (-not (Test-Path -LiteralPath (Join-Path $appRoot 'node_modules/typescript/package.json'))) {
    throw '项目级 TypeScript 尚未安装，请先在 app 目录执行 npm install。'
}

$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$logPath = Join-Path $logRoot "test_$stamp.log"
Push-Location $appRoot
try {
    & npm test 2>&1 | Tee-Object -FilePath $logPath
    if ($LASTEXITCODE -ne 0) { throw "P1 测试失败，详见 $logPath" }
} finally {
    Pop-Location
}

[pscustomobject]@{
    Passed = $true
    Node = $nodeVersion.ToString()
    Log = $logPath
} | ConvertTo-Json
