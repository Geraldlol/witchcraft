# Witchcraft WoW MCP

Witchcraft shares read-only character, location, tracked quest, and progression snapshots with Claude and Codex: the terminals it launches, and the Claude Code session the Claude tab joins once that session has the server registered. The addon sends ordinary game data through a distinct pixel channel; the desktop daemon validates and caches it; each assistant gets its own local STDIO MCP adapter reading that cache.

## Use it

After installing this build, restart the Witchcraft desktop daemon with your usual command and run `/reload` in WoW outside combat. A terminal Witchcraft launches (the Codex tab, or a Claude tab with `--no-current`) gets the MCP configuration from the restarted daemon; preserve your existing `--continue` or `resume` arguments. A joined Claude session gets it once from `mcp-setup --apply` (below), then a restart of that session and of Witchcraft. No game restart or pixel recalibration is needed for this extension: the strip remains two rows of 22 cells.

Open **WoW context** in Witchcraft's footer. Sharing starts enabled, persists across reloads, and continues when the window is closed. The panel shows acknowledged character/quest summaries and capture age; **Pause sharing** clears the desktop context once the off message reaches it. **Update now** requests a new snapshot behind any transfer already in progress. `/witch context on`, `/witch context off`, and `/witch context refresh` expose the same controls.

Ask either assistant: “Use the WoW tools to tell me where I am and what remains for my tracked quests.”

| MCP interface | Result |
|---|---|
| `wow_get_context` | Full context plus session, connection, freshness, availability and truncation metadata |
| `wow_get_character` | Character name, class, level, map ID, zone and subzone |
| `wow_get_quests` | Tracked quests with IDs, titles, completion and objective progress |
| `wow_get_progress` | The player's own money, experience toward the next level and rested bonus, and situation: instance, difficulty, group size and own role, dead or ghost, in combat |
| `wow_get_errors` | The newest Lua errors, warnings and blocked actions Witchcraft recorded (up to 8 of 20 stored): kind, message, top three stack frames, repeat count, first and last seen, reloads ago. Untrusted text from any installed addon |
| `wow_find_guide` | Search the limited local quest/item catalog without revealing solutions |
| `wow_explain_quest` | Selected hint tier, observed tracked-quest evidence, reference requirements and explicit unknowns |
| `wow_get_loot_sources` | Reference item sources and encounters; does not save goals |
| `wow_get_loot_plan` | Saved goals ranked by distinct active wishlist items per acquisition source |
| `wow_set_loot_goal` | **Local write:** add/reopen, mark acquired, or remove one goal in an explicitly named profile |
| `wow_rehearse_dungeon` | Role-specific indexed lessons, related loot goals, practice questions, explicit answer/reveal modes |
| `wow_suggest_detours` | Reference suggestions for the current or explicitly selected zone, filtered by personal stamps |
| `wow_get_passport` | Personal campaigns, user-confirmed progress and scrapbook notes |
| `wow_stamp_passport` | **Local write:** record or remove a user-confirmed milestone and optional note |
| `wow_set_passport_campaign` | **Local write:** enroll in or leave a personal campaign while preserving stamps |
| `wow://context` | The same complete snapshot as a read-only MCP resource |

The Guides and Adventures features add no game-data domain or gameplay actions. Their small catalogs are Classic reference data, not verified Forever requirements, mechanics or drop tables. Quest diagnosis pulls only player and tracked-quest context. Detours request only player context when no explicit zone was supplied. Other adventure queries use local references and personal records. Spoilers default to hints; higher tiers and quiz reveals must be requested. Historical turn-ins, acquired items and passport stamps are user assertions, never inferred from tracked objectives, zone presence or a completed rehearsal. The three named local-write tools save only fixed sibling goals/passport documents with cross-process locking. They are registered only when the adapter is launched with `--allow-local-writes`, which the daemon passes to the assistants it launches; a bare `witchcraft-mcp` is read-only. Twelve tools remain read-only. Normal assistant approval behavior still applies.

Each tool owns the domains it returns and pulls only those: `wow_get_character` owns `player`, `wow_get_quests` owns `quests`, `wow_get_progress` owns `progress`, `wow_get_errors` owns `errors`, and `wow_get_context` and the resource own the three game domains; errors are never part of a general context pull or a manual refresh, and the errors tool re-requests any copy older than five seconds. A tool's top-level `status` is computed over its own domains, so the character tool never reads `partial` because progression was never asked for. Group data is the group's size and the player's own role only; nothing about other players is exported.

