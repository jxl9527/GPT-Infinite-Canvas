[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$Archive,
    [Parameter(Mandatory)]
    [string]$TargetRoot
)

$ErrorActionPreference = 'Stop'
$archivePath = [IO.Path]::GetFullPath($Archive)
$targetPath = [IO.Path]::GetFullPath($TargetRoot)
if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) { throw "备份文件不存在：$archivePath" }
if (Test-Path -LiteralPath $targetPath) { throw "恢复目标已存在，拒绝覆盖：$targetPath" }
$parent = Split-Path $targetPath -Parent
if (-not (Test-Path -LiteralPath $parent -PathType Container)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) "gpt-canvas-restore-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
try {
    Expand-Archive -LiteralPath $archivePath -DestinationPath $tempRoot
    $manifestPath = Join-Path $tempRoot 'backup-manifest.json'
    $payloadRoot = Join-Path $tempRoot 'project'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or -not (Test-Path -LiteralPath $payloadRoot -PathType Container)) { throw '备份包结构无效。' }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    foreach ($entry in $manifest.files) {
        $candidate = [IO.Path]::GetFullPath((Join-Path $payloadRoot ([string]$entry.relativePath)))
        if (-not $candidate.StartsWith([IO.Path]::GetFullPath($payloadRoot), [StringComparison]::OrdinalIgnoreCase)) { throw "备份条目越界：$($entry.relativePath)" }
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw "备份条目缺失：$($entry.relativePath)" }
        $hash = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($hash -ne ([string]$entry.sha256).ToLowerInvariant()) { throw "备份条目校验失败：$($entry.relativePath)" }
    }
    New-Item -ItemType Directory -Path $targetPath | Out-Null
    Copy-Item -Path (Join-Path $payloadRoot '*') -Destination $targetPath -Recurse -Force
}
finally {
    $resolvedTemp = [IO.Path]::GetFullPath($tempRoot)
    if ($resolvedTemp.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedTemp)) {
        Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
    }
}
[pscustomobject]@{ Restored = $true; Archive = $archivePath; TargetRoot = $targetPath; FileCount = @($manifest.files).Count } | ConvertTo-Json
