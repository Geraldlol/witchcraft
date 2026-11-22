-- Ordinary-frame geometry and routing evidence for the Witchcraft view; this
-- does not emulate native font rasterization, physical capture, combat
-- behavior or a real terminal.
return function(options)
    options = options or {}
    local saved, keys = {}, { "CreateFrame", "CreateColor", "UIParent", "UISpecialFrames", "WitchcraftTerminalFrame",
        "GetPhysicalScreenSize", "GameTooltip", "NineSliceUtil", "C_Texture", "MenuUtil",
        "RaidNotice_AddMessage", "RaidWarningFrame", "PlaySound", "SOUNDKIT", "ChatFrameUtil", "hooksecurefunc" }
    for _, key in ipairs(keys) do saved[key] = _G[key] end
    local function restore() for _, key in ipairs(keys) do _G[key] = saved[key] end end
    local objects, methods = {}, {}
    local function noop() end
    for _, key in ipairs({ "SetClampedToScreen", "EnableMouse", "RegisterForDrag", "SetTextInsets",
        "SetNonSpaceWrap", "SetAutoFocus", "SetMultiLine", "SetMaxLetters", "RegisterForClicks", "EnableMouseWheel" }) do
        methods[key] = noop
    end
    function methods:SetSize(width, height)
        local changed = width ~= self.width or height ~= self.height
        self.width, self.height = width, height
        if changed and self.scripts.OnSizeChanged then self.scripts.OnSizeChanged(self, width, height) end
    end
    function methods:GetWidth() return self.width end
    function methods:GetHeight() return self.height end
    function methods:GetEffectiveScale() return self.scale or 1 end
    function methods:SetPoint(...) self.points = { { ... } } end
    function methods:GetPoint(index) return unpack(self.points[index]) end
    function methods:ClearAllPoints() self.points, self.allPoints = {}, nil end
    function methods:SetAllPoints(target) self.allPoints = target or self.parent end
    function methods:SetFont(path, size, flags)
        if options.fontFailure and path:find("DejaVu", 1, true) then return false end
        -- The live client raises on a missing file rather than returning false (in-game error, 2026-09-22).
        if path:find("Cinzel", 1, true) then error("FontString:SetFont(): Invalid font asset (" .. path .. "): file not found") end
        self.font, self.fontSize, self.fontFlags = path, size, flags; return true
    end
    function methods:SetTextColor(...) self.textColor = { ... } end
    function methods:SetShadowColor(...) self.shadowColor = { ... } end
    function methods:SetShadowOffset(...) self.shadowOffset = { ... } end
    function methods:SetAlpha() error("opacity must never fade an entire frame or its text") end
    function methods:SetJustifyH(value) self.justifyH = value end
    function methods:SetJustifyV(value) self.justifyV = value end
    function methods:SetWordWrap(value) self.wordWrap = value end
    function methods:SetMaxLines(value) self.maxLines = value end
    function methods:SetMultiLine(value) self.multiLine = value end
    function methods:SetText(value)
        assert(type(value) == "string", "widgets receive only strings")
        local changed = self.text ~= value; self.text = value
        if changed and self.scripts.OnTextChanged then self.scripts.OnTextChanged(self) end
    end
    function methods:GetText() return self.text end
    function methods:HasFocus() return self.focused == true end
    function methods:Insert(value) self:SetText(self.text .. value) end
    function methods:SetColorTexture(...) self.color = { ... }; self.gradient = nil end
    function methods:SetVertexColor(...) self.color = { ... } end
    function methods:SetGradient(orientation, from, to) self.gradient = { orientation, from, to } end
    function methods:SetRotation(value) self.rotation = value end
    function methods:SetTexture(value) self.texture = value end
    function methods:SetTexCoord(...) self.texCoord = { ... } end
    function methods:SetBlendMode(value) self.blendMode = value end
    function methods:SetDrawLayer(layer, sublevel) self.layer, self.sublevel = layer, sublevel end
    function methods:SetDesaturated(value) self.desaturated = value end
    function methods:SetNormalAtlas(value) self.normalAtlas = value end
    function methods:LockHighlight() self.highlightLocked = true end
    function methods:UnlockHighlight() self.highlightLocked = false end
    function methods:SetPushedAtlas(value) self.pushedAtlas = value end
    function methods:SetHighlightAtlas(value, blend) self.highlightAtlas, self.highlightBlend = value, blend end
    function methods:SetBackdrop(value) self.backdrop = value end
    function methods:SetBackdropColor(...) self.backdropColor = { ... } end
    function methods:SetBackdropBorderColor(...) self.borderColor = { ... } end
    function methods:SetFrameStrata(value) self.strata = value end
    function methods:SetFrameLevel(value) self.frameLevel = value end
    function methods:GetFrameLevel() return self.frameLevel or 1 end
    function methods:SetMovable(value) self.movable = value end
    function methods:SetResizable(value) self.resizable = value end
    function methods:SetResizeBounds(...) self.resizeBounds = { ... } end
    function methods:StartMoving() self.moving = true end
    function methods:StartSizing() self.sizing = true end
    function methods:StopMovingOrSizing() self.moving, self.sizing = false, false end
    function methods:SetScript(event, callback) self.scripts[event] = callback end
    function methods:SetOrientation(value) self.orientation = value end
    function methods:SetMinMaxValues(low, high) self.minimum, self.maximum = low, high end
    function methods:SetValueStep(value) self.valueStep = value end
    function methods:SetObeyStepOnDrag(value) self.obeyStep = value end
    function methods:SetValue(value)
        local changed = self.value ~= value; self.value = value
        if self.thumb then
            self.thumb:SetPoint("TOPLEFT", self, "TOPLEFT", math.max(0, self.width - self.thumb.width) * value / 100, 0)
        end
        if changed and self.scripts.OnValueChanged then self.scripts.OnValueChanged(self, value) end
    end
    function methods:GetValue() return self.value end
    function methods:SetFocus() self.focused = true end
    function methods:ClearFocus() self.focused = false end
    function methods:HighlightText(from, to) self.highlighted = { from or 0, to or -1 } end
    function methods:Show()
        local changed = not self.shown; self.shown = true
        if changed and self.scripts.OnShow then self.scripts.OnShow(self) end
    end
    function methods:Hide()
        local changed = self.shown; self.shown = false
        if changed and self.scripts.OnHide then self.scripts.OnHide(self) end
    end
    function methods:IsShown() return self.shown end
    function methods:IsVisible() return self.shown and (not self.parent or self.parent:IsVisible()) end
    local function object(kind, name, parent, layer, sublevel)
        local widget = setmetatable({ kind = kind, widgetName = name, parent = parent, layer = layer, sublevel = sublevel,
            points = {}, scripts = {}, shown = true, width = 0, height = 0, text = "", alpha = 1 }, { __index = methods })
        objects[#objects + 1] = widget; widget.fixtureID = #objects
        if name then _G[name] = widget end
        return widget
    end
    function methods:CreateTexture(name, layer, _, sublevel) return object("Texture", name, self, layer, sublevel) end
    function methods:CreateFontString(name, layer) return object("FontString", name, self, layer) end
    function methods:SetThumbTexture(path)
        self.thumb = object("Texture", nil, self, "ARTWORK"); self.thumb.texture = path
    end
    function methods:GetThumbTexture() return self.thumb end
    _G.CreateFrame = function(kind, name, parent, template)
        assert(template == nil or template == "BackdropTemplate" or template == "UIPanelCloseButton"
            or template == "UIPanelButtonTemplate", "only ordinary frame templates and the stock window and panel buttons")
        return object(kind, name, parent, template)
    end
    _G.CreateColor = function(r, g, b, a) return { r = r, g = g, b = b, a = a } end
    _G.UIParent = object("Frame")
    _G.UIParent:SetSize(options.width or 1366, options.height or 768)
    _G.UIParent.scale = options.scale or 1
    _G.UISpecialFrames, _G.WitchcraftTerminalFrame = {}, nil
    _G.GetPhysicalScreenSize = function() return 1920, 1080 end
    -- The stock nine-slice records what it was asked to apply; noStockFrame models a client without it.
    local stockLayouts = {}
    _G.NineSliceUtil = not options.noStockFrame and {
        ApplyLayoutByName = function(container, name)
            stockLayouts[#stockLayouts + 1] = { container = container, name = name }
            -- Like SetAtlas(name, true): every application restores full-size corners.
            for piece, size in pairs({ TopLeftCorner = 75, TopRightCorner = 75, BottomLeftCorner = 32, BottomRightCorner = 32 }) do
                container[piece] = container[piece] or container:CreateTexture(nil, "OVERLAY")
                container[piece]:SetSize(20, size); container[piece].texCoord = { 0, 1, 0, 1 }
            end
        end,
        GetLayout = function(name)
            return name == "ButtonFrameTemplateNoPortraitMinimizable" and {
                TopLeftCorner = { atlas = "UI-Frame-Metal-CornerTopLeft", y = 16 },
                TopRightCorner = { atlas = "UI-Frame-Metal-CornerTopRightDouble", y = 16 },
                BottomLeftCorner = { atlas = "UI-Frame-Metal-CornerBottomLeft", y = -8 },
                BottomRightCorner = { atlas = "UI-Frame-Metal-CornerBottomRight", y = -8 } } or nil
        end,
    } or nil
    -- The client's context menu, recorded: each open keeps its owner and the entries the generator made.
    local menus = {}
    _G.MenuUtil = { CreateContextMenu = function(owner, generator)
        local menu = { owner = owner, entries = {} }
        local root = {}
        function root:CreateTitle(text) menu.entries[#menu.entries + 1] = { kind = "title", text = text } end
        function root:CreateDivider() menu.entries[#menu.entries + 1] = { kind = "divider" } end
        function root:CreateButton(text, callback)
            local entry = { kind = "button", text = text, callback = callback }
            entry.SetTooltip = function(item, fn) item.tooltip = fn end
            menu.entries[#menu.entries + 1] = entry
            return entry
        end
        generator(owner, root)
        menus[#menus + 1] = menu
        return menu
    end }
    -- The chat link path, and the secure hook the view attaches to it.
    local linkHooks = {}
    _G.ChatFrameUtil = { InsertLink = function() return false end }
    _G.hooksecurefunc = function(target, name, hook)
        assert(target == _G.ChatFrameUtil and name == "InsertLink", "only the chat link path is hooked")
        linkHooks[#linkHooks + 1] = hook
    end
    local function shiftClick(link) for _, hook in ipairs(linkHooks) do hook(link) end end
    local notices, sounds = {}, {}
    _G.RaidWarningFrame, _G.SOUNDKIT = {}, { RAID_WARNING = 8959 }
    _G.RaidNotice_AddMessage = function(frame, line, color) notices[#notices + 1] = { frame = frame, line = line, color = color } end
    _G.PlaySound = function(id) sounds[#sounds + 1] = id end
    -- Atlas sizes are fixture values; only their sum exceeding the bar matters here.
    _G.C_Texture = { GetAtlasInfo = function(atlas)
        return { file = "atlas", width = 20, height = atlas:find("Top", 1, true) and 75 or 32,
            leftTexCoord = 0, rightTexCoord = 1, topTexCoord = 0, bottomTexCoord = 1 }
    end }
    local tip = { shown = false }
    function tip:SetOwner(owner, anchor) self.owner, self.anchor = owner, anchor end
    function tip:SetText(value, r, g, b, alpha, wrap)
        assert(type(value) == "string" and type(r) == "number" and type(g) == "number" and type(b) == "number")
        assert(alpha == nil or type(alpha) == "number", "GameTooltip alpha precedes its wrapping flag")
        assert(wrap == nil or type(wrap) == "boolean", "GameTooltip wrapping is its sixth argument")
        self.text, self.alpha, self.wrap = value, alpha, wrap
    end
    function tip:IsOwned(owner) return self.owner == owner end
    function tip:Show() self.shown = true end
    function tip:Hide() self.shown = false end
    _G.GameTooltip = tip
    local anchor = { TOPLEFT = { 0, 0 }, TOP = { .5, 0 }, TOPRIGHT = { 1, 0 },
        LEFT = { 0, .5 }, CENTER = { .5, .5 }, RIGHT = { 1, .5 },
        BOTTOMLEFT = { 0, 1 }, BOTTOM = { .5, 1 }, BOTTOMRIGHT = { 1, 1 } }
    local function geometry()
        local cache = {}
        local function bounds(widget)
            if cache[widget] then return cache[widget] end
            local parent = widget.parent and bounds(widget.parent) or { x = 0, y = 0, width = 0, height = 0, visible = true }
            local box = { x = parent.x, y = parent.y, width = widget.width, height = widget.height,
                visible = parent.visible and widget.shown }
            cache[widget] = box
            if widget.allPoints then
                local target = bounds(widget.allPoints)
                box.x, box.y, box.width, box.height = target.x, target.y, target.width, target.height
            elseif widget.points[1] then
                local point = widget.points[1]
                local target = bounds(point[2] or widget.parent)
                local own, relative = anchor[point[1]], anchor[point[3] or point[1]]
                box.x = target.x + target.width * relative[1] + (point[4] or 0) - box.width * own[1]
                box.y = target.y + target.height * relative[2] - (point[5] or 0) - box.height * own[2]
            end
            return box
        end
        return bounds
    end
    local calls = { send = {}, action = {}, selected = {}, saved = {}, font = {}, opacity = {}, scroll = {},
        guide = {}, scrollBottom = 0, hide = 0, resend = 0 }
    local snapshot = { activeTab = "claude", connected = true, fontSize = 10, opacity = 80, cols = 120, rows = 40,
        seq = 312, ringSize = 3000, queued = 0, view = {}, sessions = {
            { id = "claude", title = "Claude", status = "WORKING", lines = {} },
            { id = "codex", title = "Codex", status = "READY", lines = { "Codex terminal", "$ ready" } },
        } }
    for i = 1, 40 do snapshot.sessions[1].lines[i] = "Claude terminal row " .. i end
    local controller = { visible = true }
    function controller:Send(tab, value)
        calls.send[#calls.send + 1] = { tab, value }
        if self.reject then return false, "Queue is full" end
        return true
    end
    function controller:Action(tab, value) calls.action[#calls.action + 1] = { tab, value }; return true end
    function controller:SelectTab(tab)
        calls.selected[#calls.selected + 1] = tab; snapshot.activeTab = tab; self.view:Render(snapshot)
    end
    function controller:SaveView(value) calls.saved[#calls.saved + 1] = value end
    function controller:SetFontSize(value)
        calls.font[#calls.font + 1] = value; snapshot.fontSize = value; self.view:Render(snapshot)
    end
    function controller:SetOpacity(value)
        calls.opacity[#calls.opacity + 1] = value; snapshot.opacity = value; self.view:Render(snapshot)
    end
    function controller:SetContextEnabled(value)
        snapshot.context = snapshot.context or {}; snapshot.context.enabled = value; self.view:Render(snapshot)
    end
    function controller:RefreshContext() calls.contextRefresh = (calls.contextRefresh or 0) + 1 end
    function controller:ListErrors(arg) calls.errorLog = arg end
    function controller:Choose(tab, index) calls.choose = { tab, index }; return true end
    function controller:SendLong(tab, value)
        calls.long = { tab, value }
        if self.rejectLong then return false, "Too long" end
        return true
    end
    function controller:Resend() calls.resend = calls.resend + 1; return true end
    function controller:ComposeGuide(kind, reference, detail)
        calls.guide[#calls.guide + 1] = { kind = kind, reference = reference, detail = detail }
        return self.view:Prefill("Guide " .. kind .. " " .. reference .. " " .. (detail or "plan"))
    end
    local function scrollMaximum(tab)
        for _, value in ipairs(snapshot.sessions) do
            if value.id == tab then return math.max(0, #(value.history or {}) + #(value.lines or {}) - (controller.viewportRows or 40)) end
        end
        return 0
    end
    function controller:SetViewportRows(rows)
        self.viewportRows = rows
        local maximum = scrollMaximum(snapshot.activeTab)
        snapshot.scroll = { offset = math.max(0, math.min(maximum, snapshot.scroll and snapshot.scroll.offset or 0)), max = maximum }
        return snapshot.scroll
    end
    function controller:Scroll(tab, delta)
        calls.scroll[#calls.scroll + 1] = { tab, delta }
        local current = snapshot.scroll and snapshot.scroll.offset or 0
        local maximum = scrollMaximum(tab)
        snapshot.scroll = { offset = math.max(0, math.min(maximum, current + delta)), max = maximum }
        self.view:Render(snapshot)
    end
    function controller:ScrollToBottom(tab)
        calls.scrollBottom = calls.scrollBottom + 1
        snapshot.scroll = { offset = 0, max = scrollMaximum(tab) }
        self.view:Render(snapshot)
    end
    function controller:Hide()
        calls.hide = calls.hide + 1; self.visible = false
        self.view:Hide()
    end
    local ns = {}
    assert(loadfile("Witchcraft/View.lua"))("Witchcraft", ns)
    local view = ns.View.Create(controller); controller.view = view
    view:Render(snapshot); view:Show()
    local function click(widget) widget.scripts.OnClick(widget, "LeftButton") end
    local function contrast(foreground, background)
        local alpha = foreground[4] or foreground.a or 1
        local function channel(value) return value <= .04045 and value / 12.92 or ((value + .055) / 1.055) ^ 2.4 end
        local function luminance(color, blend)
            local result = 0
            for i, key in ipairs({ "r", "g", "b" }) do
                local value = color[i] or color[key]
                if blend then value = value * alpha + (background[i] or background[key]) * (1 - alpha) end
                result = result + channel(value) * ({ .2126, .7152, .0722 })[i]
            end
            return result
        end
        local first, second = luminance(foreground, true), luminance(background)
        return (math.max(first, second) + .05) / (math.min(first, second) + .05)
    end
    local function layout()
        local bounds = geometry()
        for _, widget in ipairs(objects) do
            local box = bounds(widget)
            -- The stock close button's own anchor lifts it one point above the frame, as in the client's windows.
            local stockButton = widget == view.close or widget == view.minimize
            if widget.parent and box.visible and widget ~= view.strip and not stockButton then
                local parent = bounds(widget.parent)
                assert(box.x >= parent.x - .01 and box.y >= parent.y - .01, "widget begins outside its parent: " .. widget.fixtureID)
                assert(box.x + box.width <= parent.x + parent.width + .01, "widget extends past parent width: " .. widget.fixtureID)
                assert(box.y + box.height <= parent.y + parent.height + .01, "widget extends past parent height: " .. widget.fixtureID)
            end
        end
        local last
        for _, row in ipairs(view.rows) do
            local box = bounds(row)
            if box.visible then
                if last then assert(box.y >= last.y + last.height, "terminal rows overlap") end
                assert(row.wordWrap == false and row.maxLines == 1, "terminal rows never wrap")
                last = box
            end
        end
        local headerControls = {}
        for _, widget in ipairs({ view.book, view.brand, view.tabs.claude, view.tabs.codex, view.gem, view.stateWord,
            view.smaller, view.larger, view.appearanceButton, view.minimize, view.close }) do
            local box = bounds(widget)
            if box.visible then headerControls[#headerControls + 1] = box end
        end
        -- The title strip and toolbar are separate rows, so overlap is checked in both axes.
        for i = 1, #headerControls do
            for j = i + 1, #headerControls do
                local a, b = headerControls[i], headerControls[j]
                assert(a.x + a.width <= b.x or b.x + b.width <= a.x or a.y + a.height <= b.y or b.y + b.height <= a.y,
                    "header controls overlap")
            end
        end
        if not view.minimized then
            local panel, input = bounds(view.terminal), bounds(view.input)
            assert(panel.y + panel.height <= input.y, "terminal and composer overlap")
            if view.destination.shown then
                local destination = bounds(view.destination)
                assert(destination.x + destination.width <= input.x, "destination covers the input")
            end
            local send = bounds(view.send)
            assert(input.x + input.width < send.x, "send covers the input")
            if view.footer.shown then
                local footer, status = bounds(view.footer), bounds(view.status)
                assert(input.y + input.height <= footer.y, "composer does not overlap the footer")
                local context, hint = bounds(view.contextButton), bounds(view.footerHint)
                assert(context.x + context.width < hint.x and hint.width >= 50, "context and actionable feedback keep separate usable footer regions")
                if view.status.shown then assert(footer.y == status.y, "counters sit inside the footer") end
                if view.footerHint.shown and view.status.shown then
                    assert(hint.x + hint.width <= status.x, "footer hint covers connection counters")
                end
            end
            if view.enterButton.shown then
                local enter, keysControl = bounds(view.enterButton), bounds(view.keysButton)
                assert(send.x + send.width < enter.x and enter.x + enter.width < keysControl.x, "composer actions overlap")
            end
            local header = bounds(view.header)
            assert(header.height == 60 and header.width == view.frame.width, "the expanded header reserves the title strip and toolbar")
            local titleBar, headerBG = bounds(view.titleBar), bounds(view.headerBG)
            assert(titleBar.height == 22 and headerBG.y == titleBar.y + titleBar.height,
                "only the toolbar row below the stock title strip is backed")
            local accent = bounds(view.accentBar)
            assert(accent.y == header.y + header.height and accent.height == 1, "the thin accent sits below the header")
        end
    end
    if options.fixture then
        return { view = view, snapshot = snapshot, controller = controller, objects = objects,
            geometry = geometry, restore = restore, layout = layout, calls = calls, click = click }
    end
    local ok, err = xpcall(function()
        layout()
        assert(#view.rows == 60 and view.visibleRows == math.min(40, math.floor((view.terminal.height - 20) / (view.fontSize + 3))),
            "bounded sixty-row allocation fits the current pane without cropping a row")
        assert(view.frame.width == 900 and view.frame.height == 650, "new layouts use the compact console size")
        assert(view.frame.backdropColor[4] == .8 and view.terminal.backdropColor[4] == 0, "main backdrop alone owns window opacity")
        if options.noStockFrame then
            assert(not view.stockFrame and view.frame.backdrop.edgeFile and view.frame.borderColor[4] == 1,
                "without the stock layout a plain edge still bounds the window")
        else
            assert(view.stockFrame and #stockLayouts >= 1 and view.frame.backdrop.edgeFile == nil,
                "the client's minimizable window frame replaces the drawn edge")
            for _, applied in ipairs(stockLayouts) do
                assert(applied.container == view.chrome and applied.name == "ButtonFrameTemplateNoPortraitMinimizable",
                    "only the stock layout is applied, always to the chrome")
            end
        end
        assert(view.chrome:GetFrameLevel() > view.content:GetFrameLevel() and view.titleBar:GetFrameLevel() > view.chrome:GetFrameLevel(),
            "the stock art covers the body edge and the title stays above the art")
        assert(view.book.icon.texture == "Interface\\Icons\\INV_Misc_Book_09", "the guides button is a stock book icon")
        assert(view.brand.text == "Witchcraft" and view.brand.textColor[1] == 1 and math.abs(view.brand.textColor[2] - 209 / 255) < .001
            and view.brand.textColor[3] == 0, "the title uses the client's gold label colour")
        assert(view.close.kind == "Button" and view.close.layer == "UIPanelCloseButton" and view.minimize.normalAtlas == "RedButton-Condense",
            "the window buttons are the client's red close and condense buttons")
        assert(view.rowBacking.color[4] >= .35 and view.rowBacking.allPoints == view.terminal, "row backing keeps terminal text readable")
        assert(view.headerBG.gradient and view.headerBG.gradient[1] == "VERTICAL" and view.headerBG.gradient[2].a == 1,
            "the charcoal header remains opaque above fifty percent")
        assert(contrast(view.stateWord.textColor, view.headerBG.gradient[2]) >= 4.5, "header state text has readable contrast")
        assert(view.accentBar.gradient, "linked accent bar carries the agent color")
        assert(#calls.opacity == 0, "programmatic initial slider sync does not persist or reenter")
        assert(view.stateWord.text == "LINKED" and view.gem.diamond.shown, "linked state remains explicit")
        for _, widget in ipairs({ view.send, view.enterButton, view.keysButton, view.copyButton }) do
            assert(widget.kind == "Button" and widget.layer == "UIPanelButtonTemplate" and widget.tier == "stock"
                and widget.height == 22 and widget.backdrop == nil, "composer actions are the client's 22-point red panel buttons")
        end
        assert(view.send.text == "Send" and view.enterButton.text == "Enter" and view.keysButton.text == "Keys"
            and view.copyButton.text == "Copy", "stock buttons carry client-style captions")
        view.appearanceButton.scripts.OnEnter(view.appearanceButton)
        assert(tip.shown and tip.owner == view.appearanceButton and tip.anchor == "ANCHOR_TOP"
            and tip.text == view.appearanceButton.tooltip and tip.alpha == 1 and tip.wrap == true,
            "Appearance exposes a wrapped tooltip using the native argument order")
        local otherTooltipOwner = {}
        tip:SetOwner(otherTooltipOwner, "ANCHOR_TOP")
        view.appearanceButton.scripts.OnLeave(view.appearanceButton)
        assert(tip.shown and tip.owner == otherTooltipOwner, "leaving a control never hides another owner's tooltip")
        view.appearanceButton.scripts.OnEnter(view.appearanceButton)
        view.appearanceButton:Hide()
        assert(not tip.shown and not view.appearanceButton.hover, "hiding the owner clears its tooltip and hover state")
        view.appearanceButton:Show()
        assert(view.tabs.claude.label.text == "CLAUDE" and view.tabs.claude.indicator.shown, "the active tab has an accent underline")
        assert(not view.tabs.codex.indicator.shown, "inactive tabs never carry the active underline")
        for _, widget in ipairs(objects) do
            -- Terminal rows, the composer and the copy box keep the mono; every other label is the client's Friz.
            local terminal = widget == view.input or widget == view.copyBox or widget == view.scrollMarker
                or widget == view.writeBox
            for _, row in ipairs(view.rows) do terminal = terminal or widget == row end
            if widget.font and not terminal then
                assert(widget.font == "Fonts\\FRIZQT__.TTF", "non-terminal text uses the client's Friz Quadrata: " .. widget.fixtureID)
            end
        end
        assert(view.rows[1].font:find("DejaVu", 1, true) and view.input.font:find("DejaVu", 1, true), "terminal text keeps the bundled mono")
        assert(view.status.text == "", "idle footer avoids exposing transport counters")
        -- The compact default can crop the source screen; use forty visible rows for the copy/scroll matrix below.
        view.frame:SetSize(900, 720); layout()
        assert(view.visibleRows == 40, "the enlarged fixture can display the complete forty-row source screen")
        snapshot.context = { enabled = true, status = "Shared with desktop", player = { summary = "Mulgore", age = 2 },
            quests = { count = 6, age = 4, truncated = true }, progress = { summary = "12g 34s 56c / 45% to next level", age = 9 } }
        -- Status line, copy of the last reply, and find.
        local claudeInfo = snapshot.sessions[1]
        claudeInfo.info = { model = "claude-opus-5-5", used = 517000 }
        view:Render(snapshot)
        assert(view.status.shown and view.status.text == "claude-opus-5-5 \194\183 517k context", "the footer shows model and context in use")
        snapshot.sessions[2].info = { model = "gpt-6-astra", effort = "ultra", used = 121000, window = 258400 }
        click(view.tabs.codex)
        assert(view.status.text == "gpt-6-astra ultra \194\183 121k/258k (47%)", "a recorded window shows the share in use")
        snapshot.queued = 1; view:Render(snapshot)
        assert(view.status.text == "1 queued for CODEX", "queued prompts take the counter first")
        snapshot.queued = 0; click(view.tabs.claude)
        claudeInfo.reply = { "Patched the clipping.", "Tests pass." }
        view:Render(snapshot); click(view.copyButton); layout()
        assert(view.copyMode == "screen" and view.copyReply.shown and view.copyScreen.tier == "primary", "copy opens on the screen")
        click(view.copyReply)
        assert(view.copyMode == "reply" and view.copyBox.text == "Patched the clipping.\nTests pass." and view.copyBox.highlighted,
            "Last reply copies the agent's reply from its session file")
        click(view.copyClose); claudeInfo.reply = nil; view:Render(snapshot); click(view.copyButton)
        assert(not view.copyReply.shown and view.copyMode == "screen", "without a reply there is only the screen")
        click(view.copyClose); claudeInfo.info = nil; snapshot.sessions[2].info = nil
        claudeInfo.history = { "older needle one", "filler", "older needle two" }
        view:Render(snapshot); click(view.keysButton); click(view.keysFind); layout()
        assert(view.findPanel.shown and view.findBox.focused, "Find opens from Keys with its box focused")
        view.findBox:SetText("NEEDLE"); view.findBox.scripts.OnEnterPressed(view.findBox)
        assert(view.findResult.text == "Row 3 of 43" and calls.scroll[#calls.scroll][2] > 0, "the nearest older match scrolls into view")
        click(view.findOlder); assert(view.findResult.text == "Row 1 of 43", "Older steps to the next match up")
        click(view.findOlder); assert(view.findResult.text == "No older match")
        click(view.findNewer); assert(view.findResult.text == "Row 3 of 43", "Newer steps back down")
        view.findBox:SetText(""); click(view.findOlder); assert(view.findResult.text == "Type text to find")
        click(view.findClose); assert(not view.findPanel.shown and not view.findBox.focused)
        -- The client's edit boxes store a typed | as ||, and terminal rows escape a literal | the same way.
        claudeInfo.history = { "npm test || tail" }; snapshot.scroll = { offset = 0 }
        view:Render(snapshot); click(view.keysButton); click(view.keysFind); layout()
        view.findBox:SetText("test || tail"); view.findBox.scripts.OnEnterPressed(view.findBox)
        assert(view.findResult.text:find("^Row 1 of") ~= nil, "a typed pipe finds the row's literal pipe")
        click(view.findClose)
        claudeInfo.history = nil; snapshot.scroll = { offset = 0 }; view:Render(snapshot)
        for i = #calls.scroll, 1, -1 do calls.scroll[i] = nil end
        -- The long-prompt editor opens from the "/" menu and sends through the multi-part path.
        click(view.commandsButton)
        menus[#menus].entries[1].callback(); layout()
        assert(view.writePanel.shown and view.writeBox.focused and view.writeBox.multiLine, "Write opens a focused multi-line editor")
        view.writeBox:SetText("line one\nline two")
        assert(view.writeCount.text == "17 / 4600 bytes", "the editor counts bytes against the limit")
        controller.rejectLong = true; click(view.writeSend)
        assert(view.writePanel.shown and view.writeBox.text == "line one\nline two" and view.writeCount.text == "Too long",
            "a refused prompt stays in the editor with the reason")
        controller.rejectLong = nil; click(view.writeSend)
        assert(calls.long[1] == "claude" and calls.long[2] == "line one\nline two" and not view.writePanel.shown
            and view.writeBox.text == "", "Send submits the whole text and closes the editor")
        click(view.commandsButton); menus[#menus].entries[1].callback(); layout()
        view.writeBox:SetText("cat build.log || grep error\nthen fix it"); click(view.writeSend)
        assert(calls.long[2] == "cat build.log | grep error\nthen fix it", "the editor sends a typed pipe as one pipe")
        -- Snippets, links, history and focus.
        snapshot.snippets = { "Run the tests and summarize failures", string.rep("long snippet ", 8) }
        view:Render(snapshot); click(view.commandsButton)
        local snippetMenu = menus[#menus]
        local last = snippetMenu.entries[#snippetMenu.entries]
        assert(last.kind == "button" and #last.text == 40 and last.text:sub(-3) == "...", "long snippets are cut in the menu")
        view.input:SetText(""); snippetMenu.entries[#snippetMenu.entries - 1].callback()
        assert(view.input.text == "Run the tests and summarize failures" and view.footerHint.text == "Snippet ready. Review it, then Send.",
            "a snippet is prefilled, never sent")
        snapshot.snippets = nil
        view.input:SetText("why is "); view.input:SetFocus()
        assert(#linkHooks == 1, "the view hooks the chat link path once")
        shiftClick("|cff1eff00|Hitem:5191::::::::60:::::|h[Cruel Barb]|h|r")
        assert(view.input.text == "why is [Cruel Barb] (item 5191)", "a shift-clicked link becomes its name, kind and id")
        view.input:ClearFocus(); shiftClick("|cffffff00|Hquest:166:18|h[The Defias Brotherhood]|h|r")
        assert(view.input.text == "why is [Cruel Barb] (item 5191)", "links reach the input only while it has focus")
        view.guideReference:SetText(""); view.guideReference:SetFocus()
        shiftClick("|cffffff00|Hquest:166:18|h[The Defias Brotherhood]|h|r")
        assert(view.guideReference.text:find("|Hquest:166", 1, true), "the Guides field keeps the raw link it already reads")
        view.guideReference:SetText(""); view.guideReference:ClearFocus()
        view.history.claude = {}
        snapshot.settings = { historySize = 20 }; view:Render(snapshot)
        for i = 1, 25 do view.input:SetText("prompt " .. i); click(view.send); table.remove(calls.send) end
        assert(#view.history.claude == 20 and view.history.claude[1] == "prompt 6", "history keeps the configured number of prompts")
        view.history.claude = {}; snapshot.settings = {}; view:Render(snapshot)
        view.input:SetText("first prompt"); click(view.send)
        view.input:SetText("second prompt"); click(view.send)
        view.input:SetText("second prompt"); click(view.send)
        view.input:SetText("unsent draft")
        local press = view.input.scripts.OnKeyDown
        press(view.input, "UP"); assert(view.input.text == "second prompt", "Up recalls the newest sent prompt")
        press(view.input, "UP"); assert(view.input.text == "first prompt", "a repeated prompt is kept once")
        press(view.input, "UP"); assert(view.input.text == "first prompt", "Up stops at the oldest")
        press(view.input, "DOWN"); press(view.input, "DOWN")
        assert(view.input.text == "unsent draft", "walking past the newest restores the draft")
        click(view.tabs.codex); press(view.input, "UP")
        assert(view.input.text == "", "each tab keeps its own history"); click(view.tabs.claude)
        for _ = 1, 3 do table.remove(calls.send) end
        view.input:SetText(""); view.input:ClearFocus(); view:ToggleMinimized(); view:FocusInput()
        assert(not view.minimized and view.input.focused, "the focus binding expands the window and focuses the input")
        for i = #calls.saved, 1, -1 do calls.saved[i] = nil end
        -- Settings from the Options page.
        assert(view.frame.strata == "DIALOG", "the normal layer is today's")
        snapshot.settings = { layer = "top" }; view:Render(snapshot)
        assert(view.frame.strata == "FULLSCREEN_DIALOG", "above everything")
        snapshot.settings = { layer = "back" }; view:Render(snapshot)
        assert(view.frame.strata == "MEDIUM", "behind other windows")
        snapshot.settings = { locked = true }; view:Render(snapshot); layout()
        view.drag.scripts.OnDragStart(view.drag)
        assert(not view.frame.moving and not view.resize.shown, "a locked window neither drags nor resizes")
        snapshot.view = { point = "TOPLEFT", relativePoint = "TOPLEFT", x = 40, y = -20 }
        snapshot.settings = { docked = true }; view:Render(snapshot); layout()
        local dock = view.frame.points[1]
        assert(dock[1] == "TOP" and dock[3] == "TOP" and dock[4] == 0 and view.locked, "docking pins the window to the top centre")
        view:Save()
        assert(calls.saved[#calls.saved].point == "TOPLEFT" and calls.saved[#calls.saved].x == 40, "docking keeps the player's own position")
        snapshot.settings = {}; view:Render(snapshot)
        local free = view.frame.points[1]
        assert(free[1] == "TOPLEFT" and free[4] == 40 and free[5] == -20 and not view.locked, "undocking returns to it")
        for i = #calls.saved, 1, -1 do calls.saved[i] = nil end
        snapshot.view = {}; view.frame:SetPoint("CENTER", _G.UIParent, "CENTER", 0, 0)
        snapshot.settings = { escapeCloses = true }; view:Render(snapshot); view:Render(snapshot)
        assert(#_G.UISpecialFrames == 1 and _G.UISpecialFrames[1] == "WitchcraftTerminalFrame", "Escape can be opted into, once")
        snapshot.settings = {}; view:Render(snapshot)
        assert(#_G.UISpecialFrames == 0, "and out again")
        snapshot.sessions[1].info = { model = "claude-opus-5-5", used = 1000 }
        snapshot.settings = { showStatus = false }; view:Render(snapshot)
        assert(view.status.text == "", "the footer status line can be hidden")
        snapshot.sessions[1].info = nil; snapshot.settings = {}
        local noticeCount, soundCount = #notices, #sounds
        view:Alert("claude", "waiting", { text = false, sound = true })
        assert(#notices == noticeCount and #sounds == soundCount + 1, "text and sound follow their settings")
        for i = #sounds, 1, -1 do sounds[i] = nil end
        local settingsOpened = 0
        controller.OpenSettings = function() settingsOpened = settingsOpened + 1 end
        controller.SetSetting = function(_, key, value)
            calls.settings = calls.settings or {}
            calls.settings[#calls.settings + 1] = { key, value }
            snapshot.tabs = snapshot.tabs or { "claude", "codex" }
            local tabMap = { tabClaude = "claude", tabCodex = "codex", tabCopilot = "copilot", tabAgy = "agy" }
            local id = tabMap[key]
            if id then
                local nextTabs = {}
                for _, item in ipairs({ "claude", "codex", "copilot", "agy" }) do
                    local had = false
                    for _, cur in ipairs(snapshot.tabs) do if cur == item then had = true end end
                    if (item == id and value) or (item ~= id and had) then nextTabs[#nextTabs + 1] = item end
                end
                if #nextTabs == 0 then return false, "At least one tab stays visible" end
                snapshot.tabs = nextTabs
            end
            view:Render(snapshot)
            return true
        end
        click(view.appearanceButton); layout()
        assert(view.tabsLabel.text == "Agent tabs" and view.tabToggles.agy.label.text == "AGY",
            "Appearance offers quick toggles for each agent tab")
        click(view.tabToggles.agy); layout()
        assert(view.tabs.agy.shown and view.tabToggles.agy.tier == "primary", "toggling AGY in Appearance reveals its tab")
        click(view.tabToggles.agy); layout()
        assert(not view.tabs.agy.shown and view.tabToggles.agy.tier == "secondary", "toggling AGY again hides its tab")
        click(view.allSettings)
        assert(settingsOpened == 1 and not view.appearancePanel.shown, "All settings opens the Options page")
        -- Choice strip: a waiting menu gets numbered stock buttons between the terminal and the composer.
        assert(not view.choiceBar.shown, "no strip without a menu")
        local claudeSession = snapshot.sessions[1]
        claudeSession.state, claudeSession.choices = "waiting", { options = { "Yes", "Yes, and don't ask again", "No" }, selected = 1 }
        view:Render(snapshot); layout()
        local bars = geometry()
        assert(view.choiceBar.shown and bars(view.terminal).y + bars(view.terminal).height <= bars(view.choiceBar).y
            and bars(view.choiceBar).y + bars(view.choiceBar).height <= bars(view.input).y,
            "the strip sits between the terminal and the composer")
        assert(view.choiceButtons[1].shown and view.choiceButtons[3].shown and not view.choiceButtons[4].shown
            and view.choiceButtons[1].text == "1  Yes" and view.choiceButtons[1].layer == "UIPanelButtonTemplate",
            "one numbered stock button per option")
        assert(view.choiceButtons[1].highlightLocked and not view.choiceButtons[2].highlightLocked, "the marked option is lit")
        view.choiceButtons[2].scripts.OnEnter(view.choiceButtons[2])
        assert(tip.shown and tip.text == "2. Yes, and don't ask again", "the whole option is on hover")
        view.choiceButtons[2].scripts.OnLeave(view.choiceButtons[2])
        click(view.choiceButtons[3])
        assert(calls.choose[1] == "claude" and calls.choose[2] == 3 and view.footerHint.text == "Claude: option 3 chosen",
            "a button answers the menu through the controller")
        layout()
        assert(not view.choiceBar.shown, "an answered menu's buttons leave at once, so a second click cannot follow")
        snapshot.answered = { claude = true }; view:Render(snapshot); layout()
        assert(not view.choiceBar.shown, "they stay away while the controller says the screen is answered")
        snapshot.answered = nil
        -- Option labels are terminal text: WoW markup in them is shown, never rendered.
        claudeSession.choices = { options = { "Run |cffff0000rm -rf|r", "No" }, selected = 1 }
        view:Render(snapshot); layout()
        assert(view.choiceButtons[1].text == "1  Run ||cffff0000rm -rf||r", "a label's escape codes stay literal")
        view.choiceButtons[1].scripts.OnEnter(view.choiceButtons[1])
        assert(tip.text == "1. Run ||cffff0000rm -rf||r", "and in the tooltip")
        view.choiceButtons[1].scripts.OnLeave(view.choiceButtons[1])
        snapshot.settings = { showChoices = false }; view:Render(snapshot); layout()
        assert(not view.choiceBar.shown, "the choice strip can be turned off")
        snapshot.settings = {}
        snapshot.combat = true; view:Render(snapshot); layout()
        assert(not view.choiceBar.shown, "combat freezes the rows, so the strip hides")
        snapshot.combat = false; claudeSession.state, claudeSession.choices = nil, nil
        view:Render(snapshot); layout()
        assert(not view.choiceBar.shown, "the strip leaves with the menu")
        -- A tab whose console has closed says so, and the menu frozen on its last screen offers no answers.
        claudeSession.state, claudeSession.choices = "waiting", { options = { "Yes", "No" }, selected = 1 }
        claudeSession.status = "exited (console 24492 closed)"
        -- An earlier action's message (the choice just made) must not hide that the console closed.
        view:Render(snapshot); layout()
        assert(not view.choiceBar.shown, "a closed console's last menu cannot be answered")
        assert(view.footerHint.text == "Claude: exited (console 24492 closed)", "the footer names a tab that is no longer running")
        claudeSession.status, claudeSession.state, claudeSession.choices = "running", nil, nil
        view:Render(snapshot); layout()
        -- A joined Claude session started before its WoW tools were registered has none of them.
        local toolless = "Claude: no WoW tools. Run mcp-setup --apply, restart Claude, then Witchcraft"
        claudeSession.tools = false; view:Render(snapshot)
        assert(view.footerHint.text == toolless, "the footer says the joined session is missing its tools, and the whole fix")
        -- Losing the link outranks an advisory about the remote session, which may be stale by then.
        snapshot.connected = false; view:Render(snapshot)
        assert(view.footerHint.text ~= toolless, "the link notice wins while the host cannot be heard")
        snapshot.connected = true
        claudeSession.tools = nil; view:Render(snapshot)
        assert(view.footerHint.text ~= toolless)
        -- A live session the host cannot hear (WoW in the background) reads as paused, not offline.
        snapshot.paused, snapshot.connected = true, false; view:Render(snapshot)
        assert(view:State() == "paused" and view.stateWord.text == "PAUSED" and view.accentBar.color[1] > view.accentBar.color[3],
            "the pause is amber and named")
        snapshot.paused, snapshot.connected = nil, true; view:Render(snapshot)
        assert(view:State() == "linked")
        -- Badges say why a tab wants the player, and alerts reach them while they look elsewhere.
        snapshot.attention = { codex = "waiting" }; view:Render(snapshot)
        assert(view.tabs.codex.unread.shown and view.tabs.codex.unread.backdropColor[1] == 1
            and view.tabs.codex.unread.backdropColor[2] < .2, "waiting is a red badge")
        snapshot.attention = { codex = "done" }; view:Render(snapshot)
        assert(view.tabs.codex.unread.backdropColor[2] == 1 and view.tabs.codex.unread.backdropColor[1] < .2, "finished is a green badge")
        snapshot.attention = nil; view:Render(snapshot)
        assert(not view.tabs.codex.unread.shown, "no badge once seen")
        view:Alert("codex", "waiting"); view:Alert("claude", "done")
        assert(notices[1].frame == _G.RaidWarningFrame and notices[1].line == "Codex needs you" and notices[2].line == "Claude finished"
            and #sounds == 2 and sounds[1] == 8959, "alerts use the raid-warning line and sound")
        -- Slash command menu: plain commands send at once, argument commands prefill, drafts are kept.
        local function pick(menu, text)
            for _, entry in ipairs(menu.entries) do if entry.kind == "button" and entry.text == text then return entry end end
            error("no menu entry " .. text)
        end
        assert(view.commandsButton.shown and view.commandsButton.layer == "UIPanelButtonTemplate" and view.commandsButton.text == "/",
            "a stock / button sits in the composer")
        local sendBox, slash = view.send, view.commandsButton
        assert(slash.points[1][4] + slash.width < sendBox.points[1][4], "the / button sits left of Send")
        click(view.commandsButton)
        local menu = menus[#menus]
        assert(menu.owner == view.commandsButton and menu.entries[1].text == "Write a long prompt..."
            and menu.entries[3].kind == "title" and menu.entries[3].text == "Claude commands",
            "the menu is anchored to its button and titled for the active tab")
        local dividers, buttons = 0, 0
        for _, entry in ipairs(menu.entries) do
            if entry.kind == "divider" then dividers = dividers + 1 elseif entry.kind == "button" then buttons = buttons + 1 end
            if entry.kind == "button" and entry.text ~= "Write a long prompt..." then
                assert(entry.text:match("^/[a-z]+") and entry.tooltip, "every command is a slash command with a tooltip")
                assert(not entry.text:find("quit", 1, true) and not entry.text:find("logout", 1, true), "exit commands are left out")
            end
        end
        assert(dividers == 5 and buttons == 16 and menu.entries[#menu.entries].text:find("snippet add", 1, true),
            "four Claude groups of commands, then the snippets section with how to add one")
        local tipOwner = {}
        tip:SetOwner(tipOwner, "ANCHOR_TOP"); function tip:AddLine(line) self.line = line end
        pick(menu, "/clear").tooltip(tip)
        assert(tip.text == "/clear" and tip.line:find("mirror", 1, true), "the /clear tooltip warns about the mirrored session")
        local sent = #calls.send
        view.input:SetText("keep me")
        pick(menu, "/model").callback()
        assert(#calls.send == sent + 1 and calls.send[#calls.send][1] == "claude" and calls.send[#calls.send][2] == "/model"
            and view.input.text == "keep me" and view.footerHint.text == "Sent /model to Claude",
            "a plain command is sent at once and leaves the draft alone")
        pick(menu, "/compact ...").callback()
        assert(view.input.text == "keep me" and view.footerHint.text:find("before choosing a command", 1, true),
            "an argument command never replaces a draft")
        view.input:SetText("")
        pick(menu, "/compact ...").callback()
        assert(view.input.text == "/compact " and view.input.focused and #calls.send == sent + 1
            and view.footerHint.text == "Finish /compact for Claude, then Send.", "an argument command is prefilled, not sent")
        view.input:SetText(""); view.input:ClearFocus(); table.remove(calls.send)
        click(view.tabs.codex); click(view.commandsButton)
        menu = menus[#menus]
        assert(menu.entries[3].text == "Codex commands" and pick(menu, "/review ...") and pick(menu, "/diff"),
            "the Codex tab offers Codex's commands")
        pick(menu, "/status").callback()
        assert(calls.send[#calls.send][1] == "codex" and calls.send[#calls.send][2] == "/status", "Codex commands go to Codex")
        table.remove(calls.send); click(view.tabs.claude)
        local menuUtil = _G.MenuUtil; _G.MenuUtil = nil
        assert(view:OpenCommands(view.commandsButton) == false and view.footerHint.text:find("unavailable", 1, true),
            "a client without the menu reports it instead of raising")
        _G.MenuUtil = menuUtil
        view:Render(snapshot); click(view.contextButton); layout()
        assert(view.contextPanel.shown and not view.keysPanel.shown and not view.appearancePanel.shown)
        assert(view.contextPlayer.text:find("Mulgore", 1, true) and view.contextQuests.text:find("6 tracked / partial", 1, true))
        assert(view.contextProgress.shown and view.contextProgress.text == "Progress: 12g 34s 56c / 45% to next level / 9s ago",
            "the progress summary renders under the quest line with its age")
        assert(view.contextErrors.shown and view.contextErrors.text == "Lua errors: sent only when an agent asks",
            "the errors line says errors wait for an agent")
        assert(view.contextStatus.text == "Sharing: on" and view.contextRefresh.shown, "sharing state and refresh are visible when on")
        click(view.contextRefresh); assert(calls.contextRefresh == 1, "refresh requests a fresh context snapshot")
        click(view.contextToggle); layout()
        assert(not snapshot.context.enabled and view.contextToggle.label.text == "ENABLE" and not view.contextRefresh.shown,
            "off state hides update and promotes enable")
        assert(view.contextToggle.backdropColor[4] == 1, "enable sharing becomes the primary action")
        click(view.contextToggle); assert(snapshot.context.enabled and view.contextToggle.label.text == "PAUSE")
        assert(view.contextToggle.tier == "secondary", "pause sharing is secondary")
        view.frame:SetSize(580, 280); layout()
        assert(view.contextPanel.backdropColor[4] == .96, "context pane is the same glass as the other popovers")
        click(view.contextClose); assert(not view.contextPanel.shown)
        view.frame:SetSize(900, 720); layout()
        click(view.appearanceButton); layout()
        assert(view.appearancePanel.shown and view.opacityValue.text == "80%", "appearance exposes current percentage")
        assert(not view.panelSmaller.shown, "font controls stay in the header at full width")
        for index, expected in ipairs({ 25, 65, 100 }) do
            click(view.opacityPresets[index]); layout()
            assert(view.opacity == expected and calls.opacity[#calls.opacity] == expected and view.opacityValue.text == expected .. "%")
        end
        local opacityCalls = #calls.opacity
        view:Render(snapshot); assert(#calls.opacity == opacityCalls, "slider render does not loop into persistence")
        view.opacitySlider:SetValue(0); layout()
        assert(view.frame.backdropColor[4] == 0 and view.terminal.backdropColor[4] == 0 and view.input.backdropColor[4] == 0)
        assert(view.appearancePanel.backdropColor[4] == .96, "temporary settings remain readable over transparent terminal")
        assert(view.rowBacking.color[4] >= .35, "row backing ignores the slider")
        assert(view.headerBG.gradient[2].a >= .9, "header labels keep a readable backing in glass")
        assert(view.composerBG.color[4] >= .35 and view.composerBG.color[1] < .2, "composer keeps a dark backing in glass")
        for _, widget in ipairs(view.buttons) do
            if widget.tier == "glyph" then assert(widget.backdropColor[4] == 0, "glyph buttons leave the backing to their parent") end
        end
        assert(view.rows[1].textColor[4] == 1 and view.rows[1].shadowColor[4] == .9, "terminal text retains full alpha with readable shadow")
        assert(view.sliderFill.width == 0, "slider fill tracks the value")
        view.opacitySlider:SetValue(45)
        assert(view.opacity == 45 and #calls.opacity == opacityCalls + 2, "user slider updates persist once each")
        assert(view.sliderFill.width > 0 and view.sliderFill.width < view.sliderTrack.width, "slider fill is proportional")
        click(view.appearanceClose); assert(not view.appearancePanel.shown)
        click(view.keysButton); layout()
        assert(view.keysPanel.shown and view.controls[5].label.text == "INTERRUPT", "interrupt is deliberately inside the keys menu")
        assert(view.controls[5].backdropColor[4] == 1
            and contrast(view.controls[5].label.textColor, view.controls[5].backdropColor) >= 4.5, "interrupt is a readable filled warning action")
        assert(not view.keysEnter.shown, "the panel enter appears only when the composer enter collapses")
        click(view.keysButton); assert(not view.keysPanel.shown)
        -- Copy: a read-only box over the terminal holds the visible rows as plain text.
        assert(view.copyButton.shown and not view.copyButton.highlightLocked, "copy sits in the composer row, unlit while closed")
        snapshot.sessions[1].lines[2] = "|cff66d4bdgreen|r text ||pipe|| |cffffffffwhite|r"
        view:Render(snapshot)
        click(view.copyButton); layout()
        assert(view.copyPanel.shown and not view.keysPanel.shown and view.copyPanel.backdropColor[4] == .96,
            "copy is a popover of its own, in the shared glass")
        assert(view.copyBox.focused and view.copyBox.highlighted and not view.input.focused,
            "the copy box is highlighted and focused so Ctrl+C works")
        assert(view.copyBox.font == view.rows[1].font and view.copyBox.fontSize == view.fontSize, "the copy box shares the terminal face")
        local expected = {}
        for i = 1, 40 do expected[i] = "Claude terminal row " .. i end
        expected[2] = "green text |pipe| white"
        assert(view.copyBox.text == table.concat(expected, "\n"), "copy holds exactly the visible rows with the colour runs stripped")
        view.copyBox:SetText("edited")
        assert(view.copyBox.text == table.concat(expected, "\n"), "the copy box is read-only")
        view.copyBox.scripts.OnEscapePressed(view.copyBox)
        assert(not view.copyPanel.shown and not view.copyBox.focused and view:IsShown(), "Escape in the copy box closes only the popover")
        click(view.copyButton); assert(view.copyPanel.shown and view.copyButton.highlightLocked, "open copy keeps its button lit")
        click(view.copyClose); assert(not view.copyPanel.shown and not view.copyButton.highlightLocked, "close returns to the terminal")
        view.frame:SetSize(580, 280); click(view.copyButton); layout()
        local copyBounds = geometry()
        local copyPanel, copyTerminal = copyBounds(view.copyPanel), copyBounds(view.terminal)
        assert(view.copyPanel.shown and copyPanel.y >= copyTerminal.y
            and copyPanel.y + copyPanel.height <= copyTerminal.y + copyTerminal.height, "copy covers only the terminal at the minimum height")
        assert(select(2, view.copyBox.text:gsub("\n", "")) == view.visibleRows - 1, "the small window copies its own row count")
        click(view.copyClose); view.frame:SetSize(900, 720); layout()
        snapshot.sessions[1].lines[2] = "Claude terminal row 2"; view:Render(snapshot)
        assert(view.rows[1].text == "Claude terminal row 1" and view.rows[40].text == "Claude terminal row 40")
        assert(#_G.UISpecialFrames == 0, "Escape in the game world never closes the terminal")
        -- Scrollback: the window is history .. lines ending offset rows above the bottom.
        assert(not view.scrollMarker.shown, "no scrollback marker while at the bottom")
        snapshot.sessions[1].history = {}
        for i = 1, 100 do snapshot.sessions[1].history[i] = "Claude history row " .. i end
        view:Render(snapshot); layout()
        assert(view.rows[1].text == "Claude terminal row 1" and view.rows[40].text == "Claude terminal row 40"
            and not view.scrollMarker.shown, "history alone does not move the viewport")
        view.terminal.scripts.OnMouseWheel(view.terminal, 1)
        assert(calls.scroll[1][1] == "claude" and calls.scroll[1][2] == 3, "one wheel notch up asks for three older lines")
        assert(view.rows[1].text == "Claude history row 98" and view.rows[4].text == "Claude terminal row 1"
            and view.rows[40].text == "Claude terminal row 37", "the window ends three rows above the bottom")
        assert(view.scrollMarker.shown and view.scrollMarker.text == "\226\134\145 3 lines", "the marker counts the hidden rows")
        click(view.copyButton)
        assert(view.copyBox.text:sub(1, 22) == "Claude history row 98\n" and view.copyBox.text:find("\nClaude terminal row 37$")
            and select(2, view.copyBox.text:gsub("\n", "")) == 39, "copy follows the scrolled window, not the live bottom")
        click(view.copyButton); assert(not view.copyPanel.shown)
        layout()
        local markerBounds = geometry()
        local marker, terminalBox = markerBounds(view.scrollMarker), markerBounds(view.terminal)
        assert(marker.y + marker.height <= terminalBox.y + terminalBox.height
            and marker.y + marker.height > terminalBox.y + terminalBox.height - 20, "the marker hugs the terminal's bottom edge")
        view.input:SetFocus()
        view.input.scripts.OnKeyDown(view.input, "PAGEUP")
        assert(calls.scroll[2][2] == 39 and snapshot.scroll.offset == 42, "PageUp scrolls a page of visibleRows - 1")
        assert(view.rows[1].text == "Claude history row 59" and view.rows[40].text == "Claude history row 98")
        assert(view.scrollMarker.text == "\226\134\145 42 lines")
        view.input.scripts.OnKeyDown(view.input, "PAGEDOWN")
        assert(calls.scroll[3][2] == -39 and snapshot.scroll.offset == 3, "PageDown scrolls a page back")
        view.input.scripts.OnKeyDown(view.input, "A")
        assert(#calls.scroll == 3 and snapshot.scroll.offset == 3, "other keys are left to the edit box")
        view.terminal.scripts.OnMouseWheel(view.terminal, -1)
        assert(snapshot.scroll.offset == 0 and not view.scrollMarker.shown and view.rows[40].text == "Claude terminal row 40",
            "wheel down returns to the live rows")
        view.terminal.scripts.OnMouseWheel(view.terminal, 1); assert(snapshot.scroll.offset == 3)
        view.input.scripts.OnKeyDown(view.input, "END")
        assert(calls.scrollBottom == 1 and snapshot.scroll.offset == 0 and not view.scrollMarker.shown, "End snaps to the bottom")
        snapshot.scroll = { offset = 100, max = 100 }; view:Render(snapshot); layout()
        assert(view.rows[1].text == "Claude history row 1" and view.rows[40].text == "Claude history row 40"
            and view.scrollMarker.text == "\226\134\145 100 lines", "the top of the history is the oldest window")
        snapshot.scroll = { offset = 1, max = 100 }; view:Render(snapshot)
        assert(view.scrollMarker.text == "\226\134\145 1 line")
        snapshot.scroll = nil; snapshot.sessions[1].history = nil; view:Render(snapshot)
        assert(view.rows[40].text == "Claude terminal row 40" and not view.scrollMarker.shown, "a snapshot without scroll is the bottom")
        view.input:SetText("Claude draft"); view.input:SetFocus()
        click(view.tabs.codex)
        assert(view.activeTab == "codex" and view.rows[1].text == "Codex terminal" and view.rows[3].text == "")
        assert(view.input.text == "" and not view.input.focused and view.destination.text:find("CODEX", 1, true))
        assert(view.gem.diamond.color[2] > view.gem.diamond.color[1] and view.destination.textColor[2] > view.destination.textColor[1],
            "codex accent moves with the tab")
        view.input:SetText("codex\n\r\0\27\t prompt")
        view.input.scripts.OnEnterPressed(view.input)
        assert(calls.send[1][1] == "codex" and calls.send[1][2] == "codex prompt", "Enter sends sanitized text to exact visible tab")
        assert(view.input.text == "", "queued text clears")
        view.input:SetText("git log --oneline || head -5"); view.input.scripts.OnEnterPressed(view.input)
        assert(calls.send[#calls.send][2] == "git log --oneline | head -5", "a typed pipe reaches the agent as one pipe")
        view.input.scripts.OnKeyDown(view.input, "UP")
        assert(view.input.text == "git log --oneline || head -5", "history keeps the edit box's own form, so recall shows one pipe")
        view.input:SetText("")
        click(view.tabs.claude)
        assert(view.input.text == "Claude draft", "per-tab drafts survive switching without crossing routing")
        controller.reject = true; click(view.send)
        assert(view.input.text == "Claude draft" and view.footerHint.text == "Queue is full", "rejected prompt remains available")
        controller.reject = false
        for i, control in ipairs(view.controls) do
            if i > 1 then click(view.keysButton); assert(view.keysPanel.shown) end
            click(control)
            assert(calls.action[i][1] == "claude", "terminal keys follow current tab")
            assert(not view.keysPanel.shown, "a selected terminal key dismisses its menu")
        end
        assert(calls.action[1][2] == "enter" and calls.action[5][2] == "interrupt")
        local count = #objects
        for i = 1, 100 do snapshot.seq = i; view:Render(snapshot) end
        assert(#objects == count, "render reuses existing frames and all sixty rows")
        -- Collapse order 900 -> 260
        view.frame:SetSize(700, 500); layout()
        assert(not view.stateWord.shown and view.gem.shown and view.smaller.shown, "below 740 the word hides and the gem stays")
        view.frame:SetSize(600, 500); layout()
        assert(not view.smaller.shown and not view.larger.shown and view.footerHint.shown and not view.status.shown,
            "below 620 font glyphs and counters yield space to actionable status")
        click(view.appearanceButton); layout()
        assert(view.panelSmaller.shown and view.panelLarger.shown, "font size moves into Appearance below 620")
        click(view.panelLarger); assert(calls.font[#calls.font] == 11, "popover font controls drive the controller")
        click(view.appearanceButton)
        view.frame:SetSize(500, 400); layout()
        assert(not view.enterButton.shown and view.keysButton.shown and view.appearanceButton.shown,
            "below 520 enter collapses into keys while Appearance remains accessible")
        click(view.keysButton); layout()
        assert(view.keysEnter.shown, "keys panel offers enter while the composer enter is hidden")
        assert(not view.copyButton.shown and view.keysCopy.shown, "copy moves into keys beside enter below 520")
        assert(not view.commandsButton.shown and view.keysCommands.shown, "the command menu moves into keys below 520")
        local opened = #menus
        click(view.keysCommands)
        assert(#menus == opened + 1 and menus[#menus].owner == view.keysCommands, "the Keys panel opens the same menu")
        click(view.keysCopy); layout()
        assert(view.copyPanel.shown and not view.keysPanel.shown and view.copyBox.focused, "the keys pane copy opens the same popover")
        click(view.copyClose); click(view.keysButton); layout()
        click(view.keysEnter); assert(calls.action[#calls.action][2] == "enter" and not view.keysPanel.shown)
        click(view.book); layout()
        assert(view.guidePanel.shown and view.guideReference.focused and not view.appearancePanel.shown,
            "the book seal opens Guides, leaving Appearance on the ellipsis")
        local sentBeforeGuide = #calls.send
        view.guideReference:SetText("The Defias Brotherhood")
        click(view.guideQuestButtons[1])
        assert(view.input.text == "Claude draft" and view.footerHint.text:find("Draft kept", 1, true),
            "guide actions preserve a nonempty active draft and explain the refusal")
        assert(not view.guidePanel.shown and not view.guideReference.focused and view.input.focused,
            "a kept draft is revealed and guide reference focus is released")
        for index, detail in ipairs({ "hint", "details", "solution" }) do
            view.input:SetText(""); click(view.book); click(view.guideQuestButtons[index]); layout()
            assert(calls.guide[#calls.guide].detail == detail and view.input.text:find(detail, 1, true),
                "the clicked spoiler level is the only requested level")
        end
        view.input:SetText(""); click(view.book); view.guideReference:SetText("")
        local guideCount = #calls.guide
        click(view.guideLootAdd)
        assert(#calls.guide == guideCount and view.guidePanel.shown and view.guideReference.focused,
            "an empty loot reference asks for an item without silently opening the plan")
        view.guideReference:SetText("Cruel Barb"); click(view.guideLootAdd)
        assert(calls.guide[#calls.guide].kind == "loot" and calls.guide[#calls.guide].reference == "Cruel Barb")
        local claudeGuide = view.input.text
        click(view.tabs.codex); click(view.book); click(view.guideLootPlan)
        assert(view.activeTab == "codex" and calls.guide[#calls.guide].reference == "" and view.input.text == "Guide loot  plan",
            "My Plan composes in the selected assistant and ignores the reference field")
        click(view.tabs.claude)
        assert(view.input.text == claudeGuide and #calls.send == sentBeforeGuide, "guide drafts stay per-tab and never auto-submit")
        click(view.book); click(view.guideClose)
        assert(not view.guideReference.focused and view.guideReference.text == "Cruel Barb", "closing retains the guide reference without focus")
        click(view.book); click(view.guidePages.adventures); layout()
        assert(view.guidePage == "adventures" and view.guideReference.text == "" and view.guideReference.focused,
            "Adventures starts with its own reference and focus")
        assert(not view.guideQuestButtons[1].shown and not view.guideLootAdd.shown and view.guideRoleButtons[1].shown
            and view.guideAdventureButtons[3].shown and view.guideRole == nil, "pages separate controls without choosing a role")
        view.guideReference:SetText("The Deadmines")
        local beforeAdventure, keptDraft = #calls.guide, view.input.text
        click(view.guideAdventureButtons[1])
        assert(#calls.guide == beforeAdventure and view.guideHint.text:find("Choose your rehearsal role", 1, true),
            "a named rehearsal requires explicit role selection")
        click(view.guideRoleButtons[2]); click(view.guideAdventureButtons[1])
        assert(view.input.text == keptDraft and view.message:find("Draft kept", 1, true), "adventures preserve an existing draft")
        view.input:SetText(""); click(view.book); click(view.guideAdventureButtons[1])
        assert(calls.guide[#calls.guide].kind == "rehearse" and calls.guide[#calls.guide].detail == "healer"
            and calls.guide[#calls.guide].reference == "The Deadmines", "rehearsal uses only the selected role")
        click(view.book); click(view.guidePages.quests)
        assert(view.guideReference.text == "Cruel Barb" and view.guideQuestButtons[1].shown
            and not view.guideRoleButtons[1].shown, "Quest / Loot keeps its reference and restores its controls")
        click(view.guidePages.adventures)
        assert(view.guideReference.text == "The Deadmines" and view.guideRole == "healer", "Adventures keeps its own input and chosen role")
        view.input:SetText(""); view.guideReference:SetText(""); click(view.guideAdventureButtons[1])
        assert(calls.guide[#calls.guide].kind == "rehearse" and calls.guide[#calls.guide].reference == "",
            "blank rehearsal asks for the supported dungeon menu")
        view.input:SetText(""); click(view.book); click(view.guideAdventureButtons[2])
        assert(calls.guide[#calls.guide].kind == "nearby" and calls.guide[#calls.guide].reference == "", "blank detours use current-zone context")
        view.input:SetText(""); click(view.book); view.guideReference:SetText("Westfall"); click(view.guideAdventureButtons[2])
        assert(calls.guide[#calls.guide].reference == "Westfall", "detours preserve an explicitly entered zone")
        view.input:SetText(""); click(view.book); click(view.guideAdventureButtons[3])
        assert(calls.guide[#calls.guide].kind == "passport" and calls.guide[#calls.guide].reference == ""
            and #calls.send == sentBeforeGuide, "passport ignores the field and every adventure remains an unsent draft")
        click(view.book); click(view.guidePages.quests); click(view.guideClose)
        view.frame:SetSize(400, 300); layout()
        assert(view.footer.shown and view.footerHint.shown and not view.destination.shown and view.destinationTick.shown and view.minimize.shown,
            "below 420 the status footer remains available, the TO label becomes a tick and minimize stays in the title strip")
        view.frame:SetSize(50, 50); layout()
        assert(view.frame.width == 260 and view.frame.height == 280, "small resize is clamped to the 260 by 280 minimum")
        assert(view.tabs.claude.shown and view.tabs.codex.shown and not view.gem.shown and view.close.shown and view.input.shown
            and view.send.shown and view.contextButton.shown and view.appearanceButton.shown,
            "the minimum layout keeps tabs, close, terminal, input, send and settings reachable")
        click(view.book); layout()
        assert(view.guidePanel.shown and view.guideQuestButtons[3].shown and view.guideLootPlan.shown,
            "all guide controls fit the minimum window")
        click(view.guideClose)
        snapshot.status = "Queue is full. Retry when the desktop agent has acknowledged the retained prompts."
        view:Render(snapshot)
        assert(view.footerHint.shown and view.footerHint.text == snapshot.status and not view.status.shown
            and view.feedbackHover.allPoints == view.footerHint, "minimum width retains actionable feedback and its full-text hover target")
        view.feedbackHover.scripts.OnEnter(view.feedbackHover)
        assert(tip.shown and tip.owner == view.feedbackHover and tip.text == snapshot.status and tip.wrap,
            "narrow feedback exposes the complete actionable message in the tooltip")
        view.feedbackHover.scripts.OnLeave(view.feedbackHover)
        assert(not tip.shown, "leaving the feedback target dismisses its tooltip")
        view.feedbackHover.scripts.OnEnter(view.feedbackHover)
        view.feedbackHover:Hide()
        assert(not tip.shown, "hiding feedback also dismisses its owned tooltip")
        view.feedbackHover:Show()
        click(view.contextButton); layout()
        assert(view.contextButton.label.text == "Context" and view.contextPanel.shown and view.contextRefresh.shown,
            "enabled context remains reachable at minimum width")
        click(view.contextToggle); layout()
        assert(not snapshot.context.enabled and view.contextToggle.shown and not view.contextRefresh.shown,
            "context can be paused at minimum width")
        click(view.contextToggle); click(view.contextClose)
        click(view.appearanceButton); layout()
        assert(view.appearancePanel.shown and view.panelLarger.shown,
            "all Appearance controls remain within the smallest window")
        click(view.appearanceClose)
        snapshot.status = "Connected"; view:Render(snapshot)
        assert(view.rowOffset > 0 and view.rows[view.visibleRows].text == "Claude terminal row 40", "small viewport retains terminal prompt end")
        click(view.keysButton); click(view.keysCopy); layout()
        assert(view.copyPanel.shown and view.copyBox.text:find("Claude terminal row 40$"), "copy fits the 260 by 280 minimum")
        click(view.copyClose)
        view.frame:SetSize(9000, 9000); layout()
        assert(view.frame.width <= _G.UIParent.width and view.frame.height <= _G.UIParent.height, "large resize stays on screen")
        assert(view:FittedCols() <= 160 and view:FittedCols() >= 40, "FittedCols stays within the 40..160 ring envelope bound")
        view.resize.scripts.OnMouseUp(view.resize, "LeftButton")
        assert(#calls.saved == 1 and calls.saved[1].width == view.frame.width, "released resize persists dimensions")
        view.frame:SetPoint("TOPLEFT", _G.UIParent, "TOPLEFT", 35, -29)
        view.drag.scripts.OnDragStop(view.drag)
        assert(calls.saved[2].x == 35 and calls.saved[2].y == -29, "drag persists released anchor")
        view.frame:SetPoint("CENTER", _G.UIParent, "CENTER", 0, 0)
        view.frame:SetSize(900, 720); layout()
        snapshot.scroll = { offset = 5, max = 100 }
        click(view.minimize); layout()
        assert(view.frame.height == 50 and not view.content.shown and not view.resize.shown, "minimize retains only the bar")
        assert(view.minimize.normalAtlas == "RedButton-Expand", "the collapsed bar offers the stock expand button")
        if not options.noStockFrame then
            local topLeft, bottomLeft = view.chrome.TopLeftCorner, view.chrome.BottomLeftCorner
            assert(topLeft.height + bottomLeft.height == 50 + 16 + 8 and topLeft.height < 75 and bottomLeft.height <= 32
                and topLeft.texCoord[3] == 0 and bottomLeft.texCoord[4] == 1 and view.chrome.TopRightCorner.height == topLeft.height,
                "the bar shares its height between the top and bottom corners, keeping their outer ends")
            assert(not view.headerEdge.shown, "the stock metal is the bar's only bottom edge")
        end
        assert(not view.scrollMarker.shown, "the bar carries no scrollback marker")
        snapshot.scroll = nil
        assert(view.header.height == 50 and view.tabs.claude.label.text == "CLAUDE" and view.tabs.codex.label.text == "CODEX"
            and view.tabs.claude.width >= 60, "the bar retains named agent tabs")
        local expandedHeight = view.expandedHeight
        snapshot.unread = { claude = true, codex = true }; view:Render(snapshot); layout()
        assert(view.tabs.claude.unread.shown and view.tabs.codex.unread.shown, "both tabs can flag unseen output while collapsed")
        assert(view.tabs.codex.unread.width == 6 and not view.tabs.codex.unread.label.shown, "collapsed badges are compact dots")
        assert(view.drag.kind == "Button" and view.tabs.claude:GetFrameLevel() > view.drag:GetFrameLevel(),
            "tabs stay clickable above the double-click bar")
        view.drag.scripts.OnDoubleClick(view.drag, "RightButton")
        assert(view.minimized, "other mouse buttons do not expand the bar")
        view.input:SetFocus()
        view.drag.scripts.OnDoubleClick(view.drag, "LeftButton"); layout()
        assert(view.frame.height == expandedHeight and view.content.shown and not view.input.focused,
            "double-click restores height without taking keyboard focus")
        assert(options.noStockFrame or (view.chrome.TopLeftCorner.height == 75 and view.chrome.BottomLeftCorner.height == 32
            and view.headerEdge.shown), "expanding restores the full stock corners")
        assert(calls.saved[#calls.saved].minimized == false, "double-click expansion persists")
        assert(not view.tabs.codex.unread.label.shown and view.tabs.codex.unread.width == 6
            and view.tabs.codex.unread.backdropColor[1] > view.tabs.codex.unread.backdropColor[2], "expanded tabs retain the restrained amber unread dot")
        assert(contrast(view.tabs.codex.label.textColor, view.headerBG.gradient[2]) >= 4.5, "inactive tab text stays readable with unseen output")
        snapshot.unread.claude = false; view:Render(snapshot)
        assert(not view.tabs.claude.unread.shown and view.tabs.codex.unread.shown, "reading one tab does not clear the other's badge")
        snapshot.opacity = 0; view:Render(snapshot)
        assert(view.tabs.codex.unread.shown and view.tabs.codex.unread.backdropColor[4] == 1, "unread badge remains readable at zero opacity")
        view.drag.scripts.OnDoubleClick(view.drag, "LeftButton"); layout()
        assert(view.minimized and view.frame.height == 50, "double-click also collapses the expanded terminal")
        click(view.minimize); layout()
        assert(view.frame.height == expandedHeight and view.content.shown, "existing expand button shares the same saved size")
        snapshot.unread.codex = false; view:Render(snapshot)
        assert(not view.tabs.codex.unread.shown, "cleared output badge is removed on render")
        -- Link states
        snapshot.combat = true; view:Render(snapshot); layout()
        assert(view.stateWord.text == "PAUSED · COMBAT" and view.combatBanner.shown and not view.gem.diamond.shown
            and view.gem.barLeft.shown, "combat shows the pause gem and the frozen banner")
        assert(view.accentBar.color[1] > view.accentBar.color[2] and view.accentBar.color[2] > view.accentBar.color[3], "combat accent bar is solid amber")
        snapshot.combat = false; snapshot.stale = true; snapshot.staleCount = 2; view:Render(snapshot); layout()
        assert(view.stateWord.text == "STALE · 2" and not view.combatBanner.shown and view.staleButton.shown, "stale shows a count and a resend badge")
        assert(view.accentBar.color[1] > view.accentBar.color[2], "stale echoes into the accent bar")
        if options.noStockFrame then assert(view.frame.borderColor[1] > view.frame.borderColor[2], "the fallback edge echoes stale") end
        click(view.staleButton); assert(calls.resend == 1, "the stale badge retries retained input")
        snapshot.stale = false; snapshot.staleCount = 0
        snapshot.status = "Ring exhausted without a fresh host. Start host, then /witch reset"
        view:Render(snapshot)
        assert(view.footerHint.text == snapshot.status, "actionable controller notices reach the user")
        snapshot.status = "Connected"
        snapshot.connected = false; snapshot.sessions[1].lines = {}; view:Render(snapshot); layout()
        assert(view.stateWord.text == "DISCONNECTED" and view.accentBar.color[1] > view.accentBar.color[2] and view.gem.core.shown,
            "offline shows a hollow gem and the red accent")
        if options.noStockFrame then assert(view.frame.borderColor[1] > view.frame.borderColor[2], "the fallback edge echoes offline") end
        assert(view.empty.shown and view.empty.text == "The cauldron is cold" and view.emptyGlyph.shown, "offline empty state")
        assert(view.send.shown and view.send.text == "Send", "send stays live so prompts queue for the next link")
        snapshot.connected = true; view:Render(snapshot)
        assert(view.empty.text == "Awaiting terminal" and view.emptyHint.text:find("Claude", 1, true) and not view.emptyGlyph.shown,
            "connected empty state identifies the selected agent while waiting for the first screen")
        for i = 1, 40 do snapshot.sessions[1].lines[i] = "Claude terminal row " .. i end
        snapshot.queued = 1; view:Render(snapshot); layout()
        assert(view.send.text == "Queued" and view.inputRule.color[1] > view.inputRule.color[2]
            and view.status.text == "1 queued for CLAUDE", "in-flight prompts show an explicit queued state")
        snapshot.queued = 0; view:Render(snapshot)
        assert(view.send.text == "Send")
        snapshot.fontSize = 20; view:Render(snapshot)
        assert(view.fontSize == 20 and view.rows[1].fontSize == 20, "view honors the controller's supported font range")
        assert(not view.fontBanner.shown, "no banner while the bundled font loads")
        local top, heartbeat = {}, {}
        for i = 1, 22 do top[i] = { 85, 170, 255 }; heartbeat[i] = { 255, 0, 85 } end
        view:RenderStrip(top, heartbeat)
        local unit = 6 * 768 / 1080 / _G.UIParent:GetEffectiveScale()
        assert(view.strip.parent == _G.UIParent and view.strip.width == unit * 22 and view.strip.height == unit * 2)
        local stripGeometry = geometry()
        assert(stripGeometry(view.strip).x == 0 and stripGeometry(view.strip).y == 0, "strip stays at screen origin")
        assert(math.abs(stripGeometry(view.strip.cells[2][1]).y - unit) < .000001, "heartbeat is second physical row")
        assert(view.strip.cells[1][1].color[1] == 85 / 255 and view.strip.cells[2][1].color[1] == 1)
        snapshot.opacity = 0; view:Render(snapshot)
        assert(view.strip.shown and view.strip.width == unit * 22 and view.strip.height == unit * 2)
        assert(view.strip.cells[1][1].color[1] == 85 / 255 and view.strip.cells[2][1].color[1] == 1,
            "appearance changes never change active pixel transport geometry, visibility or colors")
        view:RenderStrip(nil, heartbeat)
        assert(view.strip.cells[1][1].color[1] == 0 and view.strip.cells[2][1].color[1] == 1, "idle top is black, independent of heartbeat")
        assert(view.burst == nil, "burst carrier surface is allocated only when explicitly armed")
        local burstRows = {}
        for row = 1, 22 do
            burstRows[row] = {}
            for column = 1, 22 do burstRows[row][column] = { row * 20, column * 20, 85 } end
        end
        local stripWidth, stripHeight = view.strip.width, view.strip.height
        local stripHeartbeat = view.strip.cells[2][1].color[1]
        view:RenderBurst(burstRows)
        assert(view.burst and view.burst.shown and #view.burst.cells == 22 and #view.burst.cells[1] == 22)
        assert(view.burst.parent == _G.UIParent and view.burst.width == unit * 22 and view.burst.height == unit * 22)
        local burstGeometry = geometry()
        assert(math.abs(burstGeometry(view.burst).x) < .000001
            and math.abs(burstGeometry(view.burst).y - unit * 2) < .000001,
            "burst begins immediately below the two live strip rows")
        assert(math.abs(burstGeometry(view.burst.cells[22][22]).x - unit * 21) < .000001
            and math.abs(burstGeometry(view.burst.cells[22][22]).y - unit * 23) < .000001,
            "burst renders a fixed twenty-two by twenty-two physical-cell page")
        assert(view.burst.cells[1][1].color[1] == 20 / 255
            and view.burst.cells[22][22].color[1] == 1,
            "burst colors use the same bounded RGB conversion")
        assert(view.strip.shown and view.strip.width == stripWidth and view.strip.height == stripHeight
            and view.strip.cells[2][1].color[1] == stripHeartbeat,
            "arming the probe preserves the proven live strip")
        view:RenderBurst(nil)
        assert(not view.burst.shown and view.strip.shown, "stopping the probe hides only its sibling surface")
        view.input:SetFocus(); view.input.scripts.OnEscapePressed(view.input)
        assert(view:IsShown() and not view.input.focused and calls.hide == 0, "Escape in the input only leaves the input")
        click(view.close)
        assert(not view:IsShown() and not view.input.focused and view.strip.shown, "hiding terminal releases focus without hiding transport")
        assert(not controller.visible and calls.hide == 1, "the close button synchronizes controller visibility")
        view:Show()
        view:ToggleMinimized(); click(view.book); layout()
        assert(not view.minimized and view.guidePanel.shown and view.guideReference.focused,
            "the book opens Guides from a collapsed window")
        click(view.guidePages.adventures); view:ToggleMinimized(); click(view.book); layout()
        assert(not view.minimized and view.guidePage == "adventures" and view.guideAdventureButtons[1].shown
            and view.guideReference.focused, "Adventures reopens from collapse with its selected page and reference focus")
        click(view.guideClose); view:ToggleMinimized(); view.input:SetText("")
        local beforePrefill = #calls.send
        assert(view:Prefill("Review this guide draft") and not view.minimized and view.content.shown and view.input.focused,
            "slash composition can expand a collapsed window into a focused draft")
        assert(#calls.send == beforePrefill and view.input.text == "Review this guide draft", "expansion never submits the draft")
        view.input:SetFocus(); view.frame:Hide()
        assert(not view.input.focused and calls.hide == 2, "a frame hide from elsewhere clears focus and routes visibility")
        view:RenderStrip(nil, nil); assert(not view.strip.shown, "controller can shut down both strip rows")
    end, debug.traceback)
    restore()
    assert(ok, err)
    if not options.fontFailure then
        local fallback = assert(loadfile("tests/witchcraft/view.lua"))()({ fixture = true, fontFailure = true, width = 620, height = 380 })
        local fallbackOK, fallbackError = xpcall(function()
            assert(fallback.view.fontFallback and fallback.view.fontBanner.shown
                and fallback.view.fontBannerText.text:find("Restart", 1, true), "font failure is a visible banner with the fix")
            assert(fallback.view.rows[1].font == "Fonts\\ARIALN.TTF", "failed bundled font gets readable native fallback")
            fallback.layout()
            local bounds = fallback.geometry()
            local banner, panel, input = bounds(fallback.view.fontBanner), bounds(fallback.view.terminal), bounds(fallback.view.input)
            assert(panel.y + panel.height <= banner.y and banner.y + banner.height <= input.y, "banner sits between terminal and composer")
            fallback.click(fallback.view.larger); fallback.layout()
            assert(fallback.view.fontSize == 11, "font controls change requested size")
            fallback.click(fallback.view.fontBannerClose); fallback.layout()
            assert(not fallback.view.fontBanner.shown, "the banner can be dismissed and does not block use")
        end, debug.traceback)
        fallback.restore(); assert(fallbackOK, fallbackError)
        for _, scale in ipairs({ .85, 1.25 }) do
            local scaled = assert(loadfile("tests/witchcraft/view.lua"))()({ fixture = true, scale = scale })
            local scaledOK, scaledError = xpcall(function()
                scaled.layout()
                local colors = {}; for i = 1, 22 do colors[i] = { 0, 85, 255 } end
                scaled.view:RenderStrip(colors, colors)
                local cellWidth = scaled.view.strip.cells[1][1].width
                assert(math.abs(cellWidth * 1080 / 768 * scale - 6) < .000001, "strip cells remain six physical pixels across scales")
            end, debug.traceback)
            scaled.restore(); assert(scaledOK, scaledError)
        end
        -- Small and large layouts, both font paths, all link states and every popover.
        -- This exercises complete control bounds independently of the visual preview.
        for _, failedFont in ipairs({ false, true }) do
            local fit = assert(loadfile("tests/witchcraft/view.lua"))()({ fixture = true, fontFailure = failedFont })
            local fitOK, fitError = xpcall(function()
                for _, width in ipairs({ 260, 420, 620, 900 }) do
                    for _, height in ipairs({ 280, 650 }) do
                        for _, fontSize in ipairs({ 10, 20 }) do
                            for _, state in ipairs({ "linked", "offline", "combat", "stale" }) do
                                fit.snapshot.fontSize = fontSize
                                fit.snapshot.connected = state ~= "offline"
                                fit.snapshot.combat, fit.snapshot.stale = state == "combat", state == "stale"
                                fit.snapshot.staleCount = 2
                                fit.snapshot.sessions[1].lines = (state == "linked" or state == "offline") and {} or { "prompt" }
                                fit.snapshot.context = { enabled = true }
                                fit.view.frame:SetSize(width, height)
                                fit.view:Render(fit.snapshot)
                                for _, panel in ipairs({ false, "context", "appearance", "keys", "copy", "guide" }) do
                                    fit.view.openPanel = panel or nil
                                    for _, page in ipairs(panel == "guide" and { "quests", "adventures" } or { "quests" }) do
                                        fit.view:SetGuidePage(page)
                                        local fits, failure = pcall(fit.layout)
                                        assert(fits, table.concat({ tostring(failedFont), width, height, fontSize, state,
                                            tostring(panel), page }, "/") .. ": " .. tostring(failure))
                                    end
                                end
                            end
                        end
                    end
                end
            end, debug.traceback)
            fit.restore(); assert(fitOK, fitError)
        end
    end
end
