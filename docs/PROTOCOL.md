# Witchcraft local transport v1

This is the implementation contract for the separate Claude and Codex terminals. It supersedes the original one-session framing sketch. Codecs are pure; the daemon's outbox owns session routing, accepted-message deduplication, acknowledgments, and PTY writes. There is no game-input injection.

## Pixel region

The addon draws two rows of 22 solid cells, each exactly 6 physical pixels square: a 132 × 12 pixel region. The top row cycles pending messages; the bottom row continuously advertises ring demand and UI identity. An idle top row is black. Capture samples the center of each cell from RGBA pixels. Calibration shows the Phase 0 pattern in the top row: red, green, blue, white, black, then 16 `(r,g,b)` level triples for `k=0..15`: `(k%4, floor(k/4), (k+1)%4)`, then magenta. Each level is multiplied by 85.

Colors encode six bits per cell: `value = (R/85)*16 + (G/85)*4 + B/85`. Channel levels are 0, 85, 170, 255. A captured channel must be within 40 of its nearest level; intervening gaps, out-of-range values, and invalid samples reject the frame. A checksum detects some capture damage; it provides neither authentication nor cryptographic integrity. The region is a local, visible user-input transport.

## Frames

All offsets in this table are one-based cell indices. Integers and bit streams use most-significant bits first.

| Cells | Field |
|---|---|
| 1 | Sync: magenta, value 51 |
| 2–4 | 18-bit message ID; normal messages 1–262143, heartbeat 0 |
| 5 | Frame index, 0–63 |
| 6 | Payload length 0–11, plus 32 for final frame; unused bit 16 must be zero |
| 7–21 | 11 payload bytes, packed into 15 six-bit cells, then two zero pad bits |
| 22 | Sum of `(cell value × cell index)` over cells 1–21, modulo 64 |

Unused payload bytes and the final two bits must be zero. Nonfinal frames carry exactly 11 bytes. Messages are at most 610 body bytes and 64 frames; encoding the maximum text currently takes 56 frames. Invalid checksums, padding, lengths, conflicting duplicates, conflicting final indices, or excess body bytes discard that candidate.

The top-row body is `epoch + tab + action + text`: eight ASCII hexadecimal characters, one tab digit, one action digit, then UTF-8 text. The epoch is a nonzero 32-bit daemon-run identity written as eight lowercase hex characters. ID allocation is monotonic within that epoch and never wraps; exhaustion needs a new epoch. Zero is reserved for heartbeat frames.

| Digit | Tab | Action digit | Action |
|---|---|---|---|
| 1 | Claude | 0 | Text |
| 2 | Codex | 1 | Enter |
| 3 | Copilot | 2 | Interrupt |
| 4 | AGY | 3 | Escape |
| | | 4 | Up |
| | | 5 | Down |

Text is valid UTF-8, at most 600 bytes, without Unicode C0 or C1 controls. Literal spaces, pipes, quotes, non-ASCII text, and emoji are allowed. Surrogate code points, malformed UTF-8, overlong encoding, and code points beyond U+10FFFF are rejected. Every non-text action requires an empty text field. A text message prefixed with `U+2062` (`INVISIBLE TIMES`, `\226\129\162`) is an in-band control request from the addon (`cols=40..240` to resize the daemon PTYs, or `clear-journal` to clear the session journal) and is consumed by the outbox without writing to any terminal. Action interpretation happens only after the daemon validates the current epoch, intended tab, and accepted ID. The codec does not execute or accept commands.

The decoder accepts out-of-order fragments and retains at most 32 incomplete IDs by default (configurable 1–128). Candidates expire after 30 seconds from their first fragment, including repeated fragments; the supported configurable interval is 1–60000 milliseconds. Completed candidates are removed and emitted. Cycling a complete message emits it again so a previously rejected message can be retried; the outbox must make accepted side effects idempotent and repeat the corresponding acknowledgment. Clear incomplete decoder state whenever the expected daemon epoch or UI nonce changes. The body epoch is not repeated in every fragment, so incomplete fragments must not survive those transitions.

## Heartbeat and reload identity

The bottom row is one final frame: ID 0, index 0, length 11. Its bytes are:

| Bytes | Meaning |
|---|---|
| 1–4 | Daemon epoch as four binary bytes; zero before a stream is attached |
| 5–8 | UI-session nonce as four binary bytes |
| 9–10 | Next chunk sequence as an unsigned 16-bit big-endian integer, 1–65535 |
| 11 | Flags: bit 0 combat, bit 1 reload requested; no other bits allowed |

The controller creates a fresh eight-hex UI nonce for each UI session; it is not restored from SavedVariables. The writer echoes this nonce in ready chunk payloads, and the addon rejects payloads belonging to a prior UI. A changed nonce resets writer cursor and pending writes. Bootstrap can advertise a zero daemon epoch while retaining its current UI nonce; placeholder chunks do not establish a stream identity. Actual generated chunk counts remain bounded to 9999; the wider heartbeat cursor allows the exhausted ring to advertise sequence 10000 with its reload/combat flags. The decoder returns `epoch`, `uiNonce`, `nextSeq`, `flags`, `combat`, and `reload`. The nonce and epoch are correlation identities, not secrets.

The binding carrier has a heartbeat as well. A binding frame with sequence `000000`, part and count `01` and the body `H` followed by one flags byte (bit 0 combat, bit 1 reload, no other bits) carries the session's epoch, binding nonce and UI nonce like a data frame and names only the ring slot the addon wants next. The host checks the session ids and the CRC, offers the slot as the writer cursor and writes that slot at once when the cursor moved. It never acknowledges a heartbeat and leaves the stop-and-wait sequence alone; a re-read of the same frame is offered again. The addon writes one at most once a second, only when the slot or flags changed and only while the carrier is idle, after a stall or while the last chunk names the `file` lane. A data frame takes the heartbeat's key; stopping, cancelling or quarantining the carrier clears it.

