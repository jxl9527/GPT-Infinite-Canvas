[CmdletBinding()]
param(
  [switch]$ValidateOnly,
  [switch]$ForceReinstall
)

$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $PSCommandPath
$appRoot = Split-Path -Parent $scriptRoot
$integrationRoot = Join-Path $appRoot '06_codex_integration'
$pluginRoot = Join-Path $integrationRoot 'd5-ai-canvas'
$marketplacePath = Join-Path $integrationRoot '.agents\plugins\marketplace.json'
$pluginManifestPath = Join-Path $pluginRoot '.codex-plugin\plugin.json'
$mcpEntryPath = Join-Path $pluginRoot 'scripts\start-mcp.mjs'
$mcpSdkPath = Join-Path $pluginRoot 'node_modules\@modelcontextprotocol\sdk\package.json'

foreach ($requiredPath in @($marketplacePath, $pluginManifestPath, $mcpEntryPath, $mcpSdkPath)) {
  if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
    throw "Codex 插件文件缺失：$requiredPath"
  }
}

$plugin = Get-Content -LiteralPath $pluginManifestPath -Raw -Encoding utf8 | ConvertFrom-Json
$marketplace = Get-Content -LiteralPath $marketplacePath -Raw -Encoding utf8 | ConvertFrom-Json
if ($plugin.name -ne 'd5-ai-canvas' -or $marketplace.name -ne 'd5-ai-canvas-local') {
  throw 'Codex 插件或本地市场名称无效。'
}

$node = Get-Command node -ErrorAction Stop
$nodeVersion = [version]((& $node.Source --version).Trim().TrimStart('v'))
if ($nodeVersion.Major -lt 24) { throw "Codex MCP 需要 Node.js 24 或更高版本，当前为 $nodeVersion" }

Push-Location $pluginRoot
try {
  & $node.Source 'scripts\probe-mcp.mjs'
  if ($LASTEXITCODE -ne 0) { throw 'Codex MCP 协议探针失败。' }
}
finally {
  Pop-Location
}

if ($ValidateOnly) {
  [pscustomobject]@{
    Valid = $true
    Plugin = $plugin.name
    Version = $plugin.version
    Marketplace = $marketplace.name
    PluginRoot = $pluginRoot
  } | ConvertTo-Json
  return
}

$codex = Get-Command codex -ErrorAction Stop
$codexConfig = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\config.toml'
if (Test-Path -LiteralPath $codexConfig -PathType Leaf) {
  $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  Copy-Item -LiteralPath $codexConfig -Destination "$codexConfig.backup-$timestamp"
}

& $codex.Source plugin marketplace add $integrationRoot
if ($LASTEXITCODE -ne 0) {
  $known = & $codex.Source plugin marketplace list | Out-String
  if ($known -notmatch '(?m)^d5-ai-canvas-local\s') { throw 'D5 AI Canvas 本地插件市场注册失败。' }
}

$installed = & $codex.Source plugin list | Out-String
$currentPluginPattern = '(?m)^d5-ai-canvas@d5-ai-canvas-local\s+installed,\s+enabled\s+' + [regex]::Escape([string]$plugin.version) + '\s+'
$currentVersionInstalled = $installed -match $currentPluginPattern

if ($ForceReinstall -and -not $currentVersionInstalled) {
  & $codex.Source plugin remove 'd5-ai-canvas@d5-ai-canvas-local'
}

if (-not $currentVersionInstalled) {
  & $codex.Source plugin add 'd5-ai-canvas@d5-ai-canvas-local'
  if ($LASTEXITCODE -ne 0) {
    $installed = & $codex.Source plugin list | Out-String
    if ($installed -notmatch $currentPluginPattern) {
      throw 'D5 AI Canvas Codex 插件安装失败；如插件缓存正在使用，请重启 Codex 后重试。'
    }
  }
}

[pscustomobject]@{
  Installed = $true
  Plugin = $plugin.name
  Version = $plugin.version
  Marketplace = $marketplace.name
  ConfigBackupCreated = (Test-Path -LiteralPath $codexConfig -PathType Leaf)
} | ConvertTo-Json
