# Builds an immutable mirror evidence baseline and, after fresh-source confirmation, final fusion inventories.
[CmdletBinding()]
param(
    [ValidateSet('ArchiveBaseline', 'VerifyBaseline', 'InspectPrimary', 'BuildPrimary', 'VerifyPrimary')]
    [string]$Mode = 'ArchiveBaseline',

    [string]$LegacyFinalArchivePath = 'C:\Users\Administrator\Desktop\maolong_final.zip',
    [string]$LegacyV3ArchivePath = 'C:\Users\Administrator\Desktop\maolong_mirror_v3.zip',

    [string]$PrimarySourcePath = '',
    [string]$ExpectedPrimarySha256 = '',
    [int]$ExpectedPrimaryFileCount = 0,
    [long]$ExpectedPrimaryBytes = 0,
    [switch]$ConfirmFreshPrimary,

    [string]$IsolationRoot = 'F:\总项目文件\Skill存储系统\01_网页开发项目\应用仓库\08_隔离运行\maolong-mirror-final-20260925',
    [string]$OutputDirectory = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:SchemaVersion = 'maolong-mirror-evidence.v1'
$script:LegacyFinalExpected = [ordered]@{
    sha256 = 'C6C0AF92EBC741BA9A3CA956E9AE98677CFF875EC3F1A4D8FDE8685C4CC3B4B3'
    archiveBytes = [long]72249868
    entryCount = 317
    fileCount = 317
    uncompressedBytes = [long]80316905
}
$script:LegacyV3Expected = [ordered]@{
    sha256 = 'AA825C2ADE5A71FC1EC7900730A4D70B95918353EEBB0BC8FBF67B6B0C2196ED'
    archiveBytes = [long]72171073
    entryCount = 278
    fileCount = 278
    uncompressedBytes = [long]80150465
}

$projectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $projectRoot 'docs\带货Agent镜像融合-20260925'
}

$script:SupportingDocuments = @(
    [ordered]@{ name = '茂隆掌柜AI_全面逆向分析报告.md'; sourcePath = 'C:\Users\Administrator\Desktop\茂隆掌柜AI_全面逆向分析报告.md' },
    [ordered]@{ name = '茂隆掌柜AI_逆向分析报告_final.md'; sourcePath = 'C:\Users\Administrator\Desktop\茂隆掌柜AI_逆向分析报告_final.md' },
    [ordered]@{ name = '茂隆掌柜AI_超级编导_逆向提示词_19技能.txt'; sourcePath = 'C:\Users\Administrator\Desktop\茂隆掌柜AI_超级编导_逆向提示词_19技能.txt' },
    [ordered]@{ name = '带货Agent源码镜像融合-新窗口启动文件-2026-09-25.md'; sourcePath = 'C:\Users\Administrator\Desktop\带货Agent源码镜像融合-新窗口启动文件-2026-09-25.md' },
    [ordered]@{ name = '视频生成提示词模板提取.md'; sourcePath = 'C:\Users\Administrator\Desktop\视频生成提示词模板提取.md' },
    [ordered]@{ name = '茂隆掌柜AI_后端技能接口_解码整理.md'; sourcePath = 'C:\Users\Administrator\Desktop\茂隆掌柜AI_后端技能接口_解码整理.md' }
)

function Get-FileSha256 {
    param([Parameter(Mandatory)][string]$LiteralPath)
    return (Get-FileHash -LiteralPath $LiteralPath -Algorithm SHA256).Hash.ToUpperInvariant()
}

function Get-BytesSha256 {
    param([Parameter(Mandatory)][byte[]]$Bytes)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToUpperInvariant()
    }
    finally {
        $sha.Dispose()
    }
}

function Get-StringSha256 {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)
    return Get-BytesSha256 -Bytes ([Text.Encoding]::UTF8.GetBytes($Value))
}

function Get-StreamSha256 {
    param([Parameter(Mandatory)][IO.Stream]$Stream)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha.ComputeHash($Stream))).Replace('-', '').ToUpperInvariant()
    }
    finally {
        $sha.Dispose()
    }
}

function ConvertTo-SafeRelativePath {
    param([Parameter(Mandatory)][string]$ArchivePath)

    if ($ArchivePath.IndexOf([char]0) -ge 0) {
        throw "Unsafe archive entry contains NUL: $ArchivePath"
    }

    $normalized = $ArchivePath.Replace('\', '/')
    $isDirectory = $normalized.EndsWith('/', [StringComparison]::Ordinal)
    if ($isDirectory) {
        $normalized = $normalized.TrimEnd('/')
    }

    if ([string]::IsNullOrWhiteSpace($normalized) -or
        $normalized.StartsWith('/', [StringComparison]::Ordinal) -or
        $normalized.StartsWith('//', [StringComparison]::Ordinal) -or
        $normalized -match '^[A-Za-z]:') {
        throw "Unsafe rooted or empty archive entry: $ArchivePath"
    }

    $segments = $normalized.Split('/')
    foreach ($segment in $segments) {
        if ([string]::IsNullOrWhiteSpace($segment) -or $segment -eq '.' -or $segment -eq '..') {
            throw "Unsafe archive entry segment in: $ArchivePath"
        }
        if ($segment.IndexOfAny([char[]]'<>:"|?*') -ge 0) {
            throw "Unsafe Windows filename character in: $ArchivePath"
        }
        if ($segment.EndsWith(' ', [StringComparison]::Ordinal) -or $segment.EndsWith('.', [StringComparison]::Ordinal)) {
            throw "Unsafe trailing dot/space in: $ArchivePath"
        }
        if ($segment -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$') {
            throw "Unsafe Windows reserved filename in: $ArchivePath"
        }
    }

    return [pscustomobject]@{
        path = ($segments -join '/')
        isDirectory = $isDirectory
    }
}

function Assert-ChildPath {
    param(
        [Parameter(Mandatory)][string]$Parent,
        [Parameter(Mandatory)][string]$Child
    )
    $parentFull = [IO.Path]::GetFullPath($Parent).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $childFull = [IO.Path]::GetFullPath($Child)
    $prefix = $parentFull + [IO.Path]::DirectorySeparatorChar
    if (-not $childFull.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Resolved path escapes intended root. root=$parentFull child=$childFull"
    }
    return $childFull
}

function Get-TextSignalsFromBytes {
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][byte[]]$Bytes,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Extension
    )
    $textExtensions = @('.html', '.js', '.css', '.json', '.md', '.txt', '.xml')
    if ($textExtensions -notcontains $Extension -or $Bytes.LongLength -gt 4MB) {
        return [pscustomobject]@{
            objectStorageErrorBody = $false
            referencesRuntimeConfig = $null
            promptCoreSha256 = $null
        }
    }

    $text = [Text.Encoding]::UTF8.GetString($Bytes)
    $objectStorageError = $text -match '(?is)^\uFEFF?\s*(?:(?:<\?xml[^>]*>\s*)?<Error>\s*<Code>\s*NoSuchKey\s*</Code>|\{\s*"Code"\s*:\s*"NoSuchKey")'
    $runtimeConfig = if ($Extension -eq '.html') { $text -match '(?i)runtime-config\.js' } else { $null }
    $promptCoreSha = $null
    if ($Extension -eq '.md' -and $text -match '底层主指令') {
        $match = [regex]::Match($text, '(?s)##\s*一、底层主指令[^\r\n]*\r?\n\s*~~~\s*\r?\n(?<core>.*?)\r?\n\s*~~~')
        if ($match.Success) {
            $core = $match.Groups['core'].Value.Replace("`r`n", "`n").Trim()
            $promptCoreSha = Get-StringSha256 -Value $core
        }
    }

    return [pscustomobject]@{
        objectStorageErrorBody = [bool]$objectStorageError
        referencesRuntimeConfig = $runtimeConfig
        promptCoreSha256 = $promptCoreSha
    }
}

