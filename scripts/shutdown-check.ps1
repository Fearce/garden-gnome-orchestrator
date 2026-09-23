# One-shot five-minute board check. The separate Windows deadline remains armed on every audit failure.
param(
    [ValidateSet('Arm', 'Run', 'Status')]
    [string]$Action = 'Status'
)

$ErrorActionPreference = 'Stop'
$checkName = 'GGO-Shutdown-Board-Check-2026-09-24'
$deadline = [datetime]::ParseExact('2026-09-24 03:00:00', 'yyyy-MM-dd HH:mm:ss', [Globalization.CultureInfo]::InvariantCulture)
$boardScript = Join-Path $PSScriptRoot 'shutdown-board.cjs'
$deadlineScript = Join-Path $PSScriptRoot 'shutdown-deadline.ps1'
$shutdownExe = Join-Path $env:SystemRoot 'System32\shutdown.exe'
$earlyName = 'GGO-OneTime-Early-Shutdown-2026-09-24'
$logPath = Join-Path $PSScriptRoot '..\server\data\shutdown-check.log'
$runStartedAt = if ($Action -eq 'Run') { Get-Date } else { $null }

function Write-Result([string]$message) {
    $line = "$(Get-Date -Format o) $message"
    Add-Content -LiteralPath $logPath -Value $line
    Write-Output $line
}

