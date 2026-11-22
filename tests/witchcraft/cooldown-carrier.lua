local ns, test, equal = ...
local Carrier = ns.CooldownCarrier

local function copy(value, seen)
    if type(value) ~= "table" then return value end
    seen = seen or {}
    if seen[value] then return seen[value] end
    local result = {}; seen[value] = result
    for key, child in pairs(value) do result[copy(key, seen)] = copy(child, seen) end
    return result
end

local function fixture(initial)
    local state = { now = 0, combat = false, raw = initial and "1|QkFTRQ==" or "",
        persisted = copy(initial), sets = 0, codec = {} }
    local api = {
        Now = function() return state.now end,
        Build = function() return ns.Evidence.version, state.build or ns.Evidence.build, "date", ns.Evidence.interface end,
        Combat = function() return state.combat end,
        Insecure = function() return true end,
        SurfaceUntainted = function() return true end,
        Accessible = function() return true end,
        Security = function() return 1 end,
        Deflate = 1,
        GetLayoutData = function() return state.raw end,
        SetLayoutData = function(value)
            state.sets = state.sets + 1
            if state.failSetAt == state.sets then error("injected set failure") end
            state.raw = value
            if value == "" then state.persisted = nil else state.persisted = copy(state.serialized) end
            if state.mismatch then state.raw = value .. "x" end
        end,
        EncodeBase64 = function(value)
            local encoded = ({ ZBASE = "QkFTRQ==", ZWITH = "V0lUSA==" })[value]
            assert(encoded)
            if not state.decoding then state.fresh = value:sub(2) end
            return encoded
        end,
        DecodeBase64 = function(value)
            local token = ({ ["QkFTRQ=="] = "BASE", ["V0lUSA=="] = "WITH" })[value]
            assert(token); state.decoding, state.decodeToken = true, token
            return "Z" .. token
        end,
        Compress = function(value) assert(value == "BASE" or value == "WITH"); return "Z" .. value end,
        Decompress = function(value)
            assert(value == "ZBASE" or value == "ZWITH"); state.decoding = nil
            return value:sub(2)
        end,
        SerializeCBOR = function(value)
            local token = value[127] and "WITH" or "BASE"
            state.serialized, state.codec[token] = copy(value), copy(value)
            return token
        end,
        DeserializeCBOR = function()
            local result
            if state.fresh == state.decodeToken then result, state.fresh = state.codec[state.decodeToken], nil
            else result = state.persisted end
            return copy(result)
        end,
    }
    return Carrier.New(api), state
end

local session = { epoch = "1234abcd", nonce = "89abcdef", uiNonce = "10293847" }
ns.TestCooldownFixture = fixture

local function hex(wire)
    return (wire:gsub(".", function(value) return string.format("%02x", value:byte()) end))
end

test("cooldown carrier Lua frame matches the independent host golden vector", function()
    equal(Carrier.CRC32("123456789"), 3421780262)
    equal(Carrier.Protocol, 2)
    -- Protocol 2: the slot (2 bytes) sits after count and before the payload length.
    local wire = assert(Carrier.Frame({ epoch = session.epoch, nonce = session.nonce, uiNonce = session.uiNonce,
        seq = 1, message = 1, part = 1, count = 1, slot = 7, kind = "context", payload = "hello" }))
    equal(hex(wire), "464302011234abcd89abcdef1029384700000100000101010007000568656c6c6f873e25be")
    local decoded = assert(Carrier.ParseFrame(wire))
    equal(decoded.epoch, session.epoch); equal(decoded.nonce, session.nonce)
    equal(decoded.seq, 1); equal(decoded.slot, 7); equal(decoded.payload, "hello"); equal(decoded.kind, "context")
    equal(Carrier.ParseFrame(wire:sub(1, -2) .. string.char((wire:byte(-1) + 1) % 256)), nil)
    -- A protocol 1 frame (the same fields without the slot) is refused even with a valid checksum.
    local oldBody = "FC" .. string.char(1, 1) .. wire:sub(5, 24) .. wire:sub(27, 33)
    local crc = Carrier.CRC32(oldBody)
    equal(Carrier.ParseFrame(oldBody .. string.char(math.floor(crc / 16777216), math.floor(crc / 65536) % 256,
        math.floor(crc / 256) % 256, crc % 256)), nil, "protocol 1 is refused by the parser")
    equal(Carrier.Frame({ epoch = session.epoch, nonce = session.nonce, uiNonce = session.uiNonce,
        seq = 1, message = 1, part = 1, count = 1, kind = "context", payload = "hello" }), nil, "a data frame needs a slot")
    equal(Carrier.Frame({ epoch = session.epoch, nonce = session.nonce, uiNonce = session.uiNonce,
        seq = 1, message = 1, part = 1, count = 1, slot = 10000, kind = "context", payload = "hello" }), nil)
end)

