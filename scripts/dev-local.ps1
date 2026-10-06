param(
  [int]$Port = 5000,
  [switch]$Restart
)

$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$nextCli = Join-Path $projectRoot "node_modules\next\dist\bin\next"
$bundledNode = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$localProxy = "http://127.0.0.1:7897"
$aidBridgeRoot = Join-Path $projectRoot "..\..\算力仓库\05_API适配器\aid-main-bridge"
$aidInitializeScript = Join-Path $aidBridgeRoot "scripts\initialize-aid-local-runtime.ps1"
$aidStartScript = Join-Path $aidBridgeRoot "scripts\start-aid-local-stack.ps1"

function Resolve-NodeExecutable {
  $systemNode = Get-Command node -ErrorAction SilentlyContinue
  if ($systemNode) {
    return $systemNode.Source
  }
  if (Test-Path -LiteralPath $bundledNode) {
    return $bundledNode
  }
  throw "Node.js was not found. Install Node.js or verify the Codex bundled runtime."
}

function Add-NodeToProcessPath([string]$NodeExecutable) {
  $nodeDirectory = Split-Path -Parent $NodeExecutable
  $processPath = [Environment]::GetEnvironmentVariable("Path", "Process")
  $pathEntries = @($processPath -split ";")

  # The pnpm fallback wrapper can launch with node.exe absent from PATH. Next
  # and native dependency scripts still invoke `node` by name, so descendants
  # must inherit the resolved runtime directory.
  if (-not ($pathEntries -contains $nodeDirectory)) {
    [Environment]::SetEnvironmentVariable("Path", "$nodeDirectory;$processPath", "Process")
  }
}

function Get-ProjectDriveFileSystem {
  $qualifier = Split-Path -Qualifier $projectRoot
  if ($qualifier -match "^([A-Za-z]):$") {
    try {
      $volume = Get-Volume -DriveLetter $Matches[1] -ErrorAction Stop
      return [string]$volume.FileSystem
    } catch {
      return ""
    }
  }
  return ""
}

function Get-LocalListener {
  $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($listener) {
    return $listener
  }

  # Get-NetTCPConnection can return no rows in a restricted Codex sandbox even
  # though the socket is listening. netstat remains readable in that case.
  $line = netstat -ano -p tcp |
    Select-String -Pattern "^\s*TCP\s+\S+:$Port\s+\S+\s+LISTENING\s+(\d+)\s*$" |
    Select-Object -First 1
  if ($line -and $line.Matches.Count -gt 0) {
    return [pscustomobject]@{ OwningProcess = [int]$line.Matches[0].Groups[1].Value }
  }
  return $null
}

function Test-ProjectProcess([int]$ProcessId) {
  # Win32_Process command-line inspection is denied in some Codex sandbox
  # sessions. Confirm both the process type and this app's unique page title.
  $basicProcess = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if (-not $basicProcess -or $basicProcess.ProcessName -ne "node") {
    return $false
  }
  try {
    $homeResponse = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 8
    # Keep the marker ASCII-only so this script also works in Windows
    # PowerShell 5.1, which may read a BOM-less UTF-8 file as ANSI.
    return ($homeResponse.StatusCode -eq 200 -and $homeResponse.Content -match "<title>AI.*?</title>")
  } catch {
    # A recoverable compilation error can make the homepage return 500. The
    # development build manifest still uniquely identifies this Next service,
    # allowing -Restart to repair it without misclassifying the port owner.
    try {
      $manifestResponse = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/_next/static/development/_buildManifest.js" -UseBasicParsing -TimeoutSec 8
      return ($manifestResponse.StatusCode -eq 200 -and $manifestResponse.Content -match "__BUILD_MANIFEST")
    } catch {
      return $false
    }
  }
}

function Test-Endpoint([string]$Path) {
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port$Path" -UseBasicParsing -TimeoutSec 8
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Test-JsonArrayCount([string]$Path, [string]$PropertyName, [int]$MinCount = 1) {
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port$Path" -UseBasicParsing -TimeoutSec 8
    if ($response.StatusCode -ne 200) {
      return $false
    }
    $data = $response.Content | ConvertFrom-Json
    $items = $data.$PropertyName
    return ($items -and $items.Count -ge $MinCount)
  } catch {
    return $false
  }
}

function Get-LocalEnvValue([string]$Name) {
  $processValue = [Environment]::GetEnvironmentVariable($Name, "Process")
  if ($processValue) { return $processValue.Trim() }

  $envFile = Join-Path $projectRoot ".env.local"
  if (-not (Test-Path -LiteralPath $envFile)) { return $null }
  $escapedName = [Regex]::Escape($Name)
  foreach ($line in Get-Content -LiteralPath $envFile) {
    if ($line -match "^\s*$escapedName\s*=\s*(.*)\s*$") {
      return $Matches[1].Trim().Trim('"').Trim("'")
    }
  }
  return $null
}

function Test-AidLocalStackReady {
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:4332/health/ready" -TimeoutSec 3
    return $health.status -eq "ready"
  } catch {
    return $false
  }
}

