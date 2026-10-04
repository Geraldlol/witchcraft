local _, ns = ...
local MinimapButton = {}
ns.MinimapButton = MinimapButton

function MinimapButton.Create(onClick)
    local minimap = _G.Minimap
    if not minimap then return end

    -- Keep the launcher outside the terminal's visibility and stream lifecycle.
    local button = CreateFrame("Button", "WitchcraftMinimapButton", minimap)
    button:SetSize(31, 31)
    button:SetPoint("CENTER", minimap, "BOTTOMLEFT", 20, 20)
    button:SetFrameLevel(minimap:GetFrameLevel() + 8)
    button:RegisterForClicks("LeftButtonUp")
    button:SetHighlightTexture("Interface\\Minimap\\UI-Minimap-ZoomButton-Highlight")

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

    local function hideTooltip()
        local tooltip = _G.GameTooltip
        if tooltip and tooltip:IsOwned(button) then tooltip:Hide() end
    end
    button:SetScript("OnClick", function() hideTooltip(); onClick() end)
    button:SetScript("OnEnter", function()
        local tooltip = _G.GameTooltip
        if not tooltip then return end
        tooltip:SetOwner(button, "ANCHOR_LEFT")
        tooltip:SetText("Witchcraft", 1, 1, 1)
        tooltip:AddLine("Left-click to show or hide your terminals.", .8, .8, .8)
        tooltip:Show()
    end)
    button:SetScript("OnLeave", hideTooltip)
    button:SetScript("OnHide", hideTooltip)
    return button
end
