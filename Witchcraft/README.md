# Witchcraft

Claude Code and Codex CLI terminals inside WoW Forever, with separate tabs, independent drafts, and an input box addressed to the selected agent. Build: `stock-frame-20260923-1`, interface `16001`.

The window uses the client's own metal window frame, red close and minimize buttons, and gold labels over a charcoal body.

The WoW MCP bridge shares read-only character, location, tracked quest and progression context with both assistants. Open **WoW context** in the footer to pause sharing, request an update, and inspect acknowledged summaries.

The book icon opens Guides: choose quest nudge, details or solution; save an item goal; or ask which dungeon covers several wishlist items. Actions prepare an editable prompt and preserve existing drafts. The first catalog covers seven Defias quest stages and twelve items across three Classic dungeons, with sources and explicit unverified-Forever status. This slice is built and offline-tested; activation and native acceptance remain pending.

The new **Adventures** page adds dungeon rehearsal, zone detours and a personal passport: nine role-specific boss lessons with quizzes, nine detours across three zones, and three campaigns with user-confirmed stamps and scrapbook notes. Rehearsals include relevant saved loot goals. These are source-linked Classic references, unverified on Forever; the passport records your reports rather than automatic game achievements.

This build also includes an opt-in dense optical carrier probe. It renders 22 extra rows below the normal strip only while the probe is active; the normal two-row transport stays unchanged. The probe is built and offline-tested, with native acceptance still pending.

By default the companion daemon joins the sessions already running in the repository: the Claude tab mirrors your live Claude Code console and the Codex tab resumes your newest Codex thread (`--no-current` starts new ones instead). It resolves terminal redraws into colored text for the game window and reads replies from a small pixel strip. A joined Claude session gets the WoW tools once you run `node bin/witchcraft.js mcp-setup --apply`, restart that session and then restart Witchcraft; the footer says when it lacks them. Authentication and agent approval prompts remain in their normal CLI sessions.

## Start

Follow [the install steps](../README.md#install) and [the daemon setup](../tools/witchcraft-daemon/README.md). After initializing the chunk addons, restart WoW completely so it discovers the new addons and bundled static font. Then calibrate the strip, start the daemon, and use `/witch` to open the window.

- Left-click the book button at the lower-left edge of the minimap to show or hide Witchcraft, just like `/witch`.
- Click **Claude** or **Codex** to choose the terminal you read and address. Each tab keeps its own unsent draft.
- An amber marker marks unseen terminal output on a tab, including while minimized. It clears when that tab is selected with the window expanded. It signals new text, not a guarantee that the agent has finished responding; the first screen after connecting is the baseline. Updates continue with the window closed while context sharing is enabled; otherwise idle updates pause until reopened.
- Click the book icon for **Guides**, or **...** for **Appearance**. Adjust background opacity from 0% (clear) to 100% (solid) or choose 25/65/100%. Text stays fully visible; the setting survives reload. Default opacity is 80%.
- The **/** button beside Send opens the selected agent's slash commands (/model, /compact, /resume and more) in the client's dropdown. Plain ones are typed with Enter at once; ones that take text are placed in the input for you to finish. Pickers they open are driven from **Keys**. On the Claude tab, /clear clears the mirrored desktop session.
- When an agent is waiting on a choice (a permission prompt or picker), numbered buttons above the composer answer it. If you are looking elsewhere, a raid-warning line and sound say which agent needs you or has finished, and its tab badge turns red or green.
- Shift-click an item, quest or spell while typing to insert it. Up and Down recall your sent prompts for that tab. Save reusable prompts with `/witch snippet add <prompt>` (`list`, `remove <n>`); they appear in the **/** menu. Key Bindings > AddOns > Witchcraft offers open-and-type, switch tab and interrupt, unbound by default.
- The footer shows the model and context in use. **Copy** can take the agent's last reply instead of the screen, **Keys > Find** searches the scrollback, and **/ > Write a long prompt** sends several lines as one prompt (up to about 4,600 bytes).
- **Settings:** Esc > Options > AddOns > Witchcraft, `/witch settings`, or Appearance > **All settings...** (the client opens Options only out of combat). Choose the window layer (above everything, normal, or behind other windows), lock or dock the window at the top of the screen, whether Escape closes it (off by default), whether it opens on login, the minimap button, alert text and sound and whether finishing alerts, whether terminal updates continue in combat (brief frame hitches are possible; prompts always go out), the choice buttons, the footer status line, prompt history size, font size, opacity and context sharing.
- Enter sends the line to that terminal. The separate **Enter** button accepts terminal prompts; **Keys** exposes Escape, arrows and Interrupt for the selected CLI.
- Scroll with the mouse wheel or Page Up/Page Down while the input is focused; End returns to the latest rows. **Copy** selects the visible terminal text for Ctrl+C. At narrow widths, Enter and Copy move into Keys. Context and Appearance remain reachable.
- Drag the title bar, or double-click its title/empty area to expand or collapse it. The minimize button beside close does the same; the expanded height is retained. Resize from the corner or use the font controls. Existing window positions and sizes are retained. The close button, `/witch` or the toggle keybinding hide the window; Escape never does, and in the input it only leaves the input. Pending input continues until acknowledged.
- The real terminal stays usable. **Ctrl+]** switches which agent it displays, independently of the WoW tabs.

