local ns, test, equal = ...
local function payload(seq, overrides)
    local value = { protocol = 1, epoch = "1234abcd", uiNonce = "abcdef01", seq = seq or 1, ringSize = 20,
        changed = true, ready = true, ack = 0, cols = 120, rows = 40,
        sessions = { { id = "claude", title = "Claude", status = "running", lines = { "one", "two" } },
            { id = "codex", title = "Codex", status = "running", lines = { "three" } } } }
    for key, child in pairs(overrides or {}) do value[key] = child end
    return value
end
ns.TestPayload = payload

test("a terminal frame exposes only a bounded tool name and never raw tool arguments", function()
    for _, sample in ipairs({ { "exec_command", true }, { "mcp__wow__get-quests", true }, { "", false },
        { "Bash /private/file", false }, { "|Hitem:1", false }, { string.rep("a", 65), false } }) do
        local ring = ns.Ring.New({ uiNonce = "abcdef01" })
        local frame = payload(1)
        frame.sessions[1].activity = sample[1]
        local result = ring:OnChunk(frame)
        assert(result.accepted)
        equal(result.sessions[1].activity, sample[2] and sample[1] or nil)
    end
end)
local function ring(options)
    options = options or {}
    options.uiNonce = "abcdef01"
    return ns.Ring.New(options)
end

test("ring accepts sequential snapshots and copies separate terminal rows", function()
    local r, p = ring(), payload()
    local seq, name = r:Next()
    equal(seq, 1); equal(name, "Witchcraft_Chunk_0001")
    local result = r:OnChunk(p)
    equal(result.accepted, true); equal(result.newEpoch, true); equal(r:Next(), 2)
    equal(result.sessions[1].id, "claude"); equal(result.sessions[2].id, "codex")
    p.sessions[1].lines[1] = "mutated after receive"
    equal(result.sessions[1].lines[1], "one")
    equal(r.ringSize, 20)
    equal(result.cursorLane, nil); equal(r:Snapshot().cursorLane, nil)
    result = r:OnChunk(payload(2, { cursorLane = "strip" }))
    equal(result.accepted, true); equal(result.cursorLane, "strip"); equal(r:Snapshot().cursorLane, "strip")
    result = r:OnChunk(payload(3, { cursorLane = "bogus" }))
    equal(result.accepted, true); equal(result.cursorLane, nil); equal(r:Snapshot().cursorLane, nil)
end)

test("ring idle backoff is bounded and activity resets it", function()
    local r = ring()
    equal(r:OnChunk(payload()).delay, 1)
    for seq, expected in ipairs({ 2, 4, 8, 8 }) do
        equal(r:OnChunk(payload(seq + 1, { changed = false })).delay, expected)
    end
    equal(r:OnChunk(payload(6)).delay, 1)
    assert(r:SetHz(0.5))
    equal(r:OnChunk(payload(7)).delay, 2)
    equal(r:SetHz(0), nil); equal(r:SetHz(0 / 0), nil); equal(r:SetHz(3), nil)
end)

test("ring rejects duplicate future malformed and prior UI snapshots without accepting state", function()
    local cases = {
        { protocol = 2 }, { seq = 2 }, { uiNonce = "ffffffff" }, { epoch = "00000000" }, { ready = true, changed = 1 },
        { rows = 61 }, { cols = 161 }, { ack = -1 }, { ack = 262144 }, { ringSize = 0 },
        { sessions = { { id = "claude", title = "x", status = "x", lines = {} } } },
        { sessions = setmetatable({}, {}) }, { sessions = { [2] = {} } },
    }
    for _, overrides in ipairs(cases) do
        local r = ring()
        equal(r:OnChunk(payload(1, overrides)).accepted, false)
        equal(r.nextSeq, 1); equal(r.epoch, nil); equal(r.ack, 0)
    end
    local r = ring()
    assert(r:OnChunk(payload()).accepted)
    equal(r:OnChunk(payload()).accepted, false)
    equal(r.nextSeq, 2)
end)

test("ring bounds strings sparse arrays control characters and duplicate tabs", function()
    for _, mutate in ipairs({
        function(p) p.sessions[1].lines[1] = string.rep("x", 8193) end,
        function(p) p.sessions[1].lines[1] = "escape\27" end,
        function(p) p.sessions[1].lines = { [2] = "sparse" } end,
        function(p) p.sessions[1].lines[41] = "outside rows" end,
        function(p) p.sessions[2].id = "claude" end,
        function(p) p.sessions[2].title = string.rep("t", 81) end,
        function(p) p.sessions[2].lines = setmetatable({}, {}) end,
    }) do
        local r, p = ring(), payload()
        mutate(p); equal(r:OnChunk(p).accepted, false)
    end
end)

