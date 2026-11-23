# WITCHCRAFT

**Warcraft's In-game Terminal for Claude's Hunches & Codex's Reckless Attempts at Fixing Things**

https://github.com/user-attachments/assets/4ae5190a-4871-4f89-a894-2df423aef8a5

*Real time, uncut: asking Claude about the character from inside the game, then having it fix a Lua error in another addon without ever alt-tabbing out of WoW.*

**Bring Claude Code, Codex CLI, GitHub Copilot CLI, and Google Antigravity (`agy`) straight into WoW Forever.** Chat with your coding agents while waiting on a flight path, ask what's left on your tracked quests, or have an assistant read a fresh Lua error and patch your addon on the spot. Witchcraft links a movable in-game terminal window to the real CLI sessions running on your machine.

*Profession: Prompt Engineering (1/300).*

[Download](https://github.com/Geraldlol/witchcraft/releases/latest) · [Install](#install) · [First run](#first-run) · [WoW MCP tools](docs/MCP.md) · [Changelog](CHANGELOG.md) · [Help & feedback](#help-and-feedback)

Witchcraft is **free and open source (MIT)**. You bring your own Claude Code, Codex, Copilot, or Antigravity account (and whatever usage plan you normally have with them).

---

## What you can do with it

- **Run up to four assistants side by side.** Claude, Codex, Copilot, and AGY each get their own tab, colored terminal output, scrollback, prompt history, and unsent draft. Only use one or two? Hide the rest from **... (Appearance) > Agent tabs**, `/witch tab`, or the AddOns Options page.
- **Pick up the conversation you already started.** Point Witchcraft at a project folder and it joins your workflow instead of forcing a blank slate: on Windows, the Claude tab mirrors the live Claude Code console you already have open there, and on every platform the Codex tab resumes your latest thread in that folder.
- **Handle terminal prompts without leaving the game.** Permission prompts and model pickers show up as clickable numbered buttons right above the input box. You also get a `/` slash-command menu, arrow/Escape/Interrupt keys, unread tab badges, and an optional raid-warning ping when an agent finishes a turn or needs an answer.
- **Write real prompts comfortably.** Shift-click items, quests, and spells into your message, paste multi-line text (up to ~4,600 bytes), save reusable prompt snippets, search scrollback, or copy the agent's last reply in one click.
- **Give your agents live eyes on your character.** Built-in local MCP tools let your assistants check your character, zone, tracked quests, gold, XP/rested bonus, group situation, and a session journal of recent milestones (`wow_get_session_log`)—plus a Lua error log (`wow_get_errors`) so an agent can inspect stack traces and verify fixes across `/reload`s.
- **Explore Guides & Adventures.** Ask for spoiler-light quest nudges, track a dungeon loot wishlist, rehearse boss fights by role (tank, healer, or DPS), look up nearby zone detours, and stamp a personal campaign passport. *(Note: the built-in catalog covers Classic Defias quests and Deadmines, Wailing Caverns, and Shadowfang Keep as reference material—Forever custom changes aren't pre-verified.)*
- **Make the window yours.** Resize, minimize, dock, or lock it; tune font size, terminal column width (`/witch cols fit`), background opacity, and frame strata; pause updates during combat; or pop open the optional desktop Electron overlay.

## How it works under the hood

WoW addons can't open network sockets or spawn processes—and they shouldn't be able to. Witchcraft bridges the gap locally:

1. **Desktop → Game:** `init` generates a ring of tiny load-on-demand helper addons (`Witchcraft_Chunk_*`). Whenever terminal output changes, the desktop daemon writes the latest screen into the next chunk so WoW can load it on the fly—no `/reload` needed per message. When the ring eventually fills up, Witchcraft warns you at 90% and asks before reloading.
2. **Game → Desktop:** Out of combat, Witchcraft sends your prompts, keypresses, and context snapshots through a temporary, verified-empty WoW keybinding (`bindings-cache.wtf`) and immediately restores it once acknowledged. A tiny **132 × 12 pixel strip** in the top-left corner acts as a fallback (and works during combat while WoW is focused). An optional Cooldown Viewer carrier is also enabled on exact client build `1.60.1.71037` and stays off on other builds.

## What's in the repo

| Component | Location | What it does |
|---|---|---|
| **WoW addon** | [`Witchcraft/`](Witchcraft/) | The in-game terminal window, UI controls, error recorder, and context capture. |
| **Desktop daemon & overlay** | [`tools/witchcraft-daemon/`](tools/witchcraft-daemon/) | Runs on your computer to connect WoW to local Claude, Codex, Copilot, and AGY sessions. |
| **WoW MCP server** | [`witchcraft-mcp.js`](tools/witchcraft-daemon/bin/witchcraft-mcp.js) | Local STDIO server with 13 read-only WoW tools and 3 optional wishlist/passport tools. |
| **Claude Code skill** | [`.claude/skills/witchcraft-daemon/`](.claude/skills/witchcraft-daemon/) | Lets you ask Claude to start, stop, restart, or check the daemon for you (Windows + `pwsh`). |

> **Grab the full source** (clone or **Source code (zip)** on the [releases page](https://github.com/Geraldlol/witchcraft/releases/latest)) so you get both the addon and the desktop daemon. The standalone `Witchcraft-X.Y.Z.zip` release asset contains only the `Witchcraft/` addon folder.

---

## Requirements

- **WoW Forever** client (interface `16001`). Other WoW clients aren't supported.
- **OS:**
  - **Windows 10 or 11** — primary, tested setup.
  - **macOS & Linux (experimental — testers wanted!)** — macOS reads the `World of Warcraft` window via Quartz/CoreGraphics (needs **Screen Recording** permission for your terminal app); Linux reads the X11/XWayland window under Wine or Proton (`python3`, `libX11`, `libXRes`). See [Linux and macOS notes](tools/witchcraft-daemon/README.md#linux-and-macos-experimental) and let us know how it goes!
- **[Node.js](https://nodejs.org/) 24 or newer.**
- At least one supported CLI installed and signed in:
  - [Claude Code](https://code.claude.com/docs/en/overview) (`claude`)
  - [Codex CLI](https://github.com/openai/codex) (`codex`)
  - [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started) (`copilot`)
  - Google Antigravity CLI (`agy`)
  - On Windows, the daemon launches native `.exe` binaries directly (plus npm-installed `@github/copilot` via Node); `.cmd`/`.bat` shims are skipped. See [custom executable paths](tools/witchcraft-daemon/README.md#custom-executable-paths) if an agent isn't in your default `PATH`.
- **PowerShell** on Windows (the built-in Windows PowerShell handles capture; the optional Claude Code management skill uses **PowerShell 7** / `pwsh`).

---

## Install

1. **Clone or download the repository** somewhere permanent:

   ```sh
   git clone https://github.com/Geraldlol/witchcraft.git
   ```

2. **Copy the addon into WoW.** Copy the `Witchcraft` folder into your Forever client's `Interface/AddOns` directory so `Witchcraft.toc` sits at `Interface/AddOns/Witchcraft/Witchcraft.toc` (no extra nested folder).

3. **Tell the daemon where WoW lives.** In the repo root, copy `wow.config.example.json` to `wow.config.json` and point `addonsDir` at that `Interface/AddOns` folder:

   ```json
   {
     "addonsDir": "C:/Program Files/World of Warcraft/_forever_/Interface/AddOns"
   }
   ```

   *(Use forward slashes or escaped `\\` backslashes. Make sure you've logged into the client at least once so `WTF/Account` exists.)*

4. **Install daemon dependencies and create the helper ring.**

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

   - Have multiple WoW accounts under `WTF/Account`? Pass `--account 'ACCOUNT_NAME'` to `init` once—it'll remember your choice.
   - Want the optional desktop overlay too? Run `node node_modules/electron/install.js` inside `tools/witchcraft-daemon`.

5. **Restart WoW completely.** A full client restart (not just `/reload`) is needed the first time so WoW discovers the 3,000 `Witchcraft_Chunk_*` helpers and the bundled font. Make sure Witchcraft and its helpers are enabled in your character-select AddOns list.

---

## First run

Not sure if everything's wired up yet? From `tools/witchcraft-daemon`, run:

```sh
node bin/witchcraft.js doctor
```

`doctor` is read-only, works even before `npm ci`, and tells you the single next step to take (add `--only codex`, `--only claude`, etc. if you only use one agent, or `--json` for a redacted support summary with no personal paths or names).

### 1. Calibrate the fallback pixel strip (once)

In game, type `/witch calibrate`—a small colored bar will appear at the top-left of your WoW window. Keep it uncovered and run:

```sh
node bin/witchcraft.js calibrate
```

Once it says **Calibration saved**, type `/witch calibrate off` in game. You only need to redo this if you move the game window or change resolution / UI scale.

### 2. Start the daemon

From `tools/witchcraft-daemon`, point `--cwd` at the project folder you want your agents working in:

```sh
node bin/witchcraft.js run --cwd '/path/to/your/project'
```

By default this starts **Claude** and **Codex**. You can tailor which agents launch:

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

A few handy flags:
- `--no-current` starts fresh Claude/Codex sessions instead of joining your existing ones in `--cwd`.
- `--overlay` launches the optional click-through desktop HUD (**Ctrl+Shift+H** toggles interactive mode).
- **Ctrl+]** in the desktop console cycles which agent terminal is shown there, independent of which tab you're viewing in WoW.
- **To stop the daemon:** close its console window (or press **Ctrl+Break** on Windows). Pressing **Ctrl+C** sends a normal interrupt to the active assistant rather than killing the bridge. Any Windows Claude console that Witchcraft merely mirrored stays open and yours.

> **Upgrading?** Always update the `Witchcraft/` addon folder and `tools/witchcraft-daemon` together from the same release/commit.

### 3. Connect in game

1. Back in WoW, run `/reload` (out of combat), then type `/witch` or click the book icon on your minimap.
2. Run `/witch bindprobe` once out of combat to qualify the fast keybinding link for the session—or run `/witch bindprobe auto` once if you want Witchcraft to probe automatically whenever it connects.
3. Pick a tab, type a message, and hit **Enter**!

*(Tip: hitting **Enter** inside the input box sends your message; clicking the separate **Enter** button sends a raw Enter keypress to the terminal—handy for interactive menus.)*

---

## Giving your agents WoW context (MCP)

Any Claude, Codex, or Copilot terminal that Witchcraft **launches itself** gets the WoW MCP tools automatically.

- **Joined Claude sessions (Windows):** Because Witchcraft attaches to a Claude Code process you already started, register the MCP server once for that project folder:
  ```sh
  node bin/witchcraft.js mcp-setup --apply --cwd '/path/to/your/project'
  ```
  Then restart that Claude session (`claude --continue`) and restart Witchcraft. (If a joined Claude session is missing the tools, the in-game footer will let you know.)
- **Antigravity (`agy`):** Register `witchcraft_wow` in your Antigravity MCP config (`agy mcp add`) pointing `node` at `tools/witchcraft-daemon/bin/witchcraft-mcp.js --cache <absolute-path-to-.local/wow-context.json> --allow-local-writes`.

Context sharing starts **enabled**—click **WoW context** in the window footer (or use `/witch context off`) anytime you want to pause it. All tools are strictly read-only on the game side; they never perform gameplay actions.

Things you can ask in game:
- *"Check my WoW context—where am I, and what's left on my tracked quests?"*
- *"What changed in my session log over the last 20 minutes?"*
- *"Grab my latest Lua error, track down why it's happening in this repo, and fix it."*
- *"Give me a spoiler-free nudge for this Defias quest."*
- *"Which dungeon knocks out the most items on my loot wishlist?"*
- *"Quiz me on the Deadmines bosses as a healer, one fight at a time."*

See [docs/MCP.md](docs/MCP.md) for all 16 tools and manual MCP setup details.

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
| `/witch context on\|off\|refresh\|clear-journal` | Resume, pause, or refresh WoW context sharing, or wipe the local session journal. |
| `/witch errors` / `list` / `clear` | Inspect recorded Lua errors, warnings, and blocked actions, or clear the list. |
| `/witch errors watch <n>` / `checked` / `status` | Follow a specific error across `/reload`s and mark reproduction attempts to verify a fix. |
| `/witch pending` / `inspect <id>` / `resend <id>` / `discard <id>` | Review, retry, or discard unconfirmed prompts kept across a daemon restart. |
| `/witch snippet add <prompt>` / `list` / `remove <n>` | Save reusable prompts into the **/** quick-command menu. |
| `/witch guide` · `quest` · `loot` · `rehearse` · `nearby` · `passport` | Open Guides/Adventures or prefill a quest, wishlist, dungeon-practice, detour, or passport prompt. |
| `/witch reload` (or `/witch reset`) | Reload the WoW UI (waits until you're out of combat). |
| **Key Bindings > AddOns > Witchcraft** | Bind keys to toggle the window, open-and-focus the input box, cycle tabs, or interrupt an agent. |

For the full rundown on scrolling, multiline drafts, error watching, and transport internals, see the [Addon Guide](Witchcraft/README.md) and the [Daemon Guide](tools/witchcraft-daemon/README.md).

---

## Managing the daemon from Claude Code

If you use Claude Code on Windows with PowerShell 7 (`pwsh`), the bundled [witchcraft-daemon skill](.claude/skills/witchcraft-daemon/SKILL.md) lets you just say **"start Witchcraft"**, **"restart Witchcraft"**, or **"check the Witchcraft daemon"**.

- Sessions opened inside this repo pick up the skill automatically.
- To use it from other repositories, copy `.claude/skills/witchcraft-daemon` to `%USERPROFILE%\.claude\skills\witchcraft-daemon` and set `WITCHCRAFT_HOME` to your Witchcraft checkout path.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot find executable claude` / `codex` / `copilot` / `agy` | Pass `--only <agent>` if you only have one installed, or set its binary path in `.local/config.json` ([details](tools/witchcraft-daemon/README.md#custom-executable-paths)). On Windows, `.cmd`/`.bat` wrappers are ignored in favor of real `.exe` binaries. |
| `--tab copilot` or `--tab agy names a terminal that is not started` | `--tab` only chooses which tab is focused first. Add `--with-copilot` / `--with-agy`, use `--only`, or add an entry under `commands` in `.local/config.json`. |
| Copilot or AGY tab isn't showing in game | Make sure both the addon and daemon are updated (`0.4.0+`) and the agent was started, or toggle it on via **... > Agent tabs** or `/witch tab <copilot\|agy> on`. |
| `No exact Witchcraft calibration strip found` | Type `/witch calibrate` in game, make sure nothing covers the top-left corner of WoW, and run `calibrate` again. On macOS, check that your terminal app has **Screen Recording** permission in System Settings. |
| Window opens, but replies stop updating | Check `/witch status` and `node bin/witchcraft.js doctor`. Remember that combat pauses terminal updates by default, and if you're relying solely on the pixel strip, WoW needs to be the active foreground window. After restarting the daemon, `/reload` and run `/witch bindprobe` out of combat. |
| Joined Claude tab says `no WoW tools` | Run `node bin/witchcraft.js mcp-setup --apply --cwd '<same-folder>'`, restart that Claude session (`claude --continue`), and restart Witchcraft. |
| `A Witchcraft bridge owns ... bridge.lock` | Another daemon is already running! Close it cleanly first (crashed/stale locks are cleaned up automatically on startup). |
| Codex VS Code panel doesn't show my in-game messages | Witchcraft attaches a second CLI client to the same thread—reload the thread in the VS Code extension to see the new turns. |

---

## Security & privacy

- **Treat every enabled WoW addon as having shell access while Witchcraft runs.** World of Warcraft puts all enabled addons in a single shared Lua environment with no sandboxing between them—meaning another addon could drive Witchcraft's UI or queue prompts into your open agent tabs. Only run Witchcraft alongside addons you trust.
- **100% local bridge.** Witchcraft opens no network ports and runs no cloud service. It uses local files and a tiny **132 × 12** screen region (captured only while WoW is focused, or disabled completely with `--no-pixels`). Your assistants themselves still talk to Anthropic, OpenAI, GitHub, or Google under their normal terms whenever you send prompts or tool outputs.
- **You control context sharing.** Toggle sharing anytime from **WoW context** in the footer or `/witch context off`. Pausing sharing clears the live context cache and stops recording new journal events; previously recorded local journal history stays on disk until you run `/witch context clear-journal` or `node bin/witchcraft.js journal --clear`.
- **Local state stays local.** Daemon logs, calibration, context cache, journal, wishlists, and passport stamps live in git-ignored `tools/witchcraft-daemon/.local/`. Addon settings, retained drafts, and Lua error history live in WoW's `WitchcraftDB` SavedVariables.

## Updating & uninstalling

- **Updating:** Stop the daemon first, update both `Witchcraft/` and `tools/witchcraft-daemon` together (keeping your `wow.config.json`, `.local/`, and WoW SavedVariables), re-run the `npm` install/rebuild steps if `package-lock.json` changed, start the daemon, and `/reload` in game.
- **Uninstalling:** Stop the daemon, close WoW, and delete `Witchcraft` plus all `Witchcraft_Chunk_*` folders from `Interface/AddOns`. Delete `WitchcraftDB` from SavedVariables and `tools/witchcraft-daemon/.local/` only if you also want to wipe your saved preferences, wishlist, and passport.

## Contributing & tests

- **Addon checks (root):** `luacheck Witchcraft` and `lua5.1 tests/witchcraft/run.lua` (runs offline against mocked WoW APIs).
- **Package verifier (root):** `python3 -B tests/test_release_package.py`.
- **Daemon suite (`tools/witchcraft-daemon`):** Requires Node 24+ (plus Python 3 and `pwsh` 7 on Windows for the full native PTY/capture suite). Install locked dependencies and run `npm test`.

## Help and feedback

Run into a snag during setup or hit a weird edge case? [Open a bug report](https://github.com/Geraldlol/witchcraft/issues/new?template=bug_report.md) (running `node bin/witchcraft.js doctor --json` gives you a safe, redacted diagnostic block to paste). Have a cool idea for an in-game workflow? [Drop a feature request](https://github.com/Geraldlol/witchcraft/issues/new?template=feature_request.md)—and if Witchcraft makes your time in Azeroth more fun, a star on the repo is always appreciated!

## License

[MIT](LICENSE). Bundled third-party libraries keep their own licenses: Ace3 and CallbackHandler ([BSD-style](Witchcraft/Libs/LICENSE-Ace3.txt)), LibStub (public domain), and DejaVu Sans Mono ([font license](Witchcraft/Media/LICENSE-DejaVu.txt)).

*WITCHCRAFT is an independent fan project and is not affiliated with or endorsed by Blizzard Entertainment, Anthropic, OpenAI, GitHub, or Google.*