| Command | Action |
|---|---|
| `/witch` | Show or hide the window |
| `/witch status` | Build, connection, ring cursor, pending input and session identifiers |
| `/witch guide` | Quest-help and loot-goal panel |
| `/witch quest [nudge\|details\|solution] <name/link/id>` | Prepare a quest-help prompt; defaults to nudge |
| `/witch loot [name/link/id]` | Prepare an add-goal prompt, or show the saved plan with no argument |
| `/witch rehearse [tank\|healer\|damage] [dungeon]` | Prepare a role-specific rehearsal, or list supported dungeons |
| `/witch nearby [zone]` | Prepare zone detours; blank uses fresh character context |
| `/witch passport` | Prepare a request for personal campaigns, milestones and notes |
| `/witch size 8-20` | Font size |
| `/witch opacity 0-100` | Background opacity percentage; 0 is clear, 100 is solid |
| `/witch context on\|off\|refresh` | Share, pause, or refresh character and tracked quest context |
| `/witch hz 0.125-2` | Active chunk load rate; idle loads back off |
| `/witch calibrate` / `/witch calibrate off` | Show calibration colors / return to the live strip |
| `/witch burstprobe [200-2000\|corrupt\|off]` | Set page dwell in milliseconds, emit the negative checksum control, or hide the dense probe |
| `/witch resend` | Explicitly retry retained input after a daemon restart |
| `/witch reset` | Reload the UI; waits until combat ends |

## Current limits

The build has offline Lua, Node and native Windows PTY validation. **The complete two-tab flow has not finished its in-game check.** The original Phase 0 spike proved live load-on-demand file reads and exact colors for the original one-row strip; the new two-row strip, font and complete flow need runtime verification.

The dense carrier is diagnostic only. It does not update the MCP cache or send input to either assistant, and it must not replace normal traffic until the 200/300/400/500 ms native matrix passes.

The window shows the current terminal screen and the bounded history supplied by the daemon. Rows that do not fit remain reachable by scrolling; terminal mouse interaction is unavailable. Chunk loading pauses during combat. Inputs are single lines up to 600 UTF-8 bytes; the maximum takes about 11.2 seconds to transmit at five frames per second, plus scheduling and acknowledgement time. No per-message reload is used. Exhausting the single-use chunk ring triggers a guarded reload outside combat.

Pending input and window preferences use `WitchcraftDB`; current terminal screens stay in memory. WoW writes SavedVariables on reload/logout, so the queue is not guaranteed to survive a client crash before that flush. A new daemon session never automatically submits input retained from an older session.

`Media/DejaVuSansMono.ttf` and its license are bundled unchanged. Restart the client after installing the font. Generated `Witchcraft_Chunk_NNNN` addons belong in the game AddOns directory and are not part of the source ZIP.
