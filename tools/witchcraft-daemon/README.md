# Witchcraft daemon

Windows companion for the Witchcraft WoW addon. Requires Node 24 or newer and at least one installed, authenticated Claude Code, Codex CLI, GitHub Copilot CLI or Google Antigravity CLI (`agy`) installation. The default command starts Claude and Codex; use `--only claude`, `--only codex`, `--only copilot` or `--only agy` for one, or `--with-copilot` / `--with-agy` to add Copilot or AGY. Dependencies are pinned in `package-lock.json`.

The WoW MCP bridge adds six read-only game-context tools (context, character, quests, progress, Lua errors and the session journal) and the `wow://context` resource to recognized Claude/Codex/Copilot launches. Guides and Adventures add reference search, quest hints, loot planning, dungeon practice, zone detours and personal campaigns. Sixteen tools are exposed in total: thirteen read-only and three explicitly writable local goals/passport tools. The Claude tab joins your own running Claude Code session by default, which Witchcraft did not launch: give it the tools once with `node bin/witchcraft.js mcp-setup --apply` (local scope, sessions started in this checkout only; add the same `--cwd` you give `run`), then restart that session and Witchcraft. Running it again when the same server is registered only repeats the restart advice. The daemon window and the in-game footer say when a joined session lacks the tools, and follow a Claude session restarted in the mirrored console. Its default addon-to-host path is the local binding carrier described below; terminal input always takes priority. `run --no-mcp` opts out of launch-time MCP configuration. The in-game **WoW context** panel controls data sharing. Existing daemon/assistant processes must be restarted or resumed to load this extension.

## Setup

Take the addon and the daemon from the same revision; the AGY tab needs addon 0.4.0 or later, and the daemon lists AGY to the addon only once it has been started.

From this repository's `tools/witchcraft-daemon` folder:

On Windows (PowerShell):

```powershell
npm.cmd ci --ignore-scripts --no-fund
npm.cmd rebuild node-pty --ignore-scripts=false --foreground-scripts
node bin/witchcraft.js init --ring 3000
node bin/witchcraft.js doctor
```

On macOS and Linux:

```sh
npm ci --ignore-scripts --no-fund
npm rebuild node-pty --ignore-scripts=false --foreground-scripts
node bin/witchcraft.js init --ring 3000
node bin/witchcraft.js doctor
```

Install scripts stay off for the whole tree. The explicit rebuild prepares node-pty. For the optional
overlay, run `node node_modules/electron/install.js` to fetch the binary against the locked checksum.
`doctor` also runs before setup. Add `--only codex` (or another assistant) to match the intended launch.
Use `--json` for a redacted support report. A failed setup check exits with status 1. A stopped daemon
or pending in-game step displays the next action.
The release lockfile passes `npm audit` with no known vulnerabilities.

The repository root's `wow.config.json` (copy `wow.config.example.json`; it is git-ignored) must identify the intended `Interface/AddOns` directory. Account selection is automatic only when one account directory exists; otherwise add `--account NAME`. Local calibration and preferences go in ignored `.local/config.json`.

`init` creates marked load-on-demand addons. Existing marked slots are preserved unless `--clean` is explicitly supplied. All reserved folders are checked before writing; unrelated or unmarked folders cause refusal and are left untouched. `--clean` recreates only validated owned slots. Stop the daemon before reinitializing. Restart WoW after adding slots; `/reload` alone does not discover new addons or fonts.

Start both agents in a terminal:

```powershell
node bin/witchcraft.js run --cwd 'C:\path\to\your\project'
```

Run `/witch bindprobe` once out of combat for each new daemon/UI session. The default binding carrier is not build-pinned; its qualification is complete only when Witchcraft prints that host decode, acknowledgement and exact cleanup all succeeded. The probe refuses occupied keys, combat, binding-set changes and any readback mismatch. The optional production cooldown carrier is exact-build-gated in [`Witchcraft/Evidence.lua`](../../Witchcraft/Evidence.lua), currently at user-confirmed Forever build `1.60.1.71037`, and stays off on every other build. The AddOns-state experiment is a dormant source-only prototype: the addon does not load it and the daemon does not use it. Keep the screen strip calibrated as a separate fallback.

