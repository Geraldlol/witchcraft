local _, test, equal = ...

-- Run a fresh addon module against a canvas and a delayed Blizzard_WorldMap load.
local function fixture()
    local world = { frames = {}, opens = {}, waypoint = {}, foreignPin = {}, zoom = 1, width = 1000, height = 500 }
    local env = setmetatable({}, { __index = _G })
    env._G = env
    local function frame(kind, _, parent)
        assert(kind == "Frame" and parent == nil)
        local f = { shown = true, scripts = {}, events = {} }
        world.frames[#world.frames + 1] = f
        function f:SetParent(p) self.parent = p end
        function f:Show()
            if not self.shown then self.shown = true; if self.scripts.OnShow then self.scripts.OnShow(self) end end
        end
        function f:Hide()
            if self.shown then self.shown = false; if self.scripts.OnHide then self.scripts.OnHide(self) end end
        end
        function f:SetScript(s, fn) self.scripts[s] = fn end
        function f:RegisterEvent(e) self.events[e] = true end
        function f:UnregisterEvent(e) self.events[e] = nil end
        function f:SetSize() end
        function f:SetFrameLevel() end
        function f:SetAllPoints() end
        function f:ClearAllPoints() self.point = nil end
        function f:SetScale(s) self.scale = s end
        function f:SetPoint(_, canvas, _, x, y) self.point = { canvas, x, y } end
        function f:SetMouseClickEnabled(b) self.click = b end
        function f:SetMouseMotionEnabled(b) self.motion = b end
        function f:CreateTexture() return { SetAllPoints = function() end, SetPoint = function() end, SetColorTexture = function() end } end
        function f:CreateFontString() return { SetPoint = function() end, SetText = function(s, value) s.text = value end } end
        return f
    end
    env.CreateFrame = frame
    local canvas = { GetWidth = function() return world.width end, GetHeight = function() return world.height end,
        GetFrameLevel = function() return 15 end }
    local map = { GetMapID = function() return world.mapID end, GetCanvas = function() return canvas end,
        GetCanvasScale = function() return world.zoom end }
    function world:loadMap(mapID)
        self.mapID, env.WorldMapFrame = mapID, map
        for _, f in ipairs(self.frames) do
            if f.events.ADDON_LOADED then f.scripts.OnEvent(f, "ADDON_LOADED", "Blizzard_WorldMap") end
        end
    end
    function world:tick()
        for _, f in ipairs(self.frames) do if f.shown and f.scripts.OnUpdate then f.scripts.OnUpdate(f, 0.2) end end
    end
    function world:shownPins()
        local list = {}
        for _, f in ipairs(self.frames) do if f.shown and f.number then list[#list + 1] = f end end
        return list
    end
    env.InCombatLockdown = function() return world.combat end
    env.Enum = { InputDeviceInterfaceType = { Gamepad = 1 } }
    env.C_InputInterfaceStyle = { GetCurrentStyle = function() return world.gamepad and 1 or 0 end }
    env.C_Map = {
        GetMapInfo = function(id) if id == 10 or id == 20 then return { mapID = id } end end,
        OpenWorldMap = function(id) world.opens[#world.opens + 1] = id; world:loadMap(id) end,
        SetUserWaypoint = function() error("route replaced player waypoint") end,
        ClearUserWaypoint = function() error("route cleared player waypoint") end,
    }
    local tip = {}
    function tip:IsOwned(pin) return self.owner == pin end
    function tip:SetOwner(pin) self.owner = pin end
    function tip:SetText(text) self.title = text end
    function tip:AddLine(text) self.line = text end
    function tip:Show() self.shown = true end
    function tip:Hide() self.owner, self.shown = nil, false end
    env.GameTooltip, world.tip = tip, tip
    local ns = {}
    setfenv(assert(loadfile("Witchcraft/Pixel.lua")), env)("Witchcraft", ns)
    setfenv(assert(loadfile("Witchcraft/Route.lua")), env)("Witchcraft", ns)
    return ns.Route, world
end

local function proposal()
    return { id = "a", name = "|TQuest|t 矿", points = {
        { mapID = 10, x = 25, y = 0, label = "Départ |Hfoo|h" },
        { mapID = 20, x = 100, y = 50, label = "Arrivée" },
    } }
end

test("explicit route selection opens its first map, displays original stop numbers, and handles zoom and map changes", function()
    local route, w = fixture()
    equal(#w.frames, 0)
    local data = proposal()
    assert(route.Show(data))
    equal(w.opens[1], 10)
    local pin = w:shownPins()[1]
    equal(#w:shownPins(), 1)
    equal(pin.number.text, "1")
    equal(pin.motion, true)
    equal(pin.click, false)
    equal(pin.point[2], 250)
    equal(pin.point[3], 0)
    pin.scripts.OnEnter(pin)
    equal(w.tip.title, "||TQuest||t 矿")
    equal(w.tip.line, "1. Départ ||Hfoo||h")
    data.points[2].label = "Changed after selection"
    w.mapID, w.zoom = 20, 2
    w:tick()
    equal(pin.scale, 0.5)
    equal(pin.point[2], 2000)
    equal(pin.point[3], -500)
    equal(pin.number.text, "2")
    equal(w.tip.shown, false)
    pin.scripts.OnEnter(pin)
    equal(w.tip.line, "2. Arrivée")
    w.mapID = 999
    w:tick()
    equal(#w:shownPins(), 0)
    equal(w.tip.shown, false)
    w.mapID = 10
    w:tick()
    equal(w:shownPins()[1], pin)
end)

test("replacing or clearing a route only affects its owned overlay and preserves an unrelated tooltip", function()
    local route, w = fixture()
    assert(route.Show(proposal()))
    local data = proposal()
    data.points[2].mapID = 10
    assert(route.Show(data))
    equal(#w:shownPins(), 2)
    local allocated = #w.frames
    assert(route.Show(data))
    equal(#w.frames, allocated)
    w.tip:SetOwner(w.foreignPin)
    w.tip:Show()
    route.Clear()
    equal(#w:shownPins(), 0)
    equal(w.tip.owner, w.foreignPin)
    equal(w.tip.shown, true)
    route.Clear()
    assert(route.Show(proposal()))
    equal(#w:shownPins(), 1)
    equal(#w.frames, allocated)
end)

test("combat and gamepad selection wait for a manual map open and a cleared deferred route stays cleared", function()
    for _, mode in ipairs({ "gamepad", "combat" }) do
        local route, w = fixture()
        w[mode] = true
        assert(route.Show(proposal()))
        equal(#w.opens, 0)
        w:loadMap(20)
        equal(w:shownPins()[1].number.text, "2")
        route.Clear()
        equal(#w:shownPins(), 0)
    end
    local route, w = fixture()
    w.combat = true
    assert(route.Show(proposal()))
    route.Clear()
    w:loadMap(10)
    equal(#w:shownPins(), 0)
end)

test("invalid route coordinates, map IDs, text or array shapes leave the current route intact", function()
    local route, w = fixture()
    assert(route.Show(proposal()))
    for _, invalid in ipairs({
        function(p) p.points[1].x = 0/0 end,
        function(p) p.points[1].y = -1 end,
        function(p) p.points[1].mapID = 12 end,
        function(p) p.points[1].label = "a\nb" end,
        function(p) p.points[1] = nil end,
        function(p) p.points[13] = p.points[2] end,
    }) do
        local p = proposal()
        invalid(p)
        equal(route.Show(p), false)
        equal(#w.opens, 1)
        equal(w:shownPins()[1].number.text, "1")
    end
end)
