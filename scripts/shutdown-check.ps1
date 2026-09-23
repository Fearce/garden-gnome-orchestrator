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
$logPath = Join-Path $PSScriptRoot '..\server\data\shutdown-check.log'
$runStartedAt = if ($Action -eq 'Run') { Get-Date } else { $null }

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
    Write-Output "check=$($check.State); deadline=$deadline"
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

# The clock is the first decision on every run. The native Windows job already owns shutdown
# at 03:00; this path only turns off future GGO runs and never schedules another shutdown.
$node = (Get-Command node -ErrorAction Stop).Source
if ($runStartedAt -ge $deadline) {
    & $node $boardScript --expire
    if ($LASTEXITCODE -ne 0) { throw 'Could not disable the expired GGO schedule.' }
    Write-Result '03:00 passed; GGO schedule disabled and verified.'
    return
}

& $deadlineScript -Action Arm | Out-Null
& $node $boardScript --check
$auditCode = $LASTEXITCODE
if ($auditCode -eq 1) { Write-Result 'Other GGO tasks remain unfinished.'; return }
if ($auditCode -ne 0) { Write-Result "Board audit failed (exit $auditCode); preserving 03:00 deadline."; return }

# Leave enough time to recover from a failed cancel before the fixed deadline.
if ((Get-Date).AddMinutes(2) -ge $deadline) {
    Write-Result 'Idle near 03:00; leaving the native deadline to shut down.'
    return
}
try {
    & $deadlineScript -Action Cancel | Out-Null
    & $node $boardScript --disable
    if ($LASTEXITCODE -ne 0) { throw 'GGO schedule was not disabled after cancelling the deadline.' }
    & $node $boardScript --check
    if ($LASTEXITCODE -ne 0) { throw 'The board changed or could not be verified after disabling the GGO schedule.' }
    # A Windows check left running could re-arm the cancelled deadline before the 60-second shutdown.
    if (Get-Task $checkName) { Unregister-ScheduledTask -TaskName $checkName -Confirm:$false }
    if (Get-Task $checkName) { throw 'The five-minute Windows check is still registered.' }
    Write-Result '03:00 deadline cancelled and verified; GGO schedule disabled and verified. Requesting graceful shutdown in 60 seconds.'
    & $shutdownExe /s /t 60
    if ($LASTEXITCODE -ne 0) { throw "Windows rejected graceful shutdown (exit $LASTEXITCODE)." }
} catch {
    $failure = $_
    # Cancel can fail after removing the job, so verify or restore the fixed deadline.
    & $deadlineScript -Action Arm | Out-Null
    & $node $boardScript --restore
    if ($LASTEXITCODE -ne 0) { throw "Could not restore the GGO schedule after cleanup failed: $failure" }
    if (-not (Get-Task $checkName)) { & $PSCommandPath -Action Arm | Out-Null }
    throw "Early shutdown failed; restored the 03:00 deadline and GGO schedule: $failure"
}
