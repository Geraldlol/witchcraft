#Requires -Version 7
<#
Start, stop, restart, or report the Witchcraft daemon (tools/witchcraft-daemon) from outside its
own terminal. The daemon is an interactive terminal UI, so `start` opens it in a new console
window; `stop` delivers a real Ctrl+C to that console so the daemon shuts down cleanly and
removes its lock. Run with -Action status to see what is going on.
#>
[CmdletBinding()]
param(
    [ValidateSet('start', 'stop', 'restart', 'status')]
    [string]$Action = 'status',
    # pixels: the strip is read in addition to the carrier (proven ring bootstrap; game must be
    # in front for the strip). carrier: no strip at all, the cooldown carrier's heartbeat drives
    # the ring (built 2026-09-22, unproven in game). Older docs called the second mode 'binding'.
    [ValidateSet('pixels', 'carrier', 'binding')]
    [string]$Mode = 'pixels',
    [ValidateSet('', 'claude', 'codex')]
    [string]$Only = '',
    # Mirror a console you started yourself instead of launching that tab: claude=24492, or
    # claude=pick to choose from a list in the daemon's own window. `witchcraft consoles` lists
    # the candidates with their process ids. Both tabs can be named: -Attach claude=1,codex=2
    [string[]]$Attach = @(),
    [switch]$NoOverlay,
    [switch]$NoMcp,
    # By default the daemon joins what is already running in -Cwd: the Claude tab mirrors the
    # newest Claude Code console there and the Codex tab resumes the newest top-level Codex thread
    # (the VS Code extension's). -Fresh launches new sessions for both instead.
    [switch]$Fresh,
    # Kill the process tree if a clean stop does not finish within -TimeoutSec.
    [switch]$Force,
    [int]$TimeoutSec = 15,
    [string]$DaemonDir = '',
    # The Witchcraft checkout. Defaults to $env:WITCHCRAFT_HOME, then the checkout this skill sits in.
    [string]$Repo = '',
    # The folder the agents work in and whose sessions are joined. Defaults to the current folder.
    [string]$Cwd = '',
    # Defaults to addonsDir in the checkout's wow.config.json.
    [string]$AddonsDir = '',
    # Only read for status. Defaults to the character folder whose cooldownmanager.txt is newest.
    [string]$CharacterDir = ''
)

$ErrorActionPreference = 'Stop'

if (-not $Repo) { $Repo = $env:WITCHCRAFT_HOME }
if (-not $Repo) {
    $here = Join-Path $PSScriptRoot '..\..\..'
    if (Test-Path (Join-Path $here 'tools\witchcraft-daemon\bin\witchcraft.js')) { $Repo = (Resolve-Path $here).Path }
}
if (-not $Cwd) { $Cwd = (Get-Location).Path }
if (-not $AddonsDir -and $Repo) {
    try { $AddonsDir = (Get-Content (Join-Path $Repo 'wow.config.json') -Raw | ConvertFrom-Json).addonsDir } catch { }
}
if (-not $CharacterDir -and $AddonsDir) {
    $newest = Get-ChildItem (Join-Path $AddonsDir '..\..\WTF\Account\*\*\*\cooldownmanager.txt') -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($newest) { $CharacterDir = $newest.DirectoryName }
}

function Resolve-DaemonDir {
    if ($DaemonDir) { return (Resolve-Path $DaemonDir).Path }
    if ($Repo) {
        $candidate = Join-Path $Repo 'tools\witchcraft-daemon'
        if (Test-Path (Join-Path $candidate 'bin\witchcraft.js')) { return $candidate }
    }
    throw 'No witchcraft-daemon checkout found; pass -Repo, set WITCHCRAFT_HOME, or pass -DaemonDir.'
}

