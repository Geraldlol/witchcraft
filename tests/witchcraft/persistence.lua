local ns, test, equal = ...
local function clone(value)
    if type(value) ~= "table" then return value end
    local copy = {}
    for key, child in pairs(value) do copy[key] = clone(child) end
    return copy
end
local function same(actual, expected)
    equal(type(actual), type(expected))
    if type(expected) ~= "table" then equal(actual, expected); return end
    for key, value in pairs(expected) do same(actual[key], value) end
    for key in pairs(actual) do equal(expected[key] ~= nil, true) end
end

test("persistence accepts fresh and probe schema without erasing unknown fields", function()
    equal(ns.Persistence.Validate(nil), true)
    local probe = { global = { schema = 1, outbox = {}, ack = 0, nextSeq = 1, view = {},
        probe = { logins = 2, reloadRequestedAt = "2026-09-19 17:49:54" } }, profiles = { Default = {} } }
    local before = clone(probe)
    equal(ns.Persistence.Validate(probe), true); same(probe, before)
    ns.Persistence.Initialize(probe.global)
    same(probe.global.probe, before.global.probe)
    same(probe.profiles, before.profiles)
    equal(probe.global.nextId, 1); equal(probe.global.activeTab, "claude")
    equal(probe.global.opacity, 80)
    equal(probe.global.effectsEnabled, nil, "the retired effects preference is no longer defaulted")
end)

