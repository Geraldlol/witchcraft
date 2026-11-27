local _, ns = ...
local Route = {}
ns.Route = Route

local active, layer, canvas, listener
local pins = {}
local lastMap, lastWidth, lastHeight, lastScale

local function validText(text)
    return type(text) == "string" and #text <= 256 and text:find("%S") and ns.Pixel.ValidDisplayText(text)
end

local function percent(value)
    return type(value) == "number" and value >= 0 and value <= 100
end

-- Copy the player's selection. Later proposals (or a new terminal epoch) cannot change the active route.
local function readRoute(proposal)
    if type(proposal) ~= "table" or not validText(proposal.id) or not validText(proposal.name)
        or type(proposal.points) ~= "table" then return nil, "Invalid route." end
    local count = 0
    for index in pairs(proposal.points) do
        if type(index) ~= "number" or index < 1 or index > 12 or index ~= math.floor(index) then
            return nil, "A route must have 1 to 12 ordered stops."
        end
        count = count + 1
    end
    if count == 0 then return nil, "The route has no stops." end
    if not C_Map or not C_Map.GetMapInfo then return nil, "Map information is unavailable." end
    local route = { name = proposal.name:gsub("|", "||"), points = {} }
    for i = 1, count do
        local point = proposal.points[i]
        if type(point) ~= "table" or type(point.mapID) ~= "number" or point.mapID < 1 or point.mapID > 2147483647
            or point.mapID ~= math.floor(point.mapID) or not percent(point.x) or not percent(point.y) or not validText(point.label) then
            return nil, "Invalid route stop " .. i .. "."
        end
        local ok, info = pcall(C_Map.GetMapInfo, point.mapID)
        if not ok or not info then return nil, "Unknown map at stop " .. i .. "." end
        route.points[i] = { mapID = point.mapID, x = point.x, y = point.y, label = point.label:gsub("|", "||") }
    end
    return route
end

local function releaseTooltip(pin)
    local tip = _G.GameTooltip
    if tip and tip:IsOwned(pin) then tip:Hide() end
end

local function enterPin(pin)
    local tip = _G.GameTooltip
    if not active or not pin.label or not tip then return end
    tip:SetOwner(pin, "ANCHOR_RIGHT")
    tip:SetText(active.name)
    tip:AddLine(pin.label, 1, 1, 1, true)
    tip:Show()
end

local function newPin()
    -- The Forever gamepad UI hooks CreateFrame with a parent and scans map buttons. Use a
    -- passive Frame, parent it afterwards, and leave the map's providers and waypoint alone.
    local pin = CreateFrame("Frame")
    pin:SetParent(layer)
    pin:SetSize(22, 22)
    local border = pin:CreateTexture(nil, "BACKGROUND")
    border:SetAllPoints()
    border:SetColorTexture(0.95, 0.76, 0.32, 1)
    local fill = pin:CreateTexture(nil, "BORDER")
    fill:SetPoint("TOPLEFT", 1, -1)
    fill:SetPoint("BOTTOMRIGHT", -1, 1)
    fill:SetColorTexture(0.13, 0.08, 0.19, 0.96)
    pin.number = pin:CreateFontString(nil, "OVERLAY", "GameFontNormal")
    pin.number:SetPoint("CENTER")
    pin:SetScript("OnEnter", enterPin)
    pin:SetScript("OnLeave", releaseTooltip)
    pin:SetScript("OnHide", releaseTooltip)
    pin:SetMouseClickEnabled(false)
    pin:SetMouseMotionEnabled(true)
    return pin
end

local function draw(force)
    if not active then return end
    local map = WorldMapFrame
    local mapID, width, height = map:GetMapID(), canvas:GetWidth(), canvas:GetHeight()
    local scale = map:GetCanvasScale() or 1
    if scale <= 0 then scale = 1 end
    if not force and mapID == lastMap and width == lastWidth and height == lastHeight and scale == lastScale then return end
    lastMap, lastWidth, lastHeight, lastScale = mapID, width, height, scale
    local used = 0
    for index, point in ipairs(active.points) do
        if point.mapID == mapID and width > 0 and height > 0 then
            used = used + 1
            local pin = pins[used] or newPin()
            pins[used] = pin
            releaseTooltip(pin)
            pin.label = index .. ". " .. point.label
            pin.number:SetText(tostring(index))
            pin:SetScale(1 / scale)
            pin:ClearAllPoints()
            pin:SetPoint("CENTER", canvas, "TOPLEFT", point.x * width * scale / 100, -point.y * height * scale / 100)
            pin:Show()
        end
    end
    for i = used + 1, #pins do pins[i].label = nil; pins[i]:Hide() end
end

local function attach()
    local map = WorldMapFrame
    if not map or not map.GetCanvas then return false end
    local nextCanvas = map:GetCanvas()
    if not nextCanvas then return false end
    if listener then listener:UnregisterEvent("ADDON_LOADED") end
    if not layer then
        layer = CreateFrame("Frame")
        layer:SetScript("OnShow", function() draw(true) end)
        local elapsed = 0
        layer:SetScript("OnUpdate", function(_, dt)
            elapsed = elapsed + dt
            if elapsed >= 0.1 then elapsed = 0; draw(false) end
        end)
    end
    if canvas ~= nextCanvas then
        canvas = nextCanvas
        layer:SetParent(canvas)
        layer:SetAllPoints(canvas)
        layer:SetFrameLevel(canvas:GetFrameLevel() + 30)
    end
    layer:Show()
    draw(true)
    return true
end

function Route.Show(proposal)
    local route, reason = readRoute(proposal)
    if not route then return false, reason end
    active = route
    if not attach() then
        if not listener then
            listener = CreateFrame("Frame")
            listener:SetScript("OnEvent", function(_, _, name)
                if active and name == "Blizzard_WorldMap" then attach() end
            end)
        end
        listener:RegisterEvent("ADDON_LOADED")
    end
    -- Opening the map from addon code can taint the Gamepad interface's focus/close
    -- path. The same passive layer appears when the player opens their map normally.
    local style = _G.C_InputInterfaceStyle
    local gamepad = style and Enum and Enum.InputDeviceInterfaceType and style.GetCurrentStyle() == Enum.InputDeviceInterfaceType.Gamepad
    if not gamepad and not (InCombatLockdown and InCombatLockdown()) and C_Map.OpenWorldMap then
        if pcall(C_Map.OpenWorldMap, route.points[1].mapID) then
            attach()
            return true, "Route active. Hover a numbered stop for its label."
        end
    end
    return true, "Route active. Open the world map to see its numbered stops."
end

function Route.Clear()
    active = nil
    if listener then listener:UnregisterEvent("ADDON_LOADED") end
    if layer then layer:Hide() end
    for _, pin in ipairs(pins) do pin.label = nil; pin:Hide() end
    return true
end