function Read-Lock([string]$dir) {
    $path = Join-Path $dir '.local\bridge.lock'
    if (-not (Test-Path $path)) { return $null }
    try { $lock = Get-Content $path -Raw | ConvertFrom-Json } catch { return @{ path = $path; invalid = $true } }
    # A crash before the record reached the disk leaves an empty lock, which parses to nothing.
    $lockPid = if ($lock) { $lock.pid -as [int] } else { $null }
    if (-not $lockPid -or $lockPid -le 0) { return @{ path = $path; invalid = $true } }
    $proc = Get-Process -Id $lockPid -ErrorAction SilentlyContinue
    # Pids are reused: the lock is live only while that process is still the bridge that wrote it,
    # a `witchcraft.js run` created no later than the lock's startedAt.
    $alive = $false; $reused = $null
    if ($proc) {
        $command = Get-CommandLine $lockPid
        $started = $null; try { $started = ([datetime]$lock.startedAt).ToUniversalTime() } catch {}
        $created = $null; try { $created = $proc.StartTime.ToUniversalTime() } catch {}
        $startedFirst = ($null -eq $started -or $null -eq $created -or $created -le $started.AddSeconds(2))
        # A process this shell may not open (an elevated daemon) has no readable command line; then
        # only its name can be judged, as before, rather than calling a live daemon stale.
        if ([string]::IsNullOrEmpty($command)) { $alive = $proc.ProcessName -eq 'node' -and $startedFirst }
        else { $alive = ($command -match 'witchcraft\.js' -and $command -match '\srun(\s|$)') -and $startedFirst }
        if (-not $alive) { $reused = $proc.ProcessName }
    }
    return @{ path = $path; pid = $lockPid; epoch = $lock.epoch; startedAt = $lock.startedAt
              alive = $alive; reused = $reused; process = $proc }
}

# Why a lock that is not live is stale, for messages.
function Stale-Reason($lock) {
    if ($lock.reused) { return "pid $($lock.pid) now belongs to $($lock.reused)" }
    return "pid $($lock.pid) gone"
}

function Get-CommandLine([int]$processId) {
    try { (Get-CimInstance Win32_Process -Filter "ProcessId=$processId").CommandLine } catch { '' }
}

function Send-CtrlC([int]$processId) {
    # A console control event can only be raised from a process attached to that console, so a
    # short-lived child attaches, ignores the event itself, raises it, and exits.
    $script = @'
$code = @"
using System; using System.Runtime.InteropServices;
public static class ConsoleCtrl {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleCtrlHandler(IntPtr h, bool add);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GenerateConsoleCtrlEvent(uint ev, uint group);
}
"@
Add-Type -TypeDefinition $code
[ConsoleCtrl]::FreeConsole() | Out-Null
if (-not [ConsoleCtrl]::AttachConsole(TARGET_PID)) { exit 2 }
[ConsoleCtrl]::SetConsoleCtrlHandler([IntPtr]::Zero, $true) | Out-Null
$ok = [ConsoleCtrl]::GenerateConsoleCtrlEvent(0, 0)
Start-Sleep -Milliseconds 200
[ConsoleCtrl]::FreeConsole() | Out-Null
if ($ok) { exit 0 } else { exit 3 }
'@
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script.Replace('TARGET_PID', "$processId")))
    $helper = Start-Process -FilePath 'pwsh' -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded) -PassThru -WindowStyle Hidden -Wait
    return $helper.ExitCode
}

function Get-DescendantIds([int]$processId) {
    $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
    $found = New-Object System.Collections.Generic.List[int]
    $queue = [System.Collections.Generic.Queue[int]]::new(); $queue.Enqueue($processId)
    while ($queue.Count) {
        $current = $queue.Dequeue()
        foreach ($child in ($all | Where-Object ParentProcessId -eq $current)) {
            if (-not $found.Contains([int]$child.ProcessId)) { $found.Add([int]$child.ProcessId); $queue.Enqueue([int]$child.ProcessId) }
        }
    }
    return $found
}

