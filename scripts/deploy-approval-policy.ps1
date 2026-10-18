param(
  [Parameter(Mandatory=$true)][int]$AgentProcessId,
  [string]$SessionId = ''
)
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$agentFile = Join-Path $project 'pc-agent\agent.mjs'
$rollout = Join-Path $project 'artifacts\approval-rollout'
$receiptFile = Join-Path $rollout 'receipt.json'
$manifest = Get-Content -LiteralPath (Join-Path $rollout 'manifest.json') -Raw | ConvertFrom-Json
function Receipt($status, $detail) {
  @{ status=$status; at=(Get-Date).ToString('o'); detail=$detail; policy='bypass-money-edu-v2' } |
    ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $receiptFile -Encoding UTF8
}
function Check-Files {
  foreach ($item in $manifest) {
    if ((Get-FileHash -LiteralPath (Join-Path $project $item.path) -Algorithm SHA256).Hash -ne $item.hash) {
      throw "Reviewed file changed: $($item.path). Rollout stopped."
    }
  }
}
try {
  Check-Files
  Receipt 'waiting-for-idle' 'Active turns will finish before the PC agent is restarted.'
  $deadline = (Get-Date).AddHours(4)
  $idleSamples = 0
  while ((Get-Date) -lt $deadline) {
    try {
      $active = Get-Content -LiteralPath (Join-Path $project 'pc-agent\logs\running.json') -Raw | ConvertFrom-Json
      if (@($active).Count -eq 0) { $idleSamples++ } else { $idleSamples = 0 }
    } catch { $idleSamples = 0 }
    if ($idleSamples -ge 3) { break }
    Start-Sleep -Seconds 3
  }
  if ($idleSamples -lt 3) { throw 'PC did not become idle in four hours. No restart performed.' }
  Check-Files
  $old = Get-CimInstance Win32_Process -Filter "ProcessId = $AgentProcessId"
  if (-not $old -or -not $old.CommandLine.Contains($agentFile)) { throw 'Original PC agent changed; no process stopped.' }
  $task = Get-ScheduledTask -TaskName 'Keeper PC Agent'
  if (-not ($task.Actions.Arguments -join ' ').Contains($agentFile)) { throw 'Scheduled task targets a different agent.' }
  # A final read immediately before restart; never stop an active turn deliberately.
  $lastActive = Get-Content -LiteralPath (Join-Path $project 'pc-agent\logs\running.json') -Raw | ConvertFrom-Json
  if (@($lastActive).Count -ne 0) {
    throw 'A turn started during the idle window. No restart performed.'
  }
  $since = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss')
  Receipt 'restarting' 'Idle checks passed; restarting the existing PC-agent scheduled task.'
  Stop-ScheduledTask -TaskName 'Keeper PC Agent'
  Start-Sleep -Seconds 2
  Start-ScheduledTask -TaskName 'Keeper PC Agent'
  $healthy = $false
  for ($i=0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 2
    $tail = Get-Content -LiteralPath (Join-Path $project 'pc-agent\logs\agent.log') -Tail 30
    if ($tail | Where-Object { $_ -match 'Approval policy bypass-money-edu-v2' -and $_.Substring(1,19) -ge $since }) {
      $healthy = $true; break
    }
  }
  if (-not $healthy) { throw 'New policy boot marker not observed. Inspect the scheduled task before claiming deployment.' }
  $newProcess = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($agentFile) })
  if ($newProcess.Count -ne 1 -or $newProcess[0].ProcessId -eq $AgentProcessId) { throw 'Expected one replacement PC-agent process.' }
  Push-Location $project
  try {
    & $newProcess[0].ExecutablePath (Join-Path $project 'node_modules\tsx\dist\cli.mjs') (Join-Path $project 'scripts\approval-e2e.ts') *> (Join-Path $rollout 'e2e-after-deploy.log')
    if ($LASTEXITCODE -ne 0) { throw 'Post-deploy isolated end-to-end test failed.' }
  } finally { Pop-Location }
  Receipt 'deployed-and-tested' @{ processId=$newProcess[0].ProcessId; evidence='e2e-after-deploy.log'; externalActions='None: consequential tools were simulated.' }
  # No unsolicited message or follow-up is sent. Inspect the receipt after activation.
} catch {
  Receipt 'needs-review' $_.Exception.Message
  exit 1
}