`witchcraft run` adds the local MCP configuration to recognized `claude`/`claude.exe` and `codex`/`codex.exe` commands, including absolute executable paths. It preserves your existing arguments and other MCP configuration. It does not change global assistant settings or automatically approve tool calls. Custom shell commands remain unchanged. `--no-mcp` skips this launch-time integration; the in-game sharing control determines whether game data is exported.

By default the Claude tab joins your own running Claude Code session instead (`--no-current` starts a fresh one), and Witchcraft did not launch it, so it has no WoW tools until they are registered once. `node bin/witchcraft.js mcp-setup` prints the local-scope `claude mcp add` for the checkout it runs from (the same server, cache and local writes spawned tabs get), and `--apply` runs it in the repo root, or in `--cwd` when given. Claude reads its servers when a session starts, so restart that session once and then restart Witchcraft. While it runs, each WoW MCP server keeps a record in `.local/mcp-clients/` naming the process that started it; that is how the daemon window and the in-game footer can tell that a joined session lacks the tools. Servers from before this record existed do not write one, so restart the session after updating.

To attach an independently launched MCP client, run the adapter with Node:

```text
node <absolute-repo-path>/tools/witchcraft-daemon/bin/witchcraft-mcp.js
```

The default cache is `tools/witchcraft-daemon/.local/wow-context.json`. The optional `--cache <absolute-path>` launcher argument selects one fixed cache file. Tools cannot choose arbitrary files. The adapter neither starts the game nor launches a terminal. It uses the official MCP SDK's STDIO transport; there is no listening network port. See [MCP STDIO documentation](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio.html), [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), and [Claude MCP configuration](https://code.claude.com/docs/en/mcp).

## Delivery and freshness

User prompts and terminal keys always take precedence over telemetry. Context uses an independent frame marker, decoder, message IDs and acknowledgements. Both host epoch and UI nonce must match. It cannot enter either PTY through the terminal-input handler. Data acknowledgements are published only after the cache file is replaced successfully; cache failures do not stop terminal input.

Player data is one part. Quests have at most ten parts, and the desktop exposes a new quest revision only after every part arrives. Current limits are ten tracked quests, four objectives per quest, 40 UTF-8 bytes per character/location text field, and 64 bytes per quest title/objective. An additional byte budget can shorten objective lists. Truncation and API unavailability are explicit; missing progress is null rather than an invented zero.

Context is pulled, not streamed. The addon announces its sharing preference once and stays quiet until a tool asks or the user explicitly requests an update. A tool that finds its domains fresh returns the cache untouched; otherwise it writes a per-domain want file beside the cache (`wow-context.want.player.json`, `.quests.json`, `.progress.json`) and waits up to twelve seconds. The daemon folds newly requested domains into the next ring chunk as a new `contextWant` id with a `contextWantMask` (bit 1 player, bit 2 quests, bit 4 progress, bit 8 errors; chunk `contextProtocol` 4). The mask names only the domains requested since the previous id, so a chunk the game never reads simply costs that caller one stale answer; its next call raises a fresh want. Once received, unserved domain requests remain merged across repeated chunks. The addon captures the masked domains in the order player, progress, quests (progress is one cheap part and answers "how far to level"), only while sharing is enabled.

UPDATE NOW and `/witch context refresh` request one pass through all three domains. Repeated requests coalesce behind any incomplete revision and pending user input. Pausing sharing cancels a queued refresh. Ordinary game events do not start captures, and a completed refresh does not arm a periodic stream. Retries are bounded. The underlying pixel lane carries approximately 55 payload bytes/second before envelope and retry costs. A quest snapshot can take tens of seconds, especially while typing or waiting for acknowledgements during combat.

MCP calculates freshness on every read. Data older than 180 seconds is stale; missing heartbeats after 30 seconds mark the connection disconnected. Heartbeats never refresh game observations. Desktop sample ages conservatively include a 30-second retransmission allowance plus observed assembly time. The in-game panel uses its local capture clock. A new UI/host session clears prior context; pausing sharing clears data after delivery. Offline or stale cache data is never presented as a fresh observation.

## Status

Offline tests establish codec, cache, interface and lifecycle behavior. Native WoW delivery, client API returns, latency and combat transitions still require the recorded in-game acceptance checks.
