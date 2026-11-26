# WITCHCRAFT

**Warcraft's In-game Terminal for Claude's Hunches & Codex's Reckless Attempts at Fixing Things**

[![Latest release](https://img.shields.io/github/v/release/Geraldlol/witchcraft?label=release)](https://github.com/Geraldlol/witchcraft/releases/latest)
[![CI](https://github.com/Geraldlol/witchcraft/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Geraldlol/witchcraft/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/Geraldlol/witchcraft)](LICENSE)

https://github.com/user-attachments/assets/4ae5190a-4871-4f89-a894-2df423aef8a5

*Real time, uncut: asking Claude about the character from inside the game, then having it fix a Lua error in another addon without ever alt-tabbing out of WoW.*

Witchcraft puts **Claude Code, Codex CLI, GitHub Copilot CLI and Google Antigravity (`agy`)** in a window inside WoW Forever. These are the real CLI sessions running on your machine, and the addon is a movable terminal onto them. Ask what's left on your tracked quests while you sit on a flight path, or hand an agent the Lua error that just popped up and keep playing while it patches your addon.

*Profession: Prompt Engineering (1/300).*

[Download](https://github.com/Geraldlol/witchcraft/releases/latest) · [Install](#install) · [First run](#first-run) · [WoW MCP tools](docs/MCP.md) · [Changelog](CHANGELOG.md) · [Help & feedback](#help-and-feedback)

Witchcraft is **free and open source (MIT)**. You bring your own Claude Code, Codex, Copilot or Antigravity account, on whatever plan you already have.

---

## What you can do with it

- **Run up to four agents side by side.** Claude, Codex, Copilot and AGY each get a tab with colored terminal output, scrollback, prompt history and their own unsent draft. If you only use one or two, hide the others from **... (Appearance) > Agent tabs**, with `/witch tab`, or on the AddOns Options page.
- **Carry on the conversation you already have open.** Point Witchcraft at a project folder and it joins what is there instead of starting from nothing. On Windows the Claude tab mirrors the Claude Code console you already have running in that folder, and on every platform the Codex tab resumes your latest thread there.
- **Answer terminal prompts without leaving the game.** Permission prompts and model pickers turn into numbered buttons above the input box. There is a `/` slash-command menu, arrow, Escape and Interrupt keys, unread badges on the tabs, and an optional raid-warning ping when an agent finishes a turn or needs an answer.
- **Write proper prompts.** Shift-click items, quests and spells into your message, write multi-line prompts of up to about 4,600 bytes, save the ones you reuse as snippets, search the scrollback, or copy the agent's last reply with one click.
- **Let your agents see your character.** Local MCP tools give them your character, zone, tracked quests, gold, XP and rested bonus, your group, and a session journal of recent milestones (`wow_get_session_log`). There is also a Lua error log (`wow_get_errors`), so an agent can read a stack trace and check across `/reload`s that its fix held.
- **Try Guides and Adventures.** Ask for a spoiler-light nudge on a quest, keep a dungeon loot wishlist, rehearse boss fights as tank, healer or DPS, look up detours near your zone, and stamp a personal campaign passport. The built-in catalog is Classic reference material (Defias quests, Deadmines, Wailing Caverns and Shadowfang Keep), so Forever's custom changes are not verified in it.
- **Make the window yours.** Resize, minimize, dock or lock it. Set the font size, overall scale (`/witch scale 80-140`), terminal width (`/witch cols fit`), background opacity and frame strata, fade the window while it is unfocused, choose whether it stays open, minimizes or hides in combat, pause updates during combat, or open the optional Electron overlay on your desktop.

## How it works under the hood

WoW addons can't open network sockets or start processes, and that is how it should be. So Witchcraft moves data in and out of the game the long way round, all of it on your own machine:

1. **Desktop to game.** `init` generates a ring of tiny load-on-demand helper addons (`Witchcraft_Chunk_*`). When terminal output changes, the desktop daemon writes the latest screen into the next chunk and WoW loads it on the fly, so there is no `/reload` per message. The ring does fill up eventually, and Witchcraft tells you at 90% that a reload will be needed soon.
2. **Game to desktop.** Your prompts, keypresses and context snapshots have three ways out:
   - **Pixel strip (the default).** A **132 × 12 pixel strip** in the top-left corner, which the daemon reads off the screen. It works in combat, but only while WoW is the focused, uncovered window.
   - **Log lane (opt-in, since 0.5.0).** `/witch filelane log`, then `/reload`, sends everything through the client's own log file (`Logs/General.log`). It works in combat and while the game is in the background, and it lets you hide the strip (`/witch strip fallback`) or turn it off (`/witch strip off`). The cost is log volume: about 45 MB an hour while idle and about 5 MB a minute while an agent prints. The client empties the file at each start.
   - **Keybinding link.** Out of combat, messages travel through a temporary WoW keybinding on a key that Witchcraft has verified is empty (`bindings-cache.wtf`), which it restores as soon as the message is acknowledged. On client build `1.60.1.71037` the client writes that file only at `/reload`, so this link cannot carry prompts there.

   An optional Cooldown Viewer carrier is enabled on exact client build `1.60.1.71037` and stays off on every other build.

## What's in the repo

| Component | Location | What it does |
|---|---|---|
| **WoW addon** | [`Witchcraft/`](Witchcraft/) | The in-game terminal window, UI controls, error recorder, and context capture. |
| **Desktop daemon & overlay** | [`tools/witchcraft-daemon/`](tools/witchcraft-daemon/) | Runs on your computer to connect WoW to local Claude, Codex, Copilot, and AGY sessions. |
| **WoW MCP server** | [`witchcraft-mcp.js`](tools/witchcraft-daemon/bin/witchcraft-mcp.js) | Local STDIO server with 13 read-only WoW tools and 3 optional wishlist/passport tools. |
| **Claude Code skill** | [`.claude/skills/witchcraft-daemon/`](.claude/skills/witchcraft-daemon/) | Lets you ask Claude to start, stop, restart, or check the daemon for you (Windows + `pwsh`). |

The `Witchcraft-X.Y.Z.zip` on the [releases page](https://github.com/Geraldlol/witchcraft/releases/latest) contains the addon. Clone the repo or download **Source code (zip)** for the matching daemon. Versions 0.5.1 and later also support installing the daemon from an npm tarball.

---

## Requirements

- **WoW Forever** client (interface `16001`). Other WoW clients aren't supported.
- **Operating system:**
  - **Windows 10 or 11** is the primary, tested setup.
  - **macOS and Linux are experimental.** macOS reads the `World of Warcraft` window through Quartz/CoreGraphics and needs **Screen Recording** permission for your terminal app. Linux reads the X11/XWayland window under Wine or Proton (`python3`, `libX11`, `libXRes`). See the [Linux and macOS notes](tools/witchcraft-daemon/README.md#linux-and-macos-experimental). If you try either one, a report of how it went is very welcome.
- **[Node.js](https://nodejs.org/) 24 or newer.**
- At least one supported CLI, installed and signed in:
  - [Claude Code](https://code.claude.com/docs/en/overview) (`claude`)
  - [Codex CLI](https://github.com/openai/codex) (`codex`)
  - [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started) (`copilot`)
  - Google Antigravity CLI (`agy`)
  - On Windows, the daemon launches native `.exe` binaries directly (plus npm-installed `@github/copilot` through Node); `.cmd`/`.bat` shims are skipped. See [custom executable paths](tools/witchcraft-daemon/README.md#custom-executable-paths) if an agent isn't on your default `PATH`.
- **PowerShell** on Windows. The built-in Windows PowerShell handles capture; the optional Claude Code management skill uses **PowerShell 7** (`pwsh`).

---

## Install

### With npm (0.5.2)

Install the matching `Witchcraft/` addon in your Forever client’s `Interface/AddOns` directory and log into the client at least once. From the project folder where you want your assistant to work, run these commands with Node 24 or later. Replace the example path with your actual client path.

```sh
npx witchcraft-daemon@0.5.2 configure --addons-dir "/path/to/World of Warcraft/_forever_/Interface/AddOns"
npx witchcraft-daemon@0.5.2 init --ring 3000
npx witchcraft-daemon@0.5.2 doctor
```

Restart WoW completely after `init`. In game, show the strip with `/witch calibrate`, run `npx witchcraft-daemon@0.5.2 calibrate` in the terminal, then use `/witch calibrate off`. Start your assistant with `npx witchcraft-daemon@0.5.2 run --only codex` (or `--only claude`). On Windows, `npx.cmd` works in PowerShell when its script execution policy blocks `npx`.

The installed daemon keeps configuration, calibration and session state in `~/.witchcraft` across npm upgrades. Set `WITCHCRAFT_STATE_DIR` to an absolute directory to use a separate profile. For a prepublication build, a local tarball works with npm as described in the [daemon package instructions](tools/witchcraft-daemon/README.md#try-a-local-package).

To install the scoped package from GitHub’s registry, follow the [GitHub Packages instructions](tools/witchcraft-daemon/README.md#with-github-packages).

### From source

1. **Clone or download the repository** somewhere permanent:

   ```sh
   git clone https://github.com/Geraldlol/witchcraft.git
   ```

2. **Copy the addon into WoW.** Copy the `Witchcraft` folder into your Forever client's `Interface/AddOns` directory, so that `Witchcraft.toc` sits at `Interface/AddOns/Witchcraft/Witchcraft.toc` with no extra nested folder.

3. **Tell the daemon where WoW lives.** In the repo root, copy `wow.config.example.json` to `wow.config.json` and point `addonsDir` at that `Interface/AddOns` folder:

   ```json
   {
     "addonsDir": "C:/Program Files/World of Warcraft/_forever_/Interface/AddOns"
   }
   ```

   Use forward slashes or escaped `\\` backslashes. Log into the client at least once first, so that `WTF/Account` exists.

4. **Install the daemon's dependencies and create the helper ring.**

   **Windows (PowerShell):**
   ```powershell
   cd tools\witchcraft-daemon
   npm.cmd ci --ignore-scripts --no-fund
   npm.cmd rebuild node-pty --ignore-scripts=false --foreground-scripts
   node bin/witchcraft.js init --ring 3000
   ```

   **macOS & Linux:**
   ```sh
   cd tools/witchcraft-daemon
   npm ci --ignore-scripts --no-fund
   npm rebuild node-pty --ignore-scripts=false --foreground-scripts
   node bin/witchcraft.js init --ring 3000
   ```

   - More than one WoW account under `WTF/Account`? Pass `--account 'ACCOUNT_NAME'` to `init` once and it remembers your choice.
   - Want the optional desktop overlay too? Run `node node_modules/electron/install.js` inside `tools/witchcraft-daemon`.

5. **Restart WoW completely.** The first time, WoW needs a full client restart (a `/reload` is not enough) to discover the 3,000 `Witchcraft_Chunk_*` helpers and the bundled font. Check that Witchcraft and its helpers are enabled in the AddOns list on the character-select screen.

---

## First run

Not sure everything is wired up? From `tools/witchcraft-daemon`, run:

```sh
node bin/witchcraft.js doctor
```

`doctor` changes nothing, works even before `npm ci`, and tells you the one next step to take. Add `--only codex`, `--only claude` and so on if you use a single agent, or `--json` for a redacted support summary with no personal paths or names.

### 1. Calibrate the fallback pixel strip (once)

In game, type `/witch calibrate`. A small colored bar appears at the top-left of your WoW window. Keep it uncovered and run:

```sh
node bin/witchcraft.js calibrate
```

When it says **Calibration saved**, type `/witch calibrate off` in game. You only need to do this again if you move the game window or change the resolution or UI scale.

### 2. Start the daemon

From `tools/witchcraft-daemon`, point `--cwd` at the project folder you want your agents to work in:

```sh
node bin/witchcraft.js run --cwd '/path/to/your/project'
```

By default this starts **Claude** and **Codex**. You can choose which agents launch:

```sh
# Add Copilot or Antigravity alongside Claude & Codex:
node bin/witchcraft.js run --with-copilot --cwd '/path/to/your/project'
node bin/witchcraft.js run --with-agy --cwd '/path/to/your/project'

# Or run just a single assistant:
node bin/witchcraft.js run --only claude --cwd '/path/to/your/project'
node bin/witchcraft.js run --only codex --cwd '/path/to/your/project'
node bin/witchcraft.js run --only copilot --cwd '/path/to/your/project'
node bin/witchcraft.js run --only agy --cwd '/path/to/your/project'
```

A few flags and keys worth knowing:
- `--no-current` starts fresh Claude and Codex sessions instead of joining the ones you already have in `--cwd`.
- `--overlay` launches the optional click-through desktop HUD (**Ctrl+Shift+H** toggles interactive mode).
- **Ctrl+]** in the desktop console cycles which agent terminal is shown there, whichever tab you are looking at in WoW.
- **To stop the daemon,** close its console window, or press **Ctrl+Break** on Windows. **Ctrl+C** sends a normal interrupt to the active assistant and leaves the bridge running. A Windows Claude console that Witchcraft only mirrored stays open, and it stays yours.

> **Upgrading?** Always update the `Witchcraft/` addon folder and `tools/witchcraft-daemon` together, from the same release or commit.

### 3. Connect in game

1. Back in WoW, run `/reload` out of combat, then type `/witch` or click the book icon on your minimap.
2. Optional, to work without the pixel strip: run `/witch filelane log`, then `/reload`. When `/witch status` shows `lanes: log Carrier ready`, run `/witch strip fallback` to hide the strip. [How it works](#how-it-works-under-the-hood) says what this costs in log volume. On a client where the keybinding link works, `/witch bindprobe` (or `/witch bindprobe auto`) qualifies that link instead; on build `1.60.1.71037` it does not work.
3. Pick a tab, type a message and press **Enter**.

One thing that trips people up: **Enter** inside the input box sends your message, while the separate **Enter** button sends a raw Enter keypress to the terminal, which is what interactive menus want.

---

## Giving your agents WoW context (MCP)

Any Claude, Codex or Copilot terminal that Witchcraft **launches itself** gets the WoW MCP tools automatically. Two cases need a little setup:

- **Joined Claude sessions (Windows).** Here Witchcraft attaches to a Claude Code process you started yourself, so register the MCP server once for that project folder:
  ```sh
  node bin/witchcraft.js mcp-setup --apply --cwd '/path/to/your/project'
  ```
  Then restart that Claude session (`claude --continue`) and restart Witchcraft. If a joined Claude session is missing the tools, the in-game footer says so.
- **Antigravity (`agy`).** Register `witchcraft_wow` in your Antigravity MCP config (`agy mcp add`), pointing `node` at `tools/witchcraft-daemon/bin/witchcraft-mcp.js --cache <absolute-path-to-.local/wow-context.json> --allow-local-writes`.

Context sharing starts **enabled**. Click **WoW context** in the window footer, or use `/witch context off`, whenever you want to pause it. The tools only read from the game; they never perform gameplay actions.

Things you can ask in game:
- *"Check my WoW context. Where am I, and what's left on my tracked quests?"*
- *"What changed in my session log over the last 20 minutes?"*
- *"Grab my latest Lua error, find out why it happens in this repo, and fix it."*
- *"Give me a spoiler-free nudge for this Defias quest."*
- *"Which dungeon knocks out the most items on my loot wishlist?"*
- *"Quiz me on the Deadmines bosses as a healer, one fight at a time."*

See [docs/MCP.md](docs/MCP.md) for all 16 tools and the manual MCP setup.

---

## Useful in-game commands

| Command / shortcut | What it does |
|---|---|
| `/witch` (or minimap book) | Show or hide the Witchcraft window. |
| `/witch settings` | Open **Esc > Options > AddOns > Witchcraft** (window behavior, alerts, combat updates, tabs, fonts). |
| `/witch status` | Show version, connection state, active transport lane, and ring usage. |
| `/witch tab <claude\|codex\|copilot\|agy> [on\|off]` | Show, hide, or toggle an agent tab (`/witch tabs` lists all four). |
| `/witch cols 40-160\|fit` | Resize the daemon's terminal width to 40–160 columns, or `fit` to your current window width. |
| `/witch bindprobe [auto\|off]` | Qualify the fast keybinding link once, or enable/disable automatic probing on connect. |
| `/witch filelane [log\|binding]` | Choose the file lane from the game to the daemon, applied at the next `/reload`: `binding` (the default) or `log` (the client log, which works without the strip). |
| `/witch strip [always\|fallback\|off]` | When the top-left pixel strip is drawn: always, only while no file lane can carry prompts, or never. |
| `/witch scale 80-140` · `/witch resetpos` | Set the overall window scale, or centre the window and restore its default size and scale. |
| `/witch context on\|off\|refresh\|clear-journal` | Resume, pause, or refresh WoW context sharing, or wipe the local session journal. |
| `/witch errors` / `list` / `clear` | Inspect recorded Lua errors, warnings, and blocked actions, or clear the list. |
| `/witch errors watch <n>` / `checked` / `status` | Follow a specific error across `/reload`s and mark reproduction attempts to verify a fix. |
| `/witch pending` / `inspect <id>` / `resend <id>` / `discard <id>` | Review, retry, or discard unconfirmed prompts kept across a daemon restart. |
| `/witch snippet add <prompt>` / `list` / `remove <n>` | Save reusable prompts into the **/** quick-command menu. |
| `/witch guide` · `quest` · `loot` · `rehearse` · `nearby` · `passport` | Open Guides/Adventures or prefill a quest, wishlist, dungeon-practice, detour, or passport prompt. |
| `/witch reload` (or `/witch reset`) | Reload the WoW UI (waits until you're out of combat). |
| **Key Bindings > AddOns > Witchcraft** | Bind keys to toggle the window, open-and-focus the input box, cycle tabs, or interrupt an agent. |

The [Addon Guide](Witchcraft/README.md) and the [Daemon Guide](tools/witchcraft-daemon/README.md) cover the rest: scrolling, multiline drafts, error watching and how the transports work.

---

## Managing the daemon from Claude Code

If you use Claude Code on Windows with PowerShell 7 (`pwsh`), the bundled [witchcraft-daemon skill](.claude/skills/witchcraft-daemon/SKILL.md) lets you say **"start Witchcraft"**, **"restart Witchcraft"** or **"check the Witchcraft daemon"** and have it done for you.

- Sessions opened inside this repo pick up the skill automatically.
- To use it from other repositories, copy `.claude/skills/witchcraft-daemon` to `%USERPROFILE%\.claude\skills\witchcraft-daemon` and set `WITCHCRAFT_HOME` to the path of your Witchcraft checkout.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot find executable claude` / `codex` / `copilot` / `agy` | Pass `--only <agent>` if you only have one installed, or set its binary path in `.local/config.json` ([details](tools/witchcraft-daemon/README.md#custom-executable-paths)). On Windows, `.cmd`/`.bat` wrappers are ignored in favor of real `.exe` binaries. |
| `--tab copilot` or `--tab agy names a terminal that is not started` | `--tab` only chooses which tab is focused first. Add `--with-copilot` / `--with-agy`, use `--only`, or add an entry under `commands` in `.local/config.json`. |
| Copilot or AGY tab isn't showing in game | Make sure both the addon and daemon are updated (`0.4.0+`) and the agent was started, or toggle it on via **... > Agent tabs** or `/witch tab <copilot\|agy> on`. |
| `No exact Witchcraft calibration strip found` | Type `/witch calibrate` in game, make sure nothing covers the top-left corner of WoW, and run `calibrate` again. On macOS, check that your terminal app has **Screen Recording** permission in System Settings. |
| Window opens, but replies stop updating | Check `/witch status` and `node bin/witchcraft.js doctor`. Combat pauses terminal updates by default, and if you rely on the pixel strip alone, WoW has to be the active foreground window. After restarting the daemon, `/reload` (and run `/witch bindprobe` out of combat if you use the keybinding link). |
| Log lane does not link after the game was closed and started again | Update the daemon to `0.5.1` or later. If it still does not link, restart the daemon, then type `/witch`. |
| `Logs/General.log` grows quickly | That is the log lane: about 45 MB an hour while idle and about 5 MB a minute while an agent prints. The client empties the file at each start. To switch the lane off, run `/witch strip always`, `/witch filelane binding` and `/reload`. |
| Joined Claude tab says `no WoW tools` | Run `node bin/witchcraft.js mcp-setup --apply --cwd '<same-folder>'`, restart that Claude session (`claude --continue`), and restart Witchcraft. |
| `A Witchcraft bridge owns ... bridge.lock` | Another daemon is already running. Close it cleanly first. Locks left by a crash are cleaned up automatically on startup. |
| Codex VS Code panel doesn't show my in-game messages | Witchcraft attaches a second CLI client to the same thread. Reload the thread in the VS Code extension to see the new turns. |

---

## Security & privacy

- **Treat every enabled WoW addon as having shell access while Witchcraft runs.** World of Warcraft puts all enabled addons in one shared Lua environment with no sandbox between them, so another addon could drive Witchcraft's UI or queue prompts into your open agent tabs. Only run Witchcraft alongside addons you trust.
- **The bridge is local.** Witchcraft opens no network ports and runs no cloud service. It uses local files and a **132 × 12** screen region, which is captured only while WoW is focused and can be turned off completely with `--no-pixels`. Your assistants still talk to Anthropic, OpenAI, GitHub or Google under their normal terms whenever you send prompts or tool outputs.
- **You control context sharing.** Toggle it at any time from **WoW context** in the footer or with `/witch context off`. Pausing clears the live context cache and stops recording new journal events. Journal history that was already recorded stays on disk until you run `/witch context clear-journal` or `node bin/witchcraft.js journal --clear`.
- **Local state stays local.** Daemon logs, calibration, the context cache, the journal, wishlists and passport stamps live in the git-ignored `tools/witchcraft-daemon/.local/`. Addon settings, retained drafts and Lua error history live in WoW's `WitchcraftDB` SavedVariables.

## Updating & uninstalling

- **Updating.** Stop the daemon, then update `Witchcraft/` and `tools/witchcraft-daemon` together. Keep your `wow.config.json`, `.local/` and WoW SavedVariables. Run the `npm` install and rebuild steps again if `package-lock.json` changed, start the daemon, and `/reload` in game.
- **Uninstalling.** Stop the daemon, close WoW, and delete `Witchcraft` and every `Witchcraft_Chunk_*` folder from `Interface/AddOns`. Delete `WitchcraftDB` from SavedVariables and `tools/witchcraft-daemon/.local/` only if you also want your saved preferences, wishlist and passport gone.

## Contributing & tests

- **Addon checks (repo root):** `luacheck Witchcraft` and `lua5.1 tests/witchcraft/run.lua`, which runs offline against mocked WoW APIs.
- **Package verifier (repo root):** `python3 -B tests/test_release_package.py`.
- **Daemon suite (`tools/witchcraft-daemon`):** needs Node 24+, plus Python 3 and `pwsh` 7 on Windows for the full native PTY and capture suite. Install the locked dependencies and run `npm test`.

## Help and feedback

Stuck on setup, or found something odd? [Open a bug report](https://github.com/Geraldlol/witchcraft/issues/new?template=bug_report.md). `node bin/witchcraft.js doctor --json` prints a redacted diagnostic block that is safe to paste into it. If there is something you wish you could do from inside the game, [open a feature request](https://github.com/Geraldlol/witchcraft/issues/new?template=feature_request.md). And if Witchcraft made your time in Azeroth a bit more fun, a star helps other people find it.

## License

[MIT](LICENSE). Bundled third-party libraries keep their own licenses: Ace3 and CallbackHandler ([BSD-style](Witchcraft/Libs/LICENSE-Ace3.txt)), LibStub (public domain), and DejaVu Sans Mono ([font license](Witchcraft/Media/LICENSE-DejaVu.txt)).

*WITCHCRAFT is an independent fan project and is not affiliated with or endorsed by Blizzard Entertainment, Anthropic, OpenAI, GitHub, or Google.*
