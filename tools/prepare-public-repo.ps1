[CmdletBinding()]
param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$BackupRoot = 'D:\CodexWorkspace\02_任务\GPT无限画布_整理备份_20260727',
    [switch]$Execute
)

$ErrorActionPreference = 'Stop'
$resolvedProject = [IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\')
$resolvedBackup = [IO.Path]::GetFullPath($BackupRoot).TrimEnd('\')

if (-not (Test-Path -LiteralPath (Join-Path $resolvedProject '.git') -PathType Container)) {
    throw "项目目录不是预期的 Git 仓库：$resolvedProject"
}
if ($resolvedBackup.StartsWith("$resolvedProject\", [StringComparison]::OrdinalIgnoreCase)) {
    throw '备份目录不得位于项目目录内部。'
}

$records = [System.Collections.Generic.List[object]]::new()

function Remove-TreeSafely {
    param([Parameter(Mandatory)][string]$Path)

    $resolved = [IO.Path]::GetFullPath($Path)
    if (-not ($resolved.StartsWith("$resolvedProject\", [StringComparison]::OrdinalIgnoreCase))) {
        throw "拒绝删除项目目录外的路径：$resolved"
    }
    if (-not (Test-Path -LiteralPath $resolved)) { return }

    $reparsePoints = Get-ChildItem -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } |
        Sort-Object { $_.FullName.Length } -Descending
    foreach ($item in $reparsePoints) {
        try {
            if ($item.PSIsContainer) {
                [IO.Directory]::Delete($item.FullName, $false)
            }
            else {
                [IO.File]::Delete($item.FullName)
            }
        }
        catch {
            $records.Add([pscustomobject]@{
                Action = 'warning'
                Path = [IO.Path]::GetRelativePath($resolvedProject, $item.FullName)
                Reason = $_.Exception.Message
            })
        }
    }
    try {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
    catch {
        $records.Add([pscustomobject]@{
            Action = 'warning'
            Path = [IO.Path]::GetRelativePath($resolvedProject, $resolved)
            Reason = $_.Exception.Message
        })
    }
}

function Copy-DirectoryMerge {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Destination,
        [string[]]$SkipDirectoryNames = @()
    )

    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $Source -Force) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            $records.Add([pscustomobject]@{
                Action = 'discard-generated'
                Path = [IO.Path]::GetRelativePath($resolvedProject, $item.FullName)
                Reason = 'reparse-point'
            })
            continue
        }
        if ($item.PSIsContainer) {
            if ($item.Name -in $SkipDirectoryNames) {
                $records.Add([pscustomobject]@{
                    Action = 'discard-generated'
                    Path = [IO.Path]::GetRelativePath($resolvedProject, $item.FullName)
                    Reason = 'generated-directory'
                })
                continue
            }
            Copy-DirectoryMerge -Source $item.FullName -Destination (Join-Path $Destination $item.Name) -SkipDirectoryNames $SkipDirectoryNames
        }
        else {
            Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $Destination $item.Name) -Force
        }
    }
}