function Get-ArtifactClassification {
    param(
        [Parameter(Mandatory)][string]$RelativePath,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Extension,
        [Parameter(Mandatory)][bool]$ObjectStorageErrorBody
    )

    $logicalPath = $RelativePath -replace '^responses/[^/]+/', ''
    $top = ($logicalPath -split '/')[0]
    $artifactClass = 'other-static-evidence'
    $evidenceGrade = 'D-reconstruction-or-derived-note'
    $intendedAction = 'preserve-as-evidence'
    $mappedArea = '未分配；需逐条人工核对'
    $risk = '静态证据不能证明服务端实现、运行身份或生产可用性'

    if ($ObjectStorageErrorBody) {
        $artifactClass = 'broken-download-object-storage-error-body'
        $evidenceGrade = 'E-invalid-payload'
        $intendedAction = 'do-not-integrate; retain-for-completeness-gap-evidence'
        $mappedArea = '镜像下载完整性'
        $risk = '扩展名与实际错误正文不一致，不能当作 JS/CSS 执行'
    }
    elseif ($top -eq 'admin_pages' -or ($logicalPath -match '^admin(?:/|\.html$)' -and $Extension -eq '.html')) {
        $artifactClass = 'rendered-admin-page'
        $evidenceGrade = 'B-rendered-client-evidence'
        $intendedAction = 'extract-workflow-and-state-contracts-only'
        $mappedArea = Get-MappedProductArea -RelativePath $logicalPath
        $risk = 'HTML 只证明抓取时可见结构，不含后台服务、权限规则或数据库实现'
    }
    elseif ($top -eq 'pages' -or ($Extension -eq '.html' -and $logicalPath -notmatch '^admin(?:/|\.html$)')) {
        $artifactClass = 'rendered-public-page'
        $evidenceGrade = 'B-rendered-client-evidence'
        $intendedAction = 'extract-workflow-and-state-contracts-only'
        $mappedArea = Get-MappedProductArea -RelativePath $logicalPath
        $risk = '不得复刻对标品牌视觉、图标、素材或独特排版'
    }
    elseif ($top -eq 'api') {
        $artifactClass = 'captured-public-api-response'
        $evidenceGrade = 'B-public-contract-evidence'
        $intendedAction = 'map-api-fields-and-state-semantics'
        $mappedArea = Get-MappedProductArea -RelativePath $logicalPath
        $risk = '单次 JSON 快照不证明当前服务端、鉴权、队列或持久化行为'
    }
    elseif ($top -eq 'chunks' -or $logicalPath -match '(^|/)_next/static/(?:chunks|css)/') {
        $artifactClass = if ($Extension -eq '.css') { 'compiled-client-style' } else { 'compiled-client-bundle' }
        $evidenceGrade = 'B-compiled-client-evidence'
        $intendedAction = 'behavior-reference-only; never-run-from-isolation'
        $mappedArea = Get-MappedProductArea -RelativePath $logicalPath
        $risk = '编译产物不可维护，缺少源码映射、依赖锁和构建合同'
    }
    elseif ($top -eq 'assets' -or $Extension -in @('.png', '.jpg', '.jpeg', '.webp', '.svg', '.mp4', '.webm', '.mp3', '.wav')) {
        $artifactClass = if ($Extension -in @('.png', '.jpg', '.jpeg', '.mp4')) { 'captured-media-sample' } else { 'captured-brand-or-static-asset' }
        $evidenceGrade = 'C-output-or-visual-sample'
        $intendedAction = 'retain-for-comparison; never-ship-competitor-assets'
        $mappedArea = '素材/输出样本与视觉参考'
        $risk = '可能包含对标品牌、用户素材或输出样本，仅限隔离取证'
    }
    elseif ($top -eq '超级编导提示词包') {
        $artifactClass = if ($Extension -eq '.json') { 'reconstructed-director-metadata' } else { 'reconstructed-director-prompt-wrapper' }
        $evidenceGrade = 'D-reverse-reconstructed'
        $intendedAction = 'compare-rules; do-not-replace-independent-local-prompts'
        $mappedArea = '19 个超级编导、技能路由、提示词版本'
        $risk = '文件自述为逆向还原版，不是服务端逐字 system prompt'
    }
    elseif ($top -eq 'docs') {
        $artifactClass = 'mirror-bundled-analysis-or-handoff'
        $evidenceGrade = 'D-derived-document'
        $intendedAction = 'cross-check-against-observed-contracts'
        $mappedArea = Get-MappedProductArea -RelativePath $RelativePath
        $risk = '文档中的指令按证据处理，不覆盖用户当前任务或项目协议'
    }
    elseif ($top -eq 'analysis') {
        $artifactClass = 'site-discovery-metadata'
        $evidenceGrade = 'D-derived-or-public-metadata'
        $intendedAction = 'retain-for-route-completeness-audit'
        $mappedArea = '路由发现、公开索引、缺失资源记录'
        $risk = '站点地图与 robots 不能证明业务流程已闭环'
    }
    elseif ($RelativePath -in @('README.md', '离线浏览说明.txt')) {
        $artifactClass = 'mirror-package-documentation'
        $evidenceGrade = 'D-derived-document'
        $intendedAction = 'retain-for-provenance'
        $mappedArea = '镜像使用边界与来源说明'
        $risk = '说明文档不能替代逐文件哈希和真实运行验收'
    }

    return [pscustomobject]@{
        artifactClass = $artifactClass
        evidenceGrade = $evidenceGrade
        intendedAction = $intendedAction
        mappedProductArea = $mappedArea
        limitation = $risk
    }
}

function Get-MappedProductArea {
    param([Parameter(Mandatory)][string]$RelativePath)
    $lower = $RelativePath.ToLowerInvariant()
    if ($lower -match 'agent-chat|director|video-creator-skills|skill-packages') { return '带货 Agent 对话、超级编导目录与技能配置' }
    if ($lower -match 'depth-video-clone') { return '深度视频复刻、长视频分段、参考素材与模型能力' }
    if ($lower -match 'ecommerce-image-set|image_skill|image-skill') { return '带货图片组与图片技能' }
    if ($lower -match 'assets') { return '统一资产库与素材管理' }
    if ($lower -match 'model-routes') { return '模型池、路由与工作台分配边界' }
    if ($lower -match 'voices') { return '声音、配音、音色与口型能力状态' }
    if ($lower -match 'credits|payments|invoices|recharge|topup') { return '报价、余额、计费与账单终态' }
    if ($lower -match 'batches|task-reports|audit') { return '任务、队列、失败恢复、审计与历史' }
    if ($lower -match 'users|affiliate|invite|growth|kyc') { return '后台用户、合作、邀请与增长管理' }
    if ($lower -match 'discover|index_') { return '发现页、入口与工具导航' }
    if ($lower -match 'video-quality-enhance|subtitle|watermark') { return '视频工具箱相邻能力' }
    if ($lower -match 'privacy|terms') { return '公开协议页面' }
    return '共享客户端壳层、组件或静态运行依赖'
}

function New-InventoryEntry {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][long]$Bytes,
        [Parameter(Mandatory)][string]$Sha256,
        [Parameter(Mandatory)][long]$CompressedBytes,
        [Parameter(Mandatory)][pscustomobject]$Signals
    )
    $extension = [IO.Path]::GetExtension($Path).ToLowerInvariant()
    $classification = Get-ArtifactClassification -RelativePath $Path -Extension $extension -ObjectStorageErrorBody $Signals.objectStorageErrorBody
    return [pscustomobject][ordered]@{
        path = $Path
        bytes = $Bytes
        compressedBytes = $CompressedBytes
        sha256 = $Sha256
        extension = $extension
        artifactClass = $classification.artifactClass
        evidenceGrade = $classification.evidenceGrade
        intendedAction = $classification.intendedAction
        mappedProductArea = $classification.mappedProductArea
        limitation = $classification.limitation
        objectStorageErrorBody = $Signals.objectStorageErrorBody
        referencesRuntimeConfig = $Signals.referencesRuntimeConfig
        promptCoreSha256 = $Signals.promptCoreSha256
    }
}

function Assert-NoPathCollisions {
    param([Parameter(Mandatory)][object[]]$PathRecords)
    $byPath = @{}
    foreach ($record in $PathRecords) {
        $key = $record.path.ToLowerInvariant()
        if ($byPath.ContainsKey($key)) {
            throw "Case-insensitive or normalized path collision: $($record.path)"
        }
        $byPath[$key] = $record
    }
    foreach ($record in $PathRecords | Where-Object { -not $_.isDirectory }) {
        $parts = $record.path.Split('/')
        for ($index = 1; $index -lt $parts.Length; $index++) {
            $parent = ($parts[0..($index - 1)] -join '/').ToLowerInvariant()
            if ($byPath.ContainsKey($parent) -and -not $byPath[$parent].isDirectory) {
                throw "Archive file/directory conflict: $($record.path) conflicts with $parent"
            }
        }
    }
}

