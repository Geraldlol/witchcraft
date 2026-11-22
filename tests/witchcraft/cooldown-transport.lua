local ns, test, equal = ...
local fixture = ns.TestCooldownFixture

local contextAdapter = { Capture = function(_, domain)
    if domain == "player" then return { { "Tester", "WARRIOR", 10, 1412, "Mulgore", "Bloodhoof", {} } } end
    return { { true, "", 1, false, { { 1, "A quest", false, {}, false } } } }
end }

-- usedBefore stands for a WitchcraftDB in which an earlier host already used the carrier.
local function controller(carrier, state, usedBefore)
    local api = { Cooldown = carrier, Context = contextAdapter }
    if state then api.GetTime = function() return state.now end end
    return ns.TestControllerFixture({ contextEnabled = true, cooldownHost = usedBefore or nil }, api)
end

local function host(overrides)
    local fields = { contextProtocol = 4, contextAck = 0, contextWant = 0, contextWantMask = 0,
        cooldownProtocol = 2, cooldownNonce = "89abcdef", cooldownAck = 0, cooldownChecksum = 0 }
    for key, value in pairs(overrides or {}) do fields[key] = value end
    return fields
end

test("the controller starts the carrier from the host session and clears it on stop", function()
    local carrier, carrierState = fixture()
    local c, s = controller(carrier)
    equal(c.cooldown, carrier)
    equal(carrier.status, "stopped", "an unstarted host leaves the carrier inert")

    s:Accept(host())
    equal(carrier.status, "ready", "the host session starts the carrier")
    equal(carrier.nonce, "89abcdef")
    equal(carrier.epoch, c.global.epoch)
    equal(carrierState.sets, 1, "the consumed chunk wrote one heartbeat")

    -- Stop cancels the retry timer, so terminal cleanup bypasses only the carrier's own write rate.
    c:Stop()
    equal(carrier.status, "restored")
    equal(carrierState.sets, 2); equal(carrierState.raw, "")
end)

test("a host without the carrier extension leaves the carrier alone", function()
    local carrier = fixture()
    local _, s = controller(carrier)
    s:Accept()
    equal(carrier.status, "stopped", "no cooldown fields means no carrier session")
    s:Accept(host({ cooldownProtocol = 1 }))
    equal(carrier.status, "stopped", "an unknown carrier protocol is ignored")
end)

test("a quarantined carrier is reset rather than staying dead for the session", function()
    local carrier = fixture()
    local _, s = controller(carrier)
    s:Accept(host())
    carrier:Quarantine("synthetic ownership loss")
    equal(carrier.status, "quarantined")
    equal(carrier:Start({ epoch = "1234abcd", nonce = "89abcdef", uiNonce = "10293847" }), false)

    -- The next host snapshot recovers it instead of leaving the transport silent.
    s:Accept(host())
    equal(carrier.quarantined, nil)
    equal(carrier.status, "ready")
end)

test("a carrier reset refuses while a frame is still owned", function()
    local carrier = fixture()
    assert(carrier:Start({ epoch = "1234abcd", nonce = "89abcdef", uiNonce = "10293847" }))
    assert(carrier:OfferContext(1, "hello"))
    assert(carrier:Pump(nil, 1))
    carrier:Quarantine("synthetic loss with a live frame")
    equal(carrier:Reset(), false, "an owned frame must be restored, not forgotten")
end)

test("context goes down the carrier when it owns the session, and the binding lane stands aside", function()
    local carrier, carrierState = fixture()
    local c, s = controller(carrier)
    s:Accept(host())
    assert(c:CooldownActive(), "a started carrier owns the outbound context lane")

    -- Announce the preference, then ask for game data.
    c:ContextTick(); equal(c.contextCurrent.domain, "state")
    local id, text = c.contextPending.id, c.contextPending.text
    carrierState.now = carrierState.now + 1
    c:CooldownTick()
    equal(carrier.active.payload, ns.CooldownCarrier.ContextBody(id, text),
        "the pending context was handed to the carrier, carrying its own id")
    assert(carrier.outstanding, "and written once out of combat")
    equal(carrierState.sets, 2, "the chunk's heartbeat, then the context frame over it")

    -- The binding lane must not send the same snapshot a second time.
    if c.binding then
        c.binding.enabled = true
        c:BindingTick()
        equal(c.binding.active, nil, "the binding carrier stands aside while the cooldown lane owns context")
    end
end)