test("the opt-in Copilot tab is listed and cycled only while its setting is on", function()
    local raw = { global = { schema = 1 } }
    equal(ns.Persistence.Validate(raw), true)
    ns.Persistence.Initialize(raw.global)
    local c = ns.Core.New(raw.global, { UINonce = function() return "abcdef03" end })
    equal(#c:Snapshot().tabs, 2)
    c:NextTab(); equal(raw.global.activeTab, "codex")
    c:NextTab(); equal(raw.global.activeTab, "claude", "Copilot is skipped while its setting is off")
    assert(c:SetSetting("tabCopilot", true))
    equal(#c:Snapshot().tabs, 3)
    c:NextTab(); c:NextTab(); equal(raw.global.activeTab, "copilot")
    assert(c:SelectTab("claude")); assert(c:SetSetting("tabCopilot", false))
    assert(c:SetSetting("tabCodex", false))
    c:NextTab(); equal(raw.global.activeTab, "claude", "a hidden Codex and a hidden Copilot leave Claude selected")
end)

test("saved settings that hide every tab are rejected and left unmodified", function()
    local raw = { global = { schema = 1, settings = { tabClaude = false, tabCodex = false, tabCopilot = false } } }
    local ok, reason = ns.Persistence.Validate(raw)
    equal(ok, false); equal(reason, "Invalid saved tab settings")
    equal(raw.global.settings.tabCopilot, false); equal(raw.global.activeTab, nil)
    -- Copilot is off by default, so hiding Claude and Codex hides every tab.
    raw = { global = { schema = 1, settings = { tabClaude = false, tabCodex = false } } }
    ok, reason = ns.Persistence.Validate(raw)
    equal(ok, false); equal(reason, "Invalid saved tab settings"); equal(raw.global.settings.tabCopilot, nil)
end)

test("a retired effects preference from the bronze build is kept but never read", function()
    for _, legacy in ipairs({ false, true, 0, "false", {} }) do
        local raw = { global = { schema = 1, effectsEnabled = legacy, probe = { retained = "yes" } } }
        equal(ns.Persistence.Validate(raw), true)
        ns.Persistence.Initialize(raw.global)
        local c = ns.Core.New(raw.global, { UINonce = function() return "abcdef02" end })
        equal(c:Snapshot().effectsEnabled, nil); equal(raw.global.effectsEnabled, legacy)
        equal(raw.global.probe.retained, "yes")
    end
end)

test("opacity preference survives reconstruction without changing legacy data", function()
    for _, opacity in ipairs({ 0, 25, 65, 100 }) do
        local raw = { global = { schema = 1, opacity = opacity, probe = { retained = "yes" } } }
        equal(ns.Persistence.Validate(raw), true)
        ns.Persistence.Initialize(raw.global)
        local c = ns.Core.New(raw.global, { UINonce = function() return "abcdef02" end })
        equal(c:Snapshot().opacity, opacity)
        equal(raw.global.probe.retained, "yes")
    end
    for _, opacity in ipairs({ -1, 101, 1.5, math.huge, "65", false }) do
        local raw = { global = { opacity = opacity, precious = "retain" } }
        equal(ns.Persistence.Validate(raw), false)
        equal(raw.global.opacity, opacity); equal(raw.global.precious, "retain")
        equal(raw.global.schema, nil)
    end
end)

test("vendored AceDB preserves explicit schema, probe fields and queued intent on logout cleanup", function()
    local raw = { global = { schema = 1, probe = { logins = 2 }, outbox = {} } }
    local env = setmetatable({ WitchcraftDB = raw }, { __index = _G })
    env._G = env
    local frame = { RegisterEvent = function() end }
    function frame:SetScript(name, callback) self[name] = callback end
    env.CreateFrame = function() return frame end
    env.GetRealmName = function() return "Test Realm" end
    env.UnitName = function() return "Test Player" end
    env.UnitClass = function() return "Warrior", "WARRIOR" end
    env.UnitRace = function() return "Human", "HUMAN" end
    env.UnitFactionGroup = function() return "Alliance" end
    env.GetLocale = function() return "enUS" end
    env.GetCurrentRegion = function() return 1 end
    env.GetCurrentRegionName = function() return "US" end
    env.strlenutf8 = string.len
    setfenv(assert(loadfile("Witchcraft/Libs/LibStub/LibStub.lua")), env)()
    setfenv(assert(loadfile("Witchcraft/Libs/AceDB-3.0/AceDB-3.0.lua")), env)()
    local database = env.LibStub("AceDB-3.0"):New("WitchcraftDB", { global = {} }, true)
    ns.Persistence.Initialize(database.global)
    local c, state = ns.TestControllerFixture(database.global)
    state:Accept()
    equal(c.sessions[1].lines[1], "one")
    equal(database.global.sessions, nil); equal(database.global.cols, nil); equal(database.global.rows, nil)
    database.global.outbox[1] = { id = 1, epoch = "1234abcd", tab = "codex", action = "text", text = "keep until ack" }
    database.global.nextId = 2
    assert(c:SetOpacity(25))
    frame.OnEvent(frame, "PLAYER_LOGOUT")
    equal(raw.global.schema, 1); equal(raw.global.probe.logins, 2)
    equal(raw.global.opacity, 25)
    equal(raw.global.outbox[1].text, "keep until ack"); equal(raw.global.nextId, 2)
    equal(raw.global.sessions, nil); equal(raw.global.cols, nil); equal(raw.global.rows, nil)
    equal(ns.Persistence.Validate(raw), true)
end)

test("persistence malformed and newer schemas remain entirely unmodified", function()
    local bad = {
        false, 4, "raw", { global = 3 }, { global = { schema = 2, precious = "keep" } }, { profiles = "bad" },
        { global = { schema = 0 } }, { global = { view = { width = 0 } } },
        { global = { nextId = 0 } }, { global = { ack = -1 } }, { global = { epoch = "00000000" } },
        { global = { outbox = { [2] = {} } } },
    }
    for _, value in ipairs(bad) do
        local before = clone(value)
        equal(ns.Persistence.Validate(value), false); same(value, before)
    end
end)

test("terminal screens stay ephemeral while legacy cache fields remain untouched", function()
    local legacy = { sessions = { privateLegacy = "preserve existing bytes" }, cols = 999, rows = 999 }
    equal(ns.Persistence.Validate({ global = legacy }), true)
    local old = legacy.sessions
    local c, state = ns.TestControllerFixture(legacy)
    equal(#c.sessions[1].lines, 0); equal(c.cols, 120); equal(c.rows, 40)
    state:Accept({ cols = 80, rows = 30 })
    equal(c.sessions[2].lines[1], "three"); equal(c.cols, 80)
    equal(legacy.sessions, old); equal(legacy.cols, 999); equal(legacy.rows, 999)
    equal(legacy.sessions.privateLegacy, "preserve existing bytes")
    local reopened = ns.TestControllerFixture(legacy)
    equal(#reopened.sessions[1].lines, 0)
end)

test("persistence validates message bounds, ordering and terminal routing before defaults", function()
    local message = { id = 7, epoch = "abcdefab", tab = "codex", action = "text", text = "persist on reload" }
    local good = { global = { schema = 1, outbox = { message }, ack = 2, nextId = 8 } }
    equal(ns.Persistence.Validate(good), true)
    local bad = clone(good); bad.global.nextId = 7; equal(ns.Persistence.Validate(bad), false)
    bad = clone(good); bad.global.outbox[2] = clone(message); equal(ns.Persistence.Validate(bad), false)
    bad = clone(good); bad.global.outbox[1].text = string.rep("x", 601); equal(ns.Persistence.Validate(bad), false)
    bad = clone(good); bad.global.outbox[1].tab = "other"; equal(ns.Persistence.Validate(bad), false)
    bad = clone(good); bad.global.outbox[1].action = "execute"; equal(ns.Persistence.Validate(bad), false)
    bad = clone(good); bad.global.outbox[1].text = "\27"; equal(ns.Persistence.Validate(bad), false)
    bad = clone(good); bad.global.outbox[1].text = "\255"; equal(ns.Persistence.Validate(bad), false)
    bad = clone(good); bad.global.outbox[2] = clone(message); bad.global.outbox[2].id = 6
    equal(ns.Persistence.Validate(bad), false)
    bad = clone(good); bad.profileKeys = { ["Player - Realm"] = {} }; equal(ns.Persistence.Validate(bad), false)
    bad = clone(good); bad.profiles = { Default = "broken" }; equal(ns.Persistence.Validate(bad), false)
    local initialized = ns.Persistence.Initialize({ outbox = { message } })
    equal(initialized.nextId, 8)
    local c = ns.TestControllerFixture(initialized)
    equal(c.connected, false); equal(#c.global.outbox, 1); equal(c.ring.nextSeq, 1)
end)

test("AceAddon checks raw database before constructing AceDB", function()
    local function bootstrap(saved)
        local env = setmetatable({ WitchcraftDB = saved }, { __index = _G })
        env._G = env
        local state = { newCalls = 0, messages = {} }
        local addon = {}
        function addon:RegisterChatCommand() end
        function addon:Print(message) state.messages[#state.messages + 1] = message end
        local aceAddon = { NewAddon = function() return addon end }
        local aceDB = { New = function(_, name)
            equal(name, "WitchcraftDB")
            state.newCalls = state.newCalls + 1
            env.WitchcraftDB = env.WitchcraftDB or {}
            env.WitchcraftDB.global = env.WitchcraftDB.global or {}
            return { global = env.WitchcraftDB.global }
        end }
        env.LibStub = function(name)
            if name == "AceAddon-3.0" then return aceAddon end
            if name == "AceDB-3.0" then return aceDB end
            error("unexpected library")
        end
        local isolated = { Ring = ns.Ring, Pixel = ns.Pixel }
        setfenv(assert(loadfile("Witchcraft/Core.lua")), env)("Witchcraft", isolated)
        addon:OnInitialize()
        return addon, state, env
    end
    for _, raw in ipairs({ "preserve scalar", { global = { schema = 8, future = "retain" } } }) do
        local before = clone(raw)
        local addon, state, env = bootstrap(raw)
        equal(state.newCalls, 0); equal(addon.controller, nil); same(env.WitchcraftDB, before)
        equal(env.Witchcraft_ReceiveChunk(ns.TestPayload()), false)
    end
    local addon, state, env = bootstrap({ global = { schema = 1, probe = { logins = 2 } } })
    -- The controller queues terminal input, so it is never reachable from the public addon object.
    equal(state.newCalls, 1); equal(addon.controller, nil)
    equal(env.WitchcraftDB.global.probe.logins, 2); equal(env.WitchcraftDB.global.nextId, 1)
end)