function Get-ZipInventory {
    param([Parameter(Mandatory)][string]$LiteralPath)

    if (-not (Test-Path -LiteralPath $LiteralPath -PathType Leaf)) {
        throw "Archive does not exist: $LiteralPath"
    }
    $resolved = (Resolve-Path -LiteralPath $LiteralPath).Path
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archiveFile = Get-Item -LiteralPath $resolved
    $archiveSha = Get-FileSha256 -LiteralPath $resolved
    $stream = [IO.File]::Open($resolved, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $zip = $null
    try {
        $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Read, $false)
        $pathRecords = [Collections.Generic.List[object]]::new()
        $entries = [Collections.Generic.List[object]]::new()
        $entryCount = 0
        $uncompressedBytes = [long]0
        $compressedBytes = [long]0
        foreach ($entry in $zip.Entries) {
            $entryCount++
            $safe = ConvertTo-SafeRelativePath -ArchivePath $entry.FullName
            $unixType = (($entry.ExternalAttributes -shr 16) -band 0xF000)
            if ($unixType -eq 0xA000) {
                throw "Symbolic-link archive entry is not allowed: $($entry.FullName)"
            }
            $pathRecords.Add([pscustomobject]@{ path = $safe.path; isDirectory = $safe.isDirectory })
            if ($safe.isDirectory) { continue }

            $uncompressedBytes += [long]$entry.Length
            $compressedBytes += [long]$entry.CompressedLength
            $entryStream = $entry.Open()
            try {
                $sha = Get-StreamSha256 -Stream $entryStream
            }
            finally {
                $entryStream.Dispose()
            }

            $extension = [IO.Path]::GetExtension($safe.path).ToLowerInvariant()
            $signalBytes = [byte[]]@()
            if ($entry.Length -le 4MB -and $extension -in @('.html', '.js', '.css', '.json', '.md', '.txt', '.xml')) {
                $signalStream = $entry.Open()
                $memory = [IO.MemoryStream]::new()
                try {
                    $signalStream.CopyTo($memory)
                    $signalBytes = $memory.ToArray()
                }
                finally {
                    $memory.Dispose()
                    $signalStream.Dispose()
                }
            }
            $signals = Get-TextSignalsFromBytes -Bytes $signalBytes -Extension $extension
            $entries.Add((New-InventoryEntry -Path $safe.path -Bytes $entry.Length -CompressedBytes $entry.CompressedLength -Sha256 $sha -Signals $signals))
        }
        Assert-NoPathCollisions -PathRecords $pathRecords.ToArray()
    }
    finally {
        if ($null -ne $zip) { $zip.Dispose() }
        $stream.Dispose()
    }

    $sortedEntries = @($entries.ToArray() | Sort-Object path)
    $manifestLines = @($sortedEntries | ForEach-Object { "{0}`t{1}`t{2}" -f $_.path, $_.bytes, $_.sha256 })
    return [pscustomobject][ordered]@{
        sourceType = 'zip'
        sourcePath = $resolved
        packageSha256 = $archiveSha
        manifestSha256 = Get-StringSha256 -Value ($manifestLines -join "`n")
        archiveBytes = [long]$archiveFile.Length
        entryCount = $entryCount
        fileCount = $sortedEntries.Count
        uncompressedBytes = $uncompressedBytes
        compressedEntryBytes = $compressedBytes
        lastWriteTimeUtc = $archiveFile.LastWriteTimeUtc.ToString('o')
        entries = $sortedEntries
    }
}

function Get-DirectoryInventory {
    param([Parameter(Mandatory)][string]$LiteralPath)
    if (-not (Test-Path -LiteralPath $LiteralPath -PathType Container)) {
        throw "Directory does not exist: $LiteralPath"
    }
    $resolved = (Resolve-Path -LiteralPath $LiteralPath).Path
    $rootInfo = Get-Item -LiteralPath $resolved -Force
    if (($rootInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Primary directory root cannot be a reparse point: $resolved"
    }

    $entries = [Collections.Generic.List[object]]::new()
    $pathRecords = [Collections.Generic.List[object]]::new()
    $totalBytes = [long]0
    foreach ($item in Get-ChildItem -LiteralPath $resolved -Recurse -File -Force | Sort-Object FullName) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Reparse-point file is not allowed: $($item.FullName)"
        }
        $relative = [IO.Path]::GetRelativePath($resolved, $item.FullName).Replace('\', '/')
        $safe = ConvertTo-SafeRelativePath -ArchivePath $relative
        $pathRecords.Add([pscustomobject]@{ path = $safe.path; isDirectory = $false })
        $sha = Get-FileSha256 -LiteralPath $item.FullName
        $extension = $item.Extension.ToLowerInvariant()
        $signalBytes = [byte[]]@()
        if ($item.Length -le 4MB -and $extension -in @('.html', '.js', '.css', '.json', '.md', '.txt', '.xml')) {
            $signalBytes = [IO.File]::ReadAllBytes($item.FullName)
        }
        $signals = Get-TextSignalsFromBytes -Bytes $signalBytes -Extension $extension
        $entries.Add((New-InventoryEntry -Path $safe.path -Bytes $item.Length -CompressedBytes 0 -Sha256 $sha -Signals $signals))
        $totalBytes += [long]$item.Length
    }
    Assert-NoPathCollisions -PathRecords $pathRecords.ToArray()
    $sortedEntries = @($entries.ToArray() | Sort-Object path)
    $manifestLines = @($sortedEntries | ForEach-Object { "{0}`t{1}`t{2}" -f $_.path, $_.bytes, $_.sha256 })
    return [pscustomobject][ordered]@{
        sourceType = 'directory'
        sourcePath = $resolved
        packageSha256 = $null
        manifestSha256 = Get-StringSha256 -Value ($manifestLines -join "`n")
        archiveBytes = $null
        entryCount = $sortedEntries.Count
        fileCount = $sortedEntries.Count
        uncompressedBytes = $totalBytes
        compressedEntryBytes = $null
        lastWriteTimeUtc = $rootInfo.LastWriteTimeUtc.ToString('o')
        entries = $sortedEntries
    }
}

function Get-SourceInventory {
    param([Parameter(Mandatory)][string]$LiteralPath)
    if (Test-Path -LiteralPath $LiteralPath -PathType Container) {
        return Get-DirectoryInventory -LiteralPath $LiteralPath
    }
    return Get-ZipInventory -LiteralPath $LiteralPath
}

function Assert-LegacyIdentity {
    param(
        [Parameter(Mandatory)][pscustomobject]$Inventory,
        [Parameter(Mandatory)][System.Collections.IDictionary]$Expected,
        [Parameter(Mandatory)][string]$Label
    )
    $checks = [ordered]@{
        sha256 = ($Inventory.packageSha256 -eq $Expected.sha256)
        archiveBytes = ($Inventory.archiveBytes -eq $Expected.archiveBytes)
        entryCount = ($Inventory.entryCount -eq $Expected.entryCount)
        fileCount = ($Inventory.fileCount -eq $Expected.fileCount)
        uncompressedBytes = ($Inventory.uncompressedBytes -eq $Expected.uncompressedBytes)
    }
    $failed = @($checks.GetEnumerator() | Where-Object { -not $_.Value } | ForEach-Object { $_.Key })
    if ($failed.Count -gt 0) {
        throw "$Label identity mismatch: $($failed -join ', ')"
    }
    return [pscustomobject]$checks
}

function Get-ArchiveComparison {
    param(
        [Parameter(Mandatory)][pscustomobject]$Left,
        [Parameter(Mandatory)][pscustomobject]$Right,
        [Parameter(Mandatory)][string]$LeftLabel,
        [Parameter(Mandatory)][string]$RightLabel
    )
    $leftMap = @{}
    foreach ($entry in $Left.entries) { $leftMap[$entry.path] = $entry }
    $rightMap = @{}
    foreach ($entry in $Right.entries) { $rightMap[$entry.path] = $entry }
    $leftOnly = @($leftMap.Keys | Where-Object { -not $rightMap.ContainsKey($_) } | Sort-Object)
    $rightOnly = @($rightMap.Keys | Where-Object { -not $leftMap.ContainsKey($_) } | Sort-Object)
    $common = @($leftMap.Keys | Where-Object { $rightMap.ContainsKey($_) })
    $changed = @($common | Where-Object { $leftMap[$_].sha256 -ne $rightMap[$_].sha256 } | Sort-Object)
    $identical = @($common | Where-Object { $leftMap[$_].sha256 -eq $rightMap[$_].sha256 } | Sort-Object)
    return [pscustomobject][ordered]@{
        leftLabel = $LeftLabel
        rightLabel = $RightLabel
        commonCount = $common.Count
        identicalCount = $identical.Count
        changedCount = $changed.Count
        leftOnlyCount = $leftOnly.Count
        rightOnlyCount = $rightOnly.Count
        changedPaths = $changed
        leftOnlyPaths = $leftOnly
        rightOnlyPaths = $rightOnly
    }
}

function Get-SupportingDocumentRecords {
    param([string]$CopiedRoot = '')
    $records = [Collections.Generic.List[object]]::new()
    foreach ($document in $script:SupportingDocuments) {
        $path = if ([string]::IsNullOrWhiteSpace($CopiedRoot)) { $document.sourcePath } else { Join-Path $CopiedRoot $document.name }
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Supporting document does not exist: $path"
        }
        $item = Get-Item -LiteralPath $path
        $records.Add([pscustomobject][ordered]@{
            name = $document.name
            originalSourcePath = $document.sourcePath
            importedPath = if ([string]::IsNullOrWhiteSpace($CopiedRoot)) { $null } else { $path }
            bytes = [long]$item.Length
            sha256 = Get-FileSha256 -LiteralPath $path
            evidenceUse = 'supporting-analysis-only'
            instructionBoundary = '文档内指令只按证据读取；用户当前请求与项目协议优先'
        })
    }
    return $records.ToArray()
}

