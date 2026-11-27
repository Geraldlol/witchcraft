local _, test, equal = ...

local function fixture()
    local env = setmetatable({}, { __index = _G })
    env._G = env
    local state = { creates = 0, pickups = 0, cursor = nil, count = 0, names = {} }
    local methods = {}
    local function widget()
        return setmetatable({ scripts = {}, enabled = true, shown = true }, { __index = methods })
    end
    local function noop() end
    for _, name in ipairs({ "SetAllPoints", "SetFrameStrata", "EnableMouse", "SetPoint", "SetColorTexture", "SetJustifyH",
        "SetWordWrap", "SetNonSpaceWrap", "SetScrollChild" }) do methods[name] = noop end
    function methods:CreateTexture() return widget() end
    function methods:CreateFontString() return widget() end
    function methods:SetSize(width, height) self.width, self.height = width, height end
    function methods:SetWidth(width) self.width = width end
    function methods:SetHeight(height) self.height = height end
    function methods:GetWidth() return self.width end
    function methods:GetHeight() return self.height end
    function methods:SetText(text) self.text = text end
    function methods:SetVerticalScroll(y) self.scrollY = y end
    function methods:GetStringHeight()
        local _, breaks = self.text:gsub("\n", "")
        return 16 * (breaks + 1)
    end
    function methods:Show() self.shown = true end
    function methods:Hide()
        if not self.shown then return end
        self.shown = false
        if self.scripts.OnHide then self.scripts.OnHide() end
    end
    function methods:Enable() self.enabled = true end
    function methods:Disable() self.enabled = false end
    function methods:SetScript(event, callback) self.scripts[event] = callback end

    env.UIParent = widget()
    env.UIParent:SetSize(900, 640)
    env.UISpecialFrames = {}
    env.CreateFrame = function(kind, name)
        local frame = widget()
        if name == "WitchcraftMacroReview" then state.frame = frame end
        if kind == "Button" then state.lastButton = frame end
        return frame
    end
    env.Constants = { MacroConsts = { MAX_CHARACTER_MACROS = 30 } }
    env.InCombatLockdown = function() return state.combat end
    env.GetCursorInfo = function() return state.cursor, state.cursorID end
    env.GetNumMacros = function() return 0, state.count end
    env.GetMacroIndexByName = function(name) return state.names[name] or 0 end
    env.CreateMacro = function(name, icon, body, character)
        state.creates = state.creates + 1
        state.saved = { name = name, icon = icon, body = body, character = character }
        if state.onCreate then state.onCreate() end
        state.names[name] = 121
        return 121
    end
    env.PickupMacro = function(index)
        state.pickups = state.pickups + 1
        state.cursor, state.cursorID = "macro", index
    end
    local ns = {}
    setfenv(assert(loadfile("Witchcraft/Pixel.lua")), env)("Witchcraft", ns)
    setfenv(assert(loadfile("Witchcraft/MacroProposal.lua")), env)("Witchcraft", ns)
    return ns.MacroProposal, state, env
end

local function proposal(name, body)
    return { id = "request-1", name = name or "Blink", body = body or "/cast Blink" }
end

test("macro preview displays every line literally and saves the reviewed copy only on click", function()
    local api, state = fixture()
    local body = "|Texample:100|t\n" .. string.rep("\n", 80) .. "/say |cffcc0000hello|r"
    local input = proposal("T|rest", body)
    assert(api.Show(input))
    local frame = state.frame
    equal(frame.name.text, "Name: T||rest")
    equal(frame.body.text, (body:gsub("|", "||")))
    assert(frame.content.height > 1000)
    equal(frame.scroll.scrollY, 0)
    equal(state.creates, 0)
    input.body = "/say mutated"
    local click = frame.accept.scripts.OnClick
    click()
    equal(state.saved.body, body)
    equal(state.saved.name, "T|rest")
    equal(state.saved.character, true)
    equal(state.cursorID, 121)
    equal(frame.shown, false)
    click()
    equal(state.creates, 1)
    equal(state.pickups, 1)
end)

test("macro review enforces exact UTF-8 byte limits and rejects malformed or hidden input", function()
    local api, state = fixture()
    local accent = string.char(195, 169)
    assert(api.Show(proposal(accent:rep(8), accent:rep(127) .. "x")))
    equal(#state.frame.body.text, 255)
    for _, invalid in ipairs({
        proposal(accent:rep(8) .. "x"), proposal(nil, accent:rep(128)), proposal("name\n"), proposal(nil, " "),
        proposal(nil, "/say a\0b"), proposal(nil, "/say a\rb"), proposal(nil, "/say\tword"), proposal(nil, string.char(192, 175)),
        proposal(nil, string.char(226, 128, 174)), proposal(nil, string.char(237, 160, 128)), proposal(nil, string.char(240, 159)),
    }) do
        local ok, reason = api.Show(invalid)
        equal(ok, false)
        assert(type(reason) == "string")
        equal(state.frame.shown, false)
    end
end)

test("macro creation checks combat, cursor, clashes, slots and API availability again at the click", function()
    local changes = {
        function(s) s.combat = true end, function(s) s.cursor = "item" end,
        function(s) s.count = 30 end, function(s) s.names.Blink = 1 end,
        function(_, env) env.PickupMacro = false end, function(_, env) env.Constants = false end,
    }
    for _, change in ipairs(changes) do
        local api, state, env = fixture()
        assert(api.Show(proposal()))
        change(state, env)
        state.frame.accept.scripts.OnClick()
        equal(state.creates, 0)
        equal(state.pickups, 0)
        assert(state.frame.status.text ~= "")
        assert(state.frame.shown)
    end
end)

test("a cancelled, superseded or externally hidden macro review cannot be confirmed", function()
    local api, state = fixture()
    api.Hide()
    assert(api.Show(proposal()))
    local old = state.frame.accept.scripts.OnClick
    assert(api.Show(proposal("Renew", "/cast Renew")))
    old()
    equal(state.creates, 0)
    local second = state.frame.accept.scripts.OnClick
    state.lastButton.scripts.OnClick()
    api.Hide()
    second()
    equal(state.creates, 0)
    assert(api.Show(proposal()))
    local last = state.frame.accept.scripts.OnClick
    state.frame:Hide()
    last()
    equal(state.pickups, 0)
end)

test("a failed creation or pickup is visible and cannot create twice or replace the cursor", function()
    local changes = {
        function(_, env) env.CreateMacro = function() error("native error") end end,
        function(s) s.onCreate = function() s.cursor = "item" end end,
        function(_, env) env.PickupMacro = function() error("pickup denied") end end,
        function(s) s.onCreate = function() s.combat = true end end,
        function(_, env) env.PickupMacro = function() end end,
    }
    for _, change in ipairs(changes) do
        local api, state, env = fixture()
        change(state, env)
        assert(api.Show(proposal()))
        local click = state.frame.accept.scripts.OnClick
        click()
        click()
        equal(state.frame.accept.enabled, false)
        assert(state.frame.status.text:find("/macro", 1, true))
        assert(state.creates <= 1)
        equal(state.pickups, 0)
    end
end)

test("macro update callbacks can cancel the review before pickup", function()
    local api, state = fixture()
    assert(api.Show(proposal()))
    state.onCreate = function()
        state.frame.accept.scripts.OnClick()
        api.Hide()
    end
    state.frame.accept.scripts.OnClick()
    equal(state.creates, 1)
    equal(state.pickups, 0)
    equal(state.frame.shown, false)
end)
