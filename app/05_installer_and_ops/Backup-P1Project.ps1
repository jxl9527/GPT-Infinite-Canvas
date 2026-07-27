[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ProjectRoot,
    [string]$DestinationRoot = '',
    [switch]$AllowRunning
)

$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $appRoot
$sourceRoot = [IO.Path]::GetFullPath($ProjectRoot)
$outputRoot = if ($DestinationRoot) { [IO.Path]::GetFullPath($DestinationRoot) } else { Join-Path $workspaceRoot '06_交付与运维\发布包\运行备份' }
if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) { throw "项目目录不存在：$sourceRoot" }
if (-not $AllowRunning -and (Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 3220 -State Listen -ErrorAction SilentlyContinue)) {
    throw '检测到 P1 服务仍在运行。为保证一致性，请先停止服务，或仅在明确接受非一致快照时使用 -AllowRunning。'
}

New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$baseName = "P1_project_backup_$stamp"
$archive = Join-Path $outputRoot "$baseName.zip"
$index = 2
while (Test-Path -LiteralPath $archive) { $archive = Join-Path $outputRoot "${baseName}_v$index.zip"; $index++ }
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) "gpt-canvas-backup-$([guid]::NewGuid().ToString('N'))"
$payloadRoot = Join-Path $tempRoot 'project'
New-Item -ItemType Directory -Path $payloadRoot -Force | Out-Null
try {
    Copy-Item -Path (Join-Path $sourceRoot '*') -Destination $payloadRoot -Recurse -Force
    $files = Get-ChildItem -LiteralPath $payloadRoot -Recurse -File | Sort-Object FullName | ForEach-Object {
        [ordered]@{
            relativePath = [IO.Path]::GetRelativePath($payloadRoot, $_.FullName).Replace('\', '/')
            bytes = $_.Length
            sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
    $manifest = [ordered]@{ schemaVersion = '1.0'; createdAt = (Get-Date).ToString('o'); sourceName = Split-Path $sourceRoot -Leaf; files = @($files) }
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $tempRoot 'backup-manifest.json') -Encoding utf8
    Compress-Archive -Path (Join-Path $tempRoot '*') -DestinationPath $archive -CompressionLevel Optimal
}
finally {
    $resolvedTemp = [IO.Path]::GetFullPath($tempRoot)
    if ($resolvedTemp.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedTemp)) {
        Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
    }
}
[pscustomobject]@{ BackedUp = $true; Archive = $archive; Bytes = (Get-Item -LiteralPath $archive).Length; SHA256 = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash } | ConvertTo-Json
