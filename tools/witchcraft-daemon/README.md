# Witchcraft daemon

Windows companion for the Witchcraft WoW addon. Requires Node 24 or newer and at least one installed, authenticated Claude Code, Codex CLI or GitHub Copilot CLI installation. The default command starts Claude and Codex; use `--only claude`, `--only codex` or `--only copilot` for one, or `--with-copilot` for all three. Dependencies are pinned in `package-lock.json`.

The WoW MCP bridge adds five read-only game-context tools (context, character, quests, progress and Lua errors) and the `wow://context` resource to recognized Claude/Codex/Copilot launches. Guides and Adventures add reference search, quest hints, loot planning, dungeon practice, zone detours and personal campaigns. Fifteen tools are exposed in total: twelve read-only and three explicitly writable local goals/passport tools. The Claude tab joins your own running Claude Code session by default, which Witchcraft did not launch: give it the tools once with `node bin/witchcraft.js mcp-setup --apply` (local scope, sessions started in this checkout only; add the same `--cwd` you give `run`), then restart that session and Witchcraft. Running it again when the same server is registered only repeats the restart advice. The daemon window and the in-game footer say when a joined session lacks the tools, and follow a Claude session restarted in the mirrored console. Its default addon-to-host path is the local binding carrier described below; terminal input always takes priority. `run --no-mcp` opts out of launch-time MCP configuration. The in-game **WoW context** panel controls data sharing. Existing daemon/assistant processes must be restarted or resumed to load this extension.

## Setup

From this repository's `tools/witchcraft-daemon` folder:

```powershell
npm.cmd ci --ignore-scripts --no-fund
npm.cmd rebuild node-pty --ignore-scripts=false --foreground-scripts
node node_modules/electron/install.js
node -e "require('node-pty'); console.log(require('electron'))"
node bin/witchcraft.js init --ring 3000
```

Install scripts stay off for the whole tree. The two reviewed packages that need setup are handled
explicitly: node-pty's install script runs through `rebuild` (the explicit `--ignore-scripts=false`
matters: a user-level `ignore-scripts=true` otherwise makes `rebuild` succeed without running it),
and Electron's binary is fetched by its installer against the `checksums.json` pinned in the locked
package, rather than on first launch. The `node -e` check fails unless both artifacts are in place.
The release lockfile passes `npm audit` with no known vulnerabilities.

The repository root's `wow.config.json` (copy `wow.config.example.json`; it is git-ignored) must identify the intended `Interface/AddOns` directory. Account selection is automatic only when one account directory exists; otherwise add `--account NAME`. Local calibration and preferences go in ignored `.local/config.json`.

`init` creates marked load-on-demand addons. Existing marked slots are preserved unless `--clean` is explicitly supplied. All reserved folders are checked before writing; unrelated or unmarked folders cause refusal and are left untouched. `--clean` recreates only validated owned slots. Stop the daemon before reinitializing. Restart WoW after adding slots; `/reload` alone does not discover new addons or fonts.

Start both agents in a terminal:

```powershell
node bin/witchcraft.js run --cwd 'C:\path\to\your\project'
```

Run `/witch bindprobe` once out of combat for each new daemon/UI session. The default binding carrier is not build-pinned; its qualification is complete only when Witchcraft prints that host decode, acknowledgement and exact cleanup all succeeded. The probe refuses occupied keys, combat, binding-set changes and any readback mismatch. The optional cooldown and addon-state carriers remain pinned in [`Witchcraft/Evidence.lua`](../../Witchcraft/Evidence.lua) (currently 1.60.1.70205) and stay off on another build. Keep the screen strip calibrated as a separate fallback.

Calibrate the screen strip before your first run. Once calibration is saved, ordinary `run` also reads the strip, providing a fallback when a file carrier cannot operate. In WoW, run `/witch calibrate`, keep the top-left strip visible and uncovered, then run:

```powershell
node bin/witchcraft.js calibrate
```

Return to WoW and run `/witch calibrate off` after calibration. Start the daemon with the `run` command above, then `/reload` in game. Calibration captures the virtual desktop once; ongoing strip capture runs only while `WowB` is the foreground process. It pauses when you switch to another window. `--no-pixels` disables capture, so use it only when a separately configured file carrier can keep the connection moving.

Use `/witch` in game. Ctrl+] switches the real terminal between agents; the game tabs select independently. Closing all launched CLI sessions stops the daemon. Ordinary Ctrl+C is passed to the selected CLI. A second daemon is rejected by `.local/bridge.lock`, which names the running pid. A lock left by a crash (its process gone, or empty and either over a minute old or written before the last boot) is set aside as `.local/bridge.lock.stale-<written>-<epoch>.json` on the next start. A lock whose pid is alive is always refused; if that pid now belongs to another program, the witchcraft-daemon skill's status action says so and its start action clears the lock. Closing the daemon's console window, or Ctrl+Break, stops it cleanly and releases the lock.

