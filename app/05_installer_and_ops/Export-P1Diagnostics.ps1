[CmdletBinding()]
param(
    [string]$ApiRoot = 'http://127.0.0.1:3220',
    [string]$ProjectRoot = '',
    [string]$RuntimeRoot = '',
    [string]$OutputRoot = ''
)

$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $appRoot
$bridgeRoot = Join-Path $appRoot '02_bridge_service'
$resolvedRuntimeRoot = if ($RuntimeRoot) { [IO.Path]::GetFullPath($RuntimeRoot) } else { Join-Path $bridgeRoot 'runtime' }
$resolvedProjectRoot = if ($ProjectRoot) { [IO.Path]::GetFullPath($ProjectRoot) } else { Join-Path $resolvedRuntimeRoot 'default-project' }
$resolvedOutputRoot = if ($OutputRoot) { [IO.Path]::GetFullPath($OutputRoot) } else { Join-Path $workspaceRoot '06_交付与运维\发布包\诊断包' }
$tokenPath = Join-Path $resolvedRuntimeRoot 'bridge-token.txt'
if (-not (Test-Path -LiteralPath $tokenPath -PathType Leaf)) { throw "未找到本地令牌：$tokenPath" }
$token = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
$health = Invoke-RestMethod -Method Get -Uri "$($ApiRoot.TrimEnd('/'))/health"

$response = Invoke-RestMethod -Method Post -Uri "$($ApiRoot.TrimEnd('/'))/api/v1/diagnostics/export" -Headers @{ 'x-bridge-token' = $token }
if (-not $response.ok -or -not $response.diagnostic.relativePath) { throw '服务未返回有效诊断文件信息。' }
$source = [IO.Path]::GetFullPath((Join-Path $resolvedProjectRoot $response.diagnostic.relativePath))
if (-not $source.StartsWith([IO.Path]::GetFullPath($resolvedProjectRoot), [StringComparison]::OrdinalIgnoreCase)) { throw '诊断文件路径越出项目目录。' }
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "诊断文件不存在：$source" }
$actualHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne ([string]$response.diagnostic.sha256).ToLowerInvariant()) { throw '诊断文件 SHA-256 与服务返回值不一致。' }

New-Item -ItemType Directory -Path $resolvedOutputRoot -Force | Out-Null
$destination = Join-Path $resolvedOutputRoot $response.diagnostic.filename
$index = 2
while (Test-Path -LiteralPath $destination) {
    $stem = [IO.Path]::GetFileNameWithoutExtension($response.diagnostic.filename)
    $destination = Join-Path $resolvedOutputRoot "${stem}_v$index.json"
    $index++
}
Copy-Item -LiteralPath $source -Destination $destination
$pluginValidation = $null
$pluginInstaller = Join-Path $PSScriptRoot 'Install-D5AICanvas-CodexPlugin.ps1'
if (Test-Path -LiteralPath $pluginInstaller -PathType Leaf) {
    try {
        $pluginValidation = (& $pluginInstaller -ValidateOnly | Out-String) | ConvertFrom-Json
    }
    catch {
        $pluginValidation = [pscustomobject]@{ Valid = $false; Error = $_.Exception.Message }
    }
}
[pscustomobject]@{
    Exported = $true
    File = $destination
    Bytes = (Get-Item -LiteralPath $destination).Length
    SHA256 = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
    TokenIncluded = $false
    BridgeVersion = $health.releaseVersion
    CodexPlugin = $pluginValidation
} | ConvertTo-Json
