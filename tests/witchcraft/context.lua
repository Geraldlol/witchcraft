local ns, test, equal = ...
local Context = ns.Context

local function fixture()
    return {
        IsSecret = function() return false end,
        CanAccessTable = function() return true end,
        GetPlayerName = function() return "Mulgorefriend" end,
        GetPlayerClass = function() return "Shaman" end,
        GetPlayerLevel = function() return 10 end,
        GetMapID = function() return 7 end,
        GetZone = function() return "Mulgore" end,
        GetSubzone = function() return "Bloodhoof Village" end,
        GetTrackedCount = function() return 2 end,
        GetTrackedQuestID = function(index) return 100 + index end,
        GetQuestTitle = function(id) return "Quest " .. id end,
        IsQuestComplete = function(id) return id == 102 end,
        GetQuestObjectives = function()
            return { { text = "Prairie Wolf Paw: 2/8", numFulfilled = 2, numRequired = 8, finished = false } }
        end,
    }
end

test("context: player location and tracked quest progress share the agreed arrays", function()
    local adapter = Context.New(fixture())
    local player = adapter:Capture("player")
    equal(#player, 1)
    equal(Context.Encode(player[1]), '["Mulgorefriend","Shaman",10,7,"Mulgore","Bloodhoof Village",[]]')
    local parts = adapter:Capture("quests")
    equal(#parts, 2)
    equal(Context.Encode(parts[1]), '[true,"",2,false,[[101,"Quest 101",false,[["Prairie Wolf Paw: 2/8",2,8,false]],false]]]')
    equal(parts[2][5][1][3], true)
    equal(adapter:Capture("inventory"), nil)
end)

test("context: missing APIs and empty tracking remain distinguishable", function()
    local api = fixture()
    api.GetPlayerName, api.GetMapID = nil, function() return nil end
    local player = Context.New(api):Capture("player")[1]
    equal(player[1], false); equal(player[4], false)
    equal(player[7][1], "name:missing"); equal(player[7][2], "mapId:unavailable")
    api.GetTrackedCount = function() return 0 end
    equal(Context.Encode(Context.New(api):Capture("quests")), '[[true,"",0,false,[]]]')
    api.GetTrackedCount = nil
    equal(Context.Encode(Context.New(api):Capture("quests")), '[[false,"missing",0,false,[]]]')
    api.GetTrackedCount = function() error("native details must never escape") end
    equal(Context.Encode(Context.New(api):Capture("quests")), '[[false,"unavailable",0,false,[]]]')
end)

test("context: secret payloads stop before formatting or field access", function()
    local api, inspected = fixture(), false
    local secret = setmetatable({}, {
        __tostring = function() inspected = true; error("secret formatting") end,
        __index = function() inspected = true; error("secret field access") end,
    })
    api.IsSecret = function(value) return rawequal(value, secret) end
    api.GetPlayerName = function() return secret end
    local player = Context.New(api):Capture("player")[1]
    equal(player[1], false); equal(player[7][1], "name:restricted")
    api.GetQuestObjectives = function() return { secret } end
    equal(Context.New(api):Capture("quests")[1][2], "restricted")
    api.GetQuestObjectives = function() return { { text = secret, finished = false } } end
    equal(Context.New(api):Capture("quests")[1][2], "restricted")
    equal(inspected, false)
    api.GetQuestObjectives = fixture().GetQuestObjectives
    api.CanAccessTable = function() return false end
    equal(Context.New(api):Capture("quests")[1][2], "restricted")
    api.IsSecret = nil
    equal(Context.New(api):Capture("quests")[1][2], "guard-missing")
end)

test("context: invalid values never become invented level or objective progress", function()
    local api = fixture()
    api.GetPlayerLevel = function() return 0 / 0 end
    equal(Context.New(api):Capture("player")[1][3], false)
    api.GetQuestObjectives = function() return { { text = "Collect a clue", finished = false } } end
    local objective = Context.New(api):Capture("quests")[1][5][1][4][1]
    equal(objective[2], false); equal(objective[3], false)
    api.GetQuestObjectives = function() return { { text = "Collect", numRequired = -1, finished = false } } end
    equal(Context.New(api):Capture("quests")[1][2], "invalid")
    api.GetTrackedQuestID = function() return 101 end
    api.GetQuestObjectives = fixture().GetQuestObjectives
    equal(Context.New(api):Capture("quests")[1][2], "duplicate-quest")
end)

test("context: worst-case quoting UTF-8 and objective counts fit the pixel envelope", function()
    local api = fixture()
    api.GetPlayerName = function() return string.rep('"', 200) end
    api.GetPlayerClass, api.GetZone, api.GetSubzone = api.GetPlayerName, api.GetPlayerName, api.GetPlayerName
    for _, part in ipairs(Context.New(api):Capture("player")) do
        assert(#assert(Context.Encode(part)) <= Context.MAX_DATA_BYTES)
        assert(#assert(Context.Encode({ 1, "player", 2147483647, 1, 10, 2147483647, part })) <= 580)
    end
    api.GetTrackedCount = function() return 99 end
    api.GetQuestTitle = function() return string.rep("\240\159\140\149", 40) end
    api.GetQuestObjectives = function()
        local rows = {}
        for index = 1, 12 do rows[index] = {
            text = string.rep('"\\', 80), numFulfilled = 2147483647, numRequired = 2147483647, finished = false,
        } end
        return rows
    end
    local parts = Context.New(api):Capture("quests")
    equal(#parts, 10)
    for index, part in ipairs(parts) do
        equal(part[3], 99); equal(part[4], true); equal(part[5][1][5], true)
        equal(#part[5][1][2], 64)
        assert(#part[5][1][4] <= 4)
        assert(#assert(Context.Encode(part)) <= Context.MAX_DATA_BYTES)
        assert(#assert(Context.Encode({ 1, "quests", 2147483647, index, 10, 2147483647, part })) <= 580)
    end
end)

test("context: fresh captures do not mutate snapshots already in transit", function()
    local api, current = fixture(), 2
    api.GetQuestObjectives = function() return { { text = "Claw", numFulfilled = current, numRequired = 8, finished = false } } end
    local adapter = Context.New(api)
    local old = adapter:Capture("quests")
    current = 3
    equal(adapter:Capture("quests")[1][5][1][4][1][2], 3)
    equal(old[1][5][1][4][1][2], 2)
end)

test("context: encoder rejects non-data arrays cycles bad numbers and malformed UTF-8", function()
    local cycle = {}; cycle[1] = cycle
    for _, value in ipairs({ cycle, { a = 1 }, { [2] = "gap" }, { math.huge }, { -1 }, { "\192\175" } }) do
        equal(Context.Encode(value), nil)
    end
    equal(Context.Encode({ "line\nquote\"slash\\", false, {} }), '["line\\u000aquote\\"slash\\\\",false,[]]')
    local api = fixture()
    api.GetQuestTitle = function() return "\237\160\128" end
    equal(Context.New(api):Capture("quests")[1][2], "invalid")
end)

test("context: native C1 controls are sanitized before the pixel transport boundary", function()
    local api = fixture()
    local controls = "\194\128\194\159"
    api.GetPlayerName = function() return "A" .. controls .. "B" end
    api.GetQuestTitle = function() return "Quest" .. controls .. "title" end
    api.GetQuestObjectives = function()
        return { { text = "Claw" .. controls .. "count", numFulfilled = 1, numRequired = 2, finished = false } }
    end
    local adapter = Context.New(api)
    equal(adapter:Capture("player")[1][1], "A  B")
    equal(adapter:Capture("quests")[1][5][1][2], "Quest  title")
    for _, domain in ipairs({ "player", "quests" }) do
        local parts = adapter:Capture(domain)
        for index, part in ipairs(parts) do
            local encoded = assert(Context.Encode({ 1, domain, 1, index, #parts, 0, part }))
            assert(ns.Pixel.ValidText(encoded))
            assert(ns.Pixel.EncodeContext({ epoch = "0123abcd", uiNonce = "abcd0123", id = index, text = encoded }))
        end
    end
end)

local function progressFixture()
    return {
        IsSecret = function() return false end,
        CanAccessTable = function() return true end,
        GetMoney = function() return 123456 end,
        GetPlayerXP = function() return 4500 end,
        GetPlayerXPMax = function() return 10000 end,
        GetRestedXP = function() return 900 end,
        IsInInstance = function() return false, "none" end,
        GetInstanceInfo = function() return "Ragefire Chasm", "party", 1, "Normal", 5, 0, false, 389, nil end,
        GetGroupSize = function() return 0 end,
        GetPlayerRole = function() return "NONE" end,
        IsPlayerDeadOrGhost = function() return false end,
        IsPlayerGhost = function() return false end,
        IsPlayerInCombat = function() return false end,
    }
end

test("context: progress exports money, experience and situation as one agreed array", function()
    local api = progressFixture()
    local parts = Context.New(api):Capture("progress")
    equal(#parts, 1)
    equal(Context.Encode(parts[1]), '[123456,4500,10000,900,false,"none",false,false,0,false,false,false,false,[]]')
    api.GetGroupSize = function() return 5 end
    api.GetPlayerRole = function() return "TANK" end
    api.IsInInstance = function() return true, "party" end
    api.IsPlayerInCombat = function() return true end
    equal(Context.Encode(Context.New(api):Capture("progress")[1]),
        '[123456,4500,10000,900,true,"party","Ragefire Chasm","Normal",5,"TANK",false,false,true,[]]')
end)

test("context: progress at the level cap reports cap for experience and never zero", function()
    local api = progressFixture()
    api.GetPlayerXP, api.GetPlayerXPMax = function() return 0 end, function() return 0 end
    local data = Context.New(api):Capture("progress")[1]
    equal(data[2], false); equal(data[3], false)
    equal(data[14][1], "xp:cap"); equal(data[14][2], "xpMax:cap"); equal(#data[14], 2)
    equal(data[4], 900, "rested experience is independent of the cap")
end)

test("context: progress treats a nil rested bonus as zero but a failed read as unavailable", function()
    local api = progressFixture()
    api.GetRestedXP = function() return nil end
    local data = Context.New(api):Capture("progress")[1]
    equal(data[4], 0); equal(#data[14], 0)
    api.GetRestedXP = function() error("native details must never escape") end
    data = Context.New(api):Capture("progress")[1]
    equal(data[4], false); equal(data[14][1], "rested:unavailable")
end)

test("context: progress exports the role only while grouped and instance details only inside", function()
    local api = progressFixture()
    api.GetPlayerRole = function() error("must not be read while solo") end
    api.GetInstanceInfo = function() error("must not be read outside an instance") end
    local data = Context.New(api):Capture("progress")[1]
    equal(data[7], false); equal(data[8], false); equal(data[10], false); equal(#data[14], 0)
    api.GetGroupSize = function() return 3 end
    api.GetPlayerRole = function() return "HEALER" end
    data = Context.New(api):Capture("progress")[1]
    equal(data[9], 3); equal(data[10], "HEALER"); equal(#data[14], 0)
    api.IsInInstance = function() return true, "raid" end
    api.GetInstanceInfo = function() return "Molten Core", "raid", 9, "40 Player" end
    data = Context.New(api):Capture("progress")[1]
    equal(data[5], true); equal(data[6], "raid"); equal(data[7], "Molten Core"); equal(data[8], "40 Player")
end)

test("context: progress records restricted values and missing functions per field", function()
    local api = progressFixture()
    local secret = setmetatable({}, { __index = function() error("secret field access") end })
    api.IsSecret = function(value) return rawequal(value, secret) end
    api.GetMoney = function() return secret end
    api.GetGroupSize = nil
    api.IsPlayerGhost = function() return "no" end
    local data = Context.New(api):Capture("progress")[1]
    equal(data[1], false); equal(data[9], false); equal(data[10], false); equal(data[12], false)
    equal(data[14][1], "money:restricted"); equal(data[14][2], "groupSize:missing"); equal(data[14][3], "ghost:invalid")
    equal(#data[14], 3, "the role is silently absent when the group size is unknown")
    api.IsInInstance = function() return secret, secret end
    data = Context.New(api):Capture("progress")[1]
    equal(data[5], false); equal(data[6], false); equal(data[7], false)
    equal(data[14][1], "money:restricted"); equal(data[14][2], "inInstance:restricted"); equal(data[14][3], "instanceType:restricted")
end)

test("context: progress clips instance strings at their byte caps and fits the pixel envelope", function()
    local api = progressFixture()
    api.IsInInstance = function() return true, string.rep("t", 20) end
    api.GetInstanceInfo = function() return string.rep("\240\159\140\149", 12), "raid", 9, string.rep("d", 30) end
    api.GetGroupSize = function() return 40 end
    api.GetPlayerRole = function() return "DAMAGER-LONG" end
    api.GetMoney = function() return 2147483647 end
    api.GetPlayerXP, api.GetPlayerXPMax = function() return 2147483646 end, function() return 2147483647 end
    api.GetRestedXP = function() return 2147483647 end
    local data = Context.New(api):Capture("progress")[1]
    equal(#data[6], 16); equal(#data[7], 40); equal(#data[8], 24); equal(#data[10], 8)
    equal(data[14][1], "instanceType:truncated"); equal(data[14][2], "instanceName:truncated")
    equal(data[14][3], "difficulty:truncated"); equal(data[14][4], "role:truncated")
    assert(#assert(Context.Encode(data)) <= Context.MAX_DATA_BYTES)
    assert(#assert(Context.Encode({ 1, "progress", 2147483647, 1, 1, 2147483647, data })) <= 580)
    api.GetMoney = function() return 2147483648 end
    api.GetInstanceInfo = function() return "", "raid", 9, "Normal" end
    data = Context.New(api):Capture("progress")[1]
    equal(data[1], false); equal(data[14][1], "money:invalid")
    equal(data[7], false); equal(data[14][2], "instanceType:truncated"); equal(data[14][3], "instanceName:invalid")
    api.IsSecret = nil
    data = Context.New(api):Capture("progress")[1]
    equal(#data[14], 10, "every read reports the missing guard once; guarded-off fields stay silent")
    assert(#assert(Context.Encode(data)) <= Context.MAX_DATA_BYTES)
end)

local function errorStore(count, now, session)
    local state = { now = now or 5000 }
    local store = ns.Errors.New({ time = function() return state.now end })
    store:Attach({ errorSession = (session or 1) - 1 })
    for index = 1, count do
        state.now = (now or 5000) - (count - index) * 10
        store:Record("error", "Boom " .. index, "Hello/Hello.lua:" .. index .. ": in function 'f'")
    end
    state.now = now or 5000
    return store, state
end

test("context: errors travel newest first, one entry per part, with ages instead of clock times", function()
    local store = errorStore(3)
    local parts = Context.New({ Errors = store }):Capture("errors")
    equal(#parts, 3)
    equal(Context.Encode(parts[1]), '[true,"",3,false,[["error","Boom 3",["Hello/Hello.lua:3: in function \'f\'"],1,0,0,0]]]')
    equal(parts[3][5][1][2], "Boom 1"); equal(parts[3][5][1][6], 20, "last seen twenty seconds ago")
    for _, part in ipairs(parts) do assert(#Context.Encode(part) <= Context.MAX_DATA_BYTES) end
end)

test("context: an empty error store is one part, and more than eight entries mark truncation", function()
    local empty = Context.New({ Errors = errorStore(0) }):Capture("errors")
    equal(#empty, 1); equal(Context.Encode(empty[1]), '[true,"",0,false,[]]')
    local full = Context.New({ Errors = errorStore(12) }):Capture("errors")
    equal(#full, 8)
    for _, part in ipairs(full) do equal(part[3], 12); equal(part[4], true) end
    equal(full[1][5][1][2], "Boom 12")
    equal(select(2, pcall(function() return Context.New({}):Capture("errors") end))[1][1], false,
        "without a store the domain is unavailable, not empty")
end)

test("context: an error too large for a part loses stack frames, then message bytes", function()
    local store = ns.Errors.New({ time = function() return 1 end })
    store:Attach({})
    local quoted = string.rep('"', 240)
    store:Record("error", quoted, string.rep(string.rep("\\", 60) .. "\n", 3))
    local parts = Context.New({ Errors = store }):Capture("errors")
    equal(#parts, 1)
    assert(#Context.Encode(parts[1]) <= Context.MAX_DATA_BYTES)
    equal(parts[1][4], true, "shrinking is reported as truncation")
end)

test("context: reloads ago follow the session the entry was last seen in", function()
    local store, state = errorStore(1, 5000, 3)
    local global = store.global
    store:Attach(global); store:Attach(global)
    state.now = 5100
    local row = Context.New({ Errors = store }):Capture("errors")[1][5][1]
    equal(row[7], 2); equal(row[5], 100); equal(row[6], 100)
end)
