# Warcraft's In-game Terminal for Claude's Hunches & Codex's Reckless Attempts at Fixing Things (WITCHCRAFT)

Claude Code and Codex CLI terminals inside **WoW Forever**: separate tabs, independent drafts, an input box addressed to the selected agent, and optional read-only game context (character, location, tracked quests, progress, Lua errors) shared with both assistants through MCP.

It has two parts:

| Part | Folder | What it does |
|---|---|---|
| Addon | `Witchcraft/` | The in-game window (`/witch`). |
| Daemon | `tools/witchcraft-daemon/` | A Windows companion that runs Claude Code and Codex in local terminals and relays them to and from the game. |
| MCP server | `tools/witchcraft-daemon/bin/witchcraft-mcp.js` | Gives Claude and Codex 15 WoW tools (12 read-only) over local STDIO. See [docs/MCP.md](docs/MCP.md). |
| Claude Code skill | `.claude/skills/witchcraft-daemon/` | Lets Claude start, stop, restart and check the daemon for you. |

## Requirements

- Windows 10 or 11.
- The WoW Forever client (interface `16001`).
- [Node.js](https://nodejs.org/) 24 or newer.
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and/or [Codex CLI](https://github.com/openai/codex), installed as native executables and already signed in.

## Install

1. **Download** the [latest release](https://github.com/Geraldlol/witchcraft/releases/latest) source code and unzip it somewhere permanent, or `git clone https://github.com/Geraldlol/witchcraft.git`.

2. **Install the addon.** Copy the `Witchcraft` folder into your client's `Interface\AddOns` folder. (The release's `Witchcraft-<version>.zip` contains just this folder.)

3. **Point the daemon at your client.** In the repository root, copy `wow.config.example.json` to `wow.config.json` and set `addonsDir` to the absolute path of that same `Interface\AddOns` folder. Use forward slashes or doubled backslashes.

4. **Set up the daemon.** In PowerShell, from `tools\witchcraft-daemon`:

   ```powershell
   npm.cmd ci --ignore-scripts --no-fund
   npm.cmd rebuild node-pty --ignore-scripts=false --foreground-scripts
   node node_modules/electron/install.js
   node -e "require('node-pty'); console.log(require('electron'))"
   node bin/witchcraft.js init --ring 3000
   ```

   `init` creates the `Witchcraft_Chunk_*` helper addons the daemon writes to. If you have more than one WoW account folder, add `--account NAME`.

5. **Restart WoW completely** (not just `/reload`) so it discovers the new addons and the bundled font.

## Use

**Calibrate the screen strip once.** Witchcraft talks to the daemon through a small pixel strip at the top-left of the game window, plus a faster local "fast link". The fast link turns itself off on any client build other than the one pinned in `Witchcraft/Evidence.lua` (currently 1.60.1.69977), and the game and daemon both tell you when that happens. The strip then carries everything, so calibrate it before your first run. In game, type `/witch calibrate`. With WoW visible, run this from `tools\witchcraft-daemon`:

```powershell
node bin/witchcraft.js calibrate
```

Then type `/witch calibrate off` in game. Recalibrate after moving the game window or changing resolution, display scaling or UI scale. The strip is only read while WoW is the foreground window.

Start the daemon from `tools\witchcraft-daemon`, pointing `--cwd` at the folder you want the agents to work in:

```powershell
node bin/witchcraft.js run --cwd 'C:\path\to\your\project'
```

By default the Claude tab mirrors the Claude Code session already running in that folder, and the Codex tab resumes your newest Codex thread there. `--no-current` starts fresh sessions instead.

In game:

- After starting the daemon, `/reload`, then `/witch` (or the minimap book button) to show the window.
- On the pinned build, run `/witch bindprobe` once per daemon/UI session to qualify the fast link.
- `/witch settings` opens the options page, and `/witch status` shows the connection.

## WoW tools (MCP)

Terminals Witchcraft launches get the WoW MCP tools automatically (`--no-mcp` turns that off). A Claude Code session the Claude tab *joins* needs them registered once, from `tools\witchcraft-daemon`; then restart that Claude session and Witchcraft:

```powershell
node bin/witchcraft.js mcp-setup --apply --cwd 'C:\path\to\your\project'
```

Then ask either assistant something like: "Use the WoW tools to tell me where I am and what remains for my tracked quests." Any other MCP client can run the server directly with `node <repo>/tools/witchcraft-daemon/bin/witchcraft-mcp.js`. [docs/MCP.md](docs/MCP.md) lists every tool and explains sharing, freshness and the three local-write tools.

## Claude Code skill

`.claude/skills/witchcraft-daemon` lets Claude manage the daemon. The daemon is an interactive terminal, so the skill opens it in its own window, stops it cleanly, and reports on the lock, chunk ring and context cache. It needs PowerShell 7 (`pwsh`).

- Claude Code sessions started inside this repository pick it up automatically.
- To use it from your own projects, copy the folder to `%USERPROFILE%\.claude\skills\` and set `WITCHCRAFT_HOME` to this repository's path (or pass `-Repo`).

Then ask Claude to "start Witchcraft" or "check the Witchcraft daemon". By default the agents work in, and join sessions from, the folder Claude is running in.

See [`Witchcraft/README.md`](Witchcraft/README.md) for the full in-game guide and [`tools/witchcraft-daemon/README.md`](tools/witchcraft-daemon/README.md) for daemon options, transport details and troubleshooting.

## Security and privacy

- **Every addon you have enabled can type into both agent sessions and read their output while the daemon runs.** WoW gives addons no isolation from one another. Only run Witchcraft alongside addons you trust as much as a shell.
- The daemon opens no network listener. It talks to the game through files on your own machine (plus a screen capture of a small pixel strip in the optional `--pixels` mode).
- To join and describe your sessions, it reads Claude Code and Codex session records under `~/.claude` and `~/.codex` on your machine. It does not send them anywhere.
- Game context is shared only while **WoW context** sharing is on (footer panel or `/witch context off`). Whatever you or the tools give Claude or Codex is sent to those services under their own terms.
- Local state (calibration, logs, saved goals) lives in `tools/witchcraft-daemon/.local/`, which git ignores.

## Updating and uninstalling

- **Update:** replace the `Witchcraft` addon folder and this repository's files, run `npm.cmd ci` again if `package-lock.json` changed, restart the daemon, then `/reload` in game.
- **Uninstall:** stop the daemon, then delete `Witchcraft` and every `Witchcraft_Chunk_*` folder from `Interface\AddOns`. You can also delete the account's `SavedVariables\Witchcraft.lua`.

## License

[MIT](LICENSE). Bundled third-party components keep their own licenses: Ace3 and CallbackHandler ([BSD-style](Witchcraft/Libs/LICENSE-Ace3.txt)), LibStub (public domain), and DejaVu Sans Mono ([font license](Witchcraft/Media/LICENSE-DejaVu.txt)). npm dependencies are installed from `package-lock.json` under their own licenses.

Guide and adventure data are small, source-linked references built from Classic data. They have not been verified against WoW Forever.

Witchcraft is a fan project. It is not affiliated with or endorsed by Blizzard Entertainment, Anthropic or OpenAI.
