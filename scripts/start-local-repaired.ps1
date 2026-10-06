[CmdletBinding()]
param(
    [switch]$Check
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$taskProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskExpectedRoot = 'F:\总项目文件\Skill存储系统\01_网页开发项目\自媒体操盘手\当前版本'
$taskDataRoot = 'F:\总项目文件\Skill存储系统\运行数据\自媒体操盘手\local-data-20260902'
$taskDataStarter = 'F:\tools\zimeiti-local-data\scripts\Start-LocalData.ps1'
$taskNode = 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$taskPreview = Join-Path $taskProjectRoot 'scripts\start-local-data-preview.mjs'

function Test-RepairedPreviewPortAvailable {
    # Read listener state only. Never stop a process or temporarily bind port 5000.
    try {
        $taskListeners = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
        return @($taskListeners | Where-Object { $_.Port -eq 5000 }).Count -eq 0
    } catch {
        throw 'Cannot verify port 5000 availability. No services were started or stopped.'
    }
}

function Assert-RepairedPreviewPortAvailable {
    if (-not (Test-RepairedPreviewPortAvailable)) {
        throw 'Port 5000 is already in use. Stop the known preview explicitly, then retry. This script does not stop existing processes.'
    }
}

try {
    if (-not [string]::Equals($taskProjectRoot, $taskExpectedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'This starter must run from the verified F-drive project. No fallback project or database is allowed.'
    }

    $taskRuntimeFile = Join-Path $taskDataRoot 'config\runtime.json'
    $taskInitializedFile = Join-Path $taskDataRoot 'config\initialized.json'
    $taskPgVersionFile = Join-Path $taskDataRoot 'pgdata\PG_VERSION'
    $taskRequiredFiles = @(
        $taskNode, $taskDataStarter, $taskPreview, $taskRuntimeFile,
        $taskInitializedFile, $taskPgVersionFile,
        (Join-Path $taskDataRoot 'config\postgrest.conf')
    )
    foreach ($taskFile in $taskRequiredFiles) {
        if (-not (Test-Path -LiteralPath $taskFile -PathType Leaf)) {
            throw 'The existing local runtime is incomplete. Initialization or repair is intentionally not attempted.'
        }
    }

    # Start-LocalData calls its idempotent init entry before start. Require its
    # completion marker and existing cluster first so it cannot create a new DB.
    try {
        $taskRuntime = Get-Content -LiteralPath $taskRuntimeFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $taskInitialized = Get-Content -LiteralPath $taskInitializedFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $taskPgVersion = (Get-Content -LiteralPath $taskPgVersionFile -Raw -Encoding UTF8).Trim()
        if ([string]::IsNullOrWhiteSpace($taskRuntime.instanceId) -or
            $taskRuntime.instanceId -ne $taskInitialized.instanceId -or $taskPgVersion -ne '15') {
            throw 'identity mismatch'
        }
    } catch {
        # JSON errors may contain private file content; only emit a fixed error.
        throw 'The existing local database identity could not be verified. No initialization was attempted.'
    } finally {
        $taskRuntime = $null
        $taskInitialized = $null
    }

    # This validates loopback 54322/zimeiti_local and REST 54321 without starting
    # a process or connecting to any database. Credentials remain in memory.
    & $taskNode $taskPreview '--check' '--port=5000'
    if ($LASTEXITCODE -ne 0) {
        throw 'Local preview configuration validation failed. No services were started.'
    }

    if ($Check) {
        [pscustomobject]@{
            valid = $true
            existingLocalDatabase = $true
            port = 5000
            portAvailable = (Test-RepairedPreviewPortAvailable)
            started = $false
        } | ConvertTo-Json -Compress
        exit 0
    }

    Assert-RepairedPreviewPortAvailable
    Write-Host '[local-repaired] Starting the existing local database services.'
    # The verified starter uses Node windowsHide for all background processes.
    # It preserves the existing cluster; this wrapper never installs or migrates.
    & $taskDataStarter
    if ($LASTEXITCODE -ne 0) {
        throw 'The existing local database services failed to start. The website was not started.'
    }

    # Check again in case another preview claimed 5000 during database startup.
    Assert-RepairedPreviewPortAvailable
    Write-Host '[local-repaired] Opening development preview at http://127.0.0.1:5000/ (Ctrl+C stops this preview).'
    & $taskNode $taskPreview '--port=5000'
    exit $LASTEXITCODE
} catch {
    Write-Error ('[local-repaired] ' + $_.Exception.Message) -ErrorAction Continue
    exit 1
}