test("the strip stands aside for context while the carrier owns the session", function()
    -- Observed in game on 2026-09-21: both lanes drew the same pending message and the strip,
    -- being faster while the game is in front, carried most of it despite the carrier being up.
    local carrier = fixture()
    local c, s = controller(carrier)
    s:Accept(host())
    c:ContextTick(); assert(c.contextPending, "a context message is pending")
    c:PixelTick()
    equal(s.top, nil, "no context frame is drawn while the cooldown carrier owns the lane")
    assert(s.heartbeat, "the ring heartbeat still draws")

    local plain, ps = controller(fixture())
    ps:Accept({ contextProtocol = 4, contextAck = 0, contextWant = 0, contextWantMask = 0 })
    plain:ContextTick(); assert(plain.contextPending)
    plain:PixelTick()
    assert(ps.top, "without a carrier session the strip carries context as before")
end)

test("the status command reports both carrier lanes and why the cooldown lane did not start", function()
    local carrier = fixture()
    local c, s = controller(carrier)
    s:Accept(host())
    c:HandleSlash("status")
    local line = s.printed[#s.printed]
    assert(line:find("cooldown ready", 1, true), line)
    assert(line:find("binding ", 1, true), line)

    local blocked, blockedState = fixture({ [1] = 5, [2] = {}, [3] = {}, [4] = {}, [127] = "other owner" })
    local c2, s2 = controller(blocked)
    s2:Accept(host())
    equal(blocked.status, "stopped"); equal(blockedState.sets, 0)
    c2:HandleSlash("status")
    local line2 = s2.printed[#s2.printed]
    assert(line2:find("cooldown stopped (cooldown layout field 127 is already occupied)", 1, true), line2)
end)

test("the carrier lane is not used in combat and resumes afterwards", function()
    local carrier, carrierState = fixture()
    local c, s = controller(carrier)
    s:Accept(host())
    c:ContextTick()
    equal(carrierState.sets, 1, "the consumed chunk wrote one heartbeat")
    carrierState.combat = true
    carrierState.now = carrierState.now + 1
    c:CooldownTick()
    equal(carrierState.sets, 1, "no game setting is written in combat")
    carrierState.combat = false
    carrierState.now = carrierState.now + 1
    c:CooldownTick()
    equal(carrierState.sets, 2)
end)

test("a carrier-delivered announcement is acknowledged and lets game domains follow", function()
    local carrier, carrierState = fixture()
    local c, s = controller(carrier)
    s:Accept(host())
    c:ContextTick(); equal(c.contextCurrent.domain, "state")
    local id = c.contextPending.id
    carrierState.now = carrierState.now + 1
    c:CooldownTick()
    assert(carrier.outstanding, "the announcement went out over the carrier")

    -- The host decodes the addon's id from the carrier body and acknowledges exactly that.
    s:Accept(host({ contextAck = id }))
    equal(c.contextPending, nil, "the addon recognised its own message as acknowledged")
    equal(c.contextAnnounced, true, "so the announcement is complete")

    -- Which is what lets a want actually produce game data instead of re-announcing forever.
    s:Accept(host({ contextAck = id, contextWant = 1, contextWantMask = 3 }))
    c:ContextTick()
    equal(c.contextCurrent.domain, "player")
end)

test("a carrier quarantined while it still owns a frame is restored and restarted, not left dead", function()
    local carrier, carrierState = fixture()
    local c, s = controller(carrier)
    s:Accept(host())
    c:ContextTick()
    carrierState.now = carrierState.now + 1
    c:CooldownTick()
    assert(carrier.outstanding, "a frame is owned")
    equal(carrierState.sets, 2, "the chunk's heartbeat, then the context frame over it")

    -- An acknowledgement mismatch quarantines the carrier while field 127 is still ours.
    carrier:Quarantine("synthetic acknowledgement mismatch")
    equal(carrier.status, "quarantined"); assert(carrier.outstanding)
    equal(c:CooldownActive(), false)

    -- The next host snapshot must hand the setting back and bring the carrier up again.
    carrierState.now = carrierState.now + 1
    s:Accept(host())
    equal(carrier.outstanding, nil, "the owned frame was restored")
    equal(carrierState.sets, 3, "exactly one restoring write; the chunk's heartbeat waits for the write rate")
    equal(carrier.quarantined, nil)
    equal(carrier.status, "ready")
    assert(c:CooldownActive(), "the transport is alive again for the session")
end)

test("combat only defers that recovery; it does not abandon it", function()
    local carrier, carrierState = fixture()
    local c, s = controller(carrier)
    s:Accept(host())
    c:ContextTick()
    carrierState.now = carrierState.now + 1
    c:CooldownTick()
    carrier:Quarantine("synthetic acknowledgement mismatch")

    carrierState.combat = true
    carrierState.now = carrierState.now + 1
    s:Accept(host())
    equal(carrier.status, "quarantined", "nothing is written in combat")
    equal(carrierState.sets, 2)

    carrierState.combat = false
    carrierState.now = carrierState.now + 1
    s:Accept(host())
    equal(carrier.status, "ready")
    equal(carrierState.sets, 3)
end)

local function heartbeatIn(carrierState)
    local frame = ns.CooldownCarrier.ParseFrame(carrierState.persisted and carrierState.persisted[127])
    return frame and frame.kind == "heartbeat" and frame or nil
end

test("every consumed chunk offers one heartbeat carrying the ring's next slot", function()
    local carrier, carrierState = fixture()
    local c, s = controller(carrier, nil, true)
    -- Before the host session exists the heartbeat bootstraps with zero ids and the UI nonce.
    c:LoadTick()
    equal(carrier.status, "stopped"); equal(carrierState.sets, 1)
    local frame = assert(heartbeatIn(carrierState), "a slot with no host payload still produces a heartbeat")
    equal(frame.epoch, "00000000"); equal(frame.nonce, "00000000"); equal(frame.uiNonce, c.uiNonce)
    equal(frame.slot, c.ring.nextSeq); equal(frame.slot, 2)

    -- The host session starts the carrier without scrubbing the bootstrap heartbeat; the next chunk's
    -- heartbeat carries the session ids.
    carrierState.now = carrierState.now + 1
    s:Accept(host())
    equal(carrier.status, "ready"); equal(carrierState.sets, 2)
    frame = assert(heartbeatIn(carrierState))
    equal(frame.epoch, c.global.epoch); equal(frame.nonce, "89abcdef"); equal(frame.slot, 3); equal(frame.payload, "\0")

    -- Inside the write rate the offer is declined, not queued.
    s:Accept(host())
    equal(carrierState.sets, 2); equal(heartbeatIn(carrierState).slot, 3)
end)

test("a combat flag change offers a heartbeat; entering combat is gated, leaving it writes one", function()
    local carrier, carrierState = fixture()
    local c, s = controller(carrier)
    s:Accept(host()); equal(carrierState.sets, 1)
    carrierState.now = carrierState.now + 1
    s.combat, carrierState.combat = true, true
    c:OnEvent("PLAYER_REGEN_DISABLED")
    equal(carrierState.sets, 1, "no game setting is written in combat")
    s.combat, carrierState.combat = false, false
    c:OnEvent("PLAYER_REGEN_ENABLED")
    equal(carrierState.sets, 2, "leaving combat writes one heartbeat")
    equal(heartbeatIn(carrierState).payload, "\0")
    -- A requested reload advertises itself before the UI goes down.
    carrierState.now = carrierState.now + 1
    c:Reset()
    equal(s.reloads, 1); equal(carrierState.sets, 3); equal(heartbeatIn(carrierState).payload, "\2")
end)

test("no heartbeat goes out while a context frame is outstanding", function()
    local carrier, carrierState = fixture()
    local c, s = controller(carrier)
    s:Accept(host()); equal(carrierState.sets, 1)
    c:ContextTick()
    carrierState.now = carrierState.now + 1
    c:CooldownTick()
    assert(carrier.outstanding, "the context frame replaced the heartbeat"); equal(carrierState.sets, 2)
    local outstanding = ns.CooldownCarrier.ParseFrame(carrierState.persisted[127])
    equal(outstanding.kind, "context"); equal(outstanding.slot, 2)
    carrierState.now = carrierState.now + 1
    s:Accept(host())
    equal(carrierState.sets, 2, "the consumed chunk did not write a heartbeat over the data frame")
    equal(heartbeatIn(carrierState), nil); assert(carrier.outstanding)
end)

test("stopping the controller clears a heartbeat left in the field", function()
    local carrier, carrierState = fixture()
    local c, s = controller(carrier)
    s:Accept(host()); assert(heartbeatIn(carrierState))
    carrierState.now = carrierState.now + 1
    c:Stop()
    equal(carrierState.sets, 2); equal(carrierState.raw, ""); equal(carrier.heartbeat, nil); equal(carrier.status, "restored")
end)

test("bootstrap heartbeats back off while nothing answers and resume when a host chunk lands", function()
    local carrier, carrierState = fixture()
    local c, s = controller(carrier, carrierState, true)
    -- Slots that load without a host payload are what running with no daemon looks like.
    c:LoadTick()
    equal(c.connected, false); equal(carrierState.sets, 1, "the first offer writes")
    carrierState.now = carrierState.now + 7
    c:LoadTick(); equal(carrierState.sets, 1, "inside the interval the offer is declined")
    carrierState.now = carrierState.now + 1
    c:LoadTick(); equal(carrierState.sets, 2, "the interval elapsed")
    carrierState.now = carrierState.now + 15
    c:LoadTick(); equal(carrierState.sets, 2, "and the next interval is twice as long")
    carrierState.now = carrierState.now + 1
    c:LoadTick(); equal(carrierState.sets, 3)

    -- The interval doubles to a ceiling rather than growing without bound.
    for _ = 1, 8 do carrierState.now = carrierState.now + 300; c:LoadTick() end
    equal(c.heartbeatBackoff, 120)

    -- A host chunk proves someone is listening, so the ring's own cadence returns.
    carrierState.now = carrierState.now + 1
    s:Accept(host())
    equal(c.connected, true); equal(c.heartbeatBackoff, 8)
    local written = carrierState.sets
    carrierState.now = carrierState.now + 1
    s:Accept(host())
    equal(carrierState.sets, written + 1, "an answered ring writes a heartbeat per chunk")
end)

test("an unchecked client build is announced once per session, not on every host chunk", function()
    local carrier, carrierState = fixture()
    carrierState.build = "69999"
    local _, s = controller(carrier)
    s:Accept(host())
    equal(carrier.status, "stopped", "the gate still refuses an unchecked build")
    local notices = 0
    for _, line in ipairs(s.printed) do
        if line:find("1.60.1.69999", 1, true) then
            notices = notices + 1
            assert(line:find(ns.Evidence.Label(), 1, true), "the notice names the checked build")
        end
    end
    equal(notices, 1)
    s:Accept(host()); s:Accept(host())
    local after = 0
    for _, line in ipairs(s.printed) do if line:find("1.60.1.69999", 1, true) then after = after + 1 end end
    equal(after, 1, "later refusals stay in /witch status")
end)

test("a host without the carrier writes nothing to the player's layout", function()
    local carrier, carrierState = fixture()
    local c, s = controller(carrier, carrierState)
    for _ = 1, 3 do carrierState.now = carrierState.now + 10; s:Accept() end
    carrierState.now = carrierState.now + 10
    c:OnEvent("PLAYER_REGEN_ENABLED")
    carrierState.now = carrierState.now + 10
    c:Reset()
    equal(carrierState.sets, 0, "no chunk, combat change or reload touched the Cooldown Viewer layout")
    equal(c.global.cooldownHost, false)
end)

test("a fresh install sends no bootstrap heartbeat until a host has used the carrier", function()
    local carrier, carrierState = fixture()
    local c = controller(carrier, carrierState)
    c:LoadTick()
    equal(carrierState.sets, 0, "nothing says a host reads the layout, so nothing is written")

    local used, usedState = fixture()
    local d = controller(used, usedState, true)
    d:LoadTick()
    equal(usedState.sets, 1, "a host used the carrier before, so the bootstrap heartbeat goes out")
end)

test("a host drop immediately revokes the lane and retries rate-limited cleanup without pumping", function()
    local carrier, carrierState = fixture()
    local c, s = controller(carrier, carrierState)
    s:Accept(host())
    equal(c.global.cooldownHost, true, "a host that advertises the carrier is remembered")
    assert(heartbeatIn(carrierState))

    -- The host can disappear in the same write interval as the heartbeat. Lane authority must
    -- end immediately even though restoring the player's setting has to wait for the rate gate.
    s:Accept()
    equal(c.global.cooldownHost, false)
    equal(c:CooldownActive(), false, "a host that no longer advertises the carrier cannot own context")
    assert(c.cooldownDeferred, "the rate-limited restore is retained for retry")
    local written = carrierState.sets
    c.contextPending = { id = 99, text = "must use a fallback lane" }
    c:CooldownTick()
    equal(carrierState.sets, written, "the carrier never pumps after host authority is gone")

    carrierState.now = carrierState.now + 1
    c:CooldownTick()
    equal(carrierState.raw, "", "the deferred retry restores the layout beneath the heartbeat")
    equal(carrier.heartbeat, nil); equal(carrier.status, "restored"); equal(c.cooldownDeferred, nil)
    written = carrierState.sets
    for _ = 1, 3 do carrierState.now = carrierState.now + 10; s:Accept() end
    equal(carrierState.sets, written, "later chunks write nothing")
end)

test("logging out hands the layout back", function()
    local carrier, carrierState = fixture()
    local c, s = controller(carrier, carrierState)
    s:Accept(host()); assert(heartbeatIn(carrierState))
    c:OnEvent("PLAYER_LOGOUT")
    equal(carrierState.raw, "", "shutdown cleanup bypasses only the carrier's own write interval")
    equal(carrier.heartbeat, nil); equal(carrier.status, "restored")
end)

test("a host drop in combat stays inactive and restores promptly after combat", function()
    local carrier, carrierState = fixture()
    local c, s = controller(carrier, carrierState)
    s:Accept(host()); assert(heartbeatIn(carrierState))
    carrierState.now = carrierState.now + 1
    carrierState.combat, s.combat = true, true
    c:AcceptCooldownHost({})
    equal(c.global.cooldownHost, false); equal(c:CooldownActive(), false)
    assert(c.cooldownDeferred, "combat defers the ownership-safe restore")
    local written = carrierState.sets
    c:CooldownTick()
    equal(carrierState.sets, written, "combat and host loss both prevent new carrier writes")

    carrierState.combat, s.combat = false, false
    c:OnEvent("PLAYER_REGEN_ENABLED")
    equal(carrierState.raw, ""); equal(carrier.status, "restored")
    equal(c.cooldownDeferred, nil, "combat exit consumes the deferred cleanup")
end)

test("a host that drops the carrier also ends an idle carrier session, so context goes back to the other lanes", function()
    local carrier, carrierState = fixture()
    local c, s = controller(carrier, carrierState)
    s:Accept(host())
    c:ContextTick()
    carrierState.now = carrierState.now + 1; c:CooldownTick()
    local outstanding = assert(carrier.outstanding, "the announcement went out over the carrier")
    -- The acknowledgement clears the field and spends the write budget, so the carrier owns nothing.
    carrierState.now = carrierState.now + 1
    s:Accept(host({ cooldownAck = outstanding.seq, cooldownChecksum = outstanding.checksum }))
    equal(carrier.outstanding, nil); equal(carrier.heartbeat, nil)

    carrierState.now = carrierState.now + 1
    s:Accept()
    equal(c:CooldownActive(), false, "the carrier no longer owns the context lane")
    local written = carrierState.sets
    c.contextPending = c.contextPending or { id = 99, text = "x" }
    carrierState.now = carrierState.now + 1; c:CooldownTick()
    equal(carrierState.sets, written, "pending context does not reach the layout")
end)