## Public codec APIs

Lua `ns.Pixel` exports `Encode(message)`, `Heartbeat(epoch, nextSeq, flags, uiNonce)`, `Calibration()`, `ValidText(text)`, and `New({maxPending=32})`. Results are arrays of RGB triples with integer channels; the view divides channels by 255. Invalid encode/heartbeat input returns `nil, reason`. Message objects use `{epoch,id,tab,action,text}`; `session` is accepted as a `tab` alias when `tab` is absent. Optional queue methods are `Queue(message)`, `Next()`, `Ack(id,epoch)`, `Pending()`, and `Clear()`. The queue holds the oldest message until an exact epoch/ID acknowledgment, rejects ID reuse, and defaults to 32 pending messages (maximum 64).

JavaScript exports `encodeMessage`, `encodeHeartbeat`, `decodeFrame`, `decodeHeartbeat`, `calibrationCells`, `sampleFrame`, `calibrate`, and `PixelDecoder`. `sampleFrame(image,{x,y,cellSize=6,row=0})` accepts `{width,height,data}` with tightly packed RGBA bytes. `calibrate(image)` locates the full solid calibration pattern at six-pixel cell size and returns `{x,y,width:132,height:12,cellSize:6}`, or `null`. `new PixelDecoder({timeoutMs=30000,maxPending=32}).push(cells,now)` returns a complete `{epoch,id,tab,action,text}` or `null`; `clear()` discards incomplete fragments. Decode methods return `null` for invalid input; encode methods throw `TypeError`.

## Terminal display and Lua chunks

`wowtext.renderRow(runs,{cols=120})` and `renderRows` escape every literal pipe before adding the daemon's own color markers. Texture, link, atlas, and arbitrary WoW markup from terminal text remain literal. Controls become spaces and non-BMP glyphs become `?` for the static font. A row is bounded to 1–240 terminal columns; snapshots to 100 rows. Foreground supports ANSI 16/256 palettes, truecolor, bright ANSI colors for bold, and dimming. Background colors, font weight for truecolor bold, cursor animation, and pixel-exact glyph-width parity are not reproduced by FontStrings.

For exact terminal column accounting, the screen adapter provides one run per xterm cell with `width: cell.getWidth()`, skips continuation cells of width zero, and preserves combining characters in the preceding cell. Runs without a width are treated as already-normalized BMP text. `fg` accepts `{mode:'palette',value}`, `{mode:'rgb',value}`, a palette index, a six-digit hex string, or `{r,g,b}`. Literal terminal content is never treated as a clickable WoW link.

Context extension fields in a ready chunk travel together or not at all: `contextProtocol` (literal 4), `contextAck` (0..262143), `contextWant` (0..262143, a changed id means capture now) and `contextWantMask` (0..15; bit 1 player, bit 2 quests, bit 4 progress, bit 8 errors, naming only the domains requested since the previous id). Both the daemon writer and the addon ring reject a chunk carrying some but not all four, and an addon on this protocol shows "Unsupported host" for an older protocol daemon.

A ready chunk also carries `cursorLane`: `strip` when the pixel heartbeat is alive (seen within the last second) and last set the writer cursor, `file` when a carrier frame (binding or cooldown) moved it while the strip was quiet for more than a second, and nil before any request. The addon treats any other value as nil.

`lua.serializeChunk(payload)` emits exactly one `Witchcraft_ReceiveChunk(<literal table>)` call. `quoteLua` emits fixed three-digit decimal escapes for control and non-ASCII UTF-8 bytes, preventing delimiter or adjacent-digit ambiguity. Serialization permits bounded ordinary arrays, objects, booleans, finite numbers, strings, and null-as-nil; it rejects executable values, accessors, nonstandard prototypes, cycles, sparse arrays, and unsafe property names. Maximum default depth is 8, node count 20000, and output one MiB. No input Lua source is evaluated.

## Trust boundary: co-installed addons

Every addon loaded in the same client is trusted with both agent sessions. WoW gives addons one shared Lua environment, and none of the input lanes can tell Witchcraft's own input from another addon's:

- Input frames are checked only for format, epoch and ID. The epoch, UI nonce and binding nonce are published in every ring chunk, so any addon can read them and write a well-formed frame to the pixel strip, the binding cache or `WitchcraftDB.global.outbox`.
- Any addon can drive Witchcraft's own window (set the edit box text and invoke its `OnEnterPressed` script) or call `/witch`, and that input is indistinguishable from typing. A message authentication code would stop frame forgery but not this, so none is used.
- Text frames end in Enter, so forged input can answer an agent's tool-approval prompt. The agents run over the repository checkout with the daemon's environment.
- Both terminal transcripts, including up to the configured history, are in the ring chunks any addon can read while the daemon runs; `stop` rewrites every slot it published back to the not-ready placeholder.

Mitigations in place: the controller is not reachable from the public AceAddon object; input for a tab that is not running is consumed as dropped instead of blocking the in-order lanes; every input decision and carrier error is recorded without its text in `tools/witchcraft-daemon/.local/events.log`. Run the daemon only while every enabled addon is one you would trust with a shell on this machine.

## Evidence limits

The original one-row calibration and live load-on-demand file read passed Phase 0 on 1.60.1.69913, as recorded in `VALIDATION.md`. The two-row protocol, queueing, hostile text handling, and cross-language vectors have offline tests. They still require the matching in-game two-tab streaming, capture, reload, combat, and acknowledgment checks; a codec test does not establish native timing or font rendering.