test("cooldown carrier heartbeat frame matches the independent host golden vector", function()
    -- Kind 2, message 0, part 1, count 1, one byte of flags (bit 0 combat, bit 1 reload),
    -- seq = the next data sequence number, slot = the ring's next sequence number.
    local heartbeat = assert(Carrier.Frame({ epoch = session.epoch, nonce = session.nonce, uiNonce = session.uiNonce,
        seq = 1, message = 0, part = 1, count = 1, slot = 7, kind = "heartbeat", payload = string.char(0) }))
    equal(hex(heartbeat), "464302021234abcd89abcdef102938470000010000000101000700010025d69f98")
    local decoded = assert(Carrier.ParseFrame(heartbeat))
    equal(decoded.kind, "heartbeat"); equal(decoded.slot, 7); equal(decoded.message, 0); equal(decoded.payload, "\0")
    -- Before a host session the heartbeat carries zero epoch and nonce with the real uiNonce.
    local bootstrap = assert(Carrier.Frame({ epoch = "00000000", nonce = "00000000", uiNonce = session.uiNonce,
        seq = 1, message = 0, part = 1, count = 1, slot = 7, kind = "heartbeat", payload = string.char(0) }))
    equal(hex(bootstrap), "46430202000000000000000010293847000001000000010100070001009951c472")
    local parsed = assert(Carrier.ParseFrame(bootstrap))
    equal(parsed.epoch, "00000000"); equal(parsed.nonce, "00000000"); equal(parsed.uiNonce, session.uiNonce)
    -- Zero ids belong to heartbeats only; a heartbeat is exactly one part with one flag byte and message 0.
    local base = { uiNonce = session.uiNonce, seq = 1, part = 1, count = 1, slot = 7 }
    local function frame(overrides)
        local fields = {}
        for key, value in pairs(base) do fields[key] = value end
        for key, value in pairs(overrides) do fields[key] = value end
        return Carrier.Frame(fields)
    end
    equal(frame({ epoch = "00000000", nonce = "00000000", message = 1, kind = "context", payload = "hello" }), nil)
    equal(frame({ epoch = "00000000", nonce = session.nonce, message = 0, kind = "heartbeat", payload = "\0" }), nil)
    equal(frame({ epoch = session.epoch, nonce = session.nonce, message = 1, kind = "heartbeat", payload = "\0" }), nil)
    equal(frame({ epoch = session.epoch, nonce = session.nonce, message = 0, kind = "heartbeat", payload = "\0\0" }), nil)
    equal(frame({ epoch = session.epoch, nonce = session.nonce, message = 0, count = 2, kind = "heartbeat", payload = "\0" }), nil)
    equal(frame({ epoch = session.epoch, nonce = session.nonce, message = 0, kind = "context", payload = "hello" }), nil)
end)

test("cooldown carrier is inert until start and restores an initially empty layout after ACK", function()
    local carrier, state = fixture()
    equal(carrier:Pump(nil, 1), false); equal(state.sets, 0)
    assert(carrier:Start(session)); assert(carrier:OfferContext(1, "hello")); assert(carrier:Pump(nil, 1))
    equal(state.sets, 1); assert(state.persisted[127]); equal(carrier.status, "waiting")
    state.now = state.now + 1
    local outstanding = carrier.outstanding
    assert(carrier:AcceptHost({ epoch = session.epoch, cooldownProtocol = 2,
        cooldownNonce = session.nonce, cooldownAck = 1, cooldownChecksum = outstanding.checksum }))
    equal(state.sets, 2); equal(state.raw, ""); equal(state.persisted, nil)
    equal(carrier.status, "ready"); equal(carrier.nextSeq, 2)
end)

