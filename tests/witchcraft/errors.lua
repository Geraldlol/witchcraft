local ns, test, equal = ...
local Errors = ns.Errors

local function store(overrides)
    local state = { now = 1000 }
    local env = { time = function() return state.now end }
    for key, value in pairs(overrides or {}) do env[key] = value end
    return Errors.New(env), state
end

test("the handler records, then hands the same error to the previous handler", function()
    local s = store({ debugstack = function() return "[Interface/AddOns/Hello/Hello.lua]:12: in function 'Boom'\n" end })
    local handed, installed = {}, nil
    local previous = function(message) handed[#handed + 1] = message; return "previous result" end
    assert(Errors.Install(s, { geterrorhandler = function() return previous end,
        seterrorhandler = function(handler) installed = handler end }))
    equal(installed("Hello.lua:12: attempt to call nil"), "previous result")
    equal(handed[1], "Hello.lua:12: attempt to call nil")
    local entry = s:Newest()[1]
    equal(entry.kind, "error"); equal(entry.message, "Hello.lua:12: attempt to call nil")
    equal(entry.stack[1], "Hello/Hello.lua:12: in function 'Boom'", "the AddOns prefix and brackets are stripped")
end)

test("a failing recorder still chains, and an error raised while recording is dropped", function()
    local s = store({ debugstack = function() error("stack unavailable") end })
    local handed, installed = 0, nil
    assert(Errors.Install(s, { geterrorhandler = function() return function() handed = handed + 1 end end,
        seterrorhandler = function(handler) installed = handler end }))
    installed("first")
    equal(handed, 1, "the previous handler runs even when capture fails")
    equal(#s:Newest(), 1, "the message is kept without a stack")
    s.recording = true
    installed("second")
    equal(handed, 2); equal(#s:Newest(), 1, "re-entrant errors are not recorded")
    s.recording = false
    equal(Errors.Install(s, {}), false, "no handler API means no install")
end)

test("repeats merge by kind, message and first frame, and the store keeps twenty", function()
    local s, state = store()
    s:Record("error", "same", "A.lua:1: in main chunk")
    state.now = 1010
    s:Record("error", "same", "A.lua:1: in main chunk")
    s:Record("error", "same", "B.lua:2: in main chunk")
    s:Record("warning", "same", "A.lua:1: in main chunk")
    local list = s:Newest()
    equal(#list, 3)
    local merged
    for _, entry in ipairs(list) do if entry.kind == "error" and entry.stack[1] == "A.lua:1: in main chunk" then merged = entry end end
    equal(merged.count, 2); equal(merged.first, 1000); equal(merged.last, 1010)
    for index = 1, 25 do state.now = 2000 + index; s:Record("error", "error " .. index) end
    list = s:Newest()
    equal(#list, 20)
    equal(list[1].message, "error 25", "newest first")
    equal(list[20].message, "error 6", "the oldest last-seen entries were evicted")
end)

test("messages and stacks are bounded, cleaned and never split a character", function()
    local s = store()
    local long = string.rep("a", 239) .. "\195\169" .. string.rep("b", 50)
    s:Record("error", "|cffff0000red|r |Hitem:1|h[Sword]|h\tend")
    s:Record("error", long, string.rep("Interface/AddOns/X/Deep.lua:1: in function 'f'\n", 6))
    local list = s:Newest()
    equal(list[2].message, "red [Sword] end")
    equal(#list[1].message, 239, "a two-byte character that would cross 240 bytes is left out")
    assert(#list[1].stack <= 3)
    local total = 0
    for _, frame in ipairs(list[1].stack) do total = total + #frame; assert(not frame:find("Interface/AddOns/", 1, true)) end
    assert(total <= 200)
end)

test("unreadable messages and blocked-action events are recorded without their values", function()
    local secret = {}
    local s = store({ IsSecret = function(value) return value == secret end })
    s:Record("error", secret)
    equal(s:Newest()[1].message, "<unreadable>")
    s:Event("ADDON_ACTION_BLOCKED", "SomeAddon", "UseAction()")
    equal(s:Newest()[1].kind, "blocked"); equal(s:Newest()[1].message, "SomeAddon called UseAction()")
    s:Event("ADDON_ACTION_FORBIDDEN", secret, "CastSpell()")
    equal(s:Newest()[1].kind, "forbidden"); equal(s:Newest()[1].message, "<unreadable>")
    s:Event("LUA_WARNING", "Frame name clash")
    equal(s:Newest()[1].kind, "warning")
    equal(s:Newest()[1].message, "Frame name clash")
end)

test("errors seen before the database loads merge into it, and reloads are counted", function()
    local s, state = store()
    s:Record("error", "early")
    local global = { errors = { { kind = "error", message = "old", stack = {}, count = 3, first = 10, last = 20, session = 4 } },
        errorSession = 4 }
    s:Attach(global)
    equal(global.errorSession, 5)
    equal(#global.errors, 2, "the buffered error joins the saved one")
    equal(s.session, 5)
    local newest = s:Newest()
    equal(newest[1].message, "early"); equal(newest[1].session, 5)
    equal(newest[2].message, "old"); equal(newest[2].session, 4)
    state.now = 1100
    s:Record("error", "later")
    equal(#global.errors, 3, "after loading, errors go straight to the database")
    s:Clear()
    equal(#global.errors, 0); equal(#s:Newest(), 0)
end)

test("an invalid saved error list is replaced rather than trusted", function()
    for _, bad in ipairs({ "text", { { kind = "nope", message = "x", stack = {}, count = 1, first = 1, last = 1, session = 1 } },
        { { kind = "error", message = "x", stack = {}, count = 0, first = 1, last = 1, session = 1 } },
        { { kind = "error", message = "x", stack = { 1 }, count = 1, first = 1, last = 1, session = 1 } },
        { { kind = "error", message = "x", stack = {}, count = 1, first = 5, last = 1, session = 1 } } }) do
        local s = store()
        local global = { errors = bad, errorSession = "bad" }
        s:Attach(global)
        equal(#global.errors, 0); equal(global.errorSession, 1)
    end
end)
