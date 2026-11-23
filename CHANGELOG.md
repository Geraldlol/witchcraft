# Changelog

## Unreleased

- Add experimental macOS (`darwin`) support: `capture/capture-strip.py` now includes a Quartz/CoreGraphics window reader (`CGWindowListCopyWindowInfo` / `CGWindowListCreateImage`), `resolveProgram` checks POSIX `~/.local/bin/claude` and macOS Antigravity paths, default `run` on macOS/Linux launches Claude in its PTY instead of invoking Windows console mirroring, and CI runs the portable daemon and capture suite on `macos-latest` and `ubuntu-latest` alongside `windows-latest`.
- Add Google Antigravity CLI (`agy`, tab **AGY**) as a fourth agent tab across the addon, daemon (`--only agy`, `--with-agy`, `--attach agy=...`, `commands.agy`), desktop overlay (`Alt+4`) and `witchcraft-daemon` management skill, with automatic Windows `%LOCALAPPDATA%\agy\bin\agy.exe` discovery and AGY slash-command menu entries.
- Add in-window **Agent tabs** quick-toggle buttons (`CLAUDE`, `CODEX`, `COPILOT`, `AGY`) inside the **... (Appearance)** popover, a `/witch tab <claude|codex|copilot|agy> [on|off]` (`/witch tabs`) slash command, and the **AGY tab** option under `Esc > Options > AddOns > Witchcraft > Tabs` so you can show or hide tabs for whichever agents you use.
- Add the session journal (`wow_get_session_log`, `witchcraft journal [--clear]`, and `/witch context clear-journal`): the daemon diffs persisted context revisions into a bounded local journal (level-ups, zone changes, tracked quest changes and objective progress, money deltas, instance enter/leave, death/ghost/revive and group size) with cross-process clear markers, clear-generation fencing and lock-ownership verification. `wow_get_session_log` defaults to the current session and character, labels each event with its `epoch`, `uiNonce` and `character` origin, supports explicit `includeHistory` and `character` filters, and notes when context sharing is paused.
- Stand the pixel strip aside for context frames while the binding carrier is active outside combat, and let the optical strip take over automatically after a failed key claim or a 5-second binding acknowledgement timeout.
- Add opt-in automatic binding carrier qualification (`Probe binding carrier on connect` under Options > Terminal, or `/witch bindprobe auto|off`, releasing any unacknowledged probe key when turned off) and in-game terminal width requests (`/witch cols <40-160|fit>`) over a dedicated daemon control action that expires across host restarts.
- Long and multiline prompts retain their complete draft across host restarts. Review retained input before deciding to resend.
- Each updated bridge takes a lock for its target client. The same lock serializes ring setup, cleanup and bridge shutdown across installations.
- `witchcraft doctor` diagnoses setup and connection progress, with a redacted JSON report.
- `/witch errors watch` follows a selected error across reloads. Players can mark reproduction attempts and compare recurrence counts.
- The public CI runs the addon and daemon regression suites. Tagged builds produce a verified addon ZIP for manual publication.
- Short prompts from the input box now use the delivery receipt with a current daemon, so one that could not be delivered stays in the outbox for `/witch resend`; an input-box line over 600 bytes is sent as a multi-part prompt instead of being refused. An older daemon keeps the plain send, also for a short retained prompt that is resent, and still refuses a line over 600 bytes.
- Pasted text is cleaned before sending again: line ends become newlines, each tab becomes four spaces and other control bytes are removed, so a draft with tabs is no longer refused.
- Turning off **Probe binding carrier on connect** now stops only a binding carrier that option qualified; one qualified by hand with `/witch bindprobe` stays up until `/witch bindprobe off`.
- `/witch errors status` says when startup errors overflowed the 20-entry buffer before SavedVariables loaded, since the watched error's counts from that load on may then be incomplete. The mark is saved with the watch and names the first such UI load.
- Daemon: `wow_get_session_log` answers `waiting` until the current game session is known, instead of serving the last stored character's events as current; an event recorded while the journal is being cleared is kept.
- Daemon: a not-started AGY tab is no longer listed to the addon, so the 0.3.1 addon keeps working with a current daemon. Take the addon and the daemon from the same revision; the AGY tab needs addon 0.4.0 or later.
- Daemon: `init` builds each helper folder completely before putting it in place and names an incomplete folder to remove; a start clears old helper slots above a smaller ring; `doctor` reports another installation holding the client's ring lock before advising a start.
- Daemon: Codex session resume compares project paths with case on Linux; ring lock recovery judges the lock again before setting it aside, and a dead recovery claim no longer blocks later starts; the macOS reader reads the window list once per cycle and reads again when the display scale changed under an unmoved window.
- Daemon: ring lock recovery keeps the lock it judged, and a recovery claim it judged, open until it has set them aside, so a new owner's file cannot take their identity in between.
- Daemon: the session journal's clear markers are separate files that cannot move back, so a clear that lost its lock and lands late no longer replaces a newer clear. Restart running MCP clients after updating: an adapter from before this change does not read the new markers.

