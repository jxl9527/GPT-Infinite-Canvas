[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [string]$ProjectRoot = '',
    [string]$RuntimeRoot = '',
    [ValidateRange(1024, 65535)]
    [int]$Port = 3220
)

$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent $PSScriptRoot
$bridgeRoot = Join-Path $appRoot '02_bridge_service'
$resolvedRuntimeRoot = if ($RuntimeRoot) { [IO.Path]::GetFullPath($RuntimeRoot) } else { Join-Path $bridgeRoot 'runtime' }
$resolvedProjectRoot = if ($ProjectRoot) { [IO.Path]::GetFullPath($ProjectRoot) } else { Join-Path $resolvedRuntimeRoot 'default-project' }

$nodeCommand = Get-Command node -ErrorAction Stop
$nodeVersion = [version]((& $nodeCommand.Source --version).Trim().TrimStart('v'))
if ($nodeVersion.Major -lt 24) {
    throw "P1 需要 Node.js 24 或更高版本，当前为 $nodeVersion"
}
if ($SkipBuild) {
    if (-not (Test-Path -LiteralPath (Join-Path $bridgeRoot 'dist/src/main.js') -PathType Leaf)) { throw '发布版服务产物缺失，无法跳过构建。' }
}
else {
    if (-not (Test-Path -LiteralPath (Join-Path $appRoot 'node_modules/typescript/package.json'))) {
        throw '项目级依赖尚未安装，请先在 app 目录执行 npm install。'
    }
    Push-Location $appRoot
    try {
        & npm run build
        if ($LASTEXITCODE -ne 0) { throw 'P1 构建失败，服务未启动。' }
    } finally {
        Pop-Location
    }
}

$listening = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listening) {
    throw "127.0.0.1:$Port 已被进程 $($listening[0].OwningProcess) 占用。"
}

New-Item -ItemType Directory -Force -Path $resolvedRuntimeRoot, $resolvedProjectRoot | Out-Null
$serviceEnvironment = @{
    GPT_CANVAS_PROJECT_ROOT = $resolvedProjectRoot
    GPT_CANVAS_RUNTIME_ROOT = $resolvedRuntimeRoot
    GPT_CANVAS_PORT = [string]$Port
}

Push-Location $bridgeRoot
try {
    $previousProjectRoot = $env:GPT_CANVAS_PROJECT_ROOT
    $previousRuntimeRoot = $env:GPT_CANVAS_RUNTIME_ROOT
    $previousPort = $env:GPT_CANVAS_PORT
    $env:GPT_CANVAS_PROJECT_ROOT = $resolvedProjectRoot
    $env:GPT_CANVAS_RUNTIME_ROOT = $resolvedRuntimeRoot
    $env:GPT_CANVAS_PORT = [string]$Port
    & $nodeCommand.Source 'dist/src/main.js'
}
finally {
    $env:GPT_CANVAS_PROJECT_ROOT = $previousProjectRoot
    $env:GPT_CANVAS_RUNTIME_ROOT = $previousRuntimeRoot
    $env:GPT_CANVAS_PORT = $previousPort
    Pop-Location
}