Alternative commands:

```powershell
node bin/witchcraft.js run --only claude
node bin/witchcraft.js run --only codex
node bin/witchcraft.js run --only copilot
node bin/witchcraft.js run --with-copilot
node bin/witchcraft.js run --only claude -- 'C:\path\to\pwsh.exe' -NoLogo
node bin/witchcraft.js run --cols 120 --rows 40 --hz 1
```

The selected agent can still join or resume an existing session with `--only`; add `--no-current` to start fresh. To stop the companion itself, close its console window or press Ctrl+Break; Ctrl+C goes to the selected agent.

## GitHub Copilot CLI

From this folder, run `node bin/witchcraft.js run --only copilot --cwd 'C:\path\to\project'`, or add `--with-copilot` to a normal run. `--tab copilot` only selects the tab in the desktop terminal; without one of those opt-ins the run is refused. A `commands.copilot` entry in `.local/config.json` enables it on normal runs; `--only` still restricts launches to the named agent.

Copilot starts a new interactive session. Use `/resume` in the Copilot tab, or configure `commands.copilot.args` as `["--resume", "SESSION_ID"]` to resume a specific conversation. Witchcraft does not search Copilot's private session files; model/context metadata and the **Copy last reply** shortcut are unavailable for this tab. Screen output, scrollback, drafts, prompt history, terminal keys and screen-based choice detection work normally. Use a current Copilot CLI for the slash-command menu; older releases may omit commands such as `/resume` or `/compact`.

Recognized `copilot` / `copilot.exe` commands receive the WoW server via `--additional-mcp-config`, scoped to that launch. Existing arguments are preserved; no tool approval flags are added. `--no-mcp` skips injection. Windows npm installations are supported by resolving `@github/copilot`'s JavaScript bin from absolute PATH directories and running it with Node, without invoking a shell. Native `copilot.exe` takes priority.

