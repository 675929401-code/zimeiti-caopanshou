param(
  [int]$Port = 5000,
  [int]$IntervalSeconds = 5,
  [switch]$Once
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$starter = Join-Path $projectRoot "scripts\dev-local.ps1"
$logDir = Join-Path $projectRoot ".logs"
$logFile = Join-Path $logDir "local-dev-supervisor.log"

New-Item -ItemType Directory -Path $logDir -Force | Out-Null

function Write-SupervisorLog([string]$Message) {
  if ((Test-Path -LiteralPath $logFile) -and ((Get-Item -LiteralPath $logFile).Length -gt 2MB)) {
    Move-Item -LiteralPath $logFile -Destination ($logFile + ".1") -Force
  }
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
  Write-Host $line
}

function Get-LocalListener {
  $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($listener) { return $listener }

  $line = netstat -ano -p tcp |
    Select-String -Pattern "^\s*TCP\s+\S+:$Port\s+\S+\s+LISTENING\s+(\d+)\s*$" |
    Select-Object -First 1
  if ($line -and $line.Matches.Count -gt 0) {
    return [pscustomobject]@{ OwningProcess = [int]$line.Matches[0].Groups[1].Value }
  }
  return $null
}

function Test-Endpoint([string]$Path) {
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port$Path" -UseBasicParsing -TimeoutSec 8
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Test-Healthy {
  return (Test-Endpoint "/api/health?liveness=true") -and (Test-Endpoint "/")
}

function Invoke-Recovery([switch]$Restart) {
  if (-not (Test-Path -LiteralPath $starter)) {
    throw "Missing local starter: $starter"
  }

  $arguments = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", $starter,
    "-Port", "$Port"
  )
  if ($Restart) { $arguments += "-Restart" }

  $actionMessage = if ($Restart) { "Health check failed; restarting local service." } else { "No listener on port 5000; starting local service." }
  Write-SupervisorLog $actionMessage
  & powershell @arguments
  if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
    throw "dev-local.ps1 exited with code $LASTEXITCODE"
  }
}

function Invoke-CheckCycle {
  $listener = Get-LocalListener
  if (-not $listener) {
    Invoke-Recovery
    return
  }

  if (Test-Healthy) {
    Write-SupervisorLog "Service healthy: PID $($listener.OwningProcess), http://127.0.0.1:$Port/"
    return
  }

  $owner = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
  if (-not $owner -or $owner.ProcessName -ne "node") {
    throw "Port $Port is owned by a non-project process (PID $($listener.OwningProcess)); automatic recovery stopped."
  }

  Invoke-Recovery -Restart
}

Write-SupervisorLog "Local service supervisor started (port $Port, interval ${IntervalSeconds}s)."
do {
  try {
    Invoke-CheckCycle
  } catch {
    Write-SupervisorLog "Recovery failed: $($_.Exception.Message)"
  }

  if ($Once) { break }
  Start-Sleep -Seconds ([Math]::Max(2, $IntervalSeconds))
} while ($true)

Write-SupervisorLog "Local service supervisor stopped."