function Stop-Daemon([string]$dir) {
    $lock = Read-Lock $dir
    if (-not $lock) { Write-Output 'stopped: no lock file, nothing running'; return }
    if ($lock.invalid) { Remove-Item $lock.path; Write-Output "stopped: removed unreadable lock $($lock.path)"; return }
    if (-not $lock.alive) { Remove-Item $lock.path; Write-Output "stopped: no bridge was running ($(Stale-Reason $lock)); removed stale lock"; return }
    $descendants = Get-DescendantIds $lock.pid
    $code = Send-CtrlC $lock.pid
    if ($code -ne 0) { Write-Output "warning: Ctrl+C delivery helper exited $code (2 = could not attach to console)" }
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $proc = Get-Process -Id $lock.pid -ErrorAction SilentlyContinue
        if (-not $proc -and -not (Test-Path $lock.path)) { Write-Output "stopped: pid $($lock.pid) exited cleanly and released its lock"; return }
        Start-Sleep -Milliseconds 250
    }
    $proc = Get-Process -Id $lock.pid -ErrorAction SilentlyContinue
    if (-not $proc) {
        if (Test-Path $lock.path) { Remove-Item $lock.path; Write-Output "stopped: pid $($lock.pid) exited but left its lock; removed it" }
        return
    }
    if (-not $Force) {
        Write-Output "still running: pid $($lock.pid) did not exit within $TimeoutSec s. Close both agents in its window, or rerun with -Force."
        exit 1
    }
    foreach ($id in ($descendants + $lock.pid)) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 500
    if (Test-Path $lock.path) { Remove-Item $lock.path }
    Write-Output "killed: pid $($lock.pid) and $($descendants.Count) descendants; lock removed. Check the game for a stale field 127 and rerun init if chunks look wrong."
}

function Start-Daemon([string]$dir) {
    $lock = Read-Lock $dir
    if ($lock -and $lock.alive) {
        Write-Output "already running: pid $($lock.pid) since $($lock.startedAt); use -Action restart"
        exit 1
    }
    if ($lock) { Remove-Item $lock.path; Write-Output "removed stale lock ($(if ($lock.invalid) { 'unreadable' } else { Stale-Reason $lock }))" }
    # Start-Process splits unquoted arguments on spaces, and the path may have one.
    $args = @('bin/witchcraft.js', 'run', '--cwd', ('"' + $Cwd + '"'))
    if ($Mode -eq 'pixels') { $args += '--pixels' } else { $args += '--no-pixels' }
    if ($Only) { $args += @('--only', $Only) }
    $picking = $false
    foreach ($entry in $Attach) {
        if ($entry -notmatch '^(claude|codex)=([1-9][0-9]*|pick)$') {
            Write-Output "bad -Attach '$entry': use claude=PID, codex=PID, or claude=pick. Run 'node bin/witchcraft.js consoles' in $dir for the process ids."
            exit 1
        }
        if ($entry -match '=pick$') { $picking = $true }
        $args += @('--attach', $entry)
    }
    if ($NoOverlay) { $args += '--no-overlay' }
    if ($NoMcp) { $args += '--no-mcp' }
    if ($Fresh) { $args += '--no-current' }
    $proc = Start-Process -FilePath 'node' -ArgumentList $args -WorkingDirectory $dir -PassThru
    # Picking a console waits for a keypress in the daemon's own window, so nothing is locked
    # until the reader has chosen.
    if ($picking) { Write-Output "choose a console in the new window: up/down, enter to take it, escape to cancel" }
    $deadline = (Get-Date).AddSeconds($(if ($picking) { 120 } else { 10 }))
    while ((Get-Date) -lt $deadline) {
        $lock = Read-Lock $dir
        if ($lock -and $lock.alive) {
            Write-Output "started: pid $($lock.pid), mode $Mode$(if ($Only) { ", only $Only" })$(if ($Attach) { ", mirroring $($Attach -join ' ')" }), epoch $($lock.epoch), in a new console window"
            if (-not $Fresh) { Write-Output "joins current sessions: tabs not named by -Attach mirror the running Claude console and resume the newest Codex thread in the repo; the daemon window names them. -Fresh starts new ones." }
            Write-Output "next: in the game run /reload, then /witch. Pixel mode needs the game window in front."
            if ($Attach) { Write-Output "a mirrored tab is typed into from its own console window, and shows the sixteen ANSI colours only." }
            return
        }
        if ($proc.HasExited) { Write-Output "failed: node exited with code $($proc.ExitCode) before writing a lock"; exit 1 }
        Start-Sleep -Milliseconds 250
    }
    Write-Output "unclear: node pid $($proc.Id) is running but no lock appeared in time; check its window"
    exit 1
}

