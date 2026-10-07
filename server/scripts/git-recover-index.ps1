param(
    [Parameter(Mandatory=$true)][string]$CommonDirectory,
    [Parameter(Mandatory=$true)][string]$LockPath,
    [switch]$AuditOnly
)
# Called only while git-transaction.cjs owns the repository writer lease.
# Exit 75 means ownership remains active or uncertain. No native file is deleted.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$didArchive = $false
trap {
    [Console]::Error.WriteLine($_.Exception.Message)
    if ($didArchive) { exit 1 }
    exit 75
}
function Refuse([string]$Reason) { Write-Error $Reason -ErrorAction Continue; exit 75 }
$commonPath = [IO.Path]::GetFullPath($CommonDirectory).TrimEnd([IO.Path]::DirectorySeparatorChar)
$nativeLockPath = [IO.Path]::GetFullPath($LockPath)
$prefix = $commonPath + [IO.Path]::DirectorySeparatorChar
if (-not $nativeLockPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($nativeLockPath) -ne 'index.lock') { Refuse 'Native index lock is outside the named Git common directory.' }
if (-not (Test-Path -LiteralPath $nativeLockPath -PathType Leaf)) { exit 0 }
$cursor = $nativeLockPath
while ($cursor.Length -ge $commonPath.Length) {
    if (((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Refuse 'Native lock path contains a reparse point.' }
    if ($cursor.Equals($commonPath, [StringComparison]::OrdinalIgnoreCase)) { break }
    $cursor = [IO.Path]::GetDirectoryName($cursor)
}
$before = Get-Item -LiteralPath $nativeLockPath -Force
if (([DateTime]::UtcNow - $before.LastWriteTimeUtc).TotalSeconds -lt 120) { Refuse 'Native lock changed recently.' }
function Inventory {
    # Do not scope by command line or account: unavailable creation metadata is
    # uncertainty, and even an unrelated older Git process prevents recovery.
    @(Get-CimInstance Win32_Process -Filter "Name = 'git.exe'")
}
function HasPossibleOwner($Processes) {
    @($Processes | Where-Object { -not $_.CreationDate -or $_.CreationDate.ToUniversalTime() -le $before.LastWriteTimeUtc }).Count -gt 0
}
$processes = @(Inventory)
if (HasPossibleOwner $processes) { Refuse 'A Git process may still own the native lock.' }
$stream = [IO.File]::Open($nativeLockPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
try { $length = $stream.Length } finally { $stream.Dispose() }
$lockHash = (Get-FileHash -LiteralPath $nativeLockPath -Algorithm SHA256).Hash
$indexPath = Join-Path ([IO.Path]::GetDirectoryName($nativeLockPath)) 'index'
if (-not (Test-Path -LiteralPath $indexPath -PathType Leaf) -or ((Get-Item -LiteralPath $indexPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Refuse 'No ordinary real index is available for preservation verification.' }
$indexHash = (Get-FileHash -LiteralPath $indexPath -Algorithm SHA256).Hash
$archiveDirectory = Join-Path $commonPath 'ggo-orphaned-locks'
if (Test-Path -LiteralPath $archiveDirectory) {
    if (((Get-Item -LiteralPath $archiveDirectory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Refuse 'Native lock archive is a reparse point.' }
} elseif (-not $AuditOnly) { [IO.Directory]::CreateDirectory($archiveDirectory) | Out-Null }
$archiveName = 'index-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N')
$archivePath = Join-Path $archiveDirectory ($archiveName + '.lock')
$receiptPath = Join-Path $archiveDirectory ($archiveName + '.json')
$fresh = Get-Item -LiteralPath $nativeLockPath -Force
if ($fresh.Length -ne $length -or $fresh.LastWriteTimeUtc -ne $before.LastWriteTimeUtc -or (Get-FileHash -LiteralPath $nativeLockPath -Algorithm SHA256).Hash -ne $lockHash) { Refuse 'Native lock changed during the audit.' }
$processes = @(Inventory)
if (HasPossibleOwner $processes) { Refuse 'A possible Git owner appeared during the audit.' }
if ($AuditOnly) {
    [ordered]@{ recoveryEligible=$true; lockSha256=$lockHash; indexSha256=$indexHash } | ConvertTo-Json -Compress
    exit 0
}
Move-Item -LiteralPath $nativeLockPath -Destination $archivePath
$didArchive = $true
$archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
$indexAfterHash = (Get-FileHash -LiteralPath $indexPath -Algorithm SHA256).Hash
$receipt = [ordered]@{
    recoveredAt = [DateTime]::UtcNow.ToString('o'); originalLock = $nativeLockPath; archivedLock = $archivePath;
    lockCreatedAt = $before.CreationTimeUtc.ToString('o'); lockLastWriteAt = $before.LastWriteTimeUtc.ToString('o');
    lockBytes = $length; lockSha256 = $lockHash; archivedSha256 = $archiveHash;
    indexBeforeSha256 = $indexHash; indexAfterSha256 = $indexAfterHash;
    preservedIndex = ($indexHash -eq $indexAfterHash);
    observedGitProcesses = @($processes | Select-Object ProcessId,ParentProcessId,CreationDate)
}
[IO.File]::WriteAllText($receiptPath, ($receipt | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
if ($archiveHash -ne $lockHash -or $indexHash -ne $indexAfterHash) { throw ('Native lock recovery verification failed; inspect ' + $receiptPath + ' without resetting the index.') }
Write-Output ($receiptPath | ConvertTo-Json -Compress)