function Move-ToBackup {
    param([Parameter(Mandatory)][string]$RelativePath)

    $source = [IO.Path]::GetFullPath((Join-Path $resolvedProject $RelativePath))
    if (-not ($source.StartsWith("$resolvedProject\", [StringComparison]::OrdinalIgnoreCase))) {
        throw "路径越界：$RelativePath"
    }
    if (-not (Test-Path -LiteralPath $source)) {
        $records.Add([pscustomobject]@{ Action = 'skip'; Path = $RelativePath; Reason = 'not-found' })
        return
    }

    $destination = Join-Path $resolvedBackup (Join-Path '移出项目' $RelativePath)
    $action = if (Test-Path -LiteralPath $destination) { 'merge-backup' } else { 'backup' }
    $records.Add([pscustomobject]@{ Action = $action; Path = $RelativePath; Destination = $destination })
    if (-not $Execute) { return }

    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    if (Test-Path -LiteralPath $destination) {
        $sourceItem = Get-Item -LiteralPath $source -Force
        $destinationItem = Get-Item -LiteralPath $destination -Force
        if (-not ($sourceItem.PSIsContainer -and $destinationItem.PSIsContainer)) {
            throw "备份目标已存在且无法安全合并：$destination"
        }
        $skip = @('node_modules', 'dist', '.build', '.test-dist', 'coverage', '隔离验证')
        Copy-DirectoryMerge -Source $source -Destination $destination -SkipDirectoryNames $skip
        Remove-TreeSafely -Path $source
        return
    }
    if ((Get-Item -LiteralPath $source -Force).PSIsContainer) {
        (Get-Item -LiteralPath $source -Force).Attributes =
            (Get-Item -LiteralPath $source -Force).Attributes -band (-bnot [IO.FileAttributes]::ReadOnly)
    }
    Move-Item -LiteralPath $source -Destination $destination
}

function Remove-Generated {
    param([Parameter(Mandatory)][string]$RelativePath)

    $target = [IO.Path]::GetFullPath((Join-Path $resolvedProject $RelativePath))
    if (-not ($target.StartsWith("$resolvedProject\", [StringComparison]::OrdinalIgnoreCase))) {
        throw "路径越界：$RelativePath"
    }
    if (-not (Test-Path -LiteralPath $target)) {
        $records.Add([pscustomobject]@{ Action = 'skip'; Path = $RelativePath; Reason = 'not-found' })
        return
    }
    $records.Add([pscustomobject]@{ Action = 'remove-generated'; Path = $RelativePath })
    if ($Execute) {
        Remove-TreeSafely -Path $target
    }
}

function Move-InProject {
    param(
        [Parameter(Mandatory)][string]$SourceRelative,
        [Parameter(Mandatory)][string]$DestinationRelative
    )

    $source = [IO.Path]::GetFullPath((Join-Path $resolvedProject $SourceRelative))
    $destination = [IO.Path]::GetFullPath((Join-Path $resolvedProject $DestinationRelative))
    foreach ($path in @($source, $destination)) {
        if (-not ($path.StartsWith("$resolvedProject\", [StringComparison]::OrdinalIgnoreCase))) {
            throw "路径越界：$path"
        }
    }
    if (-not (Test-Path -LiteralPath $source)) {
        $records.Add([pscustomobject]@{ Action = 'skip'; Path = $SourceRelative; Reason = 'not-found' })
        return
    }
    if (Test-Path -LiteralPath $destination) {
        $sourceItem = Get-Item -LiteralPath $source -Force
        $destinationItem = Get-Item -LiteralPath $destination -Force
        if (-not ($sourceItem.PSIsContainer -and $destinationItem.PSIsContainer)) {
            throw "整理目标已存在且无法安全合并：$destination"
        }
        $records.Add([pscustomobject]@{ Action = 'merge-move'; Path = $SourceRelative; Destination = $DestinationRelative })
        if ($Execute) {
            Copy-DirectoryMerge -Source $source -Destination $destination -SkipDirectoryNames @('node_modules', 'dist', '.build', '.test-dist', 'coverage', 'runtime', 'output')
            Remove-TreeSafely -Path $source
        }
        return
    }

    $records.Add([pscustomobject]@{ Action = 'move'; Path = $SourceRelative; Destination = $DestinationRelative })
    if (-not $Execute) { return }

    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    if ((Get-Item -LiteralPath $source -Force).PSIsContainer) {
        Copy-DirectoryMerge -Source $source -Destination $destination -SkipDirectoryNames @('node_modules', 'dist', '.build', '.test-dist', 'coverage', 'runtime', 'output')
        Remove-TreeSafely -Path $source
        return
    }
    Move-Item -LiteralPath $source -Destination $destination
}

New-Item -ItemType Directory -Path $resolvedBackup -Force | Out-Null

$privateOrHistorical = @(
    '00_项目治理',
    '02_P0_技术探针',
    '04_测试与验收',
    '05_项目数据',
    '99_归档',
    '.impeccable.md',
    '使用意见.md',
    '项目导航.md',
    '项目计划书_v2.md',
    '06_交付与运维\发布包',
    '06_交付与运维\README.md',
    '06_交付与运维\安装与使用\P1安装升级回滚.md',
    '06_交付与运维\备份与迁移',
    '03_本地应用\05_installer_and_ops\Get-P1AcceptanceReport.ps1',
    '03_本地应用\05_installer_and_ops\Initialize-P1Acceptance.ps1',
    '03_本地应用\05_installer_and_ops\Install-P1Release.ps1',
    '03_本地应用\05_installer_and_ops\New-P1AcceptanceTask.ps1',
    '03_本地应用\05_installer_and_ops\Package-P1Extension.ps1',
    '03_本地应用\05_installer_and_ops\Package-P1Release.ps1',
    '03_本地应用\05_installer_and_ops\Review-P1AcceptanceCase.ps1'
)
foreach ($path in $privateOrHistorical) {
    Move-ToBackup -RelativePath $path
}

$appRoot = Join-Path $resolvedProject '03_本地应用'
if (Test-Path -LiteralPath $appRoot -PathType Container) {
    $generatedNames = @('node_modules', 'dist', '.build', '.test-dist', 'coverage', 'runtime', 'output')
    $generated = Get-ChildItem -LiteralPath $appRoot -Recurse -Directory -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -in $generatedNames } |
        Sort-Object { $_.FullName.Length }

    $selected = [System.Collections.Generic.List[System.IO.DirectoryInfo]]::new()
    foreach ($candidate in $generated) {
        $covered = $false
        foreach ($parent in $selected) {
            if ($candidate.FullName.StartsWith("$($parent.FullName)\", [StringComparison]::OrdinalIgnoreCase)) {
                $covered = $true
                break
            }
        }
        if (-not $covered) { $selected.Add($candidate) }
    }
    foreach ($directory in $selected) {
        $relative = [IO.Path]::GetRelativePath($resolvedProject, $directory.FullName)
        if ($directory.Name -in @('node_modules', 'dist', '.build', '.test-dist', 'coverage')) {
            Remove-Generated -RelativePath $relative
        }
        else {
            Move-ToBackup -RelativePath $relative
        }
    }
}

Move-InProject -SourceRelative '03_本地应用' -DestinationRelative 'app'
Move-InProject -SourceRelative '01_产品与架构' -DestinationRelative 'docs\architecture'
Move-InProject -SourceRelative '06_交付与运维\安装与使用' -DestinationRelative 'docs\guides'

if ($Execute) {
    $legacyRoot = Join-Path $resolvedProject '06_交付与运维'
    if ((Test-Path -LiteralPath $legacyRoot -PathType Container) -and -not (Get-ChildItem -LiteralPath $legacyRoot -Force)) {
        Remove-Item -LiteralPath $legacyRoot
        $records.Add([pscustomobject]@{ Action = 'remove-empty'; Path = '06_交付与运维' })
    }
}

$log = [ordered]@{
    createdAt = (Get-Date).ToString('o')
    projectRoot = $resolvedProject
    backupRoot = $resolvedBackup
    execute = [bool]$Execute
    records = $records
}
$logPath = Join-Path $resolvedBackup ($(if ($Execute) { '整理日志.json' } else { '整理预演日志.json' }))
$log | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $logPath -Encoding utf8
$log | ConvertTo-Json -Depth 6