Calibrate the screen strip before your first run. Once calibration is saved, ordinary `run` also reads the strip, providing a fallback when a file carrier cannot operate. In WoW, run `/witch calibrate`, keep the top-left strip visible and uncovered, then run:

```powershell
node bin/witchcraft.js calibrate
```

Return to WoW and run `/witch calibrate off` after calibration. Start the daemon with the `run` command above, then `/reload` in game. Calibration captures the virtual desktop once; ongoing strip capture runs only while the game client (`Wow`, `WowClassic`, `WowB` or `WowT`) is the foreground process. It pauses when you switch to another window. `--no-pixels` disables capture, so use it only when a separately configured file carrier can keep the connection moving.

Use `/witch` in game. Ctrl+] switches the real terminal between agents; the game tabs select independently. Closing all launched CLI sessions stops the daemon. Ordinary Ctrl+C is passed to the selected CLI. A second daemon is rejected by `.local/bridge.lock`, which names the running pid. A lock left by a crash (its process gone, or empty and either over a minute old or written before the last boot) is set aside as `.local/bridge.lock.stale-<written>-<epoch>.json` on the next start. A lock whose pid is alive is always refused; if that pid now belongs to another program, the witchcraft-daemon skill's status action says so and its start action clears the lock. Closing the daemon's console window, or Ctrl+Break, stops it cleanly and releases the lock.

Alternative commands:

```powershell
node bin/witchcraft.js run --only claude
node bin/witchcraft.js run --only codex
node bin/witchcraft.js run --only copilot
node bin/witchcraft.js run --only agy
node bin/witchcraft.js run --with-copilot
node bin/witchcraft.js run --with-agy
node bin/witchcraft.js run --only claude -- 'C:\path\to\pwsh.exe' -NoLogo
node bin/witchcraft.js run --cols 120 --rows 40 --hz 1
```

The selected agent can still join or resume an existing session with `--only`; add `--no-current` to start fresh. To stop the companion itself, close its console window or press Ctrl+Break; Ctrl+C goes to the selected agent.

## GitHub Copilot CLI and Google Antigravity CLI (`agy`)

From this folder, run `node bin/witchcraft.js run --only copilot --cwd 'C:\path\to\project'` (or `--only agy`), or add `--with-copilot` / `--with-agy` to a normal run. `--tab copilot` and `--tab agy` only select the tab in the desktop terminal; without one of those opt-ins the run is refused. A `commands.copilot` or `commands.agy` entry in `.local/config.json` enables that agent on normal runs; `--only` still restricts launches to the named agent.

Copilot and AGY start new interactive sessions. Use `/resume` in the Copilot tab, or configure `commands.copilot.args` as `["--resume", "SESSION_ID"]` to resume a specific conversation. Witchcraft does not search Copilot's or AGY's private session files; model/context metadata and the **Copy last reply** shortcut are unavailable for these tabs. Screen output, scrollback, drafts, prompt history, terminal keys and screen-based choice detection work normally.

Recognized `copilot` / `copilot.exe` commands receive the WoW server via `--additional-mcp-config`, scoped to that launch. Existing arguments are preserved; no tool approval flags are added. `--no-mcp` skips injection. Windows npm installations are supported by resolving `@github/copilot`'s JavaScript bin from absolute PATH directories and running it with Node, without invoking a shell. Native `copilot.exe` takes priority. For AGY on Windows, the daemon searches absolute PATH entries and `%LOCALAPPDATA%\agy\bin\agy.exe`.