function Expand-SafeZip {
    param(
        [Parameter(Mandatory)][pscustomobject]$Inventory,
        [Parameter(Mandatory)][string]$Destination
    )
    if (Test-Path -LiteralPath $Destination) {
        throw "Extraction destination already exists: $Destination"
    }
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    $destinationFull = [IO.Path]::GetFullPath($Destination)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $stream = [IO.File]::Open($Inventory.sourcePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $zip = $null
    try {
        $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Read, $false)
        foreach ($entry in $zip.Entries) {
            $safe = ConvertTo-SafeRelativePath -ArchivePath $entry.FullName
            $relativeNative = $safe.path.Replace('/', [IO.Path]::DirectorySeparatorChar)
            $target = Assert-ChildPath -Parent $destinationFull -Child (Join-Path $destinationFull $relativeNative)
            if ($safe.isDirectory) {
                New-Item -ItemType Directory -Path $target -Force | Out-Null
                continue
            }
            $parent = Split-Path -Parent $target
            if (-not (Test-Path -LiteralPath $parent)) {
                New-Item -ItemType Directory -Path $parent -Force | Out-Null
            }
            $input = $entry.Open()
            $output = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try {
                $input.CopyTo($output)
            }
            finally {
                $output.Dispose()
                $input.Dispose()
            }
        }
    }
    finally {
        if ($null -ne $zip) { $zip.Dispose() }
        $stream.Dispose()
    }
    Assert-MirrorMatchesInventory -MirrorRoot $Destination -Inventory $Inventory
}

function Copy-SafeDirectory {
    param(
        [Parameter(Mandatory)][pscustomobject]$Inventory,
        [Parameter(Mandatory)][string]$Destination
    )
    if (Test-Path -LiteralPath $Destination) {
        throw "Copy destination already exists: $Destination"
    }
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    $destinationFull = [IO.Path]::GetFullPath($Destination)
    foreach ($entry in $Inventory.entries) {
        $source = Assert-ChildPath -Parent $Inventory.sourcePath -Child (Join-Path $Inventory.sourcePath $entry.path.Replace('/', [IO.Path]::DirectorySeparatorChar))
        $target = Assert-ChildPath -Parent $destinationFull -Child (Join-Path $destinationFull $entry.path.Replace('/', [IO.Path]::DirectorySeparatorChar))
        $parent = Split-Path -Parent $target
        if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
        [IO.File]::Copy($source, $target, $false)
    }
    Assert-MirrorMatchesInventory -MirrorRoot $Destination -Inventory $Inventory
}

function Assert-MirrorMatchesInventory {
    param(
        [Parameter(Mandatory)][string]$MirrorRoot,
        [Parameter(Mandatory)][pscustomobject]$Inventory
    )
    if (-not (Test-Path -LiteralPath $MirrorRoot -PathType Container)) {
        throw "Mirror root is missing: $MirrorRoot"
    }
    $expected = @{}
    foreach ($entry in $Inventory.entries) { $expected[$entry.path.ToLowerInvariant()] = $entry }
    $actualFiles = @(Get-ChildItem -LiteralPath $MirrorRoot -Recurse -File -Force)
    if ($actualFiles.Count -ne $Inventory.fileCount) {
        throw "Mirror file count mismatch. expected=$($Inventory.fileCount) actual=$($actualFiles.Count)"
    }
    foreach ($file in $actualFiles) {
        $relative = [IO.Path]::GetRelativePath($MirrorRoot, $file.FullName).Replace('\', '/')
        $key = $relative.ToLowerInvariant()
        if (-not $expected.ContainsKey($key)) { throw "Unexpected mirror file: $relative" }
        $record = $expected[$key]
        if ([long]$file.Length -ne [long]$record.bytes) { throw "Mirror byte count mismatch: $relative" }
        if ((Get-FileSha256 -LiteralPath $file.FullName) -ne $record.sha256) { throw "Mirror SHA256 mismatch: $relative" }
        $expected.Remove($key)
    }
    if ($expected.Count -ne 0) { throw "Mirror files missing: $($expected.Keys -join ', ')" }
}

function Remove-ValidatedStagingDirectory {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$StagingPath
    )
    $resolved = Assert-ChildPath -Parent $Root -Child $StagingPath
    $leaf = Split-Path -Leaf $resolved
    if (-not $leaf.StartsWith('_staging-', [StringComparison]::Ordinal)) {
        throw "Refusing to remove non-staging directory: $resolved"
    }
    if (Test-Path -LiteralPath $resolved) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}

