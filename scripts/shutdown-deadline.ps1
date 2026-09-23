# One-time deadline for GGO scheduled task 4e52d3f9-ca5c-4b3b-a1fc-dbfc15ba511d.
# The fixed date prevents a delayed five-minute check from arming tomorrow's 03:00.
param(
    [ValidateSet('Arm', 'Cancel', 'Status')]
    [string]$Action = 'Status'
)

$ErrorActionPreference = 'Stop'
$taskName = 'GGO-OneTime-Shutdown-2026-09-24-0300'
$deadline = [datetime]::ParseExact('2026-09-24 03:00:00', 'yyyy-MM-dd HH:mm:ss', [Globalization.CultureInfo]::InvariantCulture)
$shutdownExe = Join-Path $env:SystemRoot 'System32\shutdown.exe'
$shutdownArgs = '/s /f /t 0'

if ((Get-TimeZone).Id -ne 'Romance Standard Time') {
    throw 'Expected the Windows Europe/Copenhagen time zone (Romance Standard Time).'
}

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

if ($Action -eq 'Cancel') {
    if ($existing) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        throw "Shutdown deadline $taskName was not removed."
    }
    Write-Output "Cancelled $taskName"
    return
}

if ($Action -eq 'Arm' -and -not $existing) {
    if ((Get-Date) -ge $deadline) { throw 'The one-time 03:00 deadline has passed; refusing to arm a later shutdown.' }
    $trigger = New-ScheduledTaskTrigger -Once -At $deadline
    $trigger.EndBoundary = $deadline.AddMinutes(1).ToString('s')
    $settings = New-ScheduledTaskSettingsSet -WakeToRun -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries -DeleteExpiredTaskAfter (New-TimeSpan -Hours 1)
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
        -LogonType Interactive -RunLevel Limited
    $actionSpec = New-ScheduledTaskAction -Execute $shutdownExe -Argument $shutdownArgs
    Register-ScheduledTask -TaskName $taskName -Action $actionSpec -Trigger $trigger `
        -Settings $settings -Principal $principal `
        -Description 'One-time Copenhagen 03:00 hard shutdown deadline for GGO; cancel if all work finishes early.' | Out-Null
    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
}

if (-not $existing) { throw "Shutdown deadline $taskName is not registered." }
$triggers = @($existing.Triggers)
$actions = @($existing.Actions)
$startLocal = [datetimeoffset]::Parse($triggers[0].StartBoundary).LocalDateTime
if ($triggers.Count -ne 1 -or $triggers[0].CimClass.CimClassName -ne 'MSFT_TaskTimeTrigger' -or
    $startLocal -ne $deadline -or $triggers[0].EndBoundary -ne $deadline.AddMinutes(1).ToString('s') -or
    $triggers[0].Repetition.Interval -or -not $triggers[0].Enabled -or
    $actions.Count -ne 1 -or $actions[0].Execute -ne $shutdownExe -or
    $actions[0].Arguments -ne $shutdownArgs -or
    $existing.Principal.UserId -ne $env:USERNAME -or
    $existing.Settings.StartWhenAvailable -or -not $existing.Settings.WakeToRun -or
    -not $existing.Settings.Enabled -or $existing.Settings.DeleteExpiredTaskAfter -ne 'PT1H') {
    throw "Existing task $taskName does not match the one-time shutdown deadline."
}
$info = Get-ScheduledTaskInfo -TaskName $taskName
Write-Output "Verified ${taskName}: $($startLocal.ToString('yyyy-MM-dd HH:mm:ss', [Globalization.CultureInfo]::InvariantCulture)) $((Get-TimeZone).Id); state=$($existing.State); nextRun=$($info.NextRunTime.ToString('o')); deleteExpiredAfter=$($existing.Settings.DeleteExpiredTaskAfter); startWhenAvailable=$($existing.Settings.StartWhenAvailable)"
