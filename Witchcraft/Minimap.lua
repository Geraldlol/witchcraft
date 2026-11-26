local _, ns = ...
local MinimapButton = {}
ns.MinimapButton = MinimapButton

local RADIUS = 80
local DEFAULT_ANGLE = 225

local function normalizeAngle(angle)
    if type(angle) ~= "number" or angle ~= angle or angle == math.huge or angle == -math.huge then
        return DEFAULT_ANGLE
    end
    return angle % 360
end

function MinimapButton.Create(onClick, options)
    local minimap = _G.Minimap
    if not minimap then return end
    options = options or {}

    -- Keep the launcher outside the terminal's visibility and stream lifecycle.
    local button = CreateFrame("Button", "WitchcraftMinimapButton", minimap)
    button:SetSize(31, 31)
    button:SetFrameLevel(minimap:GetFrameLevel() + 8)
    button:RegisterForClicks("LeftButtonUp")
    button:RegisterForDrag("LeftButton")
    button:SetHighlightTexture("Interface\\Minimap\\UI-Minimap-ZoomButton-Highlight")

    function button:SetAngle(angle)
        self.angle = normalizeAngle(angle)
        local radians = math.rad(self.angle)
        self:ClearAllPoints()
        self:SetPoint("CENTER", minimap, "CENTER", math.cos(radians) * RADIUS, math.sin(radians) * RADIUS)
    end
    button:SetAngle(options.angle)

    local background = button:CreateTexture(nil, "BACKGROUND")
    background:SetSize(20, 20)
    background:SetPoint("TOPLEFT", 7, -5)
    background:SetTexture("Interface\\Minimap\\UI-Minimap-Background")

    local icon = button:CreateTexture(nil, "ARTWORK")
    icon:SetSize(17, 17)
    icon:SetPoint("TOPLEFT", 7, -6)
    icon:SetTexture("Interface\\Icons\\INV_Misc_Book_09")
    icon:SetTexCoord(.05, .95, .05, .95)

    local border = button:CreateTexture(nil, "OVERLAY")
    border:SetSize(53, 53)
    border:SetPoint("TOPLEFT")
    border:SetTexture("Interface\\Minimap\\MiniMap-TrackingBorder")

    local function cursorAngle()
        local cursor = _G.GetCursorPosition
        if type(cursor) ~= "function" or not minimap.GetCenter then return nil end
        local cx, cy = cursor()
        local mx, my = minimap:GetCenter()
        local scale = minimap.GetEffectiveScale and minimap:GetEffectiveScale() or 1
        if not (cx and cy and mx and my and scale and scale > 0) then return nil end
        return normalizeAngle(math.deg(math.atan2(cy / scale - my, cx / scale - mx)))
    end

    local function hideTooltip()
        local tooltip = _G.GameTooltip
        if tooltip and tooltip:IsOwned(button) then tooltip:Hide() end
    end

    local function stopDrag()
        if not button.dragging then return end
        button.dragging = nil
        button:SetScript("OnUpdate", nil)
    end

    button:SetScript("OnDragStart", function()
        hideTooltip()
        button.dragging = true
        button:SetScript("OnUpdate", function()
            local angle = cursorAngle()
            if angle then button:SetAngle(angle) end
        end)
    end)
    button:SetScript("OnDragStop", function()
        local angle = cursorAngle()
        if angle then button:SetAngle(angle) end
        stopDrag()
        if options.onAngleChanged then options.onAngleChanged(button.angle) end
    end)
    button:SetScript("OnClick", function() hideTooltip(); onClick() end)
    button:SetScript("OnEnter", function()
        if button.dragging then return end
        local tooltip = _G.GameTooltip
        if not tooltip then return end
        tooltip:SetOwner(button, "ANCHOR_LEFT")
        tooltip:SetText("Witchcraft", 1, 1, 1)
        tooltip:AddLine("Left-click to show or hide; drag to move around the minimap.", .8, .8, .8)
        tooltip:Show()
    end)
    button:SetScript("OnLeave", hideTooltip)
    button:SetScript("OnHide", function() stopDrag(); hideTooltip() end)
    return button
end