test("cooldown carrier preserves existing fields and a concurrent layout change during cleanup", function()
    local original = { [1] = 5, [2] = { [42] = 7 }, [3] = { [9] = { [1] = 11 } }, [4] = { [11] = "name" } }
    local carrier, state = fixture(original)
    assert(carrier:Start(session)); assert(carrier:OfferContext(1, "hello")); assert(carrier:Pump(nil, 1))
    equal(state.persisted[2][42], 7); equal(state.persisted[3][9][1], 11); equal(state.persisted[4][11], "name")
    state.persisted[2][99] = 8
    state.now = state.now + 1
    local outstanding = carrier.outstanding
    assert(carrier:AcceptHost({ epoch = session.epoch, cooldownProtocol = 2,
        cooldownNonce = session.nonce, cooldownAck = 1, cooldownChecksum = outstanding.checksum }))
    equal(state.persisted[127], nil); equal(state.persisted[2][42], 7); equal(state.persisted[2][99], 8)
end)

test("cooldown carrier refuses unknown layout fields and never overwrites an ownership conflict", function()
    local unknown, unknownState = fixture({ [1] = 5, [2] = {}, [3] = {}, [4] = {}, [99] = "future" })
    equal(unknown:Start(session), false); equal(unknownState.sets, 0)
    local carrier, state = fixture()
    assert(carrier:Start(session)); assert(carrier:OfferContext(1, "hello")); assert(carrier:Pump(nil, 1))
    state.persisted[127] = "other owner"
    local outstanding = carrier.outstanding
    equal(carrier:AcceptHost({ epoch = session.epoch, cooldownProtocol = 2,
        cooldownNonce = session.nonce, cooldownAck = 1, cooldownChecksum = outstanding.checksum }), false)
    equal(state.sets, 1); equal(state.persisted[127], "other owner"); equal(carrier.status, "quarantined")
end)

test("a stale Witchcraft frame left in field 127 is scrubbed at start; a foreign occupant is not", function()
    -- Observed in game on 2026-09-21: a frame from a UI session reloaded before its ACK stayed in
    -- the live layout and every later start refused it, silently disabling the carrier.
    local stale = assert(Carrier.Frame({ epoch = "deadbeef", nonce = "0badf00d", uiNonce = "8200f394",
        seq = 1, message = 1, part = 1, count = 1, slot = 3, kind = "context", payload = "old" }))
    local carrier, state = fixture({ [1] = 5, [2] = {}, [3] = {}, [4] = {}, [127] = stale })
    assert(carrier:Start(session), "a frame that verifies as ours is scrubbed instead of blocking the carrier")
    equal(state.sets, 1); equal(state.raw, "", "an otherwise empty layout is restored to the empty value")
    equal(carrier.status, "ready")

    local kept, keptState = fixture({ [1] = 5, [2] = { [42] = 7 }, [3] = {}, [4] = {}, [127] = stale })
    assert(kept:Start(session))
    equal(keptState.sets, 1); equal(keptState.persisted[127], nil)
    equal(keptState.persisted[2][42], 7, "user fields survive the scrub")

    local foreign, foreignState = fixture({ [1] = 5, [2] = {}, [3] = {}, [4] = {}, [127] = "other owner" })
    local ok, reason = foreign:Start(session)
    equal(ok, false); equal(foreignState.sets, 0)
    equal(reason, "cooldown layout field 127 is already occupied", "a value that is not our frame is never touched")
end)