function Write-JsonAtomic {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][string]$LiteralPath
    )
    $directory = Split-Path -Parent $LiteralPath
    if (-not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
    $temporary = Join-Path $directory ('.tmp-' + [Guid]::NewGuid().ToString('N') + '.json')
    try {
        $json = $Value | ConvertTo-Json -Depth 100
        [IO.File]::WriteAllText($temporary, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporary -Destination $LiteralPath -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Write-TextAtomic {
    param(
        [Parameter(Mandatory)][string]$Value,
        [Parameter(Mandatory)][string]$LiteralPath
    )
    $directory = Split-Path -Parent $LiteralPath
    if (-not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
    $temporary = Join-Path $directory ('.tmp-' + [Guid]::NewGuid().ToString('N') + '.md')
    try {
        [IO.File]::WriteAllText($temporary, $Value, [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporary -Destination $LiteralPath -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Get-CompletenessAssessment {
    param([Parameter(Mandatory)][pscustomobject]$Inventory)
    $paths = @($Inventory.entries.path)
    $extensions = @($Inventory.entries.extension)
    $htmlCount = @($extensions | Where-Object { $_ -eq '.html' }).Count
    $jsCount = @($extensions | Where-Object { $_ -eq '.js' }).Count
    $cssCount = @($extensions | Where-Object { $_ -eq '.css' }).Count
    $assetCount = @($Inventory.entries | Where-Object { $_.extension -in @('.png', '.jpg', '.jpeg', '.webp', '.svg', '.mp4', '.webm', '.mp3', '.wav') }).Count
    $apiCount = @($paths | Where-Object { $_ -match '(^|/)api/' }).Count
    $brokenCount = @($Inventory.entries | Where-Object { $_.objectStorageErrorBody }).Count
    $htmlReferencingRuntimeConfig = @($Inventory.entries | Where-Object { $_.extension -eq '.html' -and $_.referencesRuntimeConfig -eq $true }).Count
    $runtimeConfigFileCount = @($paths | Where-Object { $_ -match '(^|/)runtime-config\.js$' }).Count
    $sourceCodeCount = @($extensions | Where-Object { $_ -in @('.ts', '.tsx', '.jsx', '.vue', '.svelte', '.py', '.go', '.rs', '.java', '.cs') }).Count
    $sourceMapCount = @($extensions | Where-Object { $_ -eq '.map' }).Count
    $hasPackageManifest = @($paths | Where-Object { $_ -match '(^|/)(package\.json|pnpm-lock\.yaml|yarn\.lock|package-lock\.json)$' }).Count -gt 0
    $hasDatabaseSchema = @($paths | Where-Object { $_ -match '(?i)(schema|migration|migrations|prisma|supabase)' }).Count -gt 0
    $hasServerSource = @($paths | Where-Object { $_ -match '^(server|backend|api-server|workers?)/' }).Count -gt 0
    $staticEvidenceScore = [math]::Min(100,
        14 +
        [math]::Min(20, $htmlCount) +
        [math]::Min(12, [math]::Floor(($jsCount + $cssCount) / 10)) +
        [math]::Min(10, [math]::Floor($assetCount / 8)) +
        [math]::Min(14, $apiCount * 2) +
        [math]::Min(8, @($paths | Where-Object { $_ -like 'docs/*' -or $_ -like '超级编导提示词包/*' }).Count)
    )
    $maintainableFrontendScore = if ($sourceCodeCount -gt 0 -and $hasPackageManifest) { 70 } elseif ($jsCount -gt 0 -and $htmlCount -gt 0) { 25 } else { 10 }
    $fullStackScore = if ($hasServerSource -and $hasDatabaseSchema -and $hasPackageManifest) { 70 } elseif ($apiCount -gt 0) { 10 } else { 5 }
    return [pscustomobject][ordered]@{
        observed = [ordered]@{
            htmlFiles = $htmlCount
            compiledJsFiles = $jsCount
            cssFiles = $cssCount
            capturedAssets = $assetCount
            capturedApiJsonFiles = $apiCount
            objectStorageErrorBodies = $brokenCount
            htmlFilesReferencingRuntimeConfig = $htmlReferencingRuntimeConfig
            runtimeConfigFileCount = $runtimeConfigFileCount
            runtimeConfigReferencedButMissingFromPackage = ($htmlReferencingRuntimeConfig -gt 0 -and $runtimeConfigFileCount -eq 0)
            sourceCodeFiles = $sourceCodeCount
            sourceMapFiles = $sourceMapCount
            hasPackageOrLockManifest = $hasPackageManifest
            hasDatabaseSchemaOrMigration = $hasDatabaseSchema
            hasServerOrWorkerSourceTree = $hasServerSource
        }
        scores = [ordered]@{
            staticBehaviorEvidence = $staticEvidenceScore
            maintainableFrontendSource = $maintainableFrontendScore
            completeFrontendAndBackendSource = $fullStackScore
            method = 'deterministic structural heuristic; scores do not substitute for runtime verification'
        }
        conclusion = '静态行为证据较丰富，但不是可维护的完整前后端源码；禁止全量覆盖主站。'
    }
}

function Get-PromptEvidenceSummary {
    param([Parameter(Mandatory)][pscustomobject]$Inventory)
    $promptFiles = @($Inventory.entries | Where-Object { $_.path -like '超级编导提示词包/*/底层提示词_还原版.md' })
    $metadataFiles = @($Inventory.entries | Where-Object { $_.path -like '超级编导提示词包/*/元数据.json' })
    $coreHashes = @($promptFiles | Where-Object { -not [string]::IsNullOrWhiteSpace($_.promptCoreSha256) } | Select-Object -ExpandProperty promptCoreSha256 -Unique)
    return [pscustomobject][ordered]@{
        promptWrapperCount = $promptFiles.Count
        metadataCount = $metadataFiles.Count
        extractedCoreHashCount = $coreHashes.Count
        extractedCoreSha256 = $coreHashes
        interpretation = if ($promptFiles.Count -eq 19 -and $coreHashes.Count -eq 1) {
            '19 个文件是技能变量包装，共用同一逆向主提示词核心；不能当作 19 份官方独立 system prompt。'
        }
        else {
            '提示词数量或核心一致性与旧审计不同，必须重新人工核对。'
        }
    }
}

function New-ProvisionalBaselineReport {
    param(
        [Parameter(Mandatory)][pscustomobject]$LegacyFinal,
        [Parameter(Mandatory)][pscustomobject]$LegacyV3,
        [Parameter(Mandatory)][object[]]$Documents,
        [Parameter(Mandatory)][pscustomobject]$Comparison
    )
    return [pscustomobject][ordered]@{
        schemaVersion = $script:SchemaVersion
        status = 'provisional-baseline-only'
        generatedAtUtc = [DateTime]::UtcNow.ToString('o')
        decisionBoundary = '用户已要求从对标站重新下载后再选择最终 primary；旧 final 与 v3 仅作为不可变基线，不能据此生成最终融合矩阵。'
        executionPolicy = 'isolated-evidence-only; never-run; never-overlay-product-source'
        legacyFinal = [ordered]@{
            sourcePath = $LegacyFinal.sourcePath
            packageSha256 = $LegacyFinal.packageSha256
            manifestSha256 = $LegacyFinal.manifestSha256
            archiveBytes = $LegacyFinal.archiveBytes
            entryCount = $LegacyFinal.entryCount
            fileCount = $LegacyFinal.fileCount
            uncompressedBytes = $LegacyFinal.uncompressedBytes
            entries = $LegacyFinal.entries
        }
        legacyV3 = [ordered]@{
            sourcePath = $LegacyV3.sourcePath
            packageSha256 = $LegacyV3.packageSha256
            manifestSha256 = $LegacyV3.manifestSha256
            archiveBytes = $LegacyV3.archiveBytes
            entryCount = $LegacyV3.entryCount
            fileCount = $LegacyV3.fileCount
            uncompressedBytes = $LegacyV3.uncompressedBytes
            entries = $LegacyV3.entries
        }
        comparison = $Comparison
        completeness = Get-CompletenessAssessment -Inventory $LegacyFinal
        promptEvidence = Get-PromptEvidenceSummary -Inventory $LegacyFinal
        supportingDocuments = $Documents
        finalDeliverablesGenerated = $false
        pending = @(
            '新抓取源路径',
            '新抓取源期望 SHA256 或目录 manifest SHA256',
            '新抓取源文件数与总字节数',
            '显式 ConfirmFreshPrimary'
        )
    }
}

function Get-RelationToBaseline {
    param(
        [Parameter(Mandatory)][pscustomobject]$Entry,
        [Parameter(Mandatory)][hashtable]$BaselineMap
    )
    if (-not $BaselineMap.ContainsKey($Entry.path)) { return 'fresh-primary-only' }
    if ($BaselineMap[$Entry.path].sha256 -eq $Entry.sha256) { return 'same-as-legacy-final' }
    return 'changed-from-legacy-final'
}

function New-FusionMatrixEntry {
    param(
        [Parameter(Mandatory)][pscustomobject]$Entry,
        [Parameter(Mandatory)][hashtable]$LegacyMap
    )
    return [pscustomobject][ordered]@{
        sourcePath = $Entry.path
        sha256 = $Entry.sha256
        bytes = $Entry.bytes
        artifactClass = $Entry.artifactClass
        evidenceGrade = $Entry.evidenceGrade
        relationToLegacyFinal = Get-RelationToBaseline -Entry $Entry -BaselineMap $LegacyMap
        mappedProductArea = $Entry.mappedProductArea
        intendedAction = $Entry.intendedAction
        statusAxes = [ordered]@{
            directMirrorReuse = '已从镜像直接复用'
            directMirrorReuseScope = '仅复制到 F 盘隔离证据库；未进入产品运行时'
            behaviorEquivalentImplementation = '尚未验证'
            backendVisibleEvidence = if ($Entry.artifactClass -eq 'rendered-admin-page' -and $Entry.path -match '/admin/assets\.html$') { '尚未验证；本次导航回到根页' } elseif ($Entry.artifactClass -in @('rendered-admin-page', 'captured-public-api-response')) { '已由后台正常可见证据补齐' } else { '不适用' }
            localEnhancement = '尚未验证'
            runtimeVerification = '尚未验证'
            externalCondition = '无；后续真实生成与生产验收另受费用授权和部署暂停约束'
            deployment = '未部署'
        }
        limitation = $Entry.limitation
    }
}

function New-PrimaryDeliverables {
    param(
        [Parameter(Mandatory)][pscustomobject]$Primary,
        [Parameter(Mandatory)][pscustomobject]$LegacyFinal,
        [Parameter(Mandatory)][pscustomobject]$LegacyV3,
        [Parameter(Mandatory)][object[]]$Documents
    )
    $legacyMap = @{}
    foreach ($entry in $LegacyFinal.entries) { $legacyMap[$entry.path] = $entry }
    $matrixEntries = @($Primary.entries | ForEach-Object { New-FusionMatrixEntry -Entry $_ -LegacyMap $legacyMap })
    $comparisonFinal = Get-ArchiveComparison -Left $Primary -Right $LegacyFinal -LeftLabel 'fresh-primary' -RightLabel 'legacy-final'
    $comparisonV3 = Get-ArchiveComparison -Left $Primary -Right $LegacyV3 -LeftLabel 'fresh-primary' -RightLabel 'legacy-v3'
    $generatedAt = [DateTime]::UtcNow.ToString('o')
    $identitySha = if ($Primary.sourceType -eq 'zip') { $Primary.packageSha256 } else { $Primary.manifestSha256 }

    $integrity = [pscustomobject][ordered]@{
        schemaVersion = $script:SchemaVersion
        status = 'fresh-primary-evidence-indexed'
        generatedAtUtc = $generatedAt
        sourceSelection = [ordered]@{
            primarySourceType = $Primary.sourceType
            primarySourcePath = $Primary.sourcePath
            primaryIdentitySha256 = $identitySha
            packageSha256 = $Primary.packageSha256
            manifestSha256 = $Primary.manifestSha256
            fileCount = $Primary.fileCount
            uncompressedBytes = $Primary.uncompressedBytes
            selectedBecause = '用户要求重新下载后重新拆解；调用者以期望哈希、文件数和显式 fresh 确认固定了本次主证据源。'
            legacyFinalIsPrimary = $false
        }
        safety = [ordered]@{
            pathTraversalRejected = $true
            absolutePathsRejected = $true
            caseInsensitiveCollisionsRejected = $true
            symbolicLinksAndReparsePointsRejected = $true
            windowsReservedNamesRejected = $true
            stagedThenAtomicallyRenamed = $true
            isolatedEvidenceOnly = $true
            executableStartupPerformed = $false
            productOverlayPerformed = $false
        }
        completeness = Get-CompletenessAssessment -Inventory $Primary
        promptEvidence = Get-PromptEvidenceSummary -Inventory $Primary
        comparisons = @($comparisonFinal, $comparisonV3)
        supportingDocuments = $Documents
        entries = $Primary.entries
    }

    $matrix = [pscustomobject][ordered]@{
        schemaVersion = $script:SchemaVersion
        status = 'fresh-primary-fusion-matrix'
        generatedAtUtc = $generatedAt
        boundary = '每个镜像文件只进入隔离证据库；产品融合必须在本站源码中按行为和合同独立实现并另行验证。'
        statusLegend = [ordered]@{
            '已从镜像直接复用' = '仅指隔离证据副本，绝不表示运行时源码复用。'
            '已依据镜像行为等价实现' = '必须由产品源码、合同测试和浏览器证据另行证明；本矩阵不自动授予此状态。'
            '已由后台正常可见证据补齐' = '必须有当前授权会话的后台读回证据；旧镜像快照不自动授予此状态。'
            '本站增强' = '超出对标行为且已在本站实现并验证的能力；本矩阵不自动授予此状态。'
            '尚未验证' = '静态证据存在，但运行行为、服务端、持久化或 UI 尚未形成当前证据闭环。'
            '受外部条件阻塞' = '需要费用授权、上游可用性、有效账户或生产环境才能完成。'
            '未部署' = '没有执行服务器部署或生产切换。'
        }
        counts = [ordered]@{
            files = $matrixEntries.Count
            directEvidenceCopies = @($matrixEntries | Where-Object { $_.statusAxes.directMirrorReuse -eq '已从镜像直接复用' }).Count
            behaviorEquivalentVerified = @($matrixEntries | Where-Object { $_.statusAxes.behaviorEquivalentImplementation -eq '已依据镜像行为等价实现' }).Count
            backendVisibleVerified = @($matrixEntries | Where-Object { $_.statusAxes.backendVisibleEvidence -eq '已由后台正常可见证据补齐' }).Count
            localEnhancementsVerified = @($matrixEntries | Where-Object { $_.statusAxes.localEnhancement -eq '本站增强' }).Count
            runtimeUnverified = @($matrixEntries | Where-Object { $_.statusAxes.runtimeVerification -eq '尚未验证' }).Count
            deployed = @($matrixEntries | Where-Object { $_.statusAxes.deployment -ne '未部署' }).Count
            undeployed = @($matrixEntries | Where-Object { $_.statusAxes.deployment -eq '未部署' }).Count
        }
        entries = $matrixEntries
    }

    $markdown = New-FusionMatrixMarkdown -Primary $Primary -Integrity $integrity -Matrix $matrix
    return [pscustomobject]@{ integrity = $integrity; matrix = $matrix; markdown = $markdown }
}

function ConvertTo-MarkdownCell {
    param([AllowEmptyString()][string]$Value)
    if ($null -eq $Value) { return '' }
    return $Value.Replace('|', '\|').Replace("`r", ' ').Replace("`n", ' ')
}

function New-FusionMatrixMarkdown {
    param(
        [Parameter(Mandatory)][pscustomobject]$Primary,
        [Parameter(Mandatory)][pscustomobject]$Integrity,
        [Parameter(Mandatory)][pscustomobject]$Matrix
    )
    $identity = if ($Primary.sourceType -eq 'zip') { $Primary.packageSha256 } else { $Primary.manifestSha256 }
    $builder = [Text.StringBuilder]::new()
    [void]$builder.AppendLine('# 茂隆掌柜 AI 镜像融合矩阵')
    [void]$builder.AppendLine()
    [void]$builder.AppendLine(('- 主证据源：`{0}`' -f $Primary.sourcePath))
    [void]$builder.AppendLine(('- 身份 SHA256：`{0}`' -f $identity))
    [void]$builder.AppendLine("- 文件数：$($Primary.fileCount)")
    [void]$builder.AppendLine("- 状态：新抓取源已建立逐文件索引；隔离证据已复用；产品等价实现仍按本站源码与验收证据分别判定。")
    [void]$builder.AppendLine("- 部署：未部署。付费真实生成：未执行。")
    [void]$builder.AppendLine()
    [void]$builder.AppendLine('## 完整度结论')
    [void]$builder.AppendLine()
    [void]$builder.AppendLine($Integrity.completeness.conclusion)
    [void]$builder.AppendLine()
    [void]$builder.AppendLine('| 维度 | 分数 |')
    [void]$builder.AppendLine('|---|---:|')
    [void]$builder.AppendLine("| 静态行为证据 | $($Integrity.completeness.scores.staticBehaviorEvidence)/100 |")
    [void]$builder.AppendLine("| 可维护前端源码 | $($Integrity.completeness.scores.maintainableFrontendSource)/100 |")
    [void]$builder.AppendLine("| 完整前后端源码 | $($Integrity.completeness.scores.completeFrontendAndBackendSource)/100 |")
    [void]$builder.AppendLine()
    [void]$builder.AppendLine('## 状态边界')
    [void]$builder.AppendLine()
    foreach ($property in $Matrix.statusLegend.GetEnumerator()) {
        [void]$builder.AppendLine("- **$($property.Key)**：$($property.Value)")
    }
    [void]$builder.AppendLine()
    [void]$builder.AppendLine('## 逐文件矩阵')
    [void]$builder.AppendLine()
    [void]$builder.AppendLine('| # | 镜像路径 | SHA256 | 类型 | 证据等级 | 与旧 final 关系 | 对应本站领域 | 处理 | 后台可见证据 | 运行验证 | 部署 |')
    [void]$builder.AppendLine('|---:|---|---|---|---|---|---|---|---|---|---|')
    $index = 0
    foreach ($entry in $Matrix.entries) {
        $index++
        $path = ConvertTo-MarkdownCell -Value $entry.sourcePath
        $mapped = ConvertTo-MarkdownCell -Value $entry.mappedProductArea
        $action = ConvertTo-MarkdownCell -Value $entry.intendedAction
        [void]$builder.AppendLine("| $index | ``$path`` | ``$($entry.sha256)`` | $($entry.artifactClass) | $($entry.evidenceGrade) | $($entry.relationToLegacyFinal) | $mapped | $action | $($entry.statusAxes.backendVisibleEvidence) | $($entry.statusAxes.runtimeVerification) | $($entry.statusAxes.deployment) |")
    }
    [void]$builder.AppendLine()
    [void]$builder.AppendLine('本表的“直接复用”只代表复制进隔离证据库；任何产品功能状态都必须由本站源码、确定性测试、数据库只读核对和真实浏览器验收另行证明。')
    return $builder.ToString()
}

function Assert-PrimaryArguments {
    param([Parameter(Mandatory)][pscustomobject]$Primary)
    if (-not $ConfirmFreshPrimary) { throw 'BuildPrimary/VerifyPrimary requires -ConfirmFreshPrimary.' }
    if ([string]::IsNullOrWhiteSpace($ExpectedPrimarySha256)) { throw 'ExpectedPrimarySha256 is required.' }
    if ($ExpectedPrimaryFileCount -le 0) { throw 'ExpectedPrimaryFileCount must be positive.' }
    if ($ExpectedPrimaryBytes -le 0) { throw 'ExpectedPrimaryBytes must be positive.' }
    $identity = if ($Primary.sourceType -eq 'zip') { $Primary.packageSha256 } else { $Primary.manifestSha256 }
    if ($identity -ne $ExpectedPrimarySha256.ToUpperInvariant()) {
        throw "Fresh primary identity mismatch. expected=$($ExpectedPrimarySha256.ToUpperInvariant()) actual=$identity"
    }
    if ($Primary.fileCount -ne $ExpectedPrimaryFileCount) {
        throw "Fresh primary file count mismatch. expected=$ExpectedPrimaryFileCount actual=$($Primary.fileCount)"
    }
    if ($Primary.uncompressedBytes -ne $ExpectedPrimaryBytes) {
        throw "Fresh primary byte count mismatch. expected=$ExpectedPrimaryBytes actual=$($Primary.uncompressedBytes)"
    }
    if ($identity -in @($script:LegacyFinalExpected.sha256, $script:LegacyV3Expected.sha256)) {
        throw 'Refusing to promote either legacy package as the fresh primary source.'
    }
}

function Initialize-Baseline {
    param(
        [Parameter(Mandatory)][pscustomobject]$LegacyFinal,
        [Parameter(Mandatory)][pscustomobject]$LegacyV3
    )
    if (-not (Test-Path -LiteralPath $IsolationRoot)) { New-Item -ItemType Directory -Path $IsolationRoot -Force | Out-Null }
    $baselineRoot = Join-Path $IsolationRoot 'baseline'
    if (Test-Path -LiteralPath $baselineRoot) {
        Assert-BaselinePayload -LegacyFinal $LegacyFinal -LegacyV3 $LegacyV3
        return
    }

    $stage = Join-Path $IsolationRoot ('_staging-baseline-' + [Guid]::NewGuid().ToString('N'))
    try {
        New-Item -ItemType Directory -Path $stage -Force | Out-Null
        $mirrorRoot = Join-Path $stage 'legacy-final\mirror'
        Expand-SafeZip -Inventory $LegacyFinal -Destination $mirrorRoot

        $archiveRoot = Join-Path $stage 'source-archives'
        New-Item -ItemType Directory -Path $archiveRoot -Force | Out-Null
        Copy-Item -LiteralPath $LegacyFinal.sourcePath -Destination (Join-Path $archiveRoot 'maolong_final.zip')
        Copy-Item -LiteralPath $LegacyV3.sourcePath -Destination (Join-Path $archiveRoot 'maolong_mirror_v3.zip')

        $documentRoot = Join-Path $stage 'supporting-documents'
        New-Item -ItemType Directory -Path $documentRoot -Force | Out-Null
        foreach ($document in $script:SupportingDocuments) {
            if (-not (Test-Path -LiteralPath $document.sourcePath -PathType Leaf)) { throw "Missing supporting document: $($document.sourcePath)" }
            Copy-Item -LiteralPath $document.sourcePath -Destination (Join-Path $documentRoot $document.name)
        }
        $documentRecords = Get-SupportingDocumentRecords -CopiedRoot $documentRoot
        $provenance = [pscustomobject][ordered]@{
            schemaVersion = $script:SchemaVersion
            status = 'immutable-legacy-baseline'
            createdAtUtc = [DateTime]::UtcNow.ToString('o')
            legacyFinal = [ordered]@{ packageSha256 = $LegacyFinal.packageSha256; manifestSha256 = $LegacyFinal.manifestSha256; fileCount = $LegacyFinal.fileCount; uncompressedBytes = $LegacyFinal.uncompressedBytes }
            legacyV3 = [ordered]@{ packageSha256 = $LegacyV3.packageSha256; manifestSha256 = $LegacyV3.manifestSha256; fileCount = $LegacyV3.fileCount; uncompressedBytes = $LegacyV3.uncompressedBytes }
            supportingDocuments = $documentRecords
            executableStartupPerformed = $false
            productOverlayPerformed = $false
        }
        Write-JsonAtomic -Value $provenance -LiteralPath (Join-Path $stage '_provenance.json')
        Move-Item -LiteralPath $stage -Destination $baselineRoot
    }
    catch {
        if (Test-Path -LiteralPath $stage) { Remove-ValidatedStagingDirectory -Root $IsolationRoot -StagingPath $stage }
        throw
    }
    Assert-BaselinePayload -LegacyFinal $LegacyFinal -LegacyV3 $LegacyV3
}

function Assert-BaselinePayload {
    param(
        [Parameter(Mandatory)][pscustomobject]$LegacyFinal,
        [Parameter(Mandatory)][pscustomobject]$LegacyV3
    )
    $baselineRoot = Join-Path $IsolationRoot 'baseline'
    if (-not (Test-Path -LiteralPath $baselineRoot -PathType Container)) { throw "Baseline is missing: $baselineRoot" }
    Assert-MirrorMatchesInventory -MirrorRoot (Join-Path $baselineRoot 'legacy-final\mirror') -Inventory $LegacyFinal
    $finalCopy = Join-Path $baselineRoot 'source-archives\maolong_final.zip'
    $v3Copy = Join-Path $baselineRoot 'source-archives\maolong_mirror_v3.zip'
    if ((Get-FileSha256 -LiteralPath $finalCopy) -ne $LegacyFinal.packageSha256) { throw 'Archived legacy final SHA mismatch.' }
    if ((Get-FileSha256 -LiteralPath $v3Copy) -ne $LegacyV3.packageSha256) { throw 'Archived legacy v3 SHA mismatch.' }
    [void](Get-SupportingDocumentRecords -CopiedRoot (Join-Path $baselineRoot 'supporting-documents'))
    $provenancePath = Join-Path $baselineRoot '_provenance.json'
    if (-not (Test-Path -LiteralPath $provenancePath -PathType Leaf)) { throw 'Baseline provenance is missing.' }
}

function Initialize-Primary {
    param([Parameter(Mandatory)][pscustomobject]$Primary)
    if (-not (Test-Path -LiteralPath $IsolationRoot)) { New-Item -ItemType Directory -Path $IsolationRoot -Force | Out-Null }
    $primaryRoot = Join-Path $IsolationRoot 'primary'
    if (Test-Path -LiteralPath $primaryRoot) {
        Assert-PrimaryPayload -Primary $Primary
        return
    }
    $stage = Join-Path $IsolationRoot ('_staging-primary-' + [Guid]::NewGuid().ToString('N'))
    try {
        New-Item -ItemType Directory -Path $stage -Force | Out-Null
        $mirrorRoot = Join-Path $stage 'mirror'
        if ($Primary.sourceType -eq 'zip') {
            Expand-SafeZip -Inventory $Primary -Destination $mirrorRoot
            $packageRoot = Join-Path $stage 'source-package'
            New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null
            Copy-Item -LiteralPath $Primary.sourcePath -Destination (Join-Path $packageRoot (Split-Path -Leaf $Primary.sourcePath))
        }
        else {
            Copy-SafeDirectory -Inventory $Primary -Destination $mirrorRoot
        }
        $provenance = [pscustomobject][ordered]@{
            schemaVersion = $script:SchemaVersion
            status = 'fresh-primary-evidence'
            createdAtUtc = [DateTime]::UtcNow.ToString('o')
            sourceType = $Primary.sourceType
            originalSourcePath = $Primary.sourcePath
            packageSha256 = $Primary.packageSha256
            manifestSha256 = $Primary.manifestSha256
            fileCount = $Primary.fileCount
            uncompressedBytes = $Primary.uncompressedBytes
            executableStartupPerformed = $false
            productOverlayPerformed = $false
        }
        Write-JsonAtomic -Value $provenance -LiteralPath (Join-Path $stage '_provenance.json')
        Move-Item -LiteralPath $stage -Destination $primaryRoot
    }
    catch {
        if (Test-Path -LiteralPath $stage) { Remove-ValidatedStagingDirectory -Root $IsolationRoot -StagingPath $stage }
        throw
    }
    Assert-PrimaryPayload -Primary $Primary
}

function Assert-PrimaryPayload {
    param([Parameter(Mandatory)][pscustomobject]$Primary)
    $primaryRoot = Join-Path $IsolationRoot 'primary'
    if (-not (Test-Path -LiteralPath $primaryRoot -PathType Container)) { throw "Primary evidence is missing: $primaryRoot" }
    Assert-MirrorMatchesInventory -MirrorRoot (Join-Path $primaryRoot 'mirror') -Inventory $Primary
    $provenancePath = Join-Path $primaryRoot '_provenance.json'
    if (-not (Test-Path -LiteralPath $provenancePath -PathType Leaf)) { throw 'Primary provenance is missing.' }
    $provenance = Get-Content -LiteralPath $provenancePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($provenance.manifestSha256 -ne $Primary.manifestSha256) { throw 'Primary provenance manifest SHA mismatch.' }
    if ($Primary.sourceType -eq 'zip') {
        $packageFiles = @(Get-ChildItem -LiteralPath (Join-Path $primaryRoot 'source-package') -File)
        if ($packageFiles.Count -ne 1 -or (Get-FileSha256 -LiteralPath $packageFiles[0].FullName) -ne $Primary.packageSha256) {
            throw 'Primary source package copy does not match.'
        }
    }
}

function Write-ProvisionalReport {
    param(
        [Parameter(Mandatory)][pscustomobject]$LegacyFinal,
        [Parameter(Mandatory)][pscustomobject]$LegacyV3
    )
    $documentRoot = Join-Path $IsolationRoot 'baseline\supporting-documents'
    $documents = Get-SupportingDocumentRecords -CopiedRoot $documentRoot
    $comparison = Get-ArchiveComparison -Left $LegacyFinal -Right $LegacyV3 -LeftLabel 'legacy-final-candidate' -RightLabel 'legacy-v3'
    $report = New-ProvisionalBaselineReport -LegacyFinal $LegacyFinal -LegacyV3 $LegacyV3 -Documents $documents -Comparison $comparison
    $path = Join-Path $OutputDirectory '旧镜像基线完整性清单.provisional.json'
    Write-JsonAtomic -Value $report -LiteralPath $path

    $note = @"
# 旧镜像基线说明（provisional）

- 旧 `maolong_final.zip`：$($LegacyFinal.fileCount) 文件，SHA256 `$($LegacyFinal.packageSha256)`。
- 旧 `maolong_mirror_v3.zip`：$($LegacyV3.fileCount) 文件，SHA256 `$($LegacyV3.packageSha256)`。
- 共同路径：$($comparison.commonCount)；字节一致：$($comparison.identicalCount)；变化：$($comparison.changedCount)；旧 final 独有：$($comparison.leftOnlyCount)；v3 独有：$($comparison.rightOnlyCount)。
- 六份独立资料已按原字节复制并逐份计算 SHA256。
- 该批次只作为旧基线，未选为最终 primary，未生成 `镜像源码完整性清单.json`、`镜像融合矩阵.json`、`镜像融合矩阵.md`。
- 镜像未启动、未覆盖主站、未部署、未触发付费生成。

等待新抓取源、期望 SHA256、文件数和总字节数后，使用 `BuildPrimary -ConfirmFreshPrimary` 生成最终三份交付物。
"@
    Write-TextAtomic -Value $note -LiteralPath (Join-Path $OutputDirectory '旧镜像基线说明.provisional.md')
    return $path
}

function Write-PrimaryDeliverables {
    param(
        [Parameter(Mandatory)][pscustomobject]$Primary,
        [Parameter(Mandatory)][pscustomobject]$LegacyFinal,
        [Parameter(Mandatory)][pscustomobject]$LegacyV3
    )
    $documents = Get-SupportingDocumentRecords -CopiedRoot (Join-Path $IsolationRoot 'baseline\supporting-documents')
    $result = New-PrimaryDeliverables -Primary $Primary -LegacyFinal $LegacyFinal -LegacyV3 $LegacyV3 -Documents $documents
    Write-JsonAtomic -Value $result.integrity -LiteralPath (Join-Path $OutputDirectory '镜像源码完整性清单.json')
    Write-JsonAtomic -Value $result.matrix -LiteralPath (Join-Path $OutputDirectory '镜像融合矩阵.json')
    Write-TextAtomic -Value $result.markdown -LiteralPath (Join-Path $OutputDirectory '镜像融合矩阵.md')
}

function Assert-PrimaryDeliverables {
    param([Parameter(Mandatory)][pscustomobject]$Primary)
    $integrityPath = Join-Path $OutputDirectory '镜像源码完整性清单.json'
    $matrixPath = Join-Path $OutputDirectory '镜像融合矩阵.json'
    $markdownPath = Join-Path $OutputDirectory '镜像融合矩阵.md'
    foreach ($path in @($integrityPath, $matrixPath, $markdownPath)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing delivery artifact: $path" }
    }
    $integrity = Get-Content -LiteralPath $integrityPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $matrix = Get-Content -LiteralPath $matrixPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (@($integrity.entries).Count -ne $Primary.fileCount) { throw 'Integrity entry count mismatch.' }
    if (@($matrix.entries).Count -ne $Primary.fileCount) { throw 'Matrix entry count mismatch.' }
    $integrityPaths = @($integrity.entries | Select-Object -ExpandProperty path)
    $matrixPaths = @($matrix.entries | Select-Object -ExpandProperty sourcePath)
    if (@($integrityPaths | Sort-Object -Unique).Count -ne $Primary.fileCount) { throw 'Integrity paths are not unique.' }
    if (@($matrixPaths | Sort-Object -Unique).Count -ne $Primary.fileCount) { throw 'Matrix paths are not unique.' }
    $expectedPaths = @($Primary.entries.path | Sort-Object)
    if ((Get-StringSha256 -Value (($integrityPaths | Sort-Object) -join "`n")) -ne (Get-StringSha256 -Value ($expectedPaths -join "`n"))) {
        throw 'Integrity path set differs from primary source.'
    }
    if ((Get-StringSha256 -Value (($matrixPaths | Sort-Object) -join "`n")) -ne (Get-StringSha256 -Value ($expectedPaths -join "`n"))) {
        throw 'Matrix path set differs from primary source.'
    }
    foreach ($entry in $matrix.entries) {
        if ($entry.statusAxes.directMirrorReuse -ne '已从镜像直接复用' -or
            $entry.statusAxes.runtimeVerification -ne '尚未验证' -or
            $entry.statusAxes.deployment -ne '未部署') {
            throw "Matrix status-axis contract failed: $($entry.sourcePath)"
        }
    }
}

$legacyFinal = Get-ZipInventory -LiteralPath $LegacyFinalArchivePath
$legacyV3 = Get-ZipInventory -LiteralPath $LegacyV3ArchivePath
[void](Assert-LegacyIdentity -Inventory $legacyFinal -Expected $script:LegacyFinalExpected -Label 'legacy final')
[void](Assert-LegacyIdentity -Inventory $legacyV3 -Expected $script:LegacyV3Expected -Label 'legacy v3')

switch ($Mode) {
    'ArchiveBaseline' {
        Initialize-Baseline -LegacyFinal $legacyFinal -LegacyV3 $legacyV3
        $reportPath = Write-ProvisionalReport -LegacyFinal $legacyFinal -LegacyV3 $legacyV3
        [pscustomobject][ordered]@{
            ok = $true
            mode = $Mode
            status = 'provisional-baseline-only'
            isolationRoot = $IsolationRoot
            reportPath = $reportPath
            finalDeliverablesGenerated = $false
        } | ConvertTo-Json -Depth 5
    }
    'VerifyBaseline' {
        Assert-BaselinePayload -LegacyFinal $legacyFinal -LegacyV3 $legacyV3
        [pscustomobject][ordered]@{
            ok = $true
            mode = $Mode
            status = 'legacy-baseline-verified'
            legacyFinalSha256 = $legacyFinal.packageSha256
            legacyV3Sha256 = $legacyV3.packageSha256
            filesVerified = $legacyFinal.fileCount
        } | ConvertTo-Json -Depth 5
    }
    'InspectPrimary' {
        if ([string]::IsNullOrWhiteSpace($PrimarySourcePath)) { throw 'PrimarySourcePath is required.' }
        $primary = Get-SourceInventory -LiteralPath $PrimarySourcePath
        $identity = if ($primary.sourceType -eq 'zip') { $primary.packageSha256 } else { $primary.manifestSha256 }
        [pscustomobject][ordered]@{
            ok = $true
            mode = $Mode
            readOnly = $true
            sourceType = $primary.sourceType
            sourcePath = $primary.sourcePath
            expectedPrimarySha256 = $identity
            packageSha256 = $primary.packageSha256
            manifestSha256 = $primary.manifestSha256
            expectedPrimaryFileCount = $primary.fileCount
            expectedPrimaryBytes = $primary.uncompressedBytes
            freshCandidate = ($identity -notin @($script:LegacyFinalExpected.sha256, $script:LegacyV3Expected.sha256))
            objectStorageErrorBodies = @($primary.entries | Where-Object { $_.objectStorageErrorBody }).Count
            runtimeConfigReferencedButMissing = (Get-CompletenessAssessment -Inventory $primary).observed.runtimeConfigReferencedButMissingFromPackage
        } | ConvertTo-Json -Depth 5
    }
    'BuildPrimary' {
        if ([string]::IsNullOrWhiteSpace($PrimarySourcePath)) { throw 'PrimarySourcePath is required.' }
        Initialize-Baseline -LegacyFinal $legacyFinal -LegacyV3 $legacyV3
        $primary = Get-SourceInventory -LiteralPath $PrimarySourcePath
        Assert-PrimaryArguments -Primary $primary
        Initialize-Primary -Primary $primary
        Write-PrimaryDeliverables -Primary $primary -LegacyFinal $legacyFinal -LegacyV3 $legacyV3
        Assert-PrimaryDeliverables -Primary $primary
        [pscustomobject][ordered]@{
            ok = $true
            mode = $Mode
            status = 'fresh-primary-deliverables-built-and-verified'
            primaryManifestSha256 = $primary.manifestSha256
            primaryPackageSha256 = $primary.packageSha256
            fileCount = $primary.fileCount
            outputDirectory = $OutputDirectory
            deployed = $false
        } | ConvertTo-Json -Depth 5
    }
    'VerifyPrimary' {
        if ([string]::IsNullOrWhiteSpace($PrimarySourcePath)) { throw 'PrimarySourcePath is required.' }
        $primary = Get-SourceInventory -LiteralPath $PrimarySourcePath
        Assert-PrimaryArguments -Primary $primary
        Assert-BaselinePayload -LegacyFinal $legacyFinal -LegacyV3 $legacyV3
        Assert-PrimaryPayload -Primary $primary
        Assert-PrimaryDeliverables -Primary $primary
        [pscustomobject][ordered]@{
            ok = $true
            mode = $Mode
            status = 'fresh-primary-evidence-and-deliverables-verified'
            primaryManifestSha256 = $primary.manifestSha256
            fileCount = $primary.fileCount
            deployed = $false
        } | ConvertTo-Json -Depth 5
    }
}
