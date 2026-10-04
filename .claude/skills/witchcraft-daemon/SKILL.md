---
name: witchcraft-daemon
description: Use when the user asks to start, stop, restart, or check the Witchcraft WoW daemon (tools/witchcraft-daemon, `witchcraft run`, the Claude and Codex tabs inside WoW Forever), when a Witchcraft bridge.lock is stale or "A Witchcraft bridge owns" blocks a start, when daemon or MCP adapter code changed and must be reloaded, or before an in-game Witchcraft test session.
---

# Witchcraft daemon

The daemon is an interactive terminal, so it cannot run inside a tool call. The script opens
it in its own console window, stops it with a real Ctrl+C so it releases its lock cleanly,
and reports what the ring, cache and carrier files say from outside.

```powershell
& "<this skill's directory>\witchcraft-daemon.ps1" -Action <status|start|stop|restart> [options]
```

## Quick reference

| Need | Command |
|---|---|
| What is running, which mode, are the tabs up, is the cache fresh | `-Action status` |
| Start in the proven mode (screen strip bootstrap), joining current sessions: Claude tab mirrors the running Claude Code console in `-Cwd` (default: the current folder), Codex tab resumes the newest Codex thread there | `-Action start` |
| Start with new Claude and Codex sessions instead | `-Action start -Fresh` |
| Start without the strip: the cooldown carrier's heartbeat drives the ring (unproven in game) | `-Action start -Mode carrier` |
| One agent only, no overlay window | `-Action start -Only codex -NoOverlay` |
| Show a tab a console you started yourself, instead of launching that tab | `-Action start -Attach claude=<pid>` |
| Choose that console from a list in the daemon's window | `-Action start -Attach claude=pick` |
| Which consoles can be mirrored, and their process ids | `node bin/witchcraft.js consoles [--all]` in the daemon dir |
| Reload daemon or MCP adapter code after an edit | `-Action restart` |
| Clean stop; waits up to 15 s for the lock to go | `-Action stop` |
| Daemon hung after a clean stop failed | `-Action stop -Force` |
| Another checkout of the daemon | `-Repo <checkout>` or `-DaemonDir <path>` |
| Agents work in another folder | `-Cwd <path>` |
| "A Witchcraft bridge owns ... bridge.lock" on start | `-Action status` first: `stale lock` means `-Action start` clears it; `running pid` means a real daemon is up, so use it or `-Action restart` |

It finds the Witchcraft checkout from `-Repo`, then `$env:WITCHCRAFT_HOME`, then the checkout
this skill sits in (`.claude/skills/witchcraft-daemon` of a clone). A copy installed under
`~/.claude/skills` needs `-Repo` or `WITCHCRAFT_HOME`. The AddOns folder comes from the
checkout's `wow.config.json`, and status reads the character folder whose
`cooldownmanager.txt` is newest (`-AddonsDir` and `-CharacterDir` override them). Locks are
per-checkout, so a stale lock in one says nothing about another.

A mirrored tab is not launched by the daemon and is typed into from its own console window, not
from the daemon's terminal. Its colour is the sixteen ANSI colours, because that is all the
console API reports back; a spawned tab keeps full truecolour. Closing a mirrored console leaves
its tab showing the last screen, and the daemon keeps running.

## Reading status

- `daemon:` running pid and mode (`pixels`, `carrier`, or the default where the strip is read when calibrated), or why not. `stale lock` means the lock's process is gone
  and the next start clears it. `running pid` means a live daemon owns it; never `-Force`
  a live daemon without telling the user it ends their in-game sessions.
- `ring:` newest chunk, seconds since written, and the want and acknowledgement counters. A
  chunk more than ~10 s old with the game running means the strip heartbeat stopped, which
  in pixel mode means the game window is not in front.
- `tabs:` `running` for both is healthy; `not started` means the command table lost one.
- `context:` cache status and age of the player and quest snapshots.
- `cooldown file:` non-empty means a carrier frame is outstanding or was left behind.

## Common mistakes

- Stopping the daemon ends the in-game Claude and Codex sessions. Say so before doing it
  when the user is mid-conversation there.
- Each agent's MCP process loads adapter code at daemon start. An edit to
  `src/mcp-server.js` or `src/context-*.js` does nothing until `-Action restart`.
- Pixel mode reads the screen only while the game is the foreground window. Nothing moves
  while the user is in another window; that is not a fault.
- After any start the user must `/reload` in the game, then `/witch`.
- The default `-Mode pixels` reads a calibrated screen strip. Calibrate once first (`/witch calibrate` in game, then
  `node bin/witchcraft.js calibrate` in the daemon dir, then `/witch calibrate off`), or use `-Mode carrier`.
- `-Force` skips the daemon's cleanup. Afterwards check the game with `/witch status` for a
  cooldown lane refusal, and expect the ring cursor to restart from slot 1.
