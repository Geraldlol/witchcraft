local ns, test, equal = ...

-- A recording stand-in for the client's Settings API: what the page registers, and the proxies'
-- getters and setters, which must route through the controller.
local function settingsApi()
    local api = { proxies = {}, controls = {}, headers = {}, registered = nil }
    local layout = { AddInitializer = function(_, initializer) api.headers[#api.headers + 1] = initializer end }
    api.Settings = {
        VarType = { Boolean = "boolean", Number = "number", String = "string" },
        RegisterVerticalLayoutCategory = function(name) api.name = name; return { GetID = function() return 77 end }, layout end,
        RegisterProxySetting = function(category, variable, varType, label, default, get, set)
            local proxy = { variable = variable, varType = varType, label = label, default = default, get = get, set = set }
            api.proxies[#api.proxies + 1] = proxy; api.proxies[variable] = proxy
            return proxy
        end,
        CreateCheckbox = function(_, setting, tooltip) api.controls[#api.controls + 1] = { kind = "checkbox", setting = setting, tooltip = tooltip } end,
        CreateSlider = function(_, setting, options, tooltip)
            api.controls[#api.controls + 1] = { kind = "slider", setting = setting, options = options, tooltip = tooltip }
        end,
        CreateSliderOptions = function(min, max, step) return { min = min, max = max, step = step } end,
        CreateDropdown = function(_, setting, options, tooltip)
            api.controls[#api.controls + 1] = { kind = "dropdown", setting = setting, options = options, tooltip = tooltip }
        end,
        CreateControlTextContainer = function()
            local data = {}
            return { Add = function(_, value, label) data[#data + 1] = { value = value, label = label } end, GetData = function() return data end }
        end,
        RegisterAddOnCategory = function(category) api.registered = category end,
    }
    api.CreateSettingsListSectionHeaderInitializer = function(name) return { header = name } end
    return api
end

test("the Options page registers every setting as a proxy through the controller", function()
    local c = ns.TestControllerFixture()
    local api = settingsApi()
    equal(ns.Options.Register(c, api), 77, "the page returns the category the settings panel opens to")
    equal(api.name, "Witchcraft"); assert(api.registered, "the category is registered as an addon page")
    equal(#api.headers, 4); equal(api.headers[1].header, "Window"); equal(api.headers[2].header, "Tabs")
    equal(api.headers[4].header, "Terminal")
    local rows = 0
    for _, row in ipairs(ns.Options.PAGE) do if row.key then rows = rows + 1 end end
    equal(#api.proxies, rows); equal(#api.controls, rows)
    for _, control in ipairs(api.controls) do assert(control.tooltip and control.tooltip ~= "", "every control explains itself") end
    local layer = api.proxies.WITCHCRAFT_LAYER
    equal(layer.varType, "string"); equal(layer.get(), "normal")
    layer.set("top"); equal(c:Setting("layer"), "top", "a change goes through the controller")
    layer.set("sideways"); equal(c:Setting("layer"), "top", "an invalid value is refused by the controller")
    local choices
    for _, control in ipairs(api.controls) do if control.setting == layer then choices = control.options() end end
    equal(#choices, 3); equal(choices[3].value, "back")
    api.proxies.WITCHCRAFT_ESCAPECLOSES.set(true); equal(c:Setting("escapeCloses"), true)
    api.proxies.WITCHCRAFT_WINDOWSCALE.set(125); equal(c:Setting("windowScale"), 125)
    api.proxies.WITCHCRAFT_WINDOWSCALE.set(50); equal(c:Setting("windowScale"), 125, "scale below 80% is refused")
    api.proxies.WITCHCRAFT_IDLEFADE.set(true); equal(c:Setting("idleFade"), true)
    api.proxies.WITCHCRAFT_COMBATWINDOW.set("minimize"); equal(c:Setting("combatWindow"), "minimize")
    api.proxies.WITCHCRAFT_ALERTCHANNEL.set("chat"); equal(c:Setting("alertChannel"), "chat")
    api.proxies.WITCHCRAFT_ALERTSOUNDSTYLE.set("ping"); equal(c:Setting("alertSoundStyle"), "ping")
    api.proxies.WITCHCRAFT_STRIPMODE.set("fallback"); equal(c:Setting("stripMode"), "fallback")
    api.proxies.WITCHCRAFT_HZ.set(0.5); equal(c.global.hz, 0.5); equal(api.proxies.WITCHCRAFT_HZ.get(), 0.5)
    api.proxies.WITCHCRAFT_AUTOFITCOLS.set(true); equal(c:Setting("autoFitCols"), true)
    equal(api.proxies.WITCHCRAFT_HISTORYSIZE.varType, "number")
    api.proxies.WITCHCRAFT_FONTSIZE.set(14); equal(c.global.fontSize, 14, "font size uses the existing controller path")
    api.proxies.WITCHCRAFT_OPACITY.set(35); equal(api.proxies.WITCHCRAFT_OPACITY.get(), 35)
    api.proxies.WITCHCRAFT_CONTEXTENABLED.set(false); equal(c.global.contextEnabled, false)
    equal(ns.Options.Register(c, {}), nil, "a client without the Settings API gets no page and no error")
end)