To mirror an existing console, use `--only copilot --attach copilot=PID` (or `copilot=pick`, or `copilot=~copilot` for the newest console running Copilot; likewise `agy=PID`, `agy=pick`, or `agy=~agy`). As with other attached consoles, configure MCP in that session yourself before attaching; Witchcraft cannot inject launch arguments into an existing process. See [Copilot MCP setup](../../docs/MCP.md#copilot-cli).

Update the addon and daemon together. The new addon accepts older two-tab and three-tab snapshots, while publishing four-tab snapshots when connected to a 0.4.0 daemon.

## Private local overlay

The desktop overlay is off by default. `run --overlay`, or `"overlay": true` in `.local/config.json`, starts it after the game link is up, and the link never waits for it. It is a same-machine presentation for the daemon's existing Claude, Codex, Copilot and AGY PTYs. It uses the pinned Electron runtime and one inherited process IPC channel; it does not open a TCP listener or take ownership of either terminal. Claude, Codex, Copilot and AGY have separate tabs (`Alt+1`, `Alt+2`, `Alt+3`, `Alt+4`). The background-opacity control runs from fully transparent to opaque while terminal text stays readable. HUD mode is click-through; `Ctrl+Shift+H` restores the interactive workbench. `--no-overlay` overrides a saved setting.

Overlay startup failure, renderer failure and bounded restart exhaustion leave the PTYs running. The daemon owns the overlay child; the overlay never owns or restarts the terminal processes.

Attached-console frames refresh the overlay using plain text, without the game's color tags. When any tab mirrors a console you own, Witchcraft stays active until explicitly stopped, including after the spawned agent exits. An entirely spawned set still ends when all launched agents exit. Shutdown cancels pending startup and retains the bridge lock until all acquired resources are cleaned up.

`witchcraft run` joins the sessions already running in `--cwd` unless `--no-current` is passed. The Claude tab mirrors the newest live interactive Claude Code session there, found in `~/.claude/sessions/<pid>.json`. The Codex tab launches `codex resume <id>` for the most recently written top-level Codex thread there, read from the first line of each rollout under `~/.codex/sessions`; subagent and `exec` threads are skipped, and folder names compare without case on Windows and macOS and with case on Linux. The VS Code Codex extension has no console to mirror, so this is a second client on its thread: both sides append to the same thread, and the extension's panel does not show turns typed in game until it reloads the thread. An explicit `--attach` or child command overrides discovery for that tab; `--only` leaves the other tabs stopped. A tab with nothing found starts fresh. The daemon window prints what it joined.

`--attach tab=~TEXT` names a console by what runs in it: the newest console whose running program or command line contains TEXT, ignoring case (`witchcraft consoles` shows both). A pattern that matches nothing stops the start. When a mirrored console closes, its tab reads `exited (console N closed)` and Witchcraft looks for a successor every five seconds: the joined Claude tab takes the newest live Claude session in `--cwd`, and a `~TEXT` tab the newest console matching TEXT. The tab then mirrors that console and takes input again, and the daemon window prints the new process. A tab attached by process id or `pick` stays closed until Witchcraft restarts.

Each published session also carries what the screen says the agent is doing (`state`: working while "esc to interrupt" shows, waiting while a marked numbered menu is on screen, with its `choices`, otherwise idle) and, from the agent's own session files, `info` (model, effort, context used and window) and its last `reply` as lines. Claude's come from its transcript, found through `~/.claude/sessions/<pid>.json`; Codex's from the resumed rollout or the newest thread in `--cwd`.

When the daemon advertises prompt protocol 1, the addon sends long and multiline drafts in a group of numbered frames bounded to 4,640 original UTF-8 bytes. Each frame identifies the first message ID, part number and total. The addon retains the complete group while the host buffers parts. The daemon reports the final outcome after the PTY adapter returns or the Windows console helper acknowledges writing the text and Enter to its native input buffer. Missing, partial or failed console writes leave the draft available for review. The receipt covers terminal input submission. Assistant processing can be checked in the terminal itself. Older addon versions can still use the legacy input format.

Attached-console lines wider than `--cols` (120 by default) continue on additional rows. Colors are retained in game, and rows above the visible screen remain in the bounded scrollback. This does not resize the source console. Restart the daemon after updating its code; `/reload` only reloads the addon.

History is bounded by both the per-session data allowance and the complete 1 MiB serialized chunk limit. If history would exceed that limit, the oldest rows are trimmed across the tabs while preserving their current screens. An oversized current screen is skipped; a later fitting snapshot resumes publication and all agent sessions remain alive.

Opt-in dense optical carrier probe:

```powershell
node bin/witchcraft.js burst-probe --timeout 30
```

While that command waits, return to foreground WoW and run `/witch burstprobe 1000`. The in-game dwell accepts 200 through 2000 ms; `/witch burstprobe corrupt` is the negative checksum control and `/witch burstprobe off` hides the extra rows. The probe is **Built / offline-tested / Native pending**. It validates data locally and never writes probe bytes to a PTY, acknowledges a context revision, or updates the MCP cache.

## Custom executable paths

An explicit child command replaces the initial tab's agent. Native executables are required; `.cmd` and `.bat` wrappers are not launched. For persistent custom paths, add `commands` to `.local/config.json` while retaining its calibration:

```json
{
  "commands": {
    "claude": { "file": "C:\\path\\to\\claude.exe", "args": [] },
    "codex": { "file": "C:\\path\\to\\codex.exe", "args": [] }
  }
}
```

If a CLI works in PowerShell but Witchcraft reports `Cannot find executable`, check whether the shell command resolves to a wrapper. Point `commands.<agent>.file` at the actual `.exe`. The daemon searches absolute `PATH` entries and also checks `%USERPROFILE%\.local\bin\claude.exe` for Claude and `%LOCALAPPDATA%\agy\bin\agy.exe` for AGY.

To mirror the same consoles on every run, add `attach` with the `--attach` forms (`PID`, `pick` or `~TEXT`). An attached tab ignores its `commands` entry; `--attach` on the command line overrides a tab, `--only` drops the other tabs' entries, and a child command drops its tab's:

```json
{
  "attach": { "claude": "~claude", "codex": "~codex" }
}
```

## Transport and lifecycle

For normal operation, the addon claims one verified-empty key from a fixed four-key allowlist, writes a canonical bounded frame with `SetBinding`, and asks the client to persist the current binding set. The host watches the configured account's `bindings-cache.wtf`, accepts only stable double reads with the expected session, sequence and checksum, and never edits the file. The addon advances only after the host acknowledgement arrives through the existing load-on-demand ring, then restores the exact prior binding and verifies readback. Any occupied key, binding-set change, malformed frame, acknowledgement jump or cleanup mismatch quarantines the carrier.

The carrier is fixed to Blizzard's binding configuration file and is treated as a supported local configuration path, not as arbitrary filesystem access. It must not be described as a Lua sandbox escape. When calibration is saved, the daemon uses one hidden PowerShell capture helper to read the calibrated 132 by 12 strip at five frames per second only while `WowB` is foreground, unless `--no-pixels` is supplied. While WoW is in the background the addon advertises the slot through the binding carrier instead, which is intended to keep the terminal updating; that path has not yet been validated in game. Calibration captures the virtual desktop once, analyzes it locally and stores only the strip coordinates. Recalibrate after moving the game window or changing resolution, display scaling or UI scale. The calibration capture is limited to sixteen million pixels across the virtual desktop; if a multi-monitor layout exceeds that limit, reduce its resolution or temporarily disable an extra display, then recalibrate in the layout you will use.

The standalone burst probe uses the same calibrated origin with a strict 132 by 144 capture profile: the normal two rows plus 22 probe rows. It accepts only a coherent whole page before passing its rows to the existing decoder. A torn, mixed, corrupted, misaligned or invalidly padded page is rejected. This profile is never selected by `run`.

Each CLI has its own PTY and headless xterm screen. Foreground colors, bold/dim and literal text become bounded WoW strings; unsupported non-BMP glyphs use placeholders. The daemon atomically replaces the next chunk requested by the game heartbeat on the strip or on the binding carrier. It does not advance through unused files on its own. Each payload contains every listed tab (AGY is listed only once it has been started), an input acknowledgement and the current UI nonce.

Input is routed only to the named PTY. Retransmissions are deduplicated within a daemon session. After a daemon restart, use `/witch pending`, `/witch inspect <id>`, and then `/witch resend <id>` or `/witch discard <id>` after checking the terminal. These commands operate on the complete retained group. SavedVariables are parsed as literal data and never evaluated. Terminal screen output is not written into SavedVariables.

The current node-pty 1.1.0 Windows adapter can retain a worker after the child has exited. Witchcraft verifies owned child PIDs have exited, releases its resources and lock, drains stdout/stderr, then ends the CLI host process. Cleanup failures produce a nonzero exit.

## Linux and macOS (experimental)

The strip reader also runs on **Linux** (when the client is an X11 or XWayland window under Proton/Wine) and on **macOS** (when the client is a native macOS or CrossOver/Wine `World of Warcraft` window). `capture/capture-strip.py` reads the game window (`XGetImage` via `libX11` + `libXRes` on Linux; `CGWindowListCopyWindowInfo` + `CGWindowListCreateImage` via `CoreGraphics` / `CoreFoundation` on macOS) and speaks the same JSON-lines protocol as the PowerShell helper. Run `calibrate` and `run` as on Windows.

**Linux and macOS testers wanted.** On macOS, grant **Screen Recording** permission to your terminal app (`System Settings > Privacy & Security > Screen Recording`) so `CoreGraphics` can read the game window pixels. If you try either platform, please open an issue with your OS version, session type, the `region.scale` that `calibrate` saved, and what worked or failed.

- On Linux, the game window is found by its title and accepted only when the X server reports that it belongs to a process named `wow*` (through libXRes and `/proc/<pid>/comm`; Wine names a process after its exe, such as `WowB.exe`). On macOS, the helper selects the largest normal-layer (`kCGWindowLayer == 0`) window whose app name starts with `World of Warcraft` (or is a Wine client exe name: `Wow`, `WowClassic`, `WowB`, `WowT`). On either platform, set `WITCHCRAFT_WINDOW_ID` to the game's window id to select a window explicitly.
- On Linux the helper keeps the window it found at start: restart `run` after restarting the game. On macOS it looks for the new game window by itself, unless `WITCHCRAFT_WINDOW_ID` pins one.
- Coordinates are relative to the game window, not the desktop. `calibrate` measures the window's upscale ratio from the strip and stores it as `region.scale`, so a client rendering below its window size (for example 2560x1440 in a 3840x2160 window, or a scaled Retina window) still decodes. Recalibrate after changing resolution, window size or UI scale.
- Keep overlays such as MangoHud off the top-left corner. While the game window is unmapped, minimized or partly off screen the helper reports idle, as it does when the game is not focused.
- A native Wayland game window cannot be read this way on Linux.
- Tested on one Linux machine: WoW Forever under GE-Proton on GNOME/XWayland, Claude tab only. On that client `bindings-cache.wtf` was written only at `/reload` or logout, so the binding carrier did not qualify and the strip carried all traffic; do not pass `--no-pixels` there.
- Win32 console mirroring (`--attach` / Windows `conhost` mirroring) is Windows-only; on macOS and Linux, `witchcraft run` automatically launches Claude and Codex directly in the daemon's own PTYs (while still resuming the newest Codex thread in `--cwd`).

## Trust boundary

Every addon enabled in the same client can type into every running agent session and read their transcripts while the daemon runs; WoW gives addons no isolation from one another. Treat enabling an addon as granting it a shell. Input decisions and carrier errors are logged without their text to `.local/events.log`.
