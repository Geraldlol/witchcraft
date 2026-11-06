# Changelog

## Unreleased

- Add an opt-in GitHub Copilot CLI tab in game and in the desktop overlay, with terminal input, console attachment, keyboard navigation, and session-only WoW MCP configuration.
- Support native and npm-installed Copilot on Windows; preserve the default Claude/Codex launch.
- Accept Copilot in pixel/binding transports and saved settings while preserving existing wire IDs. Update addon and daemon together.
- Add Node and Lua regression coverage for three-agent routing and lifecycle.


## 0.1.1 - 2026-11-04

- The optional cooldown carrier writes only after a host advertises it, revokes its lane immediately when that host disappears, and retries ownership-safe cleanup after the write-rate or combat gate clears. Logout and addon-disable cleanup bypass only Witchcraft's own write interval; native safety and exact-readback gates remain.
- The desktop overlay is opt-in with `--overlay` or local config and starts only after the game link, which never waits for Electron.
- Unchanged ring chunks are no longer rewritten every second, reducing idle disk and antivirus work.
- Windows Store `pwsh.exe` app-execution aliases now resolve without admitting `.cmd` or `.bat` wrappers.
- The daemon recognizes the Forever launch product `wowf` in `_forever_`; the default binding carrier still requires `/witch bindprobe`, while optional build-sensitive carriers retain their last qualified pin.
- MCP client/server 2.4.0, Electron 44.10.1, Zod 4.6.7 and transitive Undici 7.30.1 replace vulnerable locked versions; the release lockfile has no known npm advisories.

## 0.1.0

First public release: the Witchcraft addon (interface 16001) and its Windows daemon, with Claude and Codex tabs, session joining, WoW context over MCP, Guides, Adventures, alerts, choice buttons, settings page and desktop overlay.
