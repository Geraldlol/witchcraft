local ns, test, equal = ...
local LogCarrier = ns.LogCarrier
local ZERO, EPOCH, NONCE, UI = "00000000", "0123abcd", "89abcdef", "abcdef01"
local UNAVAILABLE = "Log carrier unavailable on this client"

local function fixture(overrides, combat)
    local state = { lines = {}, now = 100, combat = combat == true }
    local api = { LogMessage = function(text) state.lines[#state.lines + 1] = text end,
        Now = function() return state.now end, InCombatLockdown = function() return state.combat end }
    for key, value in pairs(overrides or {}) do api[key] = value end
    return LogCarrier.New(api), state
end

local function host(ack, extra)
    local result = { epoch = EPOCH, logProtocol = 1, logNonce = NONCE, logAck = ack, logUi = UI }
    for key, value in pairs(extra or {}) do result[key] = value end
    return result
end

-- The frame lines logged so far, without their padding.
local function frames(state)
    local list = {}
    for _, line in ipairs(state.lines) do if line:sub(1, 5) == "WCL1_" then list[#list + 1] = line end end
    return list
end

local function frame(slot, seq, payload)
    return LogCarrier.FrameText({ epoch = EPOCH, nonce = NONCE, uiNonce = UI, slot = slot, seq = seq, payload = payload })
end

local function input(id, text)
    return { epoch = EPOCH, id = id, tab = "codex", action = "text", text = text or "hello" }
end

local function ready(combat)
    local carrier, state = fixture(nil, combat)
    assert(carrier:Probe(UI))
    equal(carrier:Pump(1), true)
    equal(carrier.status, "Probe logged; waiting for host")
    equal(carrier.probed, true)
    local accepted, kind = carrier:AcceptHost(host(1))
    equal(accepted, true); equal(kind, "probe")
    equal(carrier.enabled, true); equal(carrier.nextSeq, 2); equal(carrier.status, "Carrier ready")
    return carrier, state
end

local BIG = "I" .. string.char(0, 0, 1, 1, 0) .. string.rep("w", 604)
local VECTORS = {
    { "probe", { epoch = ZERO, nonce = ZERO, uiNonce = UI, slot = 1, seq = 1, payload = "PFAM_BIND_PROBE" },
        "WCL1_00000000_00000000_ABCDEF01_0001_000001_KBDECTK7IJEU4RC7KBJE6QSF_0F068518" },
    { "heartbeat", { epoch = EPOCH, nonce = NONCE, uiNonce = UI, slot = 2, seq = 0, payload = "H" .. string.char(1) },
        "WCL1_0123ABCD_89ABCDEF_ABCDEF01_0002_000000_JAAQ_37756B3D" },
    { "input body of 610 bytes", { epoch = EPOCH, nonce = NONCE, uiNonce = UI, slot = 9999, seq = 2, payload = BIG },
        "WCL1_0123ABCD_89ABCDEF_ABCDEF01_270F_000002_JEAAAAIBAB3X" .. string.rep("O53X", 241) .. "_A520811C" },
}

test("log frames encode byte for byte as the daemon's fixed vectors", function()
    equal(#BIG, 610)
    for _, vector in ipairs(VECTORS) do equal(LogCarrier.FrameText(vector[2]), vector[3], vector[1]) end
    local base = VECTORS[2][2]
    local function with(field, value)
        local copy = {}
        for key, child in pairs(base) do copy[key] = child end
        copy[field] = value
        return copy
    end
    equal(LogCarrier.FrameText(with("payload", BIG .. "w")), nil, "a body over 610 bytes")
    equal(LogCarrier.FrameText(with("payload", "")), nil, "an empty body")
    equal(LogCarrier.FrameText(with("slot", 0)), nil, "slot 0")
    equal(LogCarrier.FrameText(with("payload", "XX")), nil, "sequence 0 that is not a heartbeat")
    equal(LogCarrier.FrameText(with("nonce", ZERO)), nil, "a zero nonce on a session epoch")
end)

test("every log write is one frame line followed by exactly 25 padding lines of 4,000 characters", function()
    for _, combat in ipairs({ false, true }) do
        local carrier, state = ready(combat)
        state.now = 101
        assert(carrier:Heartbeat(2, 0))
        state.now = 102
        assert(carrier:OfferInput(input(1)))
        assert(carrier:Pump(3))
        equal(#state.lines, 3 * 26)
        for index, line in ipairs(state.lines) do
            if index % 26 == 1 then equal(line:sub(1, 5), "WCL1_", "frame line " .. index)
            else equal(#line, 4000, "padding length"); equal(line:sub(1, 4), "WCLP", "padding tag") end
        end
    end
end)

test("log carrier probe reaches ready and carries input and context to their acknowledgements, in or out of combat", function()
    for _, combat in ipairs({ false, true }) do
        local carrier, state = ready(combat)
        equal(frames(state)[1], LogCarrier.FrameText(VECTORS[1][2]), "the probe frame")
        equal(carrier:Combat(), combat)
        state.now = 101
        assert(carrier:OfferInput(input(1)))
        equal(carrier.active.kind, "input")
        equal(carrier:Pump(3), true)
        equal(carrier.status, "Carrier frame logged"); equal(carrier.outstanding.seq, 2); equal(carrier.outstanding.probe, false)
        equal(frames(state)[2], frame(3, 2, "I" .. string.char(0, 0, 1, 1, 0) .. "hello"))
        local accepted, kind = carrier:AcceptHost(host(2))
        equal(accepted, true); equal(kind, "frame"); equal(carrier.active, nil); equal(carrier.nextSeq, 3)
        state.now = 102
        assert(carrier:OfferContext({ epoch = EPOCH, uiNonce = UI, id = 7, text = "ctx" }))
        equal(carrier:Pump(4), true)
        equal(frames(state)[3], frame(4, 3, "C" .. string.char(0, 0, 7) .. "ctx"))
        accepted, kind = carrier:AcceptHost(host(3))
        equal(accepted, true); equal(kind, "frame"); equal(carrier:Busy(), false); equal(carrier.status, "Carrier ready")
        equal(carrier:Snapshot().seq, 4)
    end
end)

test("a lower log acknowledgement waits, an equal one ends the frame and a higher one quarantines", function()
    local carrier, state = ready()
    state.now = 101
    assert(carrier:OfferInput(input(1)))
    assert(carrier:Pump(1))
    equal(carrier:AcceptHost(host(1)), false)
    assert(carrier.outstanding, "a lower acknowledgement waits")
    equal(carrier:AcceptHost(host(2)), true)
    state.now = 102
    assert(carrier:OfferInput(input(2)))
    assert(carrier:Pump(1))
    local ok, reason = carrier:AcceptHost(host(4))
    equal(ok, false); equal(reason, "Quarantined: carrier acknowledgement jumped")
    equal(carrier.enabled, false); equal(carrier:Busy(), false)
    equal(carrier:Pump(1), false)
end)

test("another UI session's acknowledgement leaves the log probe waiting", function()
    local carrier = fixture()
    assert(carrier:Probe(UI))
    assert(carrier:Pump(1))
    equal(carrier:AcceptHost(host(1, { logUi = "abcdef02" })), false)
    assert(carrier.outstanding and carrier.outstanding.probe, "the probe still waits")
    equal(carrier:AcceptHost({ epoch = EPOCH }), false,
        "a host without the log fields")
    equal(carrier:AcceptHost(host(1)), true)
end)

test("a host change disables the log carrier and drops its frame; a second probe in the session is refused", function()
    local carrier = ready()
    local ok, reason = carrier:Probe(UI)
    equal(ok, false); equal(reason, "Log carrier was already probed in this host session; /reload to probe again")
    equal(carrier:AcceptHost(host(1, { epoch = "22222222" })), false)
    equal(carrier.enabled, false); equal(carrier.status, "Host changed; waiting for a new probe")
    local state
    carrier, state = ready()
    state.now = 101
    assert(carrier:OfferInput(input(1)))
    assert(carrier:Pump(1))
    equal(carrier:AcceptHost(host(1, { logNonce = "76543210" })), false)
    equal(carrier.enabled, false); equal(carrier.outstanding, nil); equal(carrier.active, nil)
    equal(carrier.status, "Host changed; /reload to probe again", "the same epoch is not probed again")
    carrier = ready()
    equal(carrier:AcceptHost(host(1, { logUi = "abcdef02" })), false)
    equal(carrier.enabled, false); equal(carrier.status, "Host changed; /reload to probe again")
end)

test("an unanswered log frame is logged again after 5, 10 and 20 s with the newer slot and the same sequence", function()
    for _, combat in ipairs({ false, true }) do
        local carrier, state = ready(combat)
        state.now = 200
        assert(carrier:OfferInput(input(1)))
        equal(carrier:Pump(5), true)
        local body, sentAt, base = "I" .. string.char(0, 0, 1, 1, 0) .. "hello", carrier.outstanding.sentAt, #frames(state)
        for step, at in ipairs({ 205, 215, 235, 275, 335, 395 }) do
            state.now = at - 0.5
            equal(carrier:Pump(5 + step), false); equal(#frames(state), base + step - 1, "not before " .. at)
            state.now = at
            equal(carrier:Pump(5 + step), false, "a re-log is not a new claim")
            equal(#frames(state), base + step, "re-logged at " .. at)
            equal(frames(state)[base + step], frame(5 + step, 2, body))
        end
        equal(carrier.outstanding.sentAt, sentAt, "sentAt keeps the first send")
        equal(carrier.outstanding.seq, 2)
        equal(#state.lines % 26, 0, "every re-log carries its padding")
        equal(carrier:AcceptHost(host(2)), true)
    end
end)

test("log heartbeat refusals, the one-second limit and the heartbeat vector", function()
    for _, combat in ipairs({ false, true }) do
        local carrier = fixture(nil, combat)
        equal(select(2, carrier:Heartbeat(1, 0)), "carrier has no host session")
        local state
        carrier, state = ready(combat)
        equal(select(2, carrier:Heartbeat(2, 1)), "carrier rate limit")
        state.now = 101
        equal(select(2, carrier:Heartbeat(0, 1)), "Invalid carrier frame")
        equal(select(2, carrier:Heartbeat(2, 4)), "Invalid carrier frame")
        equal(carrier:Heartbeat(2, 1), true)
        local list = frames(state)
        equal(list[#list], VECTORS[2][3], "the heartbeat frame")
        equal(carrier:Snapshot().heartbeatSlot, 2)
        state.now = 103
        equal(select(2, carrier:Heartbeat(2, 1)), "heartbeat unchanged")
        equal(carrier:Heartbeat(3, 1), true)
        assert(carrier:OfferInput(input(1)))
        state.now = 105
        equal(select(2, carrier:Heartbeat(4, 1)), "carrier has data to send")
        assert(carrier:Pump(4))
        equal(select(2, carrier:Heartbeat(4, 1)), "waiting for host acknowledgement")
        carrier:Quarantine("test")
        equal(select(2, carrier:Heartbeat(4, 1)), "Quarantined: test")
        equal(carrier:ClearHeartbeat(), true)
    end
end)

test("a missing or throwing LogMessage leaves the log carrier unavailable", function()
    local carrier = fixture({ LogMessage = false })
    local ok, reason = carrier:Probe(UI)
    equal(ok, false); equal(reason, UNAVAILABLE); equal(carrier.status, UNAVAILABLE)
    carrier = fixture({ LogMessage = function() error("no log") end })
    assert(carrier:Probe(UI))
    ok, reason = carrier:Pump(1)
    equal(ok, false); equal(reason, UNAVAILABLE)
    equal(carrier.status, UNAVAILABLE); equal(carrier.outstanding, nil); equal(carrier.probed, nil)
    local state
    carrier, state = ready()
    local log = carrier.api.LogMessage
    carrier.api.LogMessage = function() error("no log") end
    state.now = 101
    local written, why, failed = carrier:Heartbeat(2, 0)
    equal(written, false); equal(why, UNAVAILABLE); equal(failed, true)
    equal(carrier.status, UNAVAILABLE, "a failed heartbeat write shows in the status")
    carrier.api.LogMessage = log
    state.now = 102
    assert(carrier:Heartbeat(2, 0))
    equal(carrier.status, "Carrier ready", "a later heartbeat write clears it")
end)

test("cancelling a logged data frame ends it at its acknowledgement; an unlogged item drops at once", function()
    local carrier, state = ready()
    state.now = 101
    assert(carrier:OfferInput(input(1)))
    assert(carrier:Pump(1))
    local identity = carrier.active.identity
    equal(carrier:Cancel(identity), false)
    equal(carrier.active.abandoned, true); equal(carrier.status, "Carrier waiting for host acknowledgement")
    local accepted, kind = carrier:AcceptHost(host(2))
    equal(accepted, true); equal(kind, "frame"); equal(carrier.active, nil)
    assert(carrier:OfferInput(input(2)))
    equal(carrier:Cancel("input:" .. EPOCH .. ":2"), true)
    equal(carrier:Busy(), false)
    equal(carrier:OnBindingsChanged(), true)
    equal(carrier:Stop(), true); equal(carrier.enabled, false)
end)

test("a frame line logged before its padding failed keeps its sequence until its acknowledgement", function()
    local carrier, state = fixture()
    local padding = 0
    state.padFails = true
    -- The frame line logs; the third padding line throws.
    carrier.api.LogMessage = function(text)
        if text:sub(1, 5) == "WCL1_" then padding = 0
        else
            padding = padding + 1
            if state.padFails and padding == 3 then error("no log") end
        end
        state.lines[#state.lines + 1] = text
    end
    assert(carrier:Probe(UI))
    equal(carrier:Pump(1), true)
    equal(carrier.outstanding.seq, 1); equal(carrier.outstanding.probe, true)
    equal(carrier.status, UNAVAILABLE); equal(carrier.probed, true)
    equal(carrier:AcceptHost(host(1)), true)
    state.now = 101
    assert(carrier:OfferInput(input(1)))
    local identity = carrier.active.identity
    equal(carrier:Pump(1), true)
    equal(carrier.outstanding.seq, 2); equal(carrier.status, UNAVAILABLE)
    equal(carrier:Cancel(identity), false, "the logged frame keeps its sequence")
    equal(carrier.active.abandoned, true)
    equal(carrier:OfferInput(input(2, "other")), false, "no second body while the first waits")
    for _, at in ipairs({ 106, 116, 136 }) do state.now = at; carrier:Pump(1) end
    local body, atTwo = frame(1, 2, "I" .. string.char(0, 0, 1, 1, 0) .. "hello"), 0
    for _, line in ipairs(frames(state)) do
        if line:find("_000002_", 1, true) then atTwo = atTwo + 1; equal(line, body, "the same body at sequence 2") end
    end
    equal(atTwo, 4, "the first send and three re-logs")
    local accepted, kind = carrier:AcceptHost(host(2))
    equal(accepted, true); equal(kind, "frame"); equal(carrier.active, nil)
    state.now = 140
    local written, why, failed = carrier:Heartbeat(2, 0)
    equal(written, false); equal(why, UNAVAILABLE); equal(failed, true)
    equal(carrier.heartbeat, nil, "a heartbeat whose padding failed is not recorded")
    state.padFails, state.now = false, 141
    equal(carrier:Heartbeat(2, 0), true, "the same heartbeat is offered again")
end)

test("HoldResend defers the re-log of the outstanding frame and leaves its back-off alone", function()
    local carrier, state = ready()
    equal(carrier:HoldResend(), false, "nothing outstanding, nothing to hold")
    equal(carrier.outstanding, nil)
    assert(carrier:OfferInput(input(1)))
    state.now = 102; equal(carrier:Pump(3), true)
    local sent = carrier.outstanding
    equal(sent.resendAt, 107); equal(sent.resendDelay, 5)
    state.now = 106; equal(carrier:HoldResend(), true)
    equal(sent.resendAt, 111); equal(sent.resendDelay, 5, "the back-off keeps its value")
    state.now = 110; carrier:Pump(3); equal(#frames(state), 2, "the probe and the first frame only")
    state.now = 111; carrier:Pump(3); equal(#frames(state), 3, "logged again once the hold has passed")
    sent.resendAt = 200; state.now = 120; carrier:HoldResend()
    equal(sent.resendAt, 200, "a later re-log time is never brought forward")
end)
