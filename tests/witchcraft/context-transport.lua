local ns, test, equal = ...

local function fixture(global)
    local clock, captured = { now = 1 }, {}
    local adapter = { Capture = function(_, domain)
        captured[#captured + 1] = domain
        if domain == "player" then return { { "Tester", "WARRIOR", 10, 1412, "Mulgore", "Bloodhoof", {} } } end
        if domain == "progress" then
            return { global.progress or { 123456, 4500, 10000, 900, false, "none", false, false, 0, false, false, false, false, {} } }
        end
        return { { true, "", 2, false, { { 1, "First quest", false, {}, false } } },
            { true, "", 2, false, { { 2, "Second quest", false, {}, false } } } }
    end }
    global = global or { contextEnabled = true }
    local c, s = ns.TestControllerFixture(global, {
        Context = adapter, GetTime = function() return clock.now end,
    })
    local accept = s.Accept
    function s:ContextAck(id, overrides)
        local fields = { contextProtocol = 4, contextAck = id or 0, contextWant = 0, contextWantMask = 0 }
        for key, value in pairs(overrides or {}) do fields[key] = value end
        accept(self, fields)
    end
    return c, s, clock, captured
end

local function symbols(frame)
    local result = {}
    for i, rgb in ipairs(frame) do result[i] = rgb[1] / 85 * 16 + rgb[2] / 85 * 4 + rgb[3] / 85 end
    return result
end

test("context pixels use a separate marker and bind epoch, nonce and bounded text", function()
    local message = { epoch = "0123abcd", uiNonce = "abcdef01", id = 1, text = "[1]" }
    local frames = assert(ns.Pixel.EncodeContext(message))
    equal(#frames, 2); equal(symbols(frames[1])[1], 50)
    message.text = string.rep("x", 580); equal(#assert(ns.Pixel.EncodeContext(message)), 55)
    message.text = string.rep("x", 581); equal(ns.Pixel.EncodeContext(message), nil)
    message.text = "valid"; message.uiNonce = "00000000"; equal(ns.Pixel.EncodeContext(message), nil)
    message.uiNonce = "abcdef01"; message.epoch = "00000000"; equal(ns.Pixel.EncodeContext(message), nil)
    message.epoch = "0123abcd"; message.text = "\255"; equal(ns.Pixel.EncodeContext(message), nil)
end)

test("a persisted off preference handshakes after reload and each host capability transition", function()
    local c, s, _, captured = fixture({ contextEnabled = false })
    c:Hide(); assert(c:WantStream())
    s:ContextAck(); c:ContextTick()
    equal(c.contextCurrent.domain, "state"); equal(c.contextCurrent.parts[1][1], false)
    s:ContextAck(c.contextPending.id)
    equal(c:WantStream(), false); equal(#captured, 0)
    c:Start(); equal(c:WantStream(), false, "duplicate start remains idempotent")
    c:Stop(); c:Start(); assert(c:WantStream()); c:ContextTick()
    equal(c.contextCurrent.parts[1][1], false)
    s:ContextAck(0, { epoch = "87654321" }); c:ContextTick()
    equal(c.contextPending.epoch, "87654321"); equal(c.contextCurrent.parts[1][1], false)
end)

test("ring context extension is optional, bounded and independently monotonic", function()
    local r = ns.Ring.New({ uiNonce = "abcdef01" })
    assert(r:OnChunk(ns.TestPayload()).accepted)
    local first = r:OnChunk(ns.TestPayload(2, { contextProtocol = 4, contextAck = 5, contextWant = 7, contextWantMask = 5 }))
    equal(first.contextAck, 5); equal(first.ack, 0); equal(first.contextWant, 7); equal(first.contextWantMask, 5)
    equal(r:OnChunk(ns.TestPayload(3, { contextProtocol = 4, contextAck = 4, contextWant = 7, contextWantMask = 5 })).accepted, false)
    for _, fields in ipairs({ { contextProtocol = 4 }, { contextAck = 0 }, { contextWant = 0 }, { contextWantMask = 0 },
        { contextProtocol = 4, contextAck = 0, contextWant = 0 },
        { contextProtocol = 2, contextAck = 0, contextWant = 0, contextWantMask = 0 },
        { contextProtocol = 2, contextAck = 0 }, { contextProtocol = 2, contextAck = 0, contextWant = 262144 },
        { contextProtocol = 1, contextAck = 0, contextWant = 0, contextWantMask = 0 },
        { contextProtocol = 4, contextAck = 262144, contextWant = 0, contextWantMask = 0 },
        { contextProtocol = 4, contextAck = 0, contextWant = 262144, contextWantMask = 0 },
        { contextProtocol = 4, contextAck = 0, contextWant = 0, contextWantMask = 16 },
        { contextProtocol = 3, contextAck = 0, contextWant = 0, contextWantMask = 8 },
        { contextProtocol = 4, contextAck = 0, contextWant = 0, contextWantMask = -1 },
        { contextProtocol = 4, contextAck = 0, contextWant = 0, contextWantMask = 1.5 } }) do
        equal(r:OnChunk(ns.TestPayload(3, fields)).accepted, false)
    end
    for mask = 0, 15 do
        local candidate = ns.Ring.New({ uiNonce = "abcdef01" })
        local chunk = ns.TestPayload(1, { contextProtocol = 4, contextAck = 0, contextWant = 1, contextWantMask = mask })
        equal(candidate:OnChunk(chunk).contextWantMask, mask)
    end
    local legacy = r:OnChunk(ns.TestPayload(3, { contextProtocol = 2, contextAck = 0, contextWant = 9 }))
    equal(legacy.accepted, true, "a whole protocol 2 extension keeps the terminals alive")
    equal(legacy.contextProtocol, 2); equal(legacy.contextWantMask, nil)
    r:Consumed(4, true)
    assert(r:OnChunk(ns.TestPayload(5)).accepted)
    equal(r.contextAck, 5, "legacy chunks cannot lower the retained context ACK")
    local restarted = r:OnChunk(ns.TestPayload(6, { epoch = "87654321", contextProtocol = 4, contextAck = 0,
        contextWant = 0, contextWantMask = 0 }))
    equal(restarted.accepted, true); equal(r.contextAck, 0)
end)

test("context waits for negotiated support and retains a hidden telemetry stream", function()
    local c, s, _, captured = fixture()
    c:ContextTick(); equal(c.contextPending, nil); equal(#captured, 0)
    s:Accept(); c:ContextTick(); equal(c:Snapshot().context.status, "Unsupported host")
    c:Hide(); assert(c:WantStream()); assert(c.timers.pixel)
    s:ContextAck(); c:ContextTick()
    equal(c.contextCurrent.domain, "state"); equal(c.contextPending.id, 1)
    equal(c.global.nextId, 1); equal(#c.global.outbox, 0)
    c:PixelTick(); equal(symbols(s.top)[1], 50); equal(symbols(s.heartbeat)[1], 51)
end)

test("context domain metadata becomes shared only after all parts are acknowledged", function()
    local c, s, clock, captured = fixture()
    s:ContextAck(); c:ContextTick(); s:ContextAck(c.contextPending.id, { contextWant = 1, contextWantMask = 3 })
    c:ContextTick(); equal(c.contextCurrent.domain, "player"); equal(#captured, 1)
    equal(c:Snapshot().context.player, nil)
    clock.now = 5; s:ContextAck(c.contextPending.id)
    equal(c:Snapshot().context.player.age, 4)
    assert(c:Snapshot().context.player.summary:find("Tester", 1, true))
    c:ContextTick(); equal(c.contextCurrent.domain, "quests")
    local revision = c.contextCurrent.revision
    c:OnEvent("QUEST_LOG_UPDATE"); c:RefreshContext(); equal(c.contextCurrent.revision, revision)
    s:ContextAck(c.contextPending.id); equal(c:Snapshot().context.quests, nil)
    c:ContextTick(); equal(c.contextCurrent.part, 2); equal(c.contextCurrent.revision, revision)
    s:ContextAck(c.contextPending.id)
    equal(c:Snapshot().context.quests.count, 2); equal(c:Snapshot().context.quests.status, "Shared")
    equal(c.contextCurrent, nil); equal(c.contextNextAt, clock.now + 1)
    equal(#c.global.outbox, 0)
end)

test("user input preempts context and resumes the same snapshot with a fresh transport ID", function()
    local c, s, clock = fixture()
    s:ContextAck(); c:ContextTick()
    s:ContextAck(c.contextPending.id, { contextWant = 1, contextWantMask = 3 }); c:ContextTick()
    local current, firstID = c.contextCurrent, c.contextPending.id
    c:PixelTick(); assert(c:Send("codex", "user has priority"))
    equal(c.contextPending, nil); equal(c.contextCurrent, current)
    c:ContextTick(); equal(c.contextPending, nil)
    c:PixelTick(); equal(symbols(s.top)[1], 51)
    clock.now = 70
    s:ContextAck(firstID, { ack = 1 })
    c:ContextTick(); equal(c.contextCurrent, current); assert(c.contextPending.id > firstID)
    equal(c.contextPending.createdAt, 70); equal(current.capturedAt, 1)
    c:PixelTick(); equal(symbols(s.top)[1], 50)
    equal(c.global.nextId, 2)
end)

test("turning context off preempts telemetry, waits behind user input and clears after its own ACK", function()
    local c, s = fixture()
    s:ContextAck(); c:ContextTick(); s:ContextAck(c.contextPending.id); c:ContextTick()
    assert(c:Send("claude", "finish this")); assert(c:SetContextEnabled(false)); c:Hide()
    assert(c:WantStream()); c:ContextTick(); equal(c.contextPending, nil)
    c:PixelTick(); equal(symbols(s.top)[1], 51)
    s:ContextAck(1, { ack = 1 }); c:ContextTick()
    equal(c.contextCurrent.domain, "state"); equal(c.contextCurrent.parts[1][1], false)
    local id = c.contextPending.id
    s:ContextAck(id, { ack = 1 })
    equal(c:Snapshot().context.status, "Off"); equal(c:WantStream(), false)
    equal(c.timers.context, nil); equal(c.timers.pixel, nil); equal(s.heartbeat, nil)
    c:ContextTick(); equal(c.contextPending, nil)
    assert(c:SetContextEnabled(true)); assert(c:WantStream()); c:ContextTick()
    equal(c.contextCurrent.parts[1][1], true)
end)

test("context ACKs are scoped to the accepted UI nonce and host epoch", function()
    local c, s = fixture()
    s:ContextAck(); c:ContextTick(); local pending = c.contextPending
    s:ContextAck(pending.id, { uiNonce = "11111111" })
    equal(c.contextPending, pending)
    s:ContextAck(0, { epoch = "87654321" })
    equal(c.contextPending, nil); equal(c.contextCurrent, nil)
    equal(c:Snapshot().context.player, nil)
    c:ContextTick(); equal(c.contextPending.epoch, "87654321")
    assert(c.contextPending.id > pending.id)
end)

test("context retries are bounded, renew age and IDs, and teardown cancels stale callbacks", function()
    local c, s, clock = fixture()
    s:ContextAck(); c:ContextTick()
    local revision, previous = c.contextCurrent.revision, c.contextPending.id
    for attempt = 1, 3 do
        clock.now = clock.now + 30; c:ContextTick()
        if attempt < 3 then
            c:ContextTick(); assert(c.contextPending.id > previous)
            previous = c.contextPending.id; equal(c.contextCurrent.revision, revision)
        end
    end
    equal(c.contextPending, nil); equal(c.contextCurrent, nil)
    equal(c.contextStatus, "Stalled; retrying"); equal(c.contextNextAt, clock.now + 30)
    c:OnEvent("QUEST_LOG_UPDATE"); c:ContextTick(); equal(c.contextPending, nil)
    local timer = c.timers.context.handle
    c:Stop(); timer:Fire(); equal(c.timers.context, nil); equal(c.contextPending, nil)
    equal(c.timers.pixel, nil); equal(c.timers.load, nil)
end)

test("context persistence stores only the enabled preference and rejects non-booleans", function()
    for _, value in ipairs({ 0, "true", {}, 1 }) do
        equal(ns.Persistence.Validate({ global = { contextEnabled = value } }), false)
    end
    equal(ns.Persistence.Initialize({}).contextEnabled, true)
    equal(ns.Persistence.Initialize({ contextEnabled = false }).contextEnabled, false)
    local c, s = fixture(); s:ContextAck(); c:ContextTick()
    equal(c.global.contextPending, nil); equal(c.global.contextPublished, nil)
    equal(c:SetContextEnabled("false"), false)
end)

test("game context is captured only when the host asks, not on a timer", function()
    local c, s, clock, captured = fixture()
    -- The enabled preference still announces itself once, so the host knows sharing is on.
    s:ContextAck(); c:ContextTick()
    equal(c.contextCurrent.domain, "state")
    s:ContextAck(c.contextPending.id)
    equal(c.contextAnnounced, true)

    -- Nothing has been asked for, so no game data is captured however long we wait.
    clock.now = 600
    c:OnEvent("QUEST_LOG_UPDATE"); c:OnEvent("PLAYER_ENTERING_WORLD")
    c:ContextTick(); c:ContextTick()
    equal(c.contextCurrent, nil, "an unwanted tick must capture nothing")
    equal(c.contextPending, nil); equal(#captured, 0)

    -- A want id makes exactly one pass happen.
    s:ContextAck(c.contextNextID - 1, { contextWant = 4, contextWantMask = 3 })
    c:ContextTick(); equal(c.contextCurrent.domain, "player")
    s:ContextAck(c.contextPending.id); c:ContextTick()
    equal(c.contextCurrent.domain, "quests")
    equal(#captured, 2, "the want captured both game domains")

    -- Serving that want does not arm the next one.
    s:ContextAck(c.contextPending.id); c:ContextTick()
    s:ContextAck(c.contextPending.id); c:ContextTick()
    clock.now = 1200
    c:ContextTick()
    equal(c.contextCurrent, nil, "a served want must not repeat")
    equal(c.contextServedWant, 4)
end)

test("a protocol 2 host is unsupported and a protocol 4 host is negotiated", function()
    local c, s = fixture()
    s:Accept({ contextProtocol = 2, contextAck = 0, contextWant = 5 })
    c:ContextTick(); equal(c:Snapshot().context.status, "Unsupported host")
    equal(c.connected, true, "the terminals still work against an older daemon")
    equal(c.contextProtocol, 2); equal(c.contextPending, nil); equal(c.contextWant, nil)
    s:ContextAck(); c:ContextTick()
    equal(c.contextProtocol, 4); equal(c.contextCurrent.domain, "state")
end)

local function announce(c, s)
    s:ContextAck(); c:ContextTick(); s:ContextAck(c.contextPending.id)
    equal(c.contextAnnounced, true)
end

-- Acknowledge every part of every domain of the pass in flight; returns the domain order seen.
local function serve(c, s)
    local domains, acknowledgements = {}, 0
    while c.contextCurrent do
        domains[#domains + 1] = c.contextCurrent.domain
        while c.contextCurrent and c.contextCurrent.domain == domains[#domains] do
            acknowledgements = acknowledgements + 1
            assert(acknowledgements <= 20, "context pass failed to finish after twenty acknowledgements")
            s:ContextAck(c.contextPending.id, { ack = c.global.ack,
                contextWant = c.contextWant, contextWantMask = c.contextWantMask })
            c:ContextTick()
        end
    end
    return table.concat(domains, ",")
end

test("an explicit context refresh captures all domains once without a host want", function()
    local c, s, clock, captured = fixture()
    announce(c, s)
    assert(c:RefreshContext()); assert(c:RefreshContext())
    clock.now = clock.now + 1; c:ContextTick()
    equal(serve(c, s), "player,progress,quests")
    equal(#captured, 3, "repeated refresh clicks coalesce")
    clock.now = 600; c:ContextTick()
    equal(#captured, 3); equal(c.contextPending, nil, "refresh does not start a periodic stream")
    c:HandleSlash("context refresh")
    clock.now = clock.now + 1; c:ContextTick()
    equal(serve(c, s), "player,progress,quests"); equal(#captured, 6)
end)

test("manual refresh waits for input and the current snapshot, and pausing cancels it", function()
    local c, s, clock, captured = fixture()
    announce(c, s)
    s:ContextAck(c.contextNextID - 1, { contextWant = 1, contextWantMask = 4 }); c:ContextTick()
    local current = c.contextCurrent
    assert(c:RefreshContext()); assert(c:RefreshContext()); c:ContextTick()
    equal(c.contextCurrent, current, "refresh preserves the in-flight revision")
    equal(serve(c, s), "progress")
    assert(c:Send("claude", "priority"))
    clock.now = clock.now + 1; c:ContextTick()
    equal(#captured, 1, "input takes precedence over the refresh")
    s:ContextAck(c.contextNextID - 1, { ack = 1 }); c:ContextTick()
    equal(serve(c, s), "player,progress,quests"); equal(#captured, 4)
    assert(c:RefreshContext()); assert(c:SetContextEnabled(false))
    s:ContextAck(c.contextNextID - 1, { ack = 1 }); c:ContextTick()
    equal(c.contextCurrent.domain, "state"); s:ContextAck(c.contextPending.id, { ack = 1 })
    equal(c:RefreshContext(), false)
    assert(c:SetContextEnabled(true)); c:ContextTick()
    s:ContextAck(c.contextPending.id, { ack = 1 })
    clock.now = 600; c:ContextTick()
    equal(#captured, 4, "re-enabling does not revive a cancelled refresh")
end)

test("repeated host chunks retain every merged unserved context domain", function()
    local c, s, _, captured = fixture()
    announce(c, s)
    s:ContextAck(c.contextNextID - 1, { contextWant = 1, contextWantMask = 4 }); c:ContextTick()
    local pending = c.contextPending.id
    s:ContextAck(pending - 1, { contextWant = 2, contextWantMask = 1 })
    s:ContextAck(pending - 1, { contextWant = 3, contextWantMask = 2 })
    equal(c.contextWantMask, 3)
    s:ContextAck(pending - 1, { contextWant = 3, contextWantMask = 2 })
    equal(c.contextWantMask, 3, "the repeated raw mask cannot discard an unserved bit")
    s:ContextAck(pending, { contextWant = 3, contextWantMask = 2 }); c:ContextTick()
    equal(serve(c, s), "player,quests")
    equal(table.concat(captured, ","), "progress,player,quests")
end)

test("the want mask selects domains in the fixed order player, progress, quests", function()
    local c, s, _, captured = fixture()
    announce(c, s)
    s:ContextAck(c.contextNextID - 1, { contextWant = 1, contextWantMask = 4 }); c:ContextTick()
    equal(c.contextCurrent.domain, "progress"); equal(#captured, 1)
    equal(serve(c, s), "progress")
    equal(c.contextServedWant, 1); equal(#captured, 1, "only the requested domain was captured")
    s:ContextAck(c.contextNextID - 1, { contextWant = 2, contextWantMask = 6 }); c:ContextTick()
    equal(serve(c, s), "progress,quests")
    s:ContextAck(c.contextNextID - 1, { contextWant = 3, contextWantMask = 7 }); c:ContextTick()
    equal(serve(c, s), "player,progress,quests")
    s:ContextAck(c.contextNextID - 1, { contextWant = 4, contextWantMask = 5 }); c:ContextTick()
    equal(serve(c, s), "player,progress")
    -- Progress is one cheap part and answers "how far to level", so it goes before the quest batch.
    equal(captured[1], "progress"); equal(captured[2], "progress"); equal(captured[3], "quests")
    equal(captured[4], "player"); equal(captured[5], "progress"); equal(captured[6], "quests")
    equal(#captured, 8)
end)

test("a changed want id with a zero mask is served without any capture", function()
    local c, s, clock, captured = fixture()
    announce(c, s)
    s:ContextAck(c.contextNextID - 1, { contextWant = 1, contextWantMask = 0 })
    c:ContextTick()
    equal(c.contextCurrent, nil); equal(c.contextPending, nil); equal(#captured, 0)
    equal(c.contextServedWant, 1, "the id is marked served")
    clock.now = 600; c:ContextTick(); equal(c.contextCurrent, nil); equal(#captured, 0)
    s:ContextAck(c.contextNextID - 1, { contextWant = 2, contextWantMask = 1 }); c:ContextTick()
    equal(c.contextCurrent.domain, "player"); equal(#captured, 1)
end)

test("a want id that changes while a capture is in flight is served after that pass completes", function()
    local c, s, _, captured = fixture()
    announce(c, s)
    s:ContextAck(c.contextNextID - 1, { contextWant = 1, contextWantMask = 1 }); c:ContextTick()
    equal(c.contextCurrent.domain, "player"); local revision = c.contextCurrent.revision
    -- A new id with a different mask arrives before the player part is acknowledged.
    s:ContextAck(0, { contextWant = 2, contextWantMask = 4 }); c:ContextTick()
    equal(c.contextCurrent.domain, "player"); equal(c.contextCurrent.revision, revision, "the in-flight pass is not abandoned")
    equal(c.contextServedWant, 1)
    s:ContextAck(c.contextPending.id, { contextWant = 2, contextWantMask = 4 })
    equal(c:Snapshot().context.player.status, "Shared")
    c:ContextTick(); equal(c.contextCurrent.domain, "progress"); equal(c.contextServedWant, 2)
    equal(serve(c, s), "progress"); equal(#captured, 2)
    -- Two ids superseding each other before either is served keep both requests' domains.
    s:ContextAck(c.contextNextID - 1, { contextWant = 3, contextWantMask = 2 })
    s:ContextAck(c.contextNextID - 1, { contextWant = 4, contextWantMask = 4 })
    c:ContextTick(); equal(serve(c, s), "progress,quests"); equal(c.contextServedWant, 4)
end)

local function published(progress)
    local c, s = fixture({ contextEnabled = true, progress = progress })
    announce(c, s)
    s:ContextAck(c.contextNextID - 1, { contextWant = 1, contextWantMask = 4 }); c:ContextTick()
    equal(serve(c, s), "progress")
    return c:Snapshot().context.progress, c
end

test("the progress domain is summarised for the panel like the player domain", function()
    local progress, c = published(nil)
    equal(progress.status, "Shared"); equal(progress.summary, "12g 34s 56c / 45% to next level")
    equal(c:Snapshot().context.player, nil)
    progress = published({ 5, false, false, 0, true, "party", "Ragefire Chasm", "Normal", 5, "TANK",
        false, false, false, { "xp:cap", "xpMax:cap" } })
    equal(progress.summary, "0g 0s 5c / XP capped / in Ragefire Chasm"); equal(progress.status, "Shared")
    progress = published({ false, false, false, false, false, false, false, false, false, false, false, false, false,
        { "money:restricted", "xp:restricted" } })
    equal(progress.summary, "Unavailable"); equal(progress.status, "Unavailable")
    progress = published({ 10000, 1, 2, 0, false, "none", false, false, 0, false, false, false, false, { "rested:unavailable" } })
    equal(progress.summary, "1g 0s 0c / 50% to next level"); equal(progress.status, "Partial")
    progress = published({ 0, false, 0, 0, true, "party", false, false, 0, false, true, false, false, { "xp:invalid" } })
    equal(progress.summary, "0g 0s 0c"); equal(progress.status, "Partial")
end)

test("a whole protocol 3 extension keeps the terminals alive but is not negotiated", function()
    local r = ns.Ring.New({ uiNonce = "abcdef01" })
    local legacy = r:OnChunk(ns.TestPayload(1, { contextProtocol = 3, contextAck = 0, contextWant = 1, contextWantMask = 7 }))
    equal(legacy.accepted, true); equal(legacy.contextProtocol, 3)
    local c, s = fixture()
    s:Accept({ contextProtocol = 3, contextAck = 0, contextWant = 1, contextWantMask = 7 })
    c:ContextTick(); equal(c:Snapshot().context.status, "Unsupported host")
    equal(c.connected, true)
end)

test("mask bit 8 captures errors after the other domains, and only on request", function()
    local c, s, clock, captured = fixture()
    announce(c, s)
    s:ContextAck(c.contextNextID - 1, { contextWant = 1, contextWantMask = 8 }); c:ContextTick()
    equal(serve(c, s), "errors")
    equal(c:Snapshot().context.errors.summary, "2 stored")
    s:ContextAck(c.contextNextID - 1, { contextWant = 2, contextWantMask = 15 }); c:ContextTick()
    equal(serve(c, s), "player,progress,quests,errors")
    local before = #captured
    assert(c:RefreshContext())
    clock.now = clock.now + 1; c:ContextTick()
    local refreshed = serve(c, s)
    equal(refreshed, "player,progress,quests", "a manual refresh does not send errors")
    equal(#captured, before + 3)
end)

test("errors are not captured while sharing is off", function()
    local c, s, _, captured = fixture({ contextEnabled = false })
    s:ContextAck(); c:ContextTick(); s:ContextAck(c.contextPending.id); c:ContextTick()
    s:ContextAck(c.contextNextID - 1, { contextWant = 1, contextWantMask = 8 }); c:ContextTick()
    equal(c.contextCurrent, nil)
    for _, domain in ipairs(captured) do assert(domain ~= "errors") end
end)