test("ring consumes placeholders and empty loaded files but retries unavailable files", function()
    local r = ring()
    local result = r:OnChunk({ protocol = 1, seq = 1, ringSize = 3, ready = false })
    equal(result.placeholder, true); equal(r.nextSeq, 2); equal(r.delay, 8); equal(r.accepted, 0)
    r:Consumed(1, true); equal(r.nextSeq, 2)
    r:Consumed(2, false); equal(r.nextSeq, 2)
    r:Consumed(2, true); equal(r.nextSeq, 3)
    r:Consumed(3, true); equal(r:Exhausted(), true); equal(r:Next(), nil)
end)

test("ring host epochs retire old identities and ack regression is rejected", function()
    local r = ring()
    assert(r:OnChunk(payload(1, { ack = 5 })).accepted)
    equal(r:OnChunk(payload(2, { ack = 4 })).accepted, false)
    r:Consumed(2, true)
    local result = r:OnChunk(payload(3, { epoch = "98765432" }))
    equal(result.newEpoch, true); equal(r.ack, 0)
    equal(r:OnChunk(payload(4)).accepted, false)
    equal(r.epoch, "98765432")
end)

test("ring validates binding extension as one unit and rejects acknowledgement regression", function()
    local r = ring()
    local result = r:OnChunk(payload(1, { bindingProtocol = 1, bindingNonce = "89abcdef", bindingAck = 2 }))
    equal(result.accepted, true); equal(result.bindingNonce, "89abcdef"); equal(result.bindingAck, 2)
    equal(r:OnChunk(payload(2, { bindingProtocol = 1, bindingNonce = "89abcdef", bindingAck = 1 })).accepted, false)
    r:Consumed(2, true)
    result = r:OnChunk(payload(3, { bindingProtocol = 1, bindingNonce = "76543210", bindingAck = 0 }))
    equal(result.accepted, true); equal(r.bindingAck, 0)
    for _, overrides in ipairs({
        { bindingProtocol = 1, bindingAck = 0 },
        { bindingProtocol = 1, bindingNonce = "00000000", bindingAck = 0 },
        { bindingProtocol = 1, bindingNonce = "89abcdef", bindingAck = 16777216 },
    }) do
        local candidate = ring()
        equal(candidate:OnChunk(payload(1, overrides)).accepted, false)
    end
end)