To mirror an existing console, use `--only copilot --attach copilot=PID` (or `copilot=pick`, or `copilot=~copilot` for the newest console running Copilot). As with other attached consoles, configure MCP in that Copilot session yourself before attaching; Witchcraft cannot inject launch arguments into an existing process. See [Copilot MCP setup](../../docs/MCP.md#copilot-cli).

Update the addon and daemon together. The new addon accepts older two-tab snapshots, but older addons cannot consume the new three-tab snapshots.

## Private local overlay

The desktop overlay is off by default. `run --overlay`, or `"overlay": true` in `.local/config.json`, starts it after the game link is up, and the link never waits for it. It is a same-machine presentation for the daemon's existing Claude, Codex and Copilot PTYs. It uses the pinned Electron runtime and one inherited process IPC channel; it does not open a TCP listener or take ownership of either terminal. Claude, Codex and Copilot have separate tabs (`Alt+1`, `Alt+2`, `Alt+3`). The background-opacity control runs from fully transparent to opaque while terminal text stays readable. HUD mode is click-through; `Ctrl+Shift+H` restores the interactive workbench. `--no-overlay` overrides a saved setting.

Overlay startup failure, renderer failure and bounded restart exhaustion leave the PTYs running. The daemon owns the overlay child; the overlay never owns or restarts the terminal processes.

Attached-console frames refresh the overlay using plain text, without the game's color tags. When any tab mirrors a console you own, Witchcraft stays active until explicitly stopped, including after the spawned agent exits. An entirely spawned set still ends when all launched agents exit. Shutdown cancels pending startup and retains the bridge lock until all acquired resources are cleaned up.

`witchcraft run` joins the sessions already running in `--cwd` unless `--no-current` is passed. The Claude tab mirrors the newest live interactive Claude Code session there, found in `~/.claude/sessions/<pid>.json`. The Codex tab launches `codex resume <id>` for the most recently written top-level Codex thread there, read from the first line of each rollout under `~/.codex/sessions`; subagent and `exec` threads are skipped, and folder names compare without case. The VS Code Codex extension has no console to mirror, so this is a second client on its thread: both sides append to the same thread, and the extension's panel does not show turns typed in game until it reloads the thread. An explicit `--attach` or child command overrides discovery for that tab; `--only` leaves the other tab stopped. A tab with nothing found starts fresh. The daemon window prints what it joined.

`--attach tab=~TEXT` names a console by what runs in it: the newest console whose running program or command line contains TEXT, ignoring case (`witchcraft consoles` shows both). A pattern that matches nothing stops the start. When a mirrored console closes, its tab reads `exited (console N closed)` and Witchcraft looks for a successor every five seconds: the joined Claude tab takes the newest live Claude session in `--cwd`, and a `~TEXT` tab the newest console matching TEXT. The tab then mirrors that console and takes input again, and the daemon window prints the new process. A tab attached by process id or `pick` stays closed until Witchcraft restarts.

Each published session also carries what the screen says the agent is doing (`state`: working while "esc to interrupt" shows, waiting while a marked numbered menu is on screen, with its `choices`, otherwise idle) and, from the agent's own session files, `info` (model, effort, context used and window) and its last `reply` as lines. Claude's come from its transcript, found through `~/.claude/sessions/<pid>.json`; Codex's from the resumed rollout or the newest thread in `--cwd`.

A multi-line prompt reaches the outbox as ordinary text parts: newlines travel as U+2028 and every part but the last starts with U+2063. The outbox joins a tab's parts (at most 8 KB) and writes them as one bracketed paste followed by Enter; a mirrored console types the same characters.

Attached-console lines wider than `--cols` (120 by default) continue on additional rows. Colors are retained in game, and rows above the visible screen remain in the bounded scrollback. This does not resize the source console. Restart the daemon after updating its code; `/reload` only reloads the addon.

History is bounded by both the per-session data allowance and the complete 1 MiB serialized chunk limit. If history would exceed that limit, the oldest rows are trimmed across the tabs while preserving their current screens. An oversized current screen is skipped; a later fitting snapshot resumes publication and both agent sessions remain alive.

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

If a CLI works in PowerShell but Witchcraft reports `Cannot find executable`, check whether the shell command resolves to a wrapper. Point `commands.<agent>.file` at the actual `.exe`. The daemon searches absolute `PATH` entries and also checks `%USERPROFILE%\.local\bin\claude.exe` for Claude.

To mirror the same consoles on every run, add `attach` with the `--attach` forms (`PID`, `pick` or `~TEXT`). An attached tab ignores its `commands` entry; `--attach` on the command line overrides a tab, `--only` drops the other tabs' entries, and a child command drops its tab's:

```json
{
  "attach": { "claude": "~claude", "codex": "~codex" }
}
```

## Transport and lifecycle

For normal operation, the addon claims one verified-empty key from a fixed four-key allowlist, writes a canonical bounded frame with `SetBinding`, and asks the client to persist the current binding set. The host watches the configured account's `bindings-cache.wtf`, accepts only stable double reads with the expected session, sequence and checksum, and never edits the file. The addon advances only after the host acknowledgement arrives through the existing load-on-demand ring, then restores the exact prior binding and verifies readback. Any occupied key, binding-set change, malformed frame, acknowledgement jump or cleanup mismatch quarantines the carrier.

The carrier is fixed to Blizzard's binding configuration file and is treated as a supported local configuration path, not as arbitrary filesystem access. It must not be described as a Lua sandbox escape. When calibration is saved, the daemon uses one hidden PowerShell capture helper to read the calibrated 132 by 12 strip at five frames per second only while `WowB` is foreground, unless `--no-pixels` is supplied. Calibration captures the virtual desktop once, analyzes it locally and stores only the strip coordinates. Recalibrate after moving the game window or changing resolution, display scaling or UI scale. The calibration capture is limited to sixteen million pixels across the virtual desktop; if a multi-monitor layout exceeds that limit, reduce its resolution or temporarily disable an extra display, then recalibrate in the layout you will use.

The standalone burst probe uses the same calibrated origin with a strict 132 by 144 capture profile: the normal two rows plus 22 probe rows. It accepts only a coherent whole page before passing its rows to the existing decoder. A torn, mixed, corrupted, misaligned or invalidly padded page is rejected. This profile is never selected by `run`.

Each CLI has its own PTY and headless xterm screen. Foreground colors, bold/dim and literal text become bounded WoW strings; unsupported non-BMP glyphs use placeholders. The daemon atomically replaces the next chunk requested by the game heartbeat. It does not advance through unused files on its own. Each payload contains all three tabs, an input acknowledgement and the current UI nonce.

Input is routed only to the named PTY. Retransmissions are deduplicated within a daemon session. Restarting the daemon creates a new session identifier; retained older input requires `/witch resend`. SavedVariables are parsed as literal data and never evaluated. Terminal screen output is not written into SavedVariables.

The current node-pty 1.1.0 Windows adapter can retain a worker after the child has exited. Witchcraft verifies owned child PIDs have exited, releases its resources and lock, drains stdout/stderr, then ends the CLI host process. Cleanup failures produce a nonzero exit.

## Trust boundary

Every addon enabled in the same client can type into every running agent session and read their transcripts while the daemon runs; WoW gives addons no isolation from one another. Treat enabling an addon as granting it a shell. Input decisions and carrier errors are logged without their text to `.local/events.log`.
