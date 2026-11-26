local ns, test, equal = ...

local function fixture(options)
    options = options or {}
    local state = { actions = {}, set = 1, now = 0, combat = false, saves = 0, sets = {} }
    for key, value in pairs(options.actions or {}) do state.actions[key] = value end
    local binding
    local api = {
        Now = function() return state.now end,
        InCombatLockdown = function() return state.combat end,
        GetCurrentBindingSet = function() return state.set end,
        GetBindingAction = function(key) return state.actions[key] or "" end,
        SetBinding = function(key, action)
            state.sets[#state.sets + 1] = { key, action }
            if state.rejectSet then return false end
            if state.rejectClear and action == nil then return false end
            if state.mutateReadback and action then state.actions[key] = "USER_CHANGED"
            else state.actions[key] = action end
            if state.fireUpdate and binding then binding:OnBindingsChanged() end
            return true
        end,
        SaveBindings = function()
            state.saves = state.saves + 1
            if state.failSaveAt and state.saves == state.failSaveAt then return false end
            if state.nilSave then return nil end
            return true
        end,
    }
    -- The production adapter passes GetTime and no Now.
    if options.getTime then api.GetTime, api.Now = api.Now, nil end
    binding = ns.Binding.New(api)
    return binding, state
end

local function host(ack, overrides)
    local result = { epoch = "1234abcd", bindingProtocol = 1, bindingNonce = "89abcdef", bindingAck = ack }
    for key, value in pairs(overrides or {}) do result[key] = value end
    return result
end

test("a claim that cannot proceed leaves its reason in the carrier status", function()
    -- In game on 2026-09-21 the probe armed but no frame ever reached disk, and nothing said why.
    local keys = ns.Binding.Keys
    local carrier = fixture({ actions = { [keys[1]] = "A", [keys[2]] = "B", [keys[3]] = "C", [keys[4]] = "D" } })
    assert(carrier:Probe("abcdef01"))
    equal(carrier:Pump(7), false)
    equal(carrier.status, "No reserved carrier key is unbound")

    local rejected, rejectedState = fixture(); rejectedState.rejectSet = true
    assert(rejected:Probe("abcdef01"))
    equal(rejected:Pump(7), false)
    equal(rejected.status, "SetBinding rejected the carrier frame")
end)

test("binding probe persists one inert frame, ACKs, restores the key and opens the session", function()
    local carrier, state = fixture()
    assert(carrier:Probe("abcdef01")); assert(carrier:Pump(7))
    local owned = carrier.outstanding
    equal(owned.key, ns.Binding.Keys[1]); equal(state.saves, 1)
    local frame = assert(ns.Binding.ParseAction(owned.action))
    equal(frame.epoch, "00000000"); equal(frame.nonce, "00000000"); equal(frame.uiNonce, "abcdef01")
    equal(frame.slot, 7); equal(frame.seq, 1); equal(frame.payload, "PFAM_BIND_PROBE")
    equal(carrier:AcceptHost(host(0)), false); equal(state.actions[owned.key], owned.action)
    local accepted, kind = carrier:AcceptHost(host(1))
    equal(accepted, true); equal(kind, "probe"); equal(state.actions[owned.key], nil)
    equal(state.saves, 2); equal(carrier.enabled, true); equal(carrier.nextSeq, 2)
end)

test("binding treats nil SaveBindings result as provisional until host observation", function()
    local carrier, state = fixture(); state.nilSave = true
    assert(carrier:Probe("abcdef01")); assert(carrier:Pump(3)); assert(carrier.outstanding)
    equal(state.saves, 1)
    assert(carrier:AcceptHost(host(1)))
    equal(state.actions[ns.Binding.Keys[1]], nil); equal(state.saves, 2)
end)

test("binding carrier skips occupied keys, refuses all-occupied and never mutates in combat", function()
    local occupied = {}
    for index = 1, 3 do occupied[ns.Binding.Keys[index]] = "USER_ACTION_" .. index end
    local carrier, state = fixture({ actions = occupied })
    assert(carrier:Probe("abcdef01")); assert(carrier:Pump(1))
    equal(carrier.outstanding.key, ns.Binding.Keys[4])
    for index = 1, 3 do equal(state.actions[ns.Binding.Keys[index]], "USER_ACTION_" .. index) end

    local blocked, blockedState = fixture({ actions = {
        [ns.Binding.Keys[1]] = "A", [ns.Binding.Keys[2]] = "B", [ns.Binding.Keys[3]] = "C", [ns.Binding.Keys[4]] = "D",
    } })
    assert(blocked:Probe("abcdef01")); equal(blocked:Pump(1), false); equal(blockedState.saves, 0)
    local combat, combatState = fixture(); combatState.combat = true
    equal(combat:Probe("abcdef01"), false); equal(#combatState.sets, 0); equal(combatState.saves, 0)
end)

test("binding carrier requires exact readback and restores a claim after a failed save", function()
    local changed, changedState = fixture(); changedState.mutateReadback = true
    assert(changed:Probe("abcdef01")); equal(changed:Pump(1), false)
    assert(changed.quarantined); equal(changedState.actions[ns.Binding.Keys[1]], "USER_CHANGED")
    equal(changedState.saves, 0, "ownership mismatch is never overwritten")

    local restored, restoredState = fixture(); restoredState.failSaveAt = 1
    assert(restored:Probe("abcdef01")); equal(restored:Pump(1), false)
    equal(restored.quarantined, nil); equal(restored.outstanding, nil)
    equal(restoredState.actions[ns.Binding.Keys[1]], nil); equal(restoredState.saves, 2)
end)

test("binding carrier quarantines ACK jumps, ownership changes and cleanup save failure", function()
    local jumped, jumpState = fixture(); assert(jumped:Probe("abcdef01")); assert(jumped:Pump(1))
    local jumpAction = jumped.outstanding.action
    equal(jumped:AcceptHost(host(2)), false); assert(jumped.quarantined)
    equal(jumpState.actions[ns.Binding.Keys[1]], jumpAction)

    local changed, changedState = fixture(); assert(changed:Probe("abcdef01")); assert(changed:Pump(1))
    changedState.actions[ns.Binding.Keys[1]] = "USER_NEW_ACTION"
    equal(changed:OnBindingsChanged(), false); assert(changed.quarantined)
    equal(changedState.actions[ns.Binding.Keys[1]], "USER_NEW_ACTION")

    local failed, failedState = fixture(); failedState.failSaveAt = 2
    assert(failed:Probe("abcdef01")); assert(failed:Pump(1))
    equal(failed:AcceptHost(host(1)), false); assert(failed.quarantined)
    equal(failedState.actions[ns.Binding.Keys[1]], nil)
end)

test("binding carrier defers ACK cleanup in combat and aborts on binding-set change", function()
    local carrier, state = fixture(); assert(carrier:Probe("abcdef01")); assert(carrier:Pump(1))
    state.combat = true; equal(carrier:AcceptHost(host(1)), false); assert(carrier.outstanding)
    equal(state.actions[ns.Binding.Keys[1]], carrier.outstanding.action)
    state.combat = false; assert(carrier:AcceptHost(host(1))); equal(state.actions[ns.Binding.Keys[1]], nil)

    local switched, switchedState = fixture(); assert(switched:Probe("abcdef01")); assert(switched:Pump(1))
    switchedState.set = 2; equal(switched:OnBindingsChanged(), false); assert(switched.quarantined)
    equal(#switchedState.sets, 1, "a different binding set is never edited")
end)

test("binding startup scrub removes only exact valid carrier actions on reserved keys", function()
    local stale = assert(ns.Binding.ActionFor({ epoch = "1234abcd", nonce = "89abcdef", uiNonce = "abcdef01",
        slot = 9, seq = 4, part = 1, count = 1, payload = "stale" }))
    local carrier, state = fixture({ actions = {
        [ns.Binding.Keys[1]] = stale,
        [ns.Binding.Keys[2]] = "CLICK WitchcraftCarrier_but_not_ours:LeftButton",
        [ns.Binding.Keys[3]] = "USER_ACTION",
    } })
    assert(carrier:StartupScrub())
    equal(state.actions[ns.Binding.Keys[1]], nil)
    equal(state.actions[ns.Binding.Keys[2]], "CLICK WitchcraftCarrier_but_not_ours:LeftButton")
    equal(state.actions[ns.Binding.Keys[3]], "USER_ACTION")
    equal(state.saves, 1)
end)

test("binding application frames are stop-and-wait, one hertz and clean each exact frame", function()
    local carrier, state = fixture(); assert(carrier:Probe("abcdef01")); assert(carrier:Pump(5)); assert(carrier:AcceptHost(host(1)))
    local message = { epoch = "1234abcd", id = 9, tab = "codex", action = "text", text = string.rep("x", 70) }
    assert(carrier:OfferInput(message)); equal(#carrier.active.chunks, 3)
    equal(carrier:Pump(6), false)
    state.now = .99; equal(carrier:Pump(6), false)
    state.now = 1; assert(carrier:Pump(6)); equal(carrier.outstanding.seq, 2)
    equal(carrier:Pump(6), false, "one outstanding frame only")
    assert(carrier:AcceptHost(host(2))); equal(carrier.active.part, 2); equal(state.actions[ns.Binding.Keys[1]], nil)
    equal(carrier:Pump(7), false)
    state.now = 2; assert(carrier:Pump(7)); equal(carrier.outstanding.seq, 3)
    assert(carrier:AcceptHost(host(3))); state.now = 3; assert(carrier:Pump(8))
    assert(carrier:AcceptHost(host(4))); equal(carrier.active, nil); equal(carrier.nextSeq, 5)
    equal(carrier.enabled, true)
end)

test("binding heartbeat is a seq-0 H frame, rate limited, refused while busy or in combat, replaced by data and cleared on stop", function()
    local carrier, state = fixture()
    equal(select(2, carrier:Heartbeat(2, 0)), "carrier has no host session")
    assert(carrier:Probe("abcdef01")); assert(carrier:Pump(5)); assert(carrier:AcceptHost(host(1)))
    local key = ns.Binding.Keys[1]
    state.now = 1; assert(carrier:Heartbeat(2, 0))
    local action = state.actions[key]
    assert(action:match("^CLICK WitchcraftCarrier_V1_%x+_%x+_%x+_0002_000000_01_01_[A-Z2-7]+_%x+:LeftButton$"), action)
    local frame = assert(ns.Binding.ParseAction(action))
    equal(frame.seq, 0); equal(frame.payload, "H\0"); equal(frame.epoch, "1234abcd"); equal(frame.nonce, "89abcdef")
    equal(carrier:Busy(), false); equal(carrier:Snapshot().heartbeatSlot, 2)
    local ok, reason = carrier:Heartbeat(2, 0); equal(ok, false); equal(reason, "carrier rate limit")
    state.now = 2; ok, reason = carrier:Heartbeat(2, 0); equal(ok, false); equal(reason, "heartbeat unchanged")
    assert(carrier:Heartbeat(3, 0)); equal(carrier:Snapshot().heartbeatSlot, 3)
    equal(ns.Binding.ParseAction(state.actions[key]).slot, 3)
    -- A data frame takes the heartbeat's key, so the file never holds two carrier frames.
    assert(carrier:OfferInput({ epoch = "1234abcd", id = 9, tab = "codex", action = "text", text = "hi" }))
    state.now = 3; ok, reason = carrier:Heartbeat(4, 0); equal(ok, false); equal(reason, "carrier has data to send")
    assert(carrier:Pump(4)); equal(carrier.outstanding.key, key); equal(carrier:Snapshot().heartbeatSlot, nil)
    equal(ns.Binding.ParseAction(state.actions[key]).seq, 2)
    for index = 2, 4 do equal(state.actions[ns.Binding.Keys[index]], nil) end
    state.now = 4; ok, reason = carrier:Heartbeat(4, 0); equal(ok, false); equal(reason, "waiting for host acknowledgement")
    assert(carrier:AcceptHost(host(2))); equal(state.actions[key], nil)
    state.now = 5; state.combat = true
    ok, reason = carrier:Heartbeat(4, 1); equal(ok, false); equal(reason, "Carrier paused in combat")
    state.combat = false; assert(carrier:Heartbeat(4, 1)); equal(ns.Binding.ParseAction(state.actions[key]).payload, "H\1")
    assert(carrier:Stop()); equal(state.actions[key], nil); equal(carrier:Snapshot().heartbeatSlot, nil)
    equal(carrier.quarantined, nil)
end)

test("a failed heartbeat clear keeps the key recoverable; a key someone else took drops the record", function()
    local carrier, state = fixture()
    assert(carrier:Probe("abcdef01")); assert(carrier:Pump(5)); assert(carrier:AcceptHost(host(1)))
    local key = ns.Binding.Keys[1]
    state.now = 1; assert(carrier:Heartbeat(2, 0))
    local action = state.actions[key]
    -- SetBinding refuses the clear once: the clear quarantines without recursing and keeps the record.
    state.rejectClear = true
    equal(carrier:Stop(), false)
    equal(state.actions[key], action); equal(carrier:Snapshot().heartbeatSlot, 2)
    equal(carrier.quarantined, "carrier cleanup failed"); equal(carrier.clearingHeartbeat, nil)
    state.rejectClear = nil
    equal(carrier:Stop(), true); equal(state.actions[key], nil); equal(carrier:Snapshot().heartbeatSlot, nil)

    local other, otherState = fixture()
    assert(other:Probe("abcdef01")); assert(other:Pump(5)); assert(other:AcceptHost(host(1)))
    otherState.now = 1; assert(other:Heartbeat(2, 0))
    otherState.actions[key] = "OTHER"
    equal(other:Stop(), false); equal(other:Snapshot().heartbeatSlot, nil)
    equal(other.quarantined, "reserved key ownership changed")
    equal(other:Stop(), true); equal(otherState.actions[key], "OTHER")

    -- A readback that cannot be made leaves ownership unknown: the record stays until it can be.
    local third, thirdState = fixture()
    assert(third:Probe("abcdef01")); assert(third:Pump(5)); assert(third:AcceptHost(host(1)))
    thirdState.now = 1; assert(third:Heartbeat(2, 0))
    local getter = third.api.GetBindingAction
    third.api.GetBindingAction = nil
    equal(third:Stop(), false); equal(third:Snapshot().heartbeatSlot, 2, "unknown ownership keeps the record")
    third.api.GetBindingAction = getter
    equal(third:Stop(), true); equal(thirdState.actions[key], nil); equal(third:Snapshot().heartbeatSlot, nil)

    -- A live clear whose save fails keeps the record; the next Stop saves the empty key and drops it.
    local fourth, fourthState = fixture()
    assert(fourth:Probe("abcdef01")); assert(fourth:Pump(5)); assert(fourth:AcceptHost(host(1)))
    fourthState.now = 1; assert(fourth:Heartbeat(2, 0))
    fourthState.failSaveAt = fourthState.saves + 1
    local saves = fourthState.saves
    equal(fourth:Stop(), false); equal(fourthState.actions[key], nil, "the live clear landed")
    equal(fourth:Snapshot().heartbeatSlot, 2, "an unsaved clear keeps the record")
    equal(fourth:Stop(), true); equal(fourthState.saves, saves + 2, "the second Stop saves again")
    equal(fourth:Snapshot().heartbeatSlot, nil)

    -- The saved set put the frame back on the live key before the next attempt: it is cleared again, not saved.
    local fifth, fifthState = fixture()
    assert(fifth:Probe("abcdef01")); assert(fifth:Pump(5)); assert(fifth:AcceptHost(host(1)))
    fifthState.now = 1; assert(fifth:Heartbeat(2, 0))
    local frame = fifthState.actions[key]
    fifthState.failSaveAt = fifthState.saves + 1
    equal(fifth:Stop(), false); equal(fifth:Snapshot().heartbeatSlot, 2)
    fifthState.actions[key] = frame
    equal(fifth:Stop(), true); equal(fifthState.actions[key], nil, "a restored frame is cleared before the save")
    equal(fifth:Snapshot().heartbeatSlot, nil)
end)

test("binding heartbeat flags above 3 are refused by the codec and the parser", function()
    local carrier, state = fixture()
    assert(carrier:Probe("abcdef01")); assert(carrier:Pump(5)); assert(carrier:AcceptHost(host(1)))
    state.now = 1
    local ok, reason = carrier:Heartbeat(2, 4); equal(ok, false); equal(reason, "Invalid carrier frame")
    local frame = { epoch = "1234abcd", nonce = "89abcdef", uiNonce = "abcdef01", slot = 2, seq = 0, part = 1,
        count = 1, payload = "H\3" }
    -- The daemon encodes the same flags-3 heartbeat byte for byte.
    equal(ns.Binding.ActionFor(frame),
        "CLICK WitchcraftCarrier_V1_1234ABCD_89ABCDEF_ABCDEF01_0002_000000_01_01_JABQ_46FC22DA:LeftButton")
    frame.payload = "H\4"; equal(ns.Binding.ActionFor(frame), nil)
    -- A flags-4 heartbeat encoded before the bound existed (valid CRC) no longer parses.
    equal(ns.Binding.ParseAction(
        "CLICK WitchcraftCarrier_V1_1234ABCD_89ABCDEF_ABCDEF01_0002_000000_01_01_JACA_425003FF:LeftButton"), nil)
end)

test("binding cancel of a dropped input keeps its claimed frame until the acknowledgement, and ignores another input", function()
    local carrier, state = fixture(); assert(carrier:Probe("abcdef01")); assert(carrier:Pump(5)); assert(carrier:AcceptHost(host(1)))
    local message = { epoch = "1234abcd", id = 9, tab = "copilot", action = "text", text = string.rep("x", 60) }
    assert(carrier:OfferInput(message)); assert(#carrier.active.chunks > 1)
    state.now = 1; assert(carrier:Pump(6))
    local owned, active = carrier.outstanding, carrier.active
    equal(state.actions[owned.key], owned.action)
    equal(carrier:Cancel("input:1234abcd:10"), false)
    equal(carrier.outstanding, owned); equal(carrier.active, active); equal(state.actions[owned.key], owned.action)
    state.combat = true
    equal(carrier:Cancel("input:1234abcd:9"), false)
    equal(carrier.outstanding, owned); equal(carrier.active, active); equal(state.actions[owned.key], owned.action)
    state.combat = false
    equal(carrier:Cancel("input:1234abcd:9"), false)
    equal(carrier.outstanding, owned); equal(state.actions[owned.key], owned.action)
    assert(carrier:AcceptHost(host(2)))
    equal(carrier.outstanding, nil); equal(carrier.active, nil); equal(state.actions[owned.key], nil)
    equal(carrier:Busy(), false); equal(carrier.enabled, true); equal(carrier.quarantined, nil)
end)

test("binding self UPDATE_BINDINGS is ignored while an owned write is in progress", function()
    local carrier, state = fixture(); state.fireUpdate = true
    assert(carrier:Probe("abcdef01")); assert(carrier:Pump(1))
    equal(carrier.quarantined, nil); assert(carrier.outstanding)
    assert(carrier:AcceptHost(host(1))); equal(carrier.quarantined, nil)
end)

test("an accepted acknowledgement or a new probe clears the input mark", function()
    local carrier, state = fixture(); assert(carrier:Probe("abcdef01")); assert(carrier:Pump(5)); assert(carrier:AcceptHost(host(1)))
    assert(carrier:OfferInput({ epoch = "1234abcd", id = 9, tab = "codex", action = "text", text = "hello" }))
    state.now = 1; assert(carrier:Pump(6))
    carrier.inputBlocked = true
    equal(carrier:AcceptHost(host(1)), false); equal(carrier.inputBlocked, true, "an older acknowledgement leaves the mark")
    assert(carrier:AcceptHost(host(2))); equal(carrier.inputBlocked, nil, "an accepted acknowledgement clears the mark")
    -- A proven carrier probes again only for another host session.
    equal(carrier:AcceptHost(host(2, { bindingNonce = "99999999" })), false)
    carrier.inputBlocked = true
    assert(carrier:Probe("abcdef01")); equal(carrier.inputBlocked, nil, "a new probe clears the mark")
end)

test("a heartbeat asked for inside a carrier write is refused, so one key is bound and Stop clears it", function()
    local carrier, state = fixture()
    assert(carrier:Probe("abcdef01")); assert(carrier:Pump(5)); assert(carrier:AcceptHost(host(1)))
    -- SetBinding fires UPDATE_BINDINGS synchronously; a handler that asks for a heartbeat runs inside the write.
    local set, nested = carrier.api.SetBinding, nil
    carrier.api.SetBinding = function(key, action)
        local ok = set(key, action)
        if action and not nested then nested = { carrier:Heartbeat(3, 0) } end
        return ok
    end
    state.now = 1; assert(carrier:Heartbeat(2, 0))
    equal(nested[1], false); equal(nested[2], "carrier write in progress")
    local bound = {}
    for _, key in ipairs(ns.Binding.Keys) do if (state.actions[key] or "") ~= "" then bound[#bound + 1] = key end end
    equal(#bound, 1, "one carrier key is bound")
    equal(carrier.heartbeat.key, bound[1], "and the carrier tracks it")
    equal(carrier:Stop(), true)
    for _, key in ipairs(ns.Binding.Keys) do equal(state.actions[key] or "", "", "Stop leaves " .. key .. " unbound") end
end)

test("the binding carrier reads GetTime when its api has no Now, as the production adapter passes", function()
    local carrier, state = fixture({ getTime = true })
    equal(carrier.api.Now, nil)
    state.now = 5; equal(carrier:Now(), 5, "Now follows GetTime")
    assert(carrier:Probe("abcdef01")); assert(carrier:Pump(5)); assert(carrier:AcceptHost(host(1)))
    equal(carrier.lastWriteAt, 5)
    state.now = 5.5
    local ok, reason = carrier:Heartbeat(2, 0)
    equal(ok, false); equal(reason, "carrier rate limit", "a second write inside one second is refused")
    state.now = 6; assert(carrier:Heartbeat(2, 0), "a second write after one second is accepted")
    equal(ns.Binding.ParseAction(state.actions[ns.Binding.Keys[1]]).seq, 0)
    equal(ns.Binding.New({}):Now(), 0, "with neither function the clock stays at zero")
end)

test("a cancelled data frame keeps its key until its acknowledgement, and nothing else is sent before it", function()
    local second = { epoch = "1234abcd", id = 10, tab = "codex", action = "text", text = "second" }
    -- Input A is claimed at sequence 2.
    local function claimed(text)
        local carrier, state = fixture(); assert(carrier:Probe("abcdef01")); assert(carrier:Pump(5)); assert(carrier:AcceptHost(host(1)))
        assert(carrier:OfferInput({ epoch = "1234abcd", id = 9, tab = "codex", action = "text", text = text or "first" }))
        state.now = 1; assert(carrier:Pump(6)); equal(carrier.outstanding.seq, 2)
        return carrier, state, carrier.outstanding
    end
    local carrier, state, owned = claimed()
    local writes = #state.sets
    state.now = 2
    equal(carrier:Cancel("input:1234abcd:9"), false, "nothing is released before the acknowledgement")
    equal(state.actions[owned.key], owned.action); equal(carrier.outstanding, owned); equal(carrier:Busy(), true)
    equal(carrier.status, "Carrier waiting for host acknowledgement")
    equal(carrier:OfferInput(second), false)
    for _, now in ipairs({ 3, 10, 100 }) do state.now = now; equal(carrier:Pump(7), false, "no frame at " .. now) end
    equal(#state.sets, writes, "no binding call while A is outstanding")
    equal(carrier:AcceptHost(host(1)), false); equal(carrier.outstanding, owned, "an older acknowledgement moves nothing")
    local accepted, kind = carrier:AcceptHost(host(2))
    equal(accepted, true); equal(kind, "frame")
    equal(state.actions[owned.key], nil); equal(carrier.active, nil); equal(carrier.nextSeq, 3)
    equal(carrier.status, "Carrier ready")
    assert(carrier:OfferInput(second)); state.now = 101; assert(carrier:Pump(7))
    equal(carrier.outstanding.seq, 3, "B follows the acknowledged sequence")
    -- A multi-part item abandoned at part 1 sends no part 2.
    local multi, multiState = claimed(string.rep("x", 60))
    assert(#multi.active.chunks > 1)
    equal(multi:Cancel("input:1234abcd:9"), false)
    assert(multi:AcceptHost(host(2))); equal(multi.active, nil)
    local cleared = #multiState.sets
    for _, now in ipairs({ 5, 6, 50 }) do multiState.now = now; equal(multi:Pump(7), false) end
    equal(#multiState.sets, cleared, "no part 2"); equal(multi.outstanding, nil); equal(multi:Busy(), false)
    -- In combat the cancel behaves the same and makes no binding call.
    local fought, foughtState, foughtOwned = claimed()
    foughtState.combat = true
    local sets, saves = #foughtState.sets, foughtState.saves
    equal(fought:Cancel("input:1234abcd:9"), false)
    equal(#foughtState.sets, sets); equal(foughtState.saves, saves); equal(fought.outstanding, foughtOwned)
    equal(fought.active.abandoned, true); equal(fought.status, "Carrier waiting for host acknowledgement")
    foughtState.combat = false
    assert(fought:AcceptHost(host(2))); equal(fought.active, nil); equal(foughtState.actions[foughtOwned.key], nil)
end)

test("an acknowledgement repeated after a quarantining cleanup failure only finishes the cleanup", function()
    local carrier, state = fixture(); assert(carrier:Probe("abcdef01")); assert(carrier:Pump(5)); assert(carrier:AcceptHost(host(1)))
    assert(carrier:OfferInput({ epoch = "1234abcd", id = 9, tab = "codex", action = "text", text = "hello" }))
    state.now = 1; assert(carrier:Pump(6))
    local owned = carrier.outstanding
    state.rejectClear = true
    equal(carrier:AcceptHost(host(2)), false)
    equal(carrier.quarantined, "carrier cleanup failed"); equal(carrier.outstanding, owned); equal(carrier.active, nil)
    state.rejectClear = nil
    local ok, accepted = pcall(carrier.AcceptHost, carrier, host(2))
    assert(ok, tostring(accepted)); equal(accepted, false)
    equal(carrier.outstanding, nil); equal(state.actions[owned.key], nil, "the cleanup finished")
    equal(carrier.enabled, false); equal(carrier.quarantined, "carrier cleanup failed"); equal(carrier.nextSeq, 2)
end)

test("a proven carrier refuses a second probe until a host result names another session", function()
    local refused = "Binding carrier was already probed in this host session; /reload to probe again"
    local function proven()
        local carrier, state = fixture(); assert(carrier:Probe("abcdef01")); assert(carrier:Pump(5)); assert(carrier:AcceptHost(host(1)))
        return carrier, state
    end
    local carrier, state = proven()
    local sets, saves = #state.sets, state.saves
    local ok, reason = carrier:Probe("abcdef02")
    equal(ok, false); equal(reason, refused); equal(#state.sets, sets); equal(state.saves, saves)
    equal(carrier.enabled, true); equal(carrier.nextSeq, 2); equal(carrier.active, nil)
    state.now = 5; equal(carrier:Pump(7), false); equal(#state.sets, sets, "nothing is written")
    equal(carrier:Stop(), true)
    ok, reason = carrier:Probe("abcdef02")
    equal(ok, false); equal(reason, refused, "still refused after Stop"); equal(#state.sets, sets)
    equal(carrier:AcceptHost(host(0)), false)
    equal(select(2, carrier:Probe("abcdef02")), refused, "the same session leaves it proven")
    -- Stopped, then a host result with another epoch.
    equal(carrier:AcceptHost(host(0, { epoch = "22222222" })), false)
    assert(carrier:Probe("abcdef02"), "another epoch allows a probe")
    -- Enabled, then a host result with another nonce.
    local enabled = proven()
    equal(enabled:AcceptHost(host(1, { bindingNonce = "99999999" })), false)
    equal(enabled.enabled, false); equal(enabled.status, "Host changed; run /witch bindprobe")
    assert(enabled:Probe("abcdef02"), "another nonce allows a probe")
    -- Stopped, then another nonce.
    local stopped = proven()
    equal(stopped:Stop(), true)
    equal(stopped:AcceptHost(host(1, { bindingNonce = "99999999" })), false)
    assert(stopped:Probe("abcdef02"))
    -- A host change seen while a data frame is outstanding also allows a probe once it is cleaned.
    local busy, busyState = proven()
    assert(busy:OfferInput({ epoch = "1234abcd", id = 9, tab = "codex", action = "text", text = "hello" }))
    busyState.now = 1; assert(busy:Pump(6))
    equal(busy:AcceptHost(host(1, { epoch = "22222222" })), false); equal(busy.outstanding, nil)
    assert(busy:Probe("abcdef02"))
end)

test("a probe the host may have read is not repeated after Stop, until the host session changes", function()
    local carrier, state = fixture()
    equal(carrier:AcceptHost(host(0)), false)
    assert(carrier:Probe("abcdef01")); assert(carrier:Pump(5))
    assert(carrier.outstanding and carrier.outstanding.probe, "the probe frame is on its key")
    equal(carrier:Stop(), true, "Stop releases the unanswered probe")
    local sets = #state.sets
    state.now = 5
    local ok, reason = carrier:Probe("abcdef01")
    equal(ok, false); equal(reason, "Binding carrier was already probed in this host session; /reload to probe again")
    equal(carrier:Pump(6), false); equal(#state.sets, sets, "no second probe frame is written")
    equal(carrier:AcceptHost(host(1)), false, "the late acknowledgement finds nothing outstanding")
    equal(select(1, carrier:Probe("abcdef01")), false, "the same host session still refuses")
    equal(carrier:AcceptHost(host(0, { epoch = "22222222" })), false)
    assert(carrier:Probe("abcdef01"), "another host session allows a probe")
    -- A probe still on its key when the host changes can be read by the new host.
    local waiting = fixture()
    equal(waiting:AcceptHost(host(0)), false)
    assert(waiting:Probe("abcdef01")); assert(waiting:Pump(5))
    equal(waiting:AcceptHost(host(0, { epoch = "22222222" })), false)
    equal(waiting:Stop(), true)
    equal(select(1, waiting:Probe("abcdef01")), false, "the new host may have read the probe that was still on the key")
end)

test("a host result from another epoch without the binding fields ends the carrier proven with the old host", function()
    local function proven()
        local carrier, state = fixture(); assert(carrier:Probe("abcdef01")); assert(carrier:Pump(5)); assert(carrier:AcceptHost(host(1)))
        return carrier, state
    end
    local carrier = proven()
    equal(carrier:AcceptHost({ epoch = "1234abcd" }), false)
    equal(carrier.enabled, true, "the same epoch without the fields changes nothing")
    equal(carrier:AcceptHost({ epoch = "22222222" }), false)
    equal(carrier.enabled, false); equal(carrier.status, "Host changed; run /witch bindprobe")
    assert(carrier:Probe("abcdef02"), "the new host session allows a probe")
    local busy, state = proven()
    assert(busy:OfferInput({ epoch = "1234abcd", id = 9, tab = "codex", action = "text", text = "hello" }))
    state.now = 1; assert(busy:Pump(6))
    local key = busy.outstanding.key
    equal(busy:AcceptHost({ epoch = "22222222" }), false)
    equal(busy.outstanding, nil); equal(busy.enabled, false); equal(state.actions[key], nil, "the old host's frame is cleared")
end)

test("a host change in combat ends the old carrier at once and clears its frame when combat ends", function()
    local carrier, state = fixture(); assert(carrier:Probe("abcdef01")); assert(carrier:Pump(5)); assert(carrier:AcceptHost(host(1)))
    assert(carrier:OfferInput({ epoch = "1234abcd", id = 9, tab = "codex", action = "text", text = "hello" }))
    state.now = 1; assert(carrier:Pump(6))
    local key = carrier.outstanding.key
    state.combat = true
    equal(carrier:AcceptHost(host(0, { epoch = "22222222" })), false)
    equal(carrier.enabled, false, "the old host's carrier no longer counts as enabled")
    assert(carrier.outstanding and state.actions[key], "the cleanup waits for combat to end")
    state.combat = false
    equal(carrier:AcceptHost(host(0, { epoch = "22222222" })), false)
    equal(carrier.outstanding, nil); equal(carrier.active, nil); equal(state.actions[key], nil)
    equal(carrier.status, "Host changed; run /witch bindprobe")
end)

test("an acknowledgement cleanup whose save failed only saves on the next acknowledgement or Stop", function()
    local function failing()
        local carrier, state = fixture(); assert(carrier:Probe("abcdef01")); assert(carrier:Pump(5)); assert(carrier:AcceptHost(host(1)))
        assert(carrier:OfferInput({ epoch = "1234abcd", id = 9, tab = "codex", action = "text", text = "hello" }))
        state.now = 1; assert(carrier:Pump(6))
        local owned = carrier.outstanding
        state.failSaveAt = state.saves + 1
        equal(carrier:AcceptHost(host(2)), false)
        equal(carrier.quarantined, "carrier cleanup failed"); equal(carrier.outstanding, owned)
        equal(state.actions[owned.key], nil, "the live clear landed")
        return carrier, state
    end
    local carrier, state = failing()
    local sets, saves = #state.sets, state.saves
    equal(carrier:AcceptHost(host(2)), false)
    equal(carrier.outstanding, nil, "the repeated acknowledgement finishes the cleanup")
    equal(#state.sets, sets, "no second SetBinding call"); equal(state.saves, saves + 1)
    equal(carrier.quarantined, "carrier cleanup failed")
    local stopped, stoppedState = failing()
    sets, saves = #stoppedState.sets, stoppedState.saves
    equal(stopped:Stop(), true)
    equal(stopped.outstanding, nil, "Stop finishes the cleanup"); equal(#stoppedState.sets, sets); equal(stoppedState.saves, saves + 1)
end)

test("a result naming another UI session leaves the probe waiting on its key", function()
    local carrier, state = fixture(); assert(carrier:Probe("abcdef01")); assert(carrier:Pump(5))
    local owned = carrier.outstanding
    equal(carrier:AcceptHost(host(7, { bindingUi = "abcdef00" })), false)
    assert(not carrier.quarantined); equal(carrier.outstanding, owned); equal(state.actions[owned.key], owned.action)
    equal(carrier:AcceptHost(host(1, { bindingUi = "abcdef00" })), false, "the old session's acknowledgement is not this probe's")
    assert(not carrier.quarantined); equal(carrier.outstanding, owned); equal(state.actions[owned.key], owned.action)
    local accepted, kind = carrier:AcceptHost(host(1, { bindingUi = "abcdef01" }))
    equal(accepted, true); equal(kind, "probe"); equal(carrier.enabled, true); equal(carrier.nextSeq, 2)
    equal(state.actions[owned.key], nil)
    local older = fixture(); assert(older:Probe("abcdef01")); assert(older:Pump(5))
    equal(older:AcceptHost(host(7)), false); equal(older.quarantined, "carrier acknowledgement jumped")
end)

test("a result naming another UI session ends an enabled carrier as another host does", function()
    local carrier, state = fixture(); assert(carrier:Probe("abcdef01")); assert(carrier:Pump(5))
    assert(carrier:AcceptHost(host(1, { bindingUi = "abcdef01" })))
    assert(carrier:OfferInput({ epoch = "1234abcd", id = 9, tab = "codex", action = "text", text = "hello" }))
    state.now = 1; assert(carrier:Pump(6))
    local key = carrier.outstanding.key
    equal(carrier:AcceptHost(host(2, { bindingUi = "abcdef00" })), false)
    equal(carrier.enabled, false); equal(carrier.status, "Host changed; run /witch bindprobe")
    equal(carrier.outstanding, nil); equal(state.actions[key], nil, "the frame is cleared")
    local idle = fixture(); assert(idle:Probe("abcdef01")); assert(idle:Pump(5)); assert(idle:AcceptHost(host(1)))
    equal(idle:AcceptHost(host(1, { bindingUi = "abcdef00" })), false)
    equal(idle.enabled, false); equal(idle.status, "Host changed; run /witch bindprobe")
end)