test("a carrier restarted within one session keeps its sequence and resyncs to the host acknowledgement", function()
    -- In game on 2026-09-22 a quarantine (ACK timeout while the ring was stalled) rewound the
    -- sequence to 1; the host still expected the next number, so nothing was ever acknowledged again.
    local carrier, state = fixture()
    assert(carrier:Start(session)); assert(carrier:OfferContext(1, "hello")); assert(carrier:Pump(nil, 1))
    local first = carrier.outstanding
    state.now = state.now + 1
    assert(carrier:AcceptHost({ epoch = session.epoch, cooldownProtocol = 2, cooldownNonce = session.nonce,
        cooldownAck = 1, cooldownChecksum = first.checksum }))
    assert(carrier:OfferContext(2, "again")); state.now = state.now + 1; assert(carrier:Pump(nil, 1))
    equal(carrier.outstanding.seq, 2)
    state.now = state.now + 31
    equal(carrier:Pump(nil, 1), false); equal(carrier.status, "quarantined")
    assert(carrier:RestoreOwned()); assert(carrier:Reset())
    assert(carrier:Start({ epoch = session.epoch, nonce = session.nonce, uiNonce = session.uiNonce, ack = 1 }))
    assert(carrier:OfferContext(3, "third")); state.now = state.now + 1; assert(carrier:Pump(nil, 1))
    equal(carrier.outstanding.seq, 2, "the sequence continues from the last host acknowledgement")
    equal(carrier.active.message, 2, "the message number is not rewound either")

    -- If the host had acknowledged the frame the addon gave up on, the restart skips past it.
    state.now = state.now + 31
    equal(carrier:Pump(nil, 1), false); assert(carrier:RestoreOwned()); assert(carrier:Reset())
    assert(carrier:Start({ epoch = session.epoch, nonce = session.nonce, uiNonce = session.uiNonce, ack = 2 }))
    assert(carrier:OfferContext(4, "fourth")); state.now = state.now + 1; assert(carrier:Pump(nil, 1))
    equal(carrier.outstanding.seq, 3, "a host acknowledgement seen only through the ring moves the sequence forward")

    -- A different session starts from 1 again.
    state.now = state.now + 31
    equal(carrier:Pump(nil, 1), false); assert(carrier:RestoreOwned()); assert(carrier:Reset())
    assert(carrier:Start({ epoch = session.epoch, nonce = "0badf00d", uiNonce = session.uiNonce }))
    assert(carrier:OfferContext(5, "fresh")); state.now = state.now + 1; assert(carrier:Pump(nil, 1))
    equal(carrier.outstanding.seq, 1); equal(carrier.active.message, 1)
end)

test("an acknowledgement that lands while nothing is outstanding is adopted, never reused", function()
    -- A published ack can reach a ready carrier (the ring delivered it after the frame was
    -- cleared by a restart); without adopting it the next frame would reuse an acknowledged number.
    local function ack(nonce, value)
        return { epoch = session.epoch, cooldownProtocol = 2, cooldownNonce = nonce, cooldownAck = value, cooldownChecksum = 0 }
    end
    local carrier, state = fixture()
    assert(carrier:Start(session))
    local ok, reason = carrier:AcceptHost(ack(session.nonce, 3))
    equal(ok, false); equal(reason, "acknowledgement adopted")
    equal(carrier.lastAck, 3); equal(carrier.nextSeq, 4)
    equal(carrier.status, "ready"); equal(carrier.quarantined, nil); equal(state.sets, 0)
    for _, value in ipairs({ 2, 3 }) do
        ok, reason = carrier:AcceptHost(ack(session.nonce, value))
        equal(ok, false); assert(reason ~= "acknowledgement adopted", "a lower or equal ack is not an adoption")
        equal(carrier.lastAck, 3); equal(carrier.nextSeq, 4)
    end
    ok, reason = carrier:AcceptHost(ack("0badf00d", 9))
    equal(ok, false); equal(reason, "invalid carrier acknowledgement", "another session's ack is not ours")
    equal(carrier.lastAck, 3); equal(carrier.nextSeq, 4)
    carrier.nextSeq = 10
    equal(carrier:AcceptHost(ack(session.nonce, 5)), false)
    equal(carrier.lastAck, 5); equal(carrier.nextSeq, 10, "a sequence already past the ack is not rewound")
    carrier.nextSeq = 4
    assert(carrier:OfferContext(1, "hello")); assert(carrier:Pump(nil, 1))
    equal(carrier.outstanding.seq, 4, "the next frame skips the acknowledged numbers")
    equal(Carrier.ParseFrame(state.persisted[127]).seq, 4)
end)

