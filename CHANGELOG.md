# Changelog

## Unreleased

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
