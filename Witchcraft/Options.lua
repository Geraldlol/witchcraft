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
    { key = "windowScale", label = "Window scale (%)", kind = "slider", min = 80, max = 140, step = 5,
      tooltip = "Scale the entire Witchcraft window from 80% to 140% without changing the top-left calibration strip." },
    { key = "idleFade", label = "Fade when unfocused",
      tooltip = "Dim the window while your mouse is outside and no text box or panel is open." },
    { key = "combatWindow", label = "Window in combat", kind = "choice",
      tooltip = "Keep the window as it is, collapse it to its title bar, or hide it automatically during combat and restore it after.",
      choices = { { "keep", "Keep open" }, { "minimize", "Minimize in combat" }, { "hide", "Hide in combat" } } },
    { key = "locked", label = "Lock position", tooltip = "No dragging or resizing." },
    { key = "docked", label = "Dock at top of screen", tooltip = "Keep the window at the top centre of the screen; it stays locked while docked." },
    { key = "escapeCloses", label = "Escape closes Witchcraft", tooltip = "Off by default: any Escape in the game world would otherwise close the window." },
    { key = "openOnLoad", label = "Open on login and reload", tooltip = "Show the window when the interface loads." },
    { key = "minimap", label = "Minimap button", tooltip = "Show the book button at the edge of the minimap; drag it around the rim to reposition." },
    { section = "Tabs" },
    { key = "tabClaude", label = "Claude tab", tooltip = "Show the Claude tab. A hidden tab is skipped when cycling; at least one tab stays visible." },
    { key = "tabCodex", label = "Codex tab", tooltip = "Show the Codex tab. A hidden tab is skipped when cycling; at least one tab stays visible." },
    { key = "tabCopilot", label = "Copilot tab",
      tooltip = "Show the Copilot tab. Off until the daemon starts Copilot, which switches it on;"
          .. " a hidden tab is skipped when cycling and at least one tab stays visible." },
    { key = "tabAgy", label = "AGY tab",
      tooltip = "Show the AGY (Antigravity CLI) tab. Off until the daemon starts AGY, which switches it on;"
          .. " a hidden tab is skipped when cycling and at least one tab stays visible." },
    { section = "Alerts" },
    { key = "alertText", label = "Alert message", tooltip = "Say which agent needs you or finished, while you look elsewhere." },
    { key = "alertChannel", label = "Alert message style", kind = "choice",
      tooltip = "Where alert messages appear when an agent needs you or finishes.",
      choices = { { "raid", "Raid warning banner" }, { "chat", "Chat window" } } },
    { key = "alertSound", label = "Alert sound", tooltip = "Play a sound with an alert." },
    { key = "alertSoundStyle", label = "Alert sound effect", kind = "choice",
      tooltip = "Which client sound plays when an alert fires.",
      choices = { { "raid", "Raid warning" }, { "ready", "Ready check" }, { "tell", "Whisper" }, { "ping", "Map ping" } } },
    { key = "alertFinished", label = "Alert when an agent finishes", tooltip = "Off: alert only when an agent needs you." },
    { section = "Terminal" },
    { key = "combatUpdates", label = "Keep updating in combat",
      tooltip = "Keep loading terminal updates during combat. Loading can cause brief frame hitches in a fight. Prompts you send always go out." },
    { key = "autoBindProbe", label = "Probe binding carrier on connect",
      tooltip = "Automatically run /witch bindprobe outside combat once per host session." },
    { key = "fileLane", label = "File lane to the daemon", kind = "choice",
      tooltip = "How prompts leave the game when the strip does not carry them. A change applies at the next /reload."
          .. " The client log grows by about 45 MB an hour while idle.",
      choices = { { "binding", "Key binding (default)" }, { "log", "Client log (works in combat and in the background)" } } },
    { key = "stripMode", label = "Top-left pixel strip", kind = "choice",
      tooltip = "When to draw the 132x12 optical strip in the top-left corner. Fallback hides it only while the file lane"
          .. " (log or key binding) can carry prompts. Off never draws it and refuses prompts while that link is not ready."
          .. " Calibration always shows it.",
      choices = { { "always", "Always visible" }, { "fallback", "Fallback (hide while the file link carries prompts)" },
          { "off", "Off (refuse prompts while the file link is not ready)" } } },
    { key = "hz", label = "Terminal update rate (Hz)", kind = "slider", min = 0.25, max = 2, step = 0.25,
      tooltip = "How many times per second Witchcraft checks for new terminal output while active. Lower rates save chunk slots." },
    { key = "autoFitCols", label = "Auto-fit columns when resizing",
      tooltip = "Automatically resize the desktop terminal's column width to match the window when you finish dragging the resize corner." },
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
    elseif key == "hz" then
        return function() return controller.global.hz end, function(value) controller:SetHz(value) end
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
            local default = row.key == "fontSize" and 10 or row.key == "opacity" and 80 or row.key == "hz" and 1
                or row.key == "contextEnabled" and true or ns.Settings[row.key].default
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
