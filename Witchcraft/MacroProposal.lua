local _, ns = ...
local MacroProposal = {}
ns.MacroProposal = MacroProposal

local dialog, current

local function validate(proposal)
    if type(proposal) ~= "table" or type(proposal.id) ~= "string" or proposal.id == "" then return "Invalid macro suggestion." end
    local name, body = proposal.name, proposal.body
    if type(name) ~= "string" or #name > 16 or not name:find("%S") then return "Macro names must fit in 1 to 16 UTF-8 bytes." end
    if type(body) ~= "string" or #body > 255 or not body:find("%S") then return "Macro text must fit in 1 to 255 UTF-8 bytes." end
    if not ns.Pixel.ValidDisplayText(name) or not ns.Pixel.ValidDisplayText(body, true) then
        return "The macro contains invalid UTF-8 or hidden control characters."
    end
end

local function available(proposal)
    if type(_G.InCombatLockdown) ~= "function" or type(_G.GetCursorInfo) ~= "function" or type(_G.GetNumMacros) ~= "function"
        or type(_G.GetMacroIndexByName) ~= "function" or type(_G.CreateMacro) ~= "function" or type(_G.PickupMacro) ~= "function" then
        return "The macro or cursor API is unavailable."
    end
    if _G.InCombatLockdown() then return "Leave combat to create a macro." end
    if _G.GetCursorInfo() ~= nil then return "Empty your cursor before creating a macro." end
    if (_G.GetMacroIndexByName(proposal.name) or 0) > 0 then return "A macro with that name already exists." end
    local _, characters = _G.GetNumMacros()
    local limits = _G.Constants and _G.Constants.MacroConsts
    if type(characters) ~= "number" or not limits or type(limits.MAX_CHARACTER_MACROS) ~= "number" then
        return "The character macro limit is unavailable."
    end
    if characters >= limits.MAX_CHARACTER_MACROS then return "Your character macro slots are full." end
end

function MacroProposal.Hide()
    current = nil
    if dialog then dialog:Hide() end
end

local function accept(review)
    if current ~= review or review.committed then return end
    local problem = available(review)
    if problem then dialog.status:SetText(problem); return end

    -- A second click or a synchronous UPDATE_MACROS must never create a second copy.
    review.committed = true
    dialog.accept:Disable()
    local created, index = pcall(_G.CreateMacro, review.name, 134400, review.body, true)
    if current ~= review then return end
    if not created or type(index) ~= "number" or index <= 0 then
        dialog.status:SetText("WoW could not confirm creation. Check your character macros in /macro.")
        return
    end
    -- Another addon's UPDATE_MACROS handler can change the cursor during creation.
    if not _G.InCombatLockdown() and _G.GetCursorInfo() == nil and pcall(_G.PickupMacro, index) then
        if current ~= review then return end
        local kind, macroIndex = _G.GetCursorInfo()
        if kind == "macro" and macroIndex == index then MacroProposal.Hide(); return end
    end
    dialog.status:SetText("Macro saved. Open /macro to place it on your action bar.")
end

local function makeDialog()
    local frame = CreateFrame("Frame", "WitchcraftMacroReview", UIParent)
    frame:Hide()
    frame:SetAllPoints(UIParent)
    frame:SetFrameStrata("FULLSCREEN_DIALOG")
    frame:EnableMouse(true)
    if _G.UISpecialFrames then table.insert(_G.UISpecialFrames, "WitchcraftMacroReview") end

    local panel = CreateFrame("Frame", nil, frame)
    panel:SetSize(math.min(470, UIParent:GetWidth() - 12), math.min(320, UIParent:GetHeight() - 12))
    panel:SetPoint("CENTER")
    local background = panel:CreateTexture(nil, "BACKGROUND")
    background:SetAllPoints()
    background:SetColorTexture(0.06, 0.06, 0.06, 0.98)
    local title = panel:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge")
    title:SetPoint("TOPLEFT", 16, -14)
    title:SetText("Review character macro")

    frame.name = panel:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
    frame.name:SetPoint("TOPLEFT", 16, -44)
    local scroll = CreateFrame("ScrollFrame", nil, panel, "UIPanelScrollFrameTemplate")
    scroll:SetPoint("TOPLEFT", 16, -68)
    scroll:SetPoint("BOTTOMRIGHT", -38, 78)
    local content = CreateFrame("Frame", nil, scroll)
    content:SetSize(panel:GetWidth() - 54, 1)
    local body = content:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
    body:SetPoint("TOPLEFT")
    body:SetWidth(content:GetWidth())
    body:SetJustifyH("LEFT")
    body:SetWordWrap(true)
    body:SetNonSpaceWrap(true)
    scroll:SetScrollChild(content)
    frame.scroll, frame.content, frame.body = scroll, content, body

    frame.status = panel:CreateFontString(nil, "OVERLAY", "GameFontNormal")
    frame.status:SetPoint("BOTTOMLEFT", 16, 40)
    frame.status:SetPoint("BOTTOMRIGHT", -16, 40)
    frame.status:SetJustifyH("LEFT")
    frame.accept = CreateFrame("Button", nil, panel, "UIPanelButtonTemplate")
    frame.accept:SetSize(146, 24)
    frame.accept:SetPoint("BOTTOMLEFT", 16, 10)
    frame.accept:SetText("Create & pick up")
    local close = CreateFrame("Button", nil, panel, "UIPanelButtonTemplate")
    close:SetSize(70, 24)
    close:SetPoint("BOTTOMRIGHT", -16, 10)
    close:SetText("Close")
    close:SetScript("OnClick", MacroProposal.Hide)
    frame:SetScript("OnHide", function()
        current = nil
        frame.accept:SetScript("OnClick", nil)
    end)
    return frame
end

function MacroProposal.Show(proposal)
    MacroProposal.Hide()
    local problem = validate(proposal)
    if problem then return false, problem end
    if type(CreateFrame) ~= "function" or not UIParent then return false, "The macro review window is unavailable." end
    dialog = dialog or makeDialog()
    -- The player confirms the exact strings displayed, even if the caller changes its table later.
    local review = { name = proposal.name, body = proposal.body }
    current = review
    dialog.name:SetText("Name: " .. review.name:gsub("|", "||"))
    dialog.body:SetText((review.body:gsub("|", "||")))
    dialog.accept:Enable()
    dialog.accept:SetScript("OnClick", function() accept(review) end)
    dialog.status:SetText(available(review) or "Creates a character macro. Click an action bar slot to place it.")
    dialog:Show()
    dialog.content:SetHeight(math.max(1, dialog.body:GetStringHeight() + 4))
    dialog.scroll:SetVerticalScroll(0)
    return true
end