test("a bootstrap heartbeat that fails to write is retried by the next offer, not quarantined", function()
    -- Before a host session the carrier owns nothing worth protecting, and a quarantine there
    -- would silence the transport until a host chunk happened to reset it.
    local carrier, state = fixture()
    assert(carrier:Bootstrap(session.uiNonce))
    local read, serialize = carrier.api.GetLayoutData, carrier.api.SerializeCBOR
    carrier.api.GetLayoutData = function() error("injected read failure") end
    local ok, reason = carrier:Heartbeat(5, 0)
    equal(ok, false); equal(reason, "layout read failed")
    equal(carrier.status, "stopped"); equal(carrier.quarantined, nil)
    carrier.api.GetLayoutData = read
    carrier.api.SerializeCBOR = function() error("injected codec failure") end
    ok, reason = carrier:Heartbeat(5, 0)
    equal(ok, false); equal(reason, "nondeterministic codec"); equal(carrier.status, "stopped")
    carrier.api.SerializeCBOR = serialize
    state.mismatch = true
    ok, reason = carrier:Heartbeat(5, 0)
    equal(ok, false); equal(reason, "layout write readback mismatch")
    equal(carrier.status, "stopped"); equal(carrier.quarantined, nil); equal(state.sets, 1)
    state.mismatch, state.raw = nil, ""
    state.now = state.now + 1
    assert(carrier:Heartbeat(5, 0), "the next offer simply tries again"); equal(state.sets, 2)

    -- Once a host session exists the same failure quarantines, as any owned write does.
    assert(carrier:Start(session)); equal(carrier.status, "ready")
    state.now = state.now + 1
    carrier.api.GetLayoutData = function() error("injected read failure") end
    ok, reason = carrier:Heartbeat(6, 0)
    equal(ok, false); equal(reason, "layout read failed"); equal(carrier.status, "quarantined")
    carrier.api.GetLayoutData = read
    local mismatch, mismatchState = fixture()
    assert(mismatch:Start(session)); mismatchState.mismatch = true
    ok, reason = mismatch:Heartbeat(6, 0)
    equal(ok, false); equal(reason, "layout write readback mismatch"); equal(mismatch.status, "quarantined")
end)

test("the acknowledgement timeout counts ring deliveries, not wall-clock seconds", function()
    -- A stalled ring (game in the background) delivers no chunks, so no acknowledgement can
    -- arrive; that is a pause, not a dead host. Only silence across delivered chunks times out.
    local carrier, state = fixture()
    assert(carrier:Start(session)); assert(carrier:OfferContext(1, "hello")); assert(carrier:Pump(10, 1))
    state.now = state.now + 31
    equal(carrier:Pump(10, 1), false); equal(carrier.status, "waiting", "no chunk was delivered since the write")
    state.now = state.now + 31
    equal(carrier:Pump(11, 1), false); equal(carrier.status, "waiting", "one chunk may predate the daemon's acknowledgement")
    equal(carrier:Pump(12, 1), false); equal(carrier.status, "quarantined", "two delivered chunks without the ACK is a real timeout")
    -- Without a delivery count the old wall-clock rule still applies.
    local plain, plainState = fixture()
    assert(plain:Start(session)); assert(plain:OfferContext(1, "hello")); assert(plain:Pump(nil, 1))
    plainState.now = plainState.now + 31
    equal(plain:Pump(nil, 1), false); equal(plain.status, "quarantined")
end)

