# One-shot five-minute board check. The separate Windows deadline remains armed on every audit failure.
param(
    [ValidateSet('Arm', 'Run', 'Status')]
    [string]$Action = 'Status'
)

$ErrorActionPreference = 'Stop'
$checkName = 'GGO-Shutdown-Board-Check-2026-09-24'
$earlyName = 'GGO-Early-Shutdown-2026-09-24'
$deadline = [datetime]::ParseExact('2026-09-24 03:00:00', 'yyyy-MM-dd HH:mm:ss', [Globalization.CultureInfo]::InvariantCulture)
$boardScript = Join-Path $PSScriptRoot 'shutdown-board.cjs'
$deadlineScript = Join-Path $PSScriptRoot 'shutdown-deadline.ps1'
$shutdownExe = Join-Path $env:SystemRoot 'System32\shutdown.exe'
$logPath = Join-Path $PSScriptRoot '..\server\data\shutdown-check.log'

function Write-Result([string]$message) {
    $line = "$(Get-Date -Format o) $message"
    Add-Content -LiteralPath $logPath -Value $line
    Write-Output $line
}

function Get-Task([string]$name) {
    Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
}

if ((Get-TimeZone).Id -ne 'Romance Standard Time') { throw 'Expected Europe/Copenhagen Windows time zone.' }
if (-not (Test-Path -LiteralPath $boardScript)) { throw "Missing board audit: $boardScript" }
if (-not (Test-Path -LiteralPath $deadlineScript)) { throw "Missing deadline script: $deadlineScript" }

if ($Action -eq 'Status') {
    $check = Get-Task $checkName
    $early = Get-Task $earlyName
    Write-Output "check=$($check.State); early=$($early.State); deadline=$deadline"
    return
}

if ($Action -eq 'Arm') {
    & $deadlineScript -Action Status | Out-Null
    if (Get-Task $checkName) { throw "Check task $checkName already exists; inspect it before arming another." }
    $now = Get-Date
    if ($now -ge $deadline) { throw 'The 03:00 deadline has passed.' }
    $start = $now.Date.AddHours($now.Hour).AddMinutes((([math]::Floor($now.Minute / 5) + 1) * 5))
    $trigger = New-ScheduledTaskTrigger -Once -At $start -RepetitionInterval (New-TimeSpan -Minutes 5) `
        -RepetitionDuration ($deadline - $start)
    $trigger.EndBoundary = $deadline.ToString('s')
    $settings = New-ScheduledTaskSettingsSet -WakeToRun -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries -DeleteExpiredTaskAfter (New-TimeSpan -Hours 1)
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
        -LogonType Interactive -RunLevel Limited
    $psExe = Join-Path $PSHOME 'powershell.exe'
    $taskAction = New-ScheduledTaskAction -Execute $psExe `
        -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Action Run"
    Register-ScheduledTask -TaskName $checkName -Action $taskAction -Trigger $trigger `
        -Settings $settings -Principal $principal -Description 'Five-minute GGO board check until the one-time 03:00 shutdown.' | Out-Null
    $registered = Get-Task $checkName
    if (-not $registered -or @($registered.Triggers).Count -ne 1 -or
        $registered.Triggers[0].Repetition.Interval -ne 'PT5M' -or
        $registered.Triggers[0].EndBoundary -ne $deadline.ToString('s')) {
        throw 'Could not verify the five-minute check task.'
    }
    Write-Result "Armed $checkName every five minutes through $deadline"
    return
}

if ((Get-Date) -ge $deadline) { Write-Result 'At or after 03:00; native deadline owns shutdown.'; return }
$node = (Get-Command node -ErrorAction Stop).Source
& $node $boardScript --check
$auditCode = $LASTEXITCODE
if ($auditCode -eq 1) { Write-Result 'Other GGO tasks remain unfinished.'; return }
if ($auditCode -ne 0) { Write-Result "Board audit failed (exit $auditCode); preserving 03:00 deadline."; return }

# A separate one-time task gives the completion report time to persist and keeps shutdown graceful.
$fireAt = (Get-Date).AddSeconds(45)
if ($fireAt -ge $deadline) { Write-Result 'Idle near 03:00; leaving the native deadline to shut down.'; return }
$earlyTrigger = New-ScheduledTaskTrigger -Once -At $fireAt
$earlyTrigger.EndBoundary = $fireAt.AddMinutes(2).ToString('s')
$earlySettings = New-ScheduledTaskSettingsSet -WakeToRun -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -DeleteExpiredTaskAfter (New-TimeSpan -Hours 1)
$earlyPrincipal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive -RunLevel Limited
$earlyAction = New-ScheduledTaskAction -Execute $shutdownExe -Argument '/s /t 0'
Register-ScheduledTask -TaskName $earlyName -Action $earlyAction -Trigger $earlyTrigger `
    -Settings $earlySettings -Principal $earlyPrincipal -Description 'One-time graceful shutdown after GGO board became idle.' | Out-Null
$early = Get-Task $earlyName
if (-not $early -or @($early.Triggers).Count -ne 1 -or $early.Actions[0].Arguments -ne '/s /t 0') {
    throw 'Early shutdown task could not be verified; 03:00 deadline remains armed.'
}

& $node $boardScript --disable
if ($LASTEXITCODE -ne 0) {
    Unregister-ScheduledTask -TaskName $earlyName -Confirm:$false
    if (Get-Task $earlyName) { throw 'GGO schedule stayed enabled and early shutdown could not be cancelled.' }
    throw 'GGO schedule was not disabled; early shutdown was cancelled.'
}
& $deadlineScript -Action Cancel | Out-Null
if (Get-Task $checkName) { Unregister-ScheduledTask -TaskName $checkName -Confirm:$false }
if (Get-Task $checkName) { throw 'Five-minute check is still registered.' }
Write-Result "GGO schedule disabled; early graceful shutdown set for $($fireAt.ToString('o')); 03:00 deadline cancelled."