function Get-Task([string]$name) {
    try {
        Get-ScheduledTask -TaskName $name -ErrorAction Stop
    } catch {
        if ($_.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound_TaskName,*') { return $null }
        throw
    }
}

if ((Get-TimeZone).Id -ne 'Romance Standard Time') { throw 'Expected Europe/Copenhagen Windows time zone.' }

# Retire the GGO schedule at the fixed deadline before checks needed only for an
# early-shutdown audit. The independent Windows deadline remains authoritative.
if ($Action -eq 'Run' -and $runStartedAt -ge $deadline) {
    $node = (Get-Command node -ErrorAction Stop).Source
    & $node $boardScript --expire
    if ($LASTEXITCODE -ne 0) { throw 'Could not disable the expired GGO schedule.' }
    Write-Result '03:00 passed; GGO schedule disabled and verified.'
    return
}

if ($Action -eq 'Status') {
    $check = Get-Task $checkName
    Write-Output "check=$($check.State); deadline=$deadline"
    return
}

if ($Action -eq 'Arm') {
    if (-not (Test-Path -LiteralPath $deadlineScript)) { throw "Missing deadline script: $deadlineScript" }
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

if (-not (Test-Path -LiteralPath $deadlineScript)) { throw "Missing deadline script: $deadlineScript" }

# Both the Windows checker and GGO schedule may fire in the same five-minute slot.
# Only one run may cancel the deadline and create an early shutdown task.
$runMutex = [System.Threading.Mutex]::new($false, 'Global\GGO-OneTime-Shutdown-Check-2026-09-24')
$ownsMutex = $false
try {
    try {
        $ownsMutex = $runMutex.WaitOne(0)
    } catch [System.Threading.AbandonedMutexException] {
        $ownsMutex = $true
    }
    if (-not $ownsMutex) {
        Write-Result 'Another shutdown check is running; leaving the 03:00 deadline in place.'
        return
    }

# A queued GGO check may start after another run has cancelled the deadline and
# scheduled the early shutdown. Do not re-arm the 03:00 job in that window.
$pendingEarly = Get-Task $earlyName
if ($pendingEarly) {
    if (@($pendingEarly.Actions).Count -ne 1 -or
        $pendingEarly.Actions[0].Execute -ne $shutdownExe -or
        $pendingEarly.Actions[0].Arguments -ne '/s /t 0' -or
        $pendingEarly.Settings.StartWhenAvailable -or -not $pendingEarly.Settings.Enabled -or
        $pendingEarly.Settings.DeleteExpiredTaskAfter -ne 'P2D') {
        & $deadlineScript -Action Arm | Out-Null
        throw "Unexpected early shutdown task $earlyName; preserving the 03:00 deadline."
    }
    Write-Result 'Early shutdown is already scheduled; leaving the 03:00 deadline cancelled.'
    return
}
& $deadlineScript -Action Arm | Out-Null
if (-not (Test-Path -LiteralPath $boardScript)) { throw "Missing board audit: $boardScript" }
$node = (Get-Command node -ErrorAction Stop).Source
& $node $boardScript --check
$auditCode = $LASTEXITCODE
if ($auditCode -eq 1) { Write-Result 'Other GGO tasks remain unfinished.'; return }
if ($auditCode -ne 0) { Write-Result "Board audit failed (exit $auditCode); preserving 03:00 deadline."; return }

# Leave enough time to recover from a failed cancel before the fixed deadline.
if ((Get-Date).AddMinutes(2) -ge $deadline) {
    Write-Result 'Idle near 03:00; leaving the native deadline to shut down.'
    return
}
$earlyCreated = $false
try {
    & $deadlineScript -Action Cancel | Out-Null
    & $node $boardScript --disable
    if ($LASTEXITCODE -ne 0) { throw 'GGO schedule was not disabled after cancelling the deadline.' }
    & $node $boardScript --check
    if ($LASTEXITCODE -ne 0) { throw 'The board changed or could not be verified after disabling the GGO schedule.' }
    # A Windows check left running could re-arm the cancelled deadline before the 60-second shutdown.
    if (Get-Task $checkName) { Unregister-ScheduledTask -TaskName $checkName -Confirm:$false }
    if (Get-Task $checkName) { throw 'The five-minute Windows check is still registered.' }
    # shutdown.exe /t 60 silently implies /f. Schedule /t 0 instead so applications
    # get a normal close request after the log has been written.
    if (Get-Task $earlyName) { throw "Unexpected early shutdown task $earlyName already exists." }
    $shutdownAt = (Get-Date).AddSeconds(60)
    $trigger = New-ScheduledTaskTrigger -Once -At $shutdownAt
    $trigger.EndBoundary = $shutdownAt.AddMinutes(1).ToString('s')
    # Retain the completed task beyond 03:00 so a queued GGO check resumed after
    # reboot still sees that the one-time early shutdown already happened.
    $settings = New-ScheduledTaskSettingsSet -WakeToRun -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries -DeleteExpiredTaskAfter (New-TimeSpan -Days 2)
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
        -LogonType Interactive -RunLevel Limited
    $actionSpec = New-ScheduledTaskAction -Execute $shutdownExe -Argument '/s /t 0'
    $earlyCreated = $true
    Register-ScheduledTask -TaskName $earlyName -Action $actionSpec -Trigger $trigger `
        -Settings $settings -Principal $principal -Description 'One-time graceful GGO shutdown after the board became idle.' | Out-Null
    $early = Get-Task $earlyName
    if (-not $early -or @($early.Triggers).Count -ne 1 -or @($early.Actions).Count -ne 1 -or
        [datetimeoffset]::Parse($early.Triggers[0].StartBoundary).LocalDateTime.ToString('s') -ne $shutdownAt.ToString('s') -or
        $early.Actions[0].Execute -ne $shutdownExe -or $early.Actions[0].Arguments -ne '/s /t 0' -or
        $early.Settings.StartWhenAvailable -or -not $early.Settings.WakeToRun -or -not $early.Settings.Enabled -or
        $early.Settings.DeleteExpiredTaskAfter -ne 'P2D') {
        throw "Could not verify graceful shutdown task $earlyName."
    }
    Write-Result '03:00 deadline cancelled and verified; GGO schedule disabled and verified. Graceful shutdown scheduled in 60 seconds.'
} catch {
    $failure = $_
    # Restore the fixed fallback before cleanup reads that might themselves fail.
    # A successful Cancel may already have removed it.
    & $deadlineScript -Action Arm | Out-Null
    if ($earlyCreated -and (Get-Task $earlyName)) {
        Unregister-ScheduledTask -TaskName $earlyName -Confirm:$false
        if (Get-Task $earlyName) { throw "Could not remove unverified early shutdown task $earlyName after: $failure" }
    }
    & $node $boardScript --restore
    if ($LASTEXITCODE -ne 0) { throw "Could not restore the GGO schedule after cleanup failed: $failure" }
    if (-not (Get-Task $checkName)) { & $PSCommandPath -Action Arm | Out-Null }
    throw "Early shutdown failed; restored the 03:00 deadline and GGO schedule: $failure"
}
} finally {
    if ($ownsMutex) { $runMutex.ReleaseMutex() }
    $runMutex.Dispose()
}
