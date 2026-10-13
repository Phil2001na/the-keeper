# Registers a Windows scheduled task that starts the Keeper PC agent at logon,
# hidden, and restarts it if it dies. Run once:  powershell -File install-autostart.ps1
# Remove with:  Unregister-ScheduledTask -TaskName 'Keeper PC Agent' -Confirm:$false
$dir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node).Source
$action   = New-ScheduledTaskAction -Execute $node -Argument "`"$dir\agent.mjs`"" -WorkingDirectory $dir
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'Keeper PC Agent' -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Lets the Keeper start Claude Code sessions on this PC (pc-agent/agent.mjs).' -Force | Out-Null
Start-ScheduledTask -TaskName 'Keeper PC Agent'
Write-Output "Keeper PC Agent registered and started (node: $node)."