function Start-AidLocalIntegration {
  if ((Get-LocalEnvValue "AID_INTEGRATION_ENABLED") -ne "true") { return }
  if (Test-AidLocalStackReady) {
    Write-Host "AID integration stack is already ready."
    return
  }

  if (-not (Test-Path -LiteralPath $aidInitializeScript) -or -not (Test-Path -LiteralPath $aidStartScript)) {
    Write-Warning "AID integration is enabled, but its local startup scripts are missing. The main site will start without the AID shortcut."
    return
  }

  try {
    & $aidInitializeScript | ForEach-Object { Write-Host $_ }
    $aidPortsInUse = @(8080, 4330, 4332) | Where-Object {
      Get-NetTCPConnection -State Listen -LocalPort $_ -ErrorAction SilentlyContinue
    }
    if ($aidPortsInUse.Count -gt 0) {
      & $aidStartScript -Restart | ForEach-Object { Write-Host $_ }
    } else {
      & $aidStartScript | ForEach-Object { Write-Host $_ }
    }
    if (-not (Test-AidLocalStackReady)) { throw "AID readiness did not recover" }
  } catch {
    Write-Warning "AID startup failed: $($_.Exception.Message). The main site will remain available and hide the AID shortcut."
  }
}

Start-AidLocalIntegration

$listener = Get-LocalListener
if ($listener) {
  if (-not (Test-ProjectProcess -ProcessId $listener.OwningProcess)) {
    throw "Port $Port is owned by another project (PID $($listener.OwningProcess)). Startup stopped safely."
  }

  if (-not $Restart -and (Test-Endpoint "/")) {
    Write-Host "Local sandbox is running: http://127.0.0.1:$Port/"
    Write-Host "Source changes are synchronized through HMR; no restart is needed."
    exit 0
  }

  Stop-Process -Id $listener.OwningProcess -Force
  for ($i = 0; $i -lt 20 -and (Get-LocalListener); $i++) {
    Start-Sleep -Milliseconds 250
  }
}

if (-not (Test-Path -LiteralPath $nextCli)) {
  throw "Next.js dependencies are missing. Install dependencies in the project directory first."
}

$nodeExe = Resolve-NodeExecutable
Add-NodeToProcessPath -NodeExecutable $nodeExe

$backupRefresher = Join-Path $projectRoot "scripts\ensure-local-backup.mjs"
if ($env:ENABLE_LOCAL_BACKUP_SNAPSHOT -eq "1" -and (Test-Path -LiteralPath $backupRefresher)) {
  & $nodeExe $backupRefresher $projectRoot
}

# Codex may intentionally block direct child-process network access while the
# desktop's local proxy remains available. Node 24 does not use HTTP(S)_PROXY
# for fetch unless NODE_USE_ENV_PROXY is enabled. Without these three values,
# login may appear to work from a stale local fallback while bots, settings,
# conversations, and admin privileges all disappear.
$proxyListening = netstat -ano -p tcp | Select-String -Pattern "^\s*TCP\s+127\.0\.0\.1:7897\s+\S+\s+LISTENING\s+\d+\s*$" | Select-Object -First 1
if ($proxyListening) {
  $env:HTTP_PROXY = $localProxy
  $env:HTTPS_PROXY = $localProxy
  $env:NODE_USE_ENV_PROXY = "1"
  Write-Host "Using the desktop proxy for cloud database access."
}

$logDir = Join-Path $projectRoot ".next"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$projectFileSystem = Get-ProjectDriveFileSystem
$devBundlerArg = ""
if ($projectFileSystem -and $projectFileSystem -ne "NTFS") {
  # Next 16 uses Turbopack by default. Turbopack creates junctions under
  # .next/dev/node_modules, which fails on exFAT/mobile drives with
  # "failed to create junction point ... os error 1". Use webpack for
  # non-NTFS project roots so the F-drive storage source can still run.
  $devBundlerArg = " --webpack"
  Write-Host "Project filesystem is $projectFileSystem; using Next webpack dev mode."
}
$arguments = "`"$nextCli`" dev$devBundlerArg -p $Port"

# PowerShell 5.1 Start-Process fails in some Codex desktop sessions when the
# host exposes both Path and PATH. cmd.exe start avoids rebuilding that
# case-insensitive environment dictionary and has proved stable here.
$commandLine = 'start "" /min "{0}" "{1}" dev{2} -p {3}' -f $nodeExe, $nextCli, $devBundlerArg, $Port
& $env:ComSpec /d /c $commandLine

$ready = $false
for ($i = 0; $i -lt 60; $i++) {
  # A usable local sandbox needs both the page and the shared cloud data. Do
  # not report a false success when only the static shell is available.
  if (
    (Test-Endpoint "/") -and
    (Test-Endpoint "/api/settings") -and
    (Test-JsonArrayCount "/api/bots" "bots" 1) -and
    (Test-JsonArrayCount "/api/nav-items" "navItems" 1) -and
    (Test-JsonArrayCount "/api/shortcuts" "shortcuts" 1) -and
    (Test-JsonArrayCount "/api/chat-models" "models" 1)
  ) {
    $ready = $true
    break
  }
  Start-Sleep -Seconds 1
}

if (-not $ready) {
  throw "Local sandbox startup failed. Run the script interactively to inspect Next.js startup output."
}

$activeListener = Get-LocalListener
Write-Host "Local sandbox is ready: http://127.0.0.1:$Port/"
Write-Host "Listener PID: $($activeListener.OwningProcess)"
Write-Host "Home and realtime data endpoints passed health checks."
Write-Host "Source changes are synchronized to the sandbox through HMR."
