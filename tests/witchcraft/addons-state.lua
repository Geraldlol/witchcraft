local ns, test, equal = ...
local State = ns.AddonsState
local SESSION = "0123456789abcdef"
local function fixture()
    local state = { now = 0, values = {}, original = {}, saves = {}, calls = 0, character = "Player-fixture", combat = false }
    for index, name in ipairs(State.Names) do
        state.values[name] = index % 3 == 0 and 2 or 0
        state.original[name] = state.values[name]
    end
    local function set(name, character, value)
        equal(character, state.character); assert(state.original[name] ~= nil)
        state.calls = state.calls + 1
        if state.failSet == state.calls then error("injected setter failure") end
        state.values[name] = value
    end
    local api = {
        Now = function() return state.now end,
        Build = function() return ns.Evidence.version, state.build or ns.Evidence.build, "date", ns.Evidence.interface end,
        Character = function() return state.character end,
        Insecure = function() return false end,
        Combat = function() return state.combat end,
        GetAddOnSecurity = function() return 1 end,
        DoesAddOnExist = function(name) return name ~= state.missing end,
        IsAddOnLoaded = function(name) return name == state.loaded, false end,
        GetAddOnEnableState = function(name) return state.values[name] end,
        EnableAddOn = function(name, character) set(name, character, 2) end,
        DisableAddOn = function(name, character) set(name, character, 0) end,
        SaveAddOns = function()
            local copy = {}
            for name, value in pairs(state.values) do copy[name] = value end
            state.saves[#state.saves + 1] = copy
            if state.failSave == #state.saves then error("injected save failure") end
        end,
    }
    return State.New(api), state, api
end
local function phase(carrier, state)
    state.now = state.now + 2
    return carrier:Pump()
end
local function restored(carrier, state)
    assert(carrier:RequestRestore())
    assert(phase(carrier, state)); assert(phase(carrier, state)); assert(phase(carrier, state))
    equal(carrier.status, "restored")
    for name, value in pairs(state.original) do equal(state.values[name], value, name) end
end

test("state codec matches independent CRC and JavaScript golden bytes", function()
    equal(State.CRC32("123456789"), 3421780262)
    local bytes = assert(State.Encode({ session = SESSION, seq = 1, message = 1, part = 1, count = 1, payload = "hello" }))
    equal(#bytes, 32)
    equal(bytes:gsub(".", function(value) return string.format("%02x", value:byte()) end),
        "465301050123456789abcdef00010001010168656c6c6f0000000000d50c543c")
    equal(State.Encode({ session = SESSION, seq = 0 }), nil)
end)

test("state sender is inert until explicit start and uses three spaced commit saves", function()
    local carrier, state = fixture()
    equal(carrier:Pump(), false); equal(#state.saves, 0); equal(state.calls, 0)
    assert(carrier:Start(SESSION, {})); assert(carrier:Queue("hello"))
    assert(carrier:Pump()); equal(#state.saves, 1); equal(state.saves[1].WitchcraftStateCommit, 0)
    equal(carrier:Pump(), false); equal(#state.saves, 1)
    assert(phase(carrier, state)); equal(state.saves[2].WitchcraftStateCommit, 0)
    assert(phase(carrier, state)); equal(state.saves[3].WitchcraftStateCommit, 2)
    equal(carrier.status, "waiting"); equal(carrier:Acknowledge(SESSION, 2), false)
    equal(carrier:Acknowledge("1123456789abcdef", 1), false)
    assert(carrier:Acknowledge(SESSION, 1)); equal(carrier.status, "ready"); equal(carrier.seq, 2)
    equal(carrier:Acknowledge(SESSION, 1), false)
    restored(carrier, state)
end)

test("state sender maps binary bytes MSB-first and waits for ACK before next fragment", function()
    local carrier, state = fixture()
    assert(carrier:Start(SESSION, {})); assert(carrier:Queue("12345678hello"))
    for _ = 1, 3 do assert(phase(carrier, state)) end
    local expected = assert(State.Encode({ session = SESSION, seq = 1, message = 1, part = 1, count = 2, payload = "12345678" }))
    for index = 1, 256 do
        equal(state.values[State.Names[index]], math.floor(expected:byte(math.floor((index - 1) / 8) + 1) / 2 ^ (7 - (index - 1) % 8)) % 2 * 2)
    end
    equal(phase(carrier, state), false); equal(#state.saves, 3)
    assert(carrier:Acknowledge(SESSION, 1))
    for _ = 1, 3 do assert(phase(carrier, state)) end
    assert(carrier:Acknowledge(SESSION, 2)); equal(carrier.active, nil)
    restored(carrier, state)
end)

test("state ownership conflicts quarantine without overwriting the changed bank", function()
    local carrier, state = fixture()
    assert(carrier:Start(SESSION, {})); assert(carrier:Queue("hello")); assert(carrier:Pump())
    state.values[State.Names[1]] = 2
    equal(phase(carrier, state), false); equal(carrier.status, "quarantined")
    local calls = state.calls
    assert(carrier:RequestRestore()); equal(phase(carrier, state), false)
    equal(state.calls, calls); equal(state.values[State.Names[1]], 2)
end)

test("state partial setter and each save failure retain exact recoverable state snapshot", function()
    for failSave = 1, 3 do
        local carrier, state = fixture(); state.failSave = failSave
        assert(carrier:Start(SESSION, {})); assert(carrier:Queue("hello"))
        for _ = 1, failSave do phase(carrier, state) end
        equal(carrier.status, "quarantined")
        state.failSave = nil; restored(carrier, state)
    end
    local carrier, state = fixture()
    assert(carrier:Start(SESSION, {})); assert(carrier:Queue("hello")); assert(carrier:Pump())
    state.failSet = state.calls + 8
    equal(phase(carrier, state), false); equal(carrier.status, "quarantined")
    state.failSet = nil; restored(carrier, state)
end)

test("state gates pin character/build and pause in combat without writes", function()
    for _, field in ipairs({ "missing", "loaded" }) do
        local carrier, state = fixture(); state[field] = State.Names[1]
        equal(carrier:Start(SESSION, {}), false); equal(state.calls, 0)
    end
    local carrier, state = fixture(); state.build = "other"
    equal(select(2, carrier:Gate()), "requires evidence build " .. ns.Evidence.Label() .. " / "
        .. ns.Evidence.interface .. "; client is " .. ns.Evidence.version .. ".other")
    equal(carrier:Start(SESSION, {}), false); state.build = nil
    state.values[State.Names[1]] = 1; equal(carrier:Start(SESSION, {}), false)
    state.values[State.Names[1]] = 0; assert(carrier:Start(SESSION, {})); assert(carrier:Queue("hello"))
    state.combat = true; equal(carrier:Pump(), false); equal(state.calls, 0)
    state.combat = false; state.character = "Player-other"; equal(carrier:Pump(), false); equal(state.calls, 0)
end)

test("state ACK timeout stops writes and queue budgets prevent wrap or unbounded data", function()
    local carrier, state = fixture()
    assert(carrier:Start(SESSION, {}))
    equal(carrier:Queue(string.rep("x", 513)), false)
    carrier.seq = 65535; equal(carrier:Queue("123456789"), false)
    assert(carrier:Queue("hello"))
    for _ = 1, 3 do assert(phase(carrier, state)) end
    state.now = state.now + 31
    equal(carrier:Pump(), false); equal(carrier.status, "quarantined"); equal(#state.saves, 3)
    restored(carrier, state)
end)

test("state recovery is restore-only and failed restore can retry after rate limit", function()
    local carrier, state, api = fixture()
    local journal = {}
    assert(carrier:Start(SESSION, journal)); assert(carrier:Queue("hello"))
    for _ = 1, 3 do assert(phase(carrier, state)) end
    local recovery = State.New(api)
    assert(recovery:Recover(journal)); equal(recovery:Queue("resume"), false)
    state.failSave = #state.saves + 2
    assert(phase(recovery, state)); equal(phase(recovery, state), false)
    equal(recovery.status, "quarantined")
    state.failSave = nil; restored(recovery, state)
end)

test("state restores an initially enabled commit bit only after original data saves", function()
    local carrier, state = fixture()
    state.values.WitchcraftStateCommit, state.original.WitchcraftStateCommit = 2, 2
    assert(carrier:Start(SESSION, {})); assert(carrier:Queue("hello"))
    for _ = 1, 3 do assert(phase(carrier, state)) end
    assert(carrier:RequestRestore()); assert(phase(carrier, state)); assert(phase(carrier, state))
    equal(state.values.WitchcraftStateCommit, 0)
    assert(phase(carrier, state)); equal(state.values.WitchcraftStateCommit, 2)
    for name, value in pairs(state.original) do equal(state.values[name], value, name) end
end)