function Show-Status([string]$dir) {
    $lock = Read-Lock $dir
    Write-Output "daemon dir: $dir"
    if (-not $lock) { Write-Output 'daemon: not running (no lock)' }
    elseif ($lock.invalid) { Write-Output "daemon: unreadable lock at $($lock.path)" }
    elseif (-not $lock.alive) { Write-Output "daemon: not running (stale lock, $(Stale-Reason $lock))" }
    else {
        $cmd = Get-CommandLine $lock.pid
        $mode = if ($cmd -match '--no-pixels') { 'carrier' } elseif ($cmd -match '--pixels') { 'pixels' } else { 'default (strip on when calibrated)' }
        Write-Output "daemon: running pid $($lock.pid), mode $mode, epoch $($lock.epoch), started $($lock.startedAt)"
    }
    $game = Get-Process | Where-Object ProcessName -eq 'WowB' | Select-Object -First 1
    Write-Output "game: $(if ($game) { "running pid $($game.Id)" } else { 'not running' })"
    if ($AddonsDir -and (Test-Path $AddonsDir)) {
        $latest = Get-ChildItem $AddonsDir -Directory -Filter 'Witchcraft_Chunk_*' |
            ForEach-Object { Get-Item (Join-Path $_.FullName 'Chunk.lua') -ErrorAction SilentlyContinue } |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($latest) {
            $text = Get-Content $latest.FullName -Raw
            $field = { param($k) $m = [regex]::Match($text, '\["' + $k + '"\]=("?)([^,}"]*)\1'); if ($m.Success) { $m.Groups[2].Value } else { '?' } }
            $tabs = foreach ($id in 'claude', 'codex') {
                $i = $text.IndexOf('["id"]="' + $id + '"')
                if ($i -ge 0) { $m = [regex]::Match($text.Substring($i), '\["status"\]="([^"]*)"'); "$id=$($m.Groups[1].Value)" } else { "$id=?" }
            }
            $age = [int]((Get-Date) - $latest.LastWriteTime).TotalSeconds
            Write-Output "ring: $($latest.Directory.Name) written ${age}s ago, uiNonce $(& $field 'uiNonce'), want $(& $field 'contextWant'), contextAck $(& $field 'contextAck'), cooldownAck $(& $field 'cooldownAck')"
            Write-Output "tabs: $($tabs -join ', ')"
        }
    }
    $cache = Join-Path $dir '.local\wow-context.json'
    if (Test-Path $cache) {
        try {
            $c = Get-Content $cache -Raw | ConvertFrom-Json
            $hb = if ($c.lastHeartbeatAt) { [int](([DateTimeOffset]::Now.ToUnixTimeMilliseconds() - $c.lastHeartbeatAt) / 1000) } else { $null }
            $player = if ($c.player) { "$($c.player.data.name) L$($c.player.data.level) $($c.player.data.location.zone)" } else { 'none' }
            $quests = if ($c.quests) { "$($c.quests.data.trackedCount) tracked" } else { 'none' }
            Write-Output "context: status $($c.status), heartbeat $(if ($null -ne $hb) { "${hb}s ago" } else { 'never' }), player $player, quests $quests"
        } catch { Write-Output 'context: cache unreadable' }
    }
    $want = Join-Path $dir '.local\wow-context.want.json'
    if (Test-Path $want) {
        try { $w = Get-Content $want -Raw | ConvertFrom-Json; $wa = [int](([DateTimeOffset]::Now.ToUnixTimeMilliseconds() - $w.requestedAt) / 1000); Write-Output "want: requested ${wa}s ago" } catch { }
    }
    $cd = if ($CharacterDir) { Join-Path $CharacterDir 'cooldownmanager.txt' } else { '' }
    if ($cd -and (Test-Path $cd)) {
        $f = Get-Item $cd
        $state = if ($f.Length -eq 0) { 'empty' } else { "$($f.Length) bytes (a frame may be outstanding)" }
        Write-Output "cooldown file: $state, written $([int]((Get-Date) - $f.LastWriteTime).TotalSeconds)s ago"
    } else { Write-Output 'cooldown file: absent' }
}

$dir = Resolve-DaemonDir
switch ($Action) {
    'status'  { Show-Status $dir }
    'start'   { Start-Daemon $dir }
    'stop'    { Stop-Daemon $dir }
    'restart' { Stop-Daemon $dir; Start-Daemon $dir }
}
