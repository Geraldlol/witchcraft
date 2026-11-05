# Copilot CLI integration

Feature: add opt-in GitHub Copilot CLI support.
Baseline: `c159039e9a29e6af041eb8daaa17e43e9e922ff5`; branch `codex/copilot-cli`.
UI design: extend the existing tab style with a third assistant.

## Scope and compatibility

The existing target remains WoW Forever, interface 16001, Windows and Node 24+.
No new WoW APIs, client detection, or carrier qualification rules are introduced.
The source branch `Gethe/wow-ui-source:forever` resolved on 2026-11-05 to
`eac30af597e5aaa43a60f6675ef5fdcea100375f`, version `1.60.1.70790`.
This is source metadata, not runtime qualification. Existing optional carrier pins remain unchanged.

Copilot is opt-in (`--only copilot`, `--with-copilot`, `--tab copilot`, or a local command entry).
The default still launches Claude and Codex. Copilot starts fresh; `/resume` or configured
`--resume SESSION_ID` supplies explicit continuation. Automatic Copilot transcript discovery,
model/context footer metadata, and Copy last reply are outside this integration; screen copying works.
Normal CLI approvals remain in effect. MCP registration is scoped to the launched process.
Native executables take priority; npm Copilot can run via Node without a shell.

Update daemon and addon together. Existing Claude/Codex wire IDs are preserved.
The updated addon accepts both the old two-session and new three-session snapshots.
Old addons reject three-session snapshots. The bundled overlay and daemon must match.

## Requirements and implementation matrix

| ID | Acceptance | Implementation | Evidence |
|---|---|---|---|
| REQ-01 | Launch Copilot alone or alongside existing agents; preserve defaults | `agents.js`, CLI parser, `pty.js`, management script | Node selection, npm resolution and PTY tests; native Windows `copilot --help` smoke passes |
| REQ-02 | Independent tab, drafts, history, scrolling, keys and cycling | `Core.lua`, `View.lua`, sessions, overlay | Lua controller tests; Node keyboard/lifecycle/overlay tests; simulator checks below |
| REQ-03 | Route Copilot input over existing transports without changing old IDs | `Binding.lua`, `Pixel.lua`, host decoders, outbox | Pixel/binding/outbox round trips for all three agents; Lua encoding acceptance |
| REQ-04 | Persist Copilot selection and validate terminal output | persistence and `Ring.lua` | Lua tests for saved selection, old/new snapshots, duplicates and invalid IDs |
| REQ-05 | Provide WoW MCP without global config changes or approval bypass | `mcp-launch.js` | Tests for MCP arguments, paths with spaces, resume arguments, unchanged caller args and no approval flags |
| REQ-06 | Attach an existing Copilot console and preserve ownership | `SessionSet`, parser, management script | Mirror input/lifecycle tests; existing-console MCP setup documented |
| REQ-07 | Explain setup and limits | root/addon/daemon READMEs, MCP docs, changelog | Documented commands, npm fallback, explicit resume, metadata limits and paired update requirement |

## Validation checkpoint

Implementation is complete; the checks below describe the PR validation scope.
`npm test` passes 10 tests, including Lua 5.1 syntax and controller execution via the test-only
Fengari runtime. Node dependencies install successfully; `node-pty` rebuild/load succeeds.
Native Windows Copilot 0.0.362 launches through the real PTY with the injected MCP arguments,
prints help and exits zero. This smoke does not exercise an authenticated model response.
PowerShell syntax, JavaScript syntax for 52 source files, and `git diff --check` pass.

Simulator: UIForever Forever in Edge, 2026-11-05, reported build 1.60.1.70450 / interface 16001,
Solo scenario, 2560x1440, UI scale 0.64, with another addon enabled. WITCHCRAFT loads, shows all three tabs, selects Copilot,
retains a draft when switching tabs, and preserves Copilot selection through `/reload`.
The final build was re-imported and checked at 900x650 and 360x400 addon sizes; all three
tab labels fit and the Errors panel reports no Lua errors. The simulator lists one pre-existing
missing API with the other addon loaded; it was not attributed to this change.
Its bundled font is unavailable in the simulator,
so its existing fallback-font banner appears. No real game transport is connected.

Real-client verification remains not run: launch `run --only copilot`, `/reload`, qualify the
binding carrier with `/witch bindprobe`, send a prompt, exercise a permission picker, request
WoW context, switch tabs, reload to check saved selection, then stop the daemon. Repeat with
`--with-copilot` to verify concurrent live responses. Simulator/static results do not certify
native transport, combat behavior, or an authenticated Copilot/MCP turn.