test("ring accepts optional session history under the line rules and counts it in the session budget", function()
    local r, p = ring(), payload()
    p.sessions[1].history = { "old one", "old two", "old three" }
    local result = r:OnChunk(p)
    equal(result.accepted, true)
    equal(#result.sessions[1].history, 3); equal(result.sessions[1].history[3], "old three")
    p.sessions[1].history[1] = "mutated after receive"
    equal(result.sessions[1].history[1], "old one", "history is copied, not referenced")
    equal(#result.sessions[1].lines, 2, "history does not displace the viewport rows")
    equal(#result.sessions[2].history, 0, "absent history is an empty array")
    for _, mutate in ipairs({
        function(q) q.sessions[1].history = "text" end,
        function(q) q.sessions[1].history = setmetatable({}, {}) end,
        function(q) q.sessions[1].history = { [2] = "sparse" } end,
        function(q) q.sessions[1].history = { 42 } end,
        function(q) q.sessions[1].history = { "escape\27" } end,
        function(q) q.sessions[1].history = { string.rep("x", 8193) } end,
        function(q) local rows = {}; for i = 1, 1001 do rows[i] = "row" end; q.sessions[1].history = rows end,
    }) do
        local candidate, q = ring(), payload()
        mutate(q)
        local rejected = candidate:OnChunk(q)
        equal(rejected.accepted, false); equal(rejected.reason, "history")
        equal(candidate.nextSeq, 1)
    end
    local full = {}
    for i = 1, 1000 do full[i] = "row " .. i end
    local capped, q = ring(), payload()
    q.sessions[2].history = full
    equal(capped:OnChunk(q).accepted, true, "one thousand short rows fit")
    local lines, history = {}, {}
    for i = 1, 30 do lines[i] = string.rep("l", 8000) end
    for i = 1, 8 do history[i] = string.rep("h", 8000) end
    local over, overPayload = ring(), payload()
    overPayload.sessions[1].lines, overPayload.sessions[1].history = lines, history
    local overResult = over:OnChunk(overPayload)
    equal(overResult.accepted, false); equal(overResult.reason, "screen size")
    history[8] = nil
    local fits, fitsPayload = ring(), payload()
    fitsPayload.sessions[1].lines, fitsPayload.sessions[1].history = lines, history
    equal(fits:OnChunk(fitsPayload).accepted, true, "lines plus history share the 300000-byte budget")
end)

test("a session scrolled counter is copied when valid and refuses the chunk when it is not", function()
    local r = ring()
    local sessions = { { id = "claude", title = "Claude", status = "running", lines = { "one" }, scrolled = 12 },
        { id = "codex", title = "Codex", status = "running", lines = { "two" } } }
    local accepted = r:OnChunk(payload(1, { sessions = sessions }))
    equal(accepted.accepted, true)
    equal(accepted.sessions[1].scrolled, 12)
    equal(accepted.sessions[2].scrolled, 0, "a session without the field has scrolled nothing")
    for _, value in ipairs({ -1, 1.5, "7", 2147483648, 0 / 0 }) do
        sessions[1].scrolled = value
        local rejected = r:OnChunk(payload(2, { sessions = sessions }))
        equal(rejected.accepted, false); equal(rejected.reason, "scrolled")
    end
    sessions[1].scrolled = 2147483647
    equal(r:OnChunk(payload(2, { sessions = sessions })).accepted, true)
end)

test("a session without the WoW tools is copied as such; anything but false claims nothing", function()
    local r = ring()
    local sessions = { { id = "claude", title = "Claude", status = "running", lines = { "one" }, tools = false },
        { id = "codex", title = "Codex", status = "running", lines = { "two" } } }
    local result = r:OnChunk(payload(1, { sessions = sessions }))
    equal(result.accepted, true); equal(result.sessions[1].tools, false); equal(result.sessions[2].tools, nil)
    for seq, value in ipairs({ true, "false", 0 }) do
        sessions[1].tools = value
        result = r:OnChunk(payload(seq + 1, { sessions = sessions }))
        equal(result.accepted, true, "an advisory flag never refuses the screen"); equal(result.sessions[1].tools, nil)
    end
end)

test("agent state and its choice menu are copied when valid and dropped when not", function()
    local r = ring()
    local sessions = { { id = "claude", title = "Claude", status = "running", lines = { "one" }, state = "waiting",
        choices = { options = { "Yes", "No" }, selected = 1 } }, { id = "codex", title = "Codex", status = "running",
        lines = { "two" }, state = "working" } }
    local accepted = r:OnChunk(payload(1, { sessions = sessions }))
    equal(accepted.accepted, true)
    equal(accepted.sessions[1].state, "waiting"); equal(accepted.sessions[1].choices.options[2], "No")
    equal(accepted.sessions[1].choices.selected, 1); equal(accepted.sessions[2].state, "working")
    equal(accepted.sessions[2].choices, nil)
    assert(accepted.sessions[1].choices.options ~= sessions[1].choices.options, "the menu is copied, not shared")
    local seq = 2
    for _, bad in ipairs({ { options = { "Yes" }, selected = 1 }, { options = { "Yes", "No" }, selected = 3 },
        { options = { "Yes", 7 }, selected = 1 }, { options = { "Yes", "No\n" }, selected = 1 }, "menu" }) do
        sessions[1].choices = bad
        local result = r:OnChunk(payload(seq, { sessions = sessions })); seq = seq + 1
        equal(result.accepted, true, "a bad menu never refuses the screen")
        equal(result.sessions[1].state, nil, "waiting without a usable menu is not reported"); equal(result.sessions[1].choices, nil)
    end
    sessions[1].state = "sleeping"
    equal(r:OnChunk(payload(seq, { sessions = sessions })).sessions[1].state, nil, "unknown states are dropped")
end)

test("session info and the last reply are copied when well formed and dropped otherwise", function()
    local r = ring()
    local sessions = { { id = "claude", title = "Claude", status = "running", lines = { "one" },
        info = { model = "claude-opus-5-5", used = 517000 }, reply = { "Done.", "Tests pass." } },
        { id = "codex", title = "Codex", status = "running", lines = { "two" },
        info = { model = "gpt-6-astra", effort = "ultra", used = 121000, window = 258400 } } }
    local accepted = r:OnChunk(payload(1, { sessions = sessions }))
    equal(accepted.accepted, true)
    equal(accepted.sessions[1].info.model, "claude-opus-5-5"); equal(accepted.sessions[1].reply[2], "Tests pass.")
    equal(accepted.sessions[2].info.window, 258400); equal(accepted.sessions[2].reply, nil)
    sessions[1].info = { model = string.rep("m", 65) }; sessions[1].reply = { "ok", "bad\1" }
    sessions[2].info = { model = "x", used = -1 }
    local dropped = r:OnChunk(payload(2, { sessions = sessions }))
    equal(dropped.accepted, true, "bad info never refuses the screen")
    equal(dropped.sessions[1].info, nil); equal(dropped.sessions[1].reply, nil); equal(dropped.sessions[2].info, nil)
end)

test("ring passes a valid binding UI session through lowercased and rejects an invalid one", function()
    local r = ring()
    local binding = { bindingProtocol = 1, bindingNonce = "89abcdef", bindingAck = 2 }
    local function with(value)
        local overrides = { bindingUi = value }
        for key, child in pairs(binding) do overrides[key] = child end
        return overrides
    end
    local result = r:OnChunk(payload(1, with("ABCDEF02")))
    equal(result.accepted, true); equal(result.bindingUi, "abcdef02")
    result = r:OnChunk(payload(2, binding))
    equal(result.accepted, true, "an older daemon leaves the field out"); equal(result.bindingUi, nil)
    for _, value in ipairs({ "00000000", "abcdef0", "zzzzzzzz", 12345678 }) do
        local rejected = ring():OnChunk(payload(1, with(value)))
        equal(rejected.accepted, false); equal(rejected.reason, "binding extension")
    end
    equal(ring():OnChunk(payload(1, { bindingUi = "abcdef02" })).reason, "binding extension")
end)

test("ring takes a lower binding acknowledgement when it belongs to another UI session", function()
    local r = ring()
    local function with(ack, ui) return { bindingProtocol = 1, bindingNonce = "89abcdef", bindingAck = ack, bindingUi = ui } end
    equal(r:OnChunk(payload(1, with(7, "abcdef02"))).accepted, true)
    -- After a /reload the host restarts its binding sequence for the new UI session.
    local result = r:OnChunk(payload(2, with(1, "abcdef03")))
    equal(result.accepted, true, "another UI session's acknowledgement is not a regression"); equal(result.bindingAck, 1)
    local rejected = r:OnChunk(payload(3, with(0, "abcdef03")))
    equal(rejected.accepted, false); equal(rejected.reason, "binding acknowledgement regression")
end)

test("ring validates the log extension as one unit, rejects its regression and leaves it out when absent", function()
    local r = ring()
    local result = r:OnChunk(payload(1, { logProtocol = 1, logNonce = "89abcdef", logAck = 2, logUi = "abcdef01" }))
    equal(result.accepted, true); equal(result.logProtocol, 1); equal(result.logNonce, "89abcdef")
    equal(result.logAck, 2); equal(result.logUi, "abcdef01"); equal(r:Snapshot().logAck, 2)
    local rejected = r:OnChunk(payload(2, { logProtocol = 1, logNonce = "89abcdef", logAck = 1, logUi = "abcdef01" }))
    equal(rejected.accepted, false); equal(rejected.reason, "log acknowledgement regression")
    result = r:OnChunk(payload(2, { logProtocol = 1, logNonce = "89abcdef", logAck = 0, logUi = "abcdef02" }))
    equal(result.accepted, true, "another UI session restarts the log sequence")
    result = r:OnChunk(payload(3))
    equal(result.accepted, true); equal(result.logProtocol, nil); equal(result.logAck, nil); equal(result.logUi, nil)
    for _, bad in ipairs({ { logProtocol = 2, logNonce = "89abcdef", logAck = 0 }, { logProtocol = 1, logAck = 0 },
        { logProtocol = 1, logNonce = "00000000", logAck = 0 }, { logProtocol = 1, logNonce = "89abcdef", logAck = 16777216 },
        { logProtocol = 1, logNonce = "89abcdef", logAck = -1 }, { logProtocol = 1, logNonce = "89abcdef", logAck = 0, logUi = "xyz" },
        { logUi = "abcdef02" } }) do
        local refused = ring():OnChunk(payload(1, bad))
        equal(refused.accepted, false); equal(refused.reason, "log extension")
    end
end)
