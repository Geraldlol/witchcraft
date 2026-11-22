# Warcraft's In-game Terminal for Claude's Hunches & Codex's Reckless Attempts at Fixing Things (WITCHCRAFT)

https://github.com/user-attachments/assets/4ae5190a-4871-4f89-a894-2df423aef8a5

*Real time, uncut: asking Claude about the character from inside the game, then having it fix a Lua error in another addon without leaving WoW.*

**Claude Code, Codex CLI, GitHub Copilot CLI and Google Antigravity CLI (`agy`) inside WoW Forever.** Talk to your assistant from the game, continue your existing conversations, ask about your character and tracked quests, or have an agent work on your addons while you play. WITCHCRAFT connects the in-game window to the real assistant sessions on your Windows desktop.

*Profession: Prompt Engineering (1/300).*

[Download](https://github.com/Geraldlol/witchcraft/releases/latest) · [Install](#install) · [WoW MCP tools](docs/MCP.md) · [Changelog](CHANGELOG.md) · [Help and feedback](#help-and-feedback)

The addon and companion are **free and open source (MIT)**. Your Claude Code, Codex, GitHub Copilot or Google Antigravity account and their normal usage costs are separate.

## What you can do

| Feature | In game |
|---|---|
| **Four assistant terminals** | Claude, Codex, Copilot and AGY have separate tabs, unsent drafts, prompt history, colored output and scrollback. Copilot and AGY appear in game once started, and any tab can be shown or hidden from **... (Appearance) > Agent tabs**, `/witch tab <claude\|codex\|copilot\|agy> [on\|off]` or the addon's Options page. The footer shows model and context usage when available. |
| **Work on your projects** | Choose the agents' working folder. Continue a running Claude Code session or resume a Codex thread; ask them to inspect, edit and debug the files they can normally access. Their usual permissions still apply. |
| **Answer terminal prompts** | Use the slash-command menu, numbered choice buttons and **Keys** for permission prompts, model pickers, Enter, Escape, arrows and Interrupt. Unread markers and optional sound/text alerts tell you when an agent needs attention or finishes. |
| **Compose and reuse prompts** | Shift-click item, quest and spell links into your draft; recall previous prompts; save snippets; or use **/ > Write a long prompt** for multiple lines. Copy the last reply and search the scrollback. |
| **Ask about WoW** | MCP tools supply character, location, tracked quests, money, experience, rested bonus, your current situation and a bounded session journal of what changed this session. The Lua-error tool lets an assistant inspect recorded errors, warnings and blocked actions while working on a fix. |
| **Guides and Adventures** | Request spoiler-controlled quest hints, keep a loot wishlist, group goals by dungeon, rehearse encounters by role, find zone detours, and keep a personal campaign passport with notes. |
| **Make it fit your UI** | Move, resize, minimize, dock or lock the window; adjust font size, terminal column width (`/witch cols 40-160\|fit`), opacity and window layer; configure alerts, combat updates and keybindings. A separate desktop overlay also comes with the daemon. |

Guides and Adventures use a small, source-linked **Classic reference catalog**: seven Defias quest stages, twelve items across Deadmines, Wailing Caverns and Shadowfang Keep, dungeon lessons, zone detours and personal campaigns. These references are not verified Forever mechanics or drop tables. Guide buttons prepare editable prompts; loot acquisitions and passport stamps are recorded when you tell the assistant about them.

## What's included

| Component | Location | Purpose |
|---|---|---|
| WoW addon | [`Witchcraft/`](Witchcraft/) | The in-game window, controls and context capture. |
| Windows daemon and desktop overlay | [`tools/witchcraft-daemon/`](tools/witchcraft-daemon/) | Connect the game to local Claude Code, Codex, Copilot and AGY terminals. |
| MCP server | [`witchcraft-mcp.js`](tools/witchcraft-daemon/bin/witchcraft-mcp.js) | Up to 16 tools over local STDIO: 13 read-only tools and three optional tools that save local goals/passport records. |
| Claude Code skill | [`.claude/skills/witchcraft-daemon/`](.claude/skills/witchcraft-daemon/) | Start, stop, restart and check the daemon from Claude Code. |

**Download the full source to get all four.** The addon-only release ZIP contains only the `Witchcraft` folder. It still needs the desktop daemon from the source download or a clone.

## Requirements

- Windows 10 or 11 and the **WoW Forever** client, interface `16001`.
- Linux and macOS are experimental and **need testers**: the daemon can read the game's X11/XWayland window under Wine or Proton on Linux, and the game's Quartz window via CoreGraphics on macOS. See [Linux and macOS (experimental)](tools/witchcraft-daemon/README.md#linux-and-macos-experimental) and please report what you find.
- [Node.js](https://nodejs.org/) **24 or newer**.
- [Claude Code](https://code.claude.com/docs/en/overview), [Codex CLI](https://github.com/openai/codex), [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started), or Google Antigravity CLI (`agy`), installed and already signed in. The daemon uses native executables (`claude.exe` / `codex.exe` / `copilot.exe` / `agy.exe`). For npm-installed Copilot on Windows it can also launch the package with Node directly; other `.cmd` and `.bat` wrappers do not work. See [custom executable paths](tools/witchcraft-daemon/README.md#custom-executable-paths) if yours are not found.
- PowerShell for setup. The optional Claude Code management skill requires **PowerShell 7** (`pwsh`).

The default binding carrier is not build-pinned; qualify it once per daemon/UI session with `/witch bindprobe`. The optional production cooldown carrier is exact-build-gated in [`Witchcraft/Evidence.lua`](Witchcraft/Evidence.lua), user-confirmed on **1.60.1.71037**, and stays off on every other build. Keep the screen strip calibrated as a separate fallback. The AddOns-state experiment remains a dormant source-only prototype: it is not loaded by the addon, connected to the daemon or runtime-qualified. This release targets Forever; other WoW clients are outside its compatibility claim.

## Install

1. **Get the full source.** Download **Source code (zip)** from the [latest release](https://github.com/Geraldlol/witchcraft/releases/latest) and extract it somewhere permanent, or clone:

   ```powershell
   git clone https://github.com/Geraldlol/witchcraft.git
   ```

2. **Install the addon.** Copy the source's `Witchcraft` folder into your Forever client's `Interface\AddOns` folder. The result must be `Interface\AddOns\Witchcraft\Witchcraft.toc`, without an extra nested folder. The addon-only release ZIP provides the same folder.

3. **Point the daemon at that client.** In the source root, copy `wow.config.example.json` to `wow.config.json` and edit `addonsDir`. For example:

   ```json
   {
      "addonsDir": "C:/Program Files/World of Warcraft/_forever_/Interface/AddOns"
   }
   ```

   Use your actual Forever client path, with forward slashes or doubled backslashes. Log into that client at least once so it has a `WTF\Account` folder.

4. **Set up the daemon.** Open PowerShell in the source root, then run:

   ```powershell
   cd tools\witchcraft-daemon
   npm.cmd ci --ignore-scripts --no-fund
   npm.cmd rebuild node-pty --ignore-scripts=false --foreground-scripts
   node bin/witchcraft.js init --ring 3000
   ```

   `init` creates 3,000 small `Witchcraft_Chunk_*` helper addons for returning terminal output to the game. Keep them alongside `Witchcraft`. To use the optional desktop overlay, also run `node node_modules/electron/install.js` from the daemon folder.

   If several account folders exist, use `node bin/witchcraft.js init --ring 3000 --account 'ACCOUNT_FOLDER'`. Use the exact folder name under that client's `WTF\Account`; the selection is saved for later commands.

5. **Restart WoW completely** so it discovers the helper addons and bundled font. Enable WITCHCRAFT and its helper addons in the character-select AddOns list.

## First run

From `tools/witchcraft-daemon`, run `node bin/witchcraft.js doctor` for a read-only setup and connection check. It works before installing daemon dependencies. If you use a single assistant, add the same `--only` option you plan to give `run`. Follow the first **Next step** and repeat the command. For a support report, add `--json`. The report includes versions, counts and link status, and omits names, paths and terminal content.

### 1. Calibrate the screen strip

In game, type `/witch calibrate`. Keep its colored strip visible and uncovered at the top-left of the game window. From `tools\witchcraft-daemon`, run:

```powershell
node bin/witchcraft.js calibrate
```

Wait for **Calibration saved**, then type `/witch calibrate off` in game. Recalibrate after moving the game window or changing resolution, display scaling or UI scale.

Once calibrated, ordinary `run` also reads this small strip. It provides a fallback when a fast transport is unavailable and helps establish the connection. During normal use, strip capture only runs while WoW is in the foreground. See [transport and capture details](tools/witchcraft-daemon/README.md#transport-and-lifecycle).

### 2. Start your assistants

From `tools\witchcraft-daemon`, point `--cwd` at the existing project folder you want them to work in:

```powershell
node bin/witchcraft.js run --cwd 'C:\path\to\your\project'
```

This starts Claude and Codex. Add `--with-copilot` to also start Copilot, or `--with-agy` to also start AGY. `--tab` only picks which terminal the daemon window shows first and never starts one, so `--tab copilot` / `--tab agy` needs `--with-copilot` / `--with-agy`, `--only`, or a configured `commands.<agent>`. **If you only have one assistant installed**, use one of these instead:

```powershell
node bin/witchcraft.js run --only claude --cwd 'C:\path\to\your\project'
node bin/witchcraft.js run --only codex --cwd 'C:\path\to\your\project'
node bin/witchcraft.js run --only copilot --cwd 'C:\path\to\your\project'
node bin/witchcraft.js run --only agy --cwd 'C:\path\to\your\project'
```

By default, Claude mirrors the newest running interactive Claude Code session in that folder, and Codex resumes the newest top-level Codex thread there. Copilot and AGY start fresh; use `/resume` in the Copilot tab to choose a saved conversation. Automatic folder-based session discovery applies to Claude and Codex. A tab with no matching session starts fresh. Add `--no-current` to start fresh deliberately. The daemon window tells you which sessions it joined.

Updating from 0.1.x: update the addon and the daemon together. With an older two-tab daemon the addon hides the Copilot and AGY tabs, falls back to Claude if an absent tab was selected, and drops any queued messages for absent tabs with a chat notice.

The desktop overlay is off by default. Add `--overlay`, or set `"overlay": true` in `.local/config.json`, to start it after the game link is up. In the overlay, HUD mode passes clicks through; **Ctrl+Shift+H** brings back the interactive workbench. `--no-overlay` overrides a saved setting.

### 3. Connect in game

1. After starting the daemon, run `/reload` outside combat, then `/witch` or click the minimap book button.
2. Run `/witch bindprobe` outside combat once per daemon/UI session (or `/witch bindprobe auto` to probe automatically on connect). Wait for the message confirming host decode, acknowledgement and cleanup succeeded.
3. Select Claude, Codex, Copilot or AGY and send a short prompt. Confirm its reply appears in the same tab. `/witch status` shows connection details if it does not.

The input box's Enter sends your draft; the separate **Enter** button accepts a terminal prompt. Use **Keys** for navigation and Interrupt. The desktop terminal remains usable, and **Ctrl+]** switches its selected agent independently of the game tabs.

Terminal updates pause during combat by default; settings can enable them. Normal messages do not need a reload. When the finite helper-addon ring is exhausted, WITCHCRAFT schedules a guarded reload outside combat.

**To stop:** close the daemon console or press **Ctrl+Break**. Ordinary **Ctrl+C** interrupts the selected assistant. Stopping the daemon ends sessions it launched; a Claude console it merely mirrored stays yours.

## Give the assistants WoW context

Terminals WITCHCRAFT launches get the MCP tools automatically. A Claude Code session it **joins** needs the server registered once in the same working folder:

```powershell
node bin/witchcraft.js mcp-setup --apply --cwd 'C:\path\to\your\project'
```

Then restart that Claude session and WITCHCRAFT. Open **WoW context** in the footer to check sharing, pause it or request an update. **Sharing starts enabled** and its setting persists across reloads. Tools request snapshots when needed and report missing, stale or unavailable data.

Try:

- "Use the WoW tools to tell me where I am and what remains for my tracked quests."
- "Read my latest Lua error, find the cause in this addon project, and propose a fix."
- "Give me a nudge for this Defias quest without spoiling the solution."
- "Which dungeon covers the most items on my saved loot wishlist?"
- "Rehearse Deadmines with me as a healer, one question at a time."

The tools read game context; the three local-write tools save loot goals and passport records on your PC. They do not perform gameplay actions. `--no-mcp` skips automatic tool configuration for launched terminals; `/witch context off` controls game-data sharing, including for an already joined session.

See [the full tool list and MCP setup](docs/MCP.md), including how to connect another MCP client. Launching the server directly exposes the 13 read-only tools by default; `--allow-local-writes` adds the three personal-record tools.

## Useful in-game controls

| Command or control | Use |
|---|---|
| `/witch` | Show or hide the window. |
| `/witch settings` | Window, font, opacity, notifications, combat updates, prompt history and sharing options. |
| `/witch status` | Check build, connection, ring cursor and pending input. |
| `/witch tab <claude\|codex\|copilot\|agy> [on\|off]` | Show, hide or toggle an agent tab (`/witch tabs` lists all four). |
| `/witch cols 40-160\|fit` | Request daemon terminal width (40-160 columns, or fit to window width). |
| `/witch bindprobe [auto\|off]` | Qualify the binding carrier once, or toggle automatic probe on connect. |
| `/witch errors` / `/witch errors clear` | Show the recorded-error count and newest entry, or clear the history. |
| `/witch errors list` / `/witch errors watch <n>` | Select a Lua error to follow across reloads. After retrying the original action, run `/witch errors checked` and read the result with `/witch errors status`. |
| `/witch snippet add <prompt>` / `list` / `remove <n>` | Manage reusable prompts in the **/** menu. |
| `/witch guide` / `/witch quest [nudge\|details\|solution] <quest>` | Open Guides or prepare a quest-help prompt. |
| `/witch loot [item]` | Prepare a loot-goal prompt; omit the item to ask for your plan. |
| `/witch rehearse [tank\|healer\|damage] [dungeon]` | Prepare a dungeon-practice prompt. |
| `/witch nearby [zone]` / `/witch passport` | Ask for detours or your personal campaign records. |
| `/witch context on\|off\|refresh\|clear-journal` | Enable, pause or refresh context sharing, or clear the session journal. |
| **Key Bindings > AddOns > Witchcraft** | Bind toggle, open-and-type, switch-tab and interrupt actions. |

The [full addon guide](Witchcraft/README.md) covers scrolling, copying, multiline prompts, window controls and diagnostic commands. The [daemon guide](tools/witchcraft-daemon/README.md) covers custom executables, session attachment and transport details.

## Claude Code management skill

The included [witchcraft-daemon skill](.claude/skills/witchcraft-daemon/SKILL.md) lets you ask Claude to **"start Witchcraft"**, **"restart Witchcraft"** or **"check the Witchcraft daemon"**. It opens the daemon in its own console, stops it cleanly, and checks the lock, helper-addon ring and context cache. Complete installation and calibration first.

- Claude Code sessions started inside this repository discover the skill automatically.
- For other projects, copy `.claude\skills\witchcraft-daemon` to `%USERPROFILE%\.claude\skills\witchcraft-daemon`. Set `WITCHCRAFT_HOME` to the full source checkout path, or pass `-Repo` to its script.
- The skill requires PowerShell 7 (`pwsh`). By default, its agents work in and join sessions from Claude's current folder.

## Troubleshooting

| Symptom | Check |
|---|---|
| `Cannot find executable claude`, `codex`, `copilot` or `agy` | Use `--only` for your installed assistant, or configure its native `.exe` path in [the daemon's local config](tools/witchcraft-daemon/README.md#custom-executable-paths). A working `.cmd` wrapper alone is insufficient; an npm-installed `@github/copilot` is found and run through Node. |
| `--tab copilot` or `--tab agy names a terminal that is not started` | `--tab` never starts a terminal. Add `--with-copilot` / `--with-agy`, use `--only`, or configure `commands.<agent>`. |
| No Copilot or AGY tab in game | The tab turns on automatically once per host session when the daemon starts that agent, or toggle it anytime via **... (Appearance) > Agent tabs**, **Options > Tabs**, or `/witch tab <copilot\|agy> on`. |
| No calibration strip found | Run `/witch calibrate`, leave the strip uncovered, and retry. Calibration captures the virtual desktop once; very large multi-monitor layouts can exceed its 16-million-pixel limit. |
| Window opens but replies stop | Keep WoW in front when relying on the strip; check `/witch status`, the daemon console and calibration. After a daemon restart, `/reload`, then repeat `/witch bindprobe` outside combat. Combat pauses terminal updates by default. |
| Joined Claude has no WoW tools | Run `mcp-setup --apply` with the same `--cwd`, then restart that Claude session and the daemon. The footer reports when the joined session lacks the tools. |
| Context is stale or unavailable | Check sharing in **WoW context**, request an update and let delivery finish. Long quest snapshots take longer than character data, especially over the strip. |
| `A Witchcraft bridge owns ... bridge.lock` | Check the running daemon or the skill's status action. Stop the existing daemon cleanly before starting another; dead-process locks are handled on startup. |
| Codex's IDE panel does not show the game conversation | The game uses a second CLI client on the resumed thread. Reload the thread in the extension to see appended turns. |

## Help and feedback

For setup help or a bug, [open a report](https://github.com/Geraldlol/witchcraft/issues/new?template=bug_report.md). Include your WITCHCRAFT version, Forever client build, which assistant you use, and what happened. The template lists useful diagnostics; remove personal paths, account details and private conversation text before sharing them.

Have an idea? [Describe what you want to do in game](https://github.com/Geraldlol/witchcraft/issues/new?template=feature_request.md), or [check existing issues](https://github.com/Geraldlol/witchcraft/issues) for the same problem. If the project is useful, a GitHub star makes it easier to find again, and feedback from your first setup helps improve the next release.

## Security and privacy

- **Every addon you have enabled can type into every running agent session and read their output while the daemon runs.** WoW gives addons no isolation from one another. Run WITCHCRAFT alongside addons you trust as much as a shell.
- The bridge uses local files and screen capture and opens no network listener. Calibration captures the virtual desktop once to find the strip; normal capture reads only the calibrated **132 × 12 pixel** region while WoW is foreground. It is active on ordinary `run` after calibration unless `--no-pixels` is set.
- Session discovery reads local Claude Code and Codex records under `~/.claude` and `~/.codex`. The bridge has no separate upload service. The assistants use their normal providers: prompts, file content and tool results you give them can be sent to those services under their own terms.
- Game-context sharing starts enabled. Pause it in the footer or with `/witch context off`; the desktop cache clears when the pause reaches the daemon. Previously recorded local session journal history remains readable until cleared with `witchcraft journal --clear` or `/witch context clear-journal`. Normal assistant tool approvals still apply.
- Calibration, bridge logs, cached context, session journal, loot goals and passport records live under ignored `tools/witchcraft-daemon/.local/`. Addon preferences, pending input and error history use the client's `WitchcraftDB` SavedVariables.

## Updating and uninstalling

**Update:** stop the daemon first, including older releases running from other folders. Update the addon and daemon together and preserve `wow.config.json`, `tools/witchcraft-daemon/.local/` and your WoW SavedVariables. If `package-lock.json` changed, repeat the dependency setup from [Install](#install). Restart the daemon and `/reload`. Fully restart WoW if new addon folders or fonts were added.

**Uninstall:** stop the daemon and close WoW, then remove `Witchcraft` and the `Witchcraft_Chunk_*` folders created for it from that client's `Interface\AddOns`. Keep SavedVariables and `.local/` if you want your preferences, goals and passport for a later reinstall; remove them only if you also want to erase that state. Remove any copied management skill and local MCP registration you added.

## Contributor checks

From the repository root, run `lua5.1 tests/witchcraft/run.lua` for the addon regression suite and `luacheck Witchcraft` for lint. The Lua tests supply their own WoW API fixtures. The Windows daemon suite needs Node 24, Python 3 available as `python3`, and PowerShell 7 available as `pwsh`. From `tools/witchcraft-daemon`, install the locked dependencies and run `npm test`. The suite exercises the native terminal with synthetic child processes and temporary directories. Run `python3 -B tests/test_release_package.py` from the root for the package verifier.

## License

[MIT](LICENSE). Bundled third-party components keep their own licenses: Ace3 and CallbackHandler ([BSD-style](Witchcraft/Libs/LICENSE-Ace3.txt)), LibStub (public domain), and DejaVu Sans Mono ([font license](Witchcraft/Media/LICENSE-DejaVu.txt)). npm dependencies are installed from `package-lock.json` under their own licenses.

WITCHCRAFT is a fan project. It is not affiliated with or endorsed by Blizzard Entertainment, Anthropic, OpenAI, GitHub or Google.