## 0.3.1 - 2026-11-22

- Move the optional production cooldown carrier's exact-build gate from Forever `1.60.1.70205` to `1.60.1.71037` after a build-matched UI-source comparison and user-confirmed in-game operation on 71037.
- Keep the default binding carrier and calibrated screen strip unchanged; the cooldown carrier still fails closed on every other build.
- Correct earlier wording: AddOns-state is a dormant source-only prototype, not a loaded, daemon-connected or runtime-qualified production transport.

## 0.3.0 - 2026-11-18

- Experimental Linux support for the strip reader, contributed by @josephrclick: on Linux the daemon reads the game's X11 or XWayland window (Wine or Proton) through a small Python helper (`python3`, `libX11`, `libXRes`). `calibrate` measures the window's upscale ratio and stores it as `region.scale`, so a client rendering below its window size still decodes. The window must belong to a `wow*` process (Wine names it after the exe); `WITCHCRAFT_WINDOW_ID` selects it explicitly. Joining a running console still needs Windows (`--no-current`). **Linux testers wanted:** this has run on one machine, and the fixes made after review are covered by unit tests only. Windows behaviour is unchanged.
- Background operation: while WoW is not the foreground window the addon advertises its ring slot through the binding carrier (a seq-0 heartbeat frame), so the terminal keeps updating without the pixel strip. The strip stays preferred while it is seen; the file lane takes over after a second of strip silence, and every chunk names the lane in use (`/witch status` shows `cursor <lane>`). Not yet validated in game.
- `--attach tab=~TEXT` mirrors the newest console running TEXT, and `attach` in `.local/config.json` makes that the default. A mirrored console that closes is followed to its successor (the joined Claude session, or the newest `~TEXT` match) instead of staying dead until a restart. The daemon's own consoles never answer a pattern.
- A stalled ring retry backs off from 2 s to a 30 s ceiling instead of retrying every 2 s; the footer warns at 90% of the ring; an exhausted ring no longer reloads the UI on its own but asks first (`/witch reload` or the confirmation dialog).
- Per-tab show/hide settings in a new Tabs section of the Options page. A hidden tab is not drawn, cycled or selectable; at least one tab stays visible, and hiding the active tab moves the selection.
- The Copilot tab is an ordinary tab setting, off by default. The addon switches it on once per host session when the daemon starts Copilot (a chat line names Options > Tabs), and it stays as you set it afterwards. The old show-while-selected and last-tab rules are gone; one tab always stays visible.

## 0.2.0 - 2026-11-06

- Add an opt-in GitHub Copilot CLI tab in game and in the desktop overlay, with terminal input, console attachment, keyboard navigation, and session-only WoW MCP configuration.
- Support native and npm-installed Copilot on Windows; preserve the default Claude/Codex launch.
- Accept Copilot in pixel/binding transports and saved settings while preserving existing wire IDs. Update addon and daemon together.
- Add Node and Lua regression coverage for three-agent routing and lifecycle.
- `--tab copilot` only selects the tab; a `--tab` that names a terminal with no launch is refused with a hint naming the opt-ins (`--only copilot`, `--with-copilot`, a configured `commands.copilot`).
- The Copilot tab stays hidden in game until it is selected or its session has started; the daemon banner names the launched tabs.
- The addon refuses input to a tab the connected host does not list, drops such queued messages on `Resend` and on the next accepted chunk, cancels a binding-carrier transmission of a dropped message, and a saved Copilot selection falls back to Claude on a two-session host.
- `Resend` checks the message-ID capacity before touching the saved queue.
- The desktop overlay's record and pending budgets scale with the tab count.
- An absolute configured Windows command path keeps its previous behaviour; PATH-derived candidates must still be `.exe`.

## 0.1.1 - 2026-11-04

- The optional cooldown carrier writes only after a host advertises it, revokes its lane immediately when that host disappears, and retries ownership-safe cleanup after the write-rate or combat gate clears. Logout and addon-disable cleanup bypass only Witchcraft's own write interval; native safety and exact-readback gates remain.
- The desktop overlay is opt-in with `--overlay` or local config and starts only after the game link, which never waits for Electron.
- Unchanged ring chunks are no longer rewritten every second, reducing idle disk and antivirus work.
- Windows Store `pwsh.exe` app-execution aliases now resolve without admitting `.cmd` or `.bat` wrappers.
- The daemon recognizes the Forever launch product `wowf` in `_forever_`; the default binding carrier still requires `/witch bindprobe`, while optional build-sensitive carriers retain their last qualified pin.
- MCP client/server 2.4.0, Electron 44.10.1, Zod 4.6.7 and transitive Undici 7.30.1 replace vulnerable locked versions; the release lockfile has no known npm advisories.

## 0.1.0

First public release: the Witchcraft addon (interface 16001) and its Windows daemon, with Claude and Codex tabs, session joining, WoW context over MCP, Guides, Adventures, alerts, choice buttons, settings page and desktop overlay.
