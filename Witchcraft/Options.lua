local _, ns = ...
local Options = {}
ns.Options = Options

-- Witchcraft's page in the client's Esc > Options > AddOns. Every control is a proxy setting: it
-- reads and writes through the controller, so the page and the slash commands share one set of
-- rules, and the values live only in WitchcraftDB.

-- key, label, tooltip; sections separate the page.
local PAGE = {
    { section = "Window" },
    { key = "layer", label = "Window layer", kind = "choice", tooltip = "Where Witchcraft draws among other windows.",
      choices = { { "top", "Above everything" }, { "normal", "Normal" }, { "back", "Behind other windows" } } },
    { key = "locked", label = "Lock position", tooltip = "No dragging or resizing." },
    { key = "docked", label = "Dock at top of screen", tooltip = "Keep the window at the top centre of the screen; it stays locked while docked." },
    { key = "escapeCloses", label = "Escape closes Witchcraft", tooltip = "Off by default: any Escape in the game world would otherwise close the window." },
    { key = "openOnLoad", label = "Open on login and reload", tooltip = "Show the window when the interface loads." },
    { key = "minimap", label = "Minimap button", tooltip = "Show the book button at the edge of the minimap." },
    { section = "Alerts" },
    { key = "alertText", label = "Raid warning text", tooltip = "Say which agent needs you or finished, while you look elsewhere." },
    { key = "alertSound", label = "Alert sound", tooltip = "Play the raid warning sound with an alert." },
    { key = "alertFinished", label = "Alert when an agent finishes", tooltip = "Off: alert only when an agent needs you." },
    { section = "Terminal" },
    { key = "combatUpdates", label = "Keep updating in combat",
      tooltip = "Keep loading terminal updates during combat. Loading can cause brief frame hitches in a fight. Prompts you send always go out." },
    { key = "showChoices", label = "Choice buttons", tooltip = "Numbered buttons that answer permission prompts and pickers." },
    { key = "showStatus", label = "Model and context in the footer", tooltip = "Show the model and how much context the conversation uses." },
    { key = "historySize", label = "Prompt history", kind = "choice", tooltip = "How many sent prompts Up and Down recall per tab.",
      choices = { { 20, "20 prompts" }, { 50, "50 prompts" }, { 100, "100 prompts" } } },
    { key = "fontSize", label = "Terminal font size", kind = "slider", min = 8, max = 20, step = 1,
      tooltip = "The size of the terminal rows." },
    { key = "opacity", label = "Background opacity", kind = "slider", min = 0, max = 100, step = 5,
      tooltip = "The window background only; text stays fully visible." },
    { key = "contextEnabled", label = "Share WoW context", tooltip = "Share character, quest and progress facts with your desktop agents." },
}
Options.PAGE = PAGE

-- The controller's getters and setters for the keys that are not plain settings.
local function accessors(controller, key)
    if key == "fontSize" then
        return function() return controller.global.fontSize end, function(value) controller:SetFontSize(value) end
    elseif key == "opacity" then
        return function() return controller.global.opacity end, function(value) controller:SetOpacity(value) end
    elseif key == "contextEnabled" then
        return function() return controller.global.contextEnabled == true end, function(value) controller:SetContextEnabled(value) end
    end
    return function() return controller:Setting(key) end, function(value) controller:SetSetting(key, value) end
end

-- Returns the category ID Settings.OpenToCategory takes, or nil on a client without the Settings API.
function Options.Register(controller, api)
    api = api or _G
    local settings = api.Settings
    if type(settings) ~= "table" or type(settings.RegisterVerticalLayoutCategory) ~= "function" then return nil end
    local category, layout = settings.RegisterVerticalLayoutCategory("Witchcraft")
    local types = settings.VarType or { Boolean = "boolean", Number = "number", String = "string" }
    for _, row in ipairs(PAGE) do
        if row.section then
            local header = api.CreateSettingsListSectionHeaderInitializer
            if layout and layout.AddInitializer and header then layout:AddInitializer(header(row.section)) end
        else
            local get, set = accessors(controller, row.key)
            local default = row.key == "fontSize" and 10 or row.key == "opacity" and 80 or row.key == "contextEnabled" and true
                or ns.Settings[row.key].default
            local varType = type(default) == "number" and types.Number or type(default) == "string" and types.String or types.Boolean
            local setting = settings.RegisterProxySetting(category, "WITCHCRAFT_" .. row.key:upper(), varType, row.label, default, get, set)
            if row.kind == "slider" then
                settings.CreateSlider(category, setting, settings.CreateSliderOptions(row.min, row.max, row.step), row.tooltip)
            elseif row.kind == "choice" then
                local choices = row.choices
                settings.CreateDropdown(category, setting, function()
                    local container = settings.CreateControlTextContainer()
                    for _, choice in ipairs(choices) do container:Add(choice[1], choice[2]) end
                    return container:GetData()
                end, row.tooltip)
            else
                settings.CreateCheckbox(category, setting, row.tooltip)
            end
        end
    end
    settings.RegisterAddOnCategory(category)
    return category.GetID and category:GetID() or category.ID
end