test("a leftover frame from an earlier protocol is still ours, and is scrubbed rather than refused", function()
    -- Observed in game on 2026-09-22: a protocol 1 frame from the previous build sat in field 127,
    -- the current parser refused it outright, and the carrier treated its own leftover as a
    -- stranger's value and stood down for the session.
    local function u32(value)
        return string.char(math.floor(value / 16777216) % 256, math.floor(value / 65536) % 256,
            math.floor(value / 256) % 256, value % 256)
    end
    local function legacy(payload)
        local body = "FC" .. string.char(1, 1) .. "8*y" .. "_y9"
            .. "!.9" .. "  " .. "  " .. ""
            .. string.char(0, #payload) .. payload
        return body .. u32(Carrier.CRC32(body))
    end
    local stale = legacy("old")
    equal(Carrier.ParseFrame(stale), nil, "the current parser refuses an older protocol, as it should")

    local carrier, state = fixture({ [1] = 5, [2] = {}, [3] = {}, [4] = {}, [127] = stale })
    assert(carrier:Start(session), "a leftover of ours is handed back whatever protocol wrote it")
    equal(state.sets, 1); equal(state.raw, ""); equal(carrier.status, "ready")

    -- Bootstrap must not deadlock on one either: it cannot wait for a chunk that needs a slot.
    local boot, bootState = fixture({ [1] = 5, [2] = {}, [3] = {}, [4] = {}, [127] = legacy("old") })
    assert(boot:Bootstrap(session.uiNonce))
    assert(boot:Heartbeat(7, 0), "a bootstrap heartbeat replaces a leftover of ours")
    equal(bootState.sets, 1); assert(bootState.persisted[127])

    -- A value that is not one of our frames is still never touched.
    for _, value in ipairs({ "FC not a frame", "other owner", stale:sub(1, -2) .. " " }) do
        local foreign, foreignState = fixture({ [1] = 5, [2] = {}, [3] = {}, [4] = {}, [127] = value })
        local ok, reason = foreign:Start(session)
        equal(ok, false); equal(reason, "cooldown layout field 127 is already occupied")
        equal(foreignState.sets, 0)
    end
end)

test("cooldown carrier gates combat, rate, capacity and correlated acknowledgements", function()
    local carrier, state = fixture(); state.combat = true
    equal(carrier:Start(session), false); equal(state.sets, 0)
    state.combat = false; assert(carrier:Start(session))
    equal(carrier:OfferContext(1, string.rep("x", 8193)), false)
    equal(carrier:OfferContext(0, "x"), false, "a context message must carry a real id")
    for _ = 1, 8 do assert(carrier:OfferContext(1, "x")) end
    equal(carrier:OfferContext(1, "x"), false)
    assert(carrier:Pump(nil, 1)); local outstanding = carrier.outstanding
    equal(carrier:AcceptHost({ epoch = session.epoch, cooldownProtocol = 2,
        cooldownNonce = session.nonce, cooldownAck = 1, cooldownChecksum = outstanding.checksum + 1 }), false)
    equal(carrier.status, "quarantined"); equal(state.sets, 1)
end)

test("the ring carries the cooldown acknowledgement fields or refuses the chunk", function()
    local r = ns.Ring.New({ uiNonce = "abcdef01" })
    assert(r:OnChunk(ns.TestPayload()).accepted)
    local accepted = r:OnChunk(ns.TestPayload(2, { cooldownProtocol = 2, cooldownNonce = "89abcdef",
        cooldownAck = 5, cooldownChecksum = 4294967295 }))
    equal(accepted.cooldownProtocol, 2); equal(accepted.cooldownNonce, "89abcdef")
    equal(accepted.cooldownAck, 5); equal(accepted.cooldownChecksum, 4294967295)
    for _, fields in ipairs({
        { cooldownProtocol = 1 },
        { cooldownAck = 0 },
        { cooldownProtocol = 1, cooldownNonce = "89abcdef", cooldownAck = 0, cooldownChecksum = 0 },
        { cooldownProtocol = 2, cooldownNonce = "00000000", cooldownAck = 0, cooldownChecksum = 0 },
        { cooldownProtocol = 2, cooldownNonce = "89abcdef", cooldownAck = 16777216, cooldownChecksum = 0 },
        { cooldownProtocol = 2, cooldownNonce = "89abcdef", cooldownAck = 0, cooldownChecksum = 4294967296 },
    }) do
        equal(r:OnChunk(ns.TestPayload(3, fields)).accepted, false)
    end
    assert(r:OnChunk(ns.TestPayload(3)).accepted)
end)

test("a heartbeat bootstraps with zero ids, carries session ids after start, and overwrites only itself", function()
    local carrier, state = fixture()
    equal(carrier:Heartbeat(5, 0), false, "no ui nonce yet")
    assert(carrier:Bootstrap(session.uiNonce))
    equal(carrier:Heartbeat(0, 0), false); equal(carrier:Heartbeat(10000, 0), false); equal(carrier:Heartbeat(5, 256), false)
    assert(carrier:Heartbeat(5, 0))
    equal(state.sets, 1); equal(carrier.status, "stopped", "a heartbeat does not start the carrier")
    local frame = assert(Carrier.ParseFrame(state.persisted[127]))
    equal(frame.kind, "heartbeat"); equal(frame.epoch, "00000000"); equal(frame.nonce, "00000000")
    equal(frame.uiNonce, session.uiNonce); equal(frame.slot, 5); equal(frame.seq, 1); equal(frame.payload, "\0")
    equal(carrier.outstanding, nil, "a heartbeat is never outstanding")

    -- One write per second, then our own heartbeat is simply replaced.
    equal(carrier:Heartbeat(6, 0), false)
    state.now = state.now + 1
    assert(carrier:Heartbeat(6, 1)); equal(state.sets, 2)
    frame = assert(Carrier.ParseFrame(state.persisted[127])); equal(frame.slot, 6); equal(frame.payload, "\1")

    -- Start adopts the bootstrap heartbeat instead of scrubbing it; later heartbeats carry the session.
    assert(carrier:Start(session)); equal(state.sets, 2); equal(carrier.status, "ready")
    state.now = state.now + 1
    assert(carrier:Heartbeat(7, 0)); equal(state.sets, 3)
    frame = assert(Carrier.ParseFrame(state.persisted[127]))
    equal(frame.epoch, session.epoch); equal(frame.nonce, session.nonce); equal(frame.slot, 7); equal(frame.seq, 1)

    -- Queued data takes the lane: the data frame advertises the slot itself and replaces the heartbeat.
    assert(carrier:OfferContext(1, "hello"))
    equal(carrier:Heartbeat(8, 0), false, "data is waiting to go out")
    state.now = state.now + 1
    assert(carrier:Pump(nil, 8)); equal(state.sets, 4); equal(carrier.heartbeat, nil)
    frame = assert(Carrier.ParseFrame(state.persisted[127])); equal(frame.kind, "context"); equal(frame.slot, 8)
    state.now = state.now + 1
    equal(carrier:Heartbeat(9, 0), false, "never while a data frame is outstanding"); equal(state.sets, 4)
    assert(carrier:AcceptHost({ epoch = session.epoch, cooldownProtocol = 2, cooldownNonce = session.nonce,
        cooldownAck = 1, cooldownChecksum = carrier.outstanding.checksum }))
    equal(state.raw, "", "the cleanup restores the layout from before the first heartbeat")
    state.now = state.now + 1
    assert(carrier:Heartbeat(9, 0)); equal(Carrier.ParseFrame(state.persisted[127]).seq, 2, "seq is the next data sequence")
end)

test("a heartbeat never touches a foreign value, and in bootstrap replaces any leftover of ours", function()
    local foreign, foreignState = fixture({ [1] = 5, [2] = {}, [3] = {}, [4] = {}, [127] = "other owner" })
    assert(foreign:Bootstrap(session.uiNonce))
    local ok, reason = foreign:Heartbeat(5, 0)
    equal(ok, false); equal(reason, "cooldown layout field 127 is already occupied"); equal(foreignState.sets, 0)
    equal(foreign.status, "stopped", "a refused heartbeat is not a quarantine")

    local staleData = assert(Carrier.Frame({ epoch = "deadbeef", nonce = "0badf00d", uiNonce = "8200f394",
        seq = 1, message = 1, part = 1, count = 1, slot = 3, kind = "context", payload = "old" }))
    local blocked, blockedState = fixture({ [1] = 5, [2] = {}, [3] = {}, [4] = {}, [127] = staleData })
    assert(blocked:Bootstrap(session.uiNonce))
    -- A data frame from a session that has gone is unreadable to the host, whose receiver is bound
    -- to one UI nonce. Leaving it for Start would deadlock a carrier-only bootstrap: Start needs a
    -- chunk, and a chunk needs the slot only a heartbeat can advertise.
    assert(blocked:Heartbeat(5, 0), "bootstrap replaces a leftover of ours")
    equal(blockedState.sets, 1)
    equal(Carrier.ParseFrame(blockedState.persisted[127]).kind, "heartbeat")

    -- A heartbeat left by the UI session before a reload is nobody's to wait for.
    local staleHeartbeat = assert(Carrier.Frame({ epoch = "00000000", nonce = "00000000", uiNonce = "8200f394",
        seq = 1, message = 0, part = 1, count = 1, slot = 3, kind = "heartbeat", payload = "\2" }))
    local carrier, state = fixture({ [1] = 5, [2] = { [42] = 7 }, [3] = {}, [4] = {}, [127] = staleHeartbeat })
    assert(carrier:Bootstrap(session.uiNonce))
    assert(carrier:Heartbeat(5, 0)); equal(state.sets, 1)
    equal(Carrier.ParseFrame(state.persisted[127]).uiNonce, session.uiNonce)
    equal(state.persisted[2][42], 7, "user fields survive")
    state.now = state.now + 1
    assert(carrier:RestoreOwned()); equal(state.sets, 2)
    equal(state.persisted[127], nil); equal(state.persisted[2][42], 7); equal(carrier.heartbeat, nil)
end)

test("restoring the carrier clears a heartbeat and hands back the original layout", function()
    local carrier, state = fixture()
    assert(carrier:Bootstrap(session.uiNonce)); assert(carrier:Heartbeat(5, 0))
    equal(carrier:RestoreOwned(), false, "the cleanup write is rate limited like any other")
    state.now = state.now + 1
    assert(carrier:RestoreOwned())
    equal(state.sets, 2); equal(state.raw, ""); equal(carrier.status, "restored"); equal(carrier.heartbeat, nil)
    -- A restored carrier can bootstrap again, and a reset keeps a heartbeat that is still in the field.
    state.now = state.now + 1
    assert(carrier:Heartbeat(6, 0)); equal(state.sets, 3)
    assert(carrier:Reset()); assert(carrier.heartbeat, "reset forgets nothing that is still in the field")
    state.now = state.now + 1
    assert(carrier:Start(session)); equal(state.sets, 3, "start adopts it rather than scrubbing")

    -- Combat gates a heartbeat exactly as it gates a data frame.
    local combat, combatState = fixture()
    assert(combat:Bootstrap(session.uiNonce)); combatState.combat = true
    equal(combat:Heartbeat(5, 0), false); equal(combatState.sets, 0)
    combatState.combat = false
    assert(combat:Heartbeat(5, 1)); equal(combatState.sets, 1)
end)

test("an outstanding frame follows the ring to a new slot, so its acknowledgement can still arrive", function()
    -- Tabbed out, the strip is unreadable and a waiting carrier sends no heartbeats. If the addon
    -- used up the slot its frame named before the host wrote it, the host kept rewriting a slot the
    -- addon had already read: the acknowledgement could never arrive. The frame now re-advertises.
    local carrier, state = fixture()
    assert(carrier:Start(session)); assert(carrier:OfferContext(1, "hello")); assert(carrier:Pump(10, 54))
    local first = carrier.outstanding
    local firstWire, firstChecksum = first.wire, first.checksum
    equal(state.sets, 1)
    equal(carrier:Pump(10, 54), false); equal(state.sets, 1, "an unchanged slot is not rewritten")
    state.now = state.now + 0.5
    equal(carrier:Pump(10, 55), false); equal(state.sets, 1, "the write rate still applies")
    state.now = state.now + 1
    assert(carrier:Pump(10, 55)); equal(state.sets, 2, "a moved ring rewrites the frame")
    local rewritten = carrier.outstanding
    assert(rewritten.wire ~= firstWire and rewritten.seq == first.seq and rewritten.slot == 55,
        "the same sequence and payload now name the slot the addon wants")
    equal(state.persisted[127], rewritten.wire)
    equal(carrier.status, "waiting")
    -- The host may acknowledge whichever version it read.
    state.now = state.now + 1
    assert(carrier:AcceptHost({ epoch = session.epoch, cooldownProtocol = 2,
        cooldownNonce = session.nonce, cooldownAck = 1, cooldownChecksum = firstChecksum }))
    equal(carrier.status, "ready"); equal(carrier.nextSeq, 2); equal(state.raw, "")
end)

test("a rewrite never touches a field someone else has taken, and a foreign checksum still quarantines", function()
    local carrier, state = fixture()
    assert(carrier:Start(session)); assert(carrier:OfferContext(1, "hello")); assert(carrier:Pump(10, 54))
    state.now = state.now + 2
    state.persisted[127] = "someone else"; state.raw = "1|V0lUSA=="
    equal(carrier:Pump(10, 55), false); equal(carrier.status, "quarantined", "a changed field is never overwritten")
    local other, otherState = fixture()
    assert(other:Start(session)); assert(other:OfferContext(1, "hello")); assert(other:Pump(10, 54))
    otherState.now = otherState.now + 2; assert(other:Pump(10, 55))
    equal(other:AcceptHost({ epoch = session.epoch, cooldownProtocol = 2, cooldownNonce = session.nonce,
        cooldownAck = 1, cooldownChecksum = 12345 }), false)
    equal(other.status, "quarantined", "a checksum of no frame we wrote is a real mismatch")
end)

test("an unchecked client build names both builds in the refusal", function()
    local carrier, state = fixture()
    state.build = "69999"
    local ok, reason = carrier:Gate()
    equal(ok, false)
    equal(reason, "unsupported client build " .. ns.Evidence.version .. ".69999 (checked: " .. ns.Evidence.Label() .. ")")
end)
