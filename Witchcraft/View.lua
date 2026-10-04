local _, ns = ...
local View = {}
View.__index = View
ns.View = View

-- The client's own metal window frame around the terminal, in the client's
-- font colours; controls, status and text remain native, independently readable regions.
local MONO = "Interface\\AddOns\\Witchcraft\\Media\\DejaVuSansMono.ttf"
-- Every label uses the client's Friz Quadrata, the face behind GameFontNormal. Arial Narrow is only the
-- terminal's fallback when the bundled mono cannot load.
local TERMINAL_FALLBACK = "Fonts\\ARIALN.TTF"
local LABEL_FONT = "Fonts\\FRIZQT__.TTF"
local WHITE = "Interface\\Buttons\\WHITE8X8"
local BOOK_ICON = "Interface\\Icons\\INV_Misc_Book_09"
-- Stock nine-slice layout of the client's minimizable windows; Forever re-offsets it for its Camelot art.
local FRAME_LAYOUT = "ButtonFrameTemplateNoPortraitMinimizable"
local MAX_ROWS, CELLS, BURST_ROWS = 60, 22, 22
-- TITLE is the metal title strip the stock layout draws; the toolbar row sits below it.
local TITLE, HEADER, ACCENT, COMPOSER, FOOTER, BAR, PAD, BANNER = 22, 60, 1, 44, 36, 50, 22, 24
-- The strip of answers shown while the selected agent waits on a choice menu.
local CHOICES, CHOICE_MIN, MAX_CHOICES = 32, 64, 9
local COLLAPSE = { word = 740, font = 620, keys = 520, footer = 420 }
-- The "Window layer" setting, as frame strata: above panels, today's layer, or beneath them.
local LAYERS = { top = "FULLSCREEN_DIALOG", normal = "DIALOG", back = "MEDIUM" }
-- Labels use the client's NORMAL (gold), HIGHLIGHT (white), GRAY, ORANGE and RED font colours.
local C = {
    body = { 12, 12, 12 }, rowBacking = { 0, 0, 0 }, frameBrass = { 128, 104, 24 }, brassBright = { 255, 209, 0 },
    parchHi = { 28, 28, 28 }, parchLo = { 12, 12, 12 }, ink = { 255, 209, 0 }, inkSoft = { 255, 209, 0 },
    text = { 255, 255, 255 }, muted = { 160, 160, 160 },
    claude = { 232, 158, 115 }, claudeDeep = { 196, 110, 66 }, codex = { 102, 212, 189 }, codexDeep = { 35, 150, 125 },
    warning = { 255, 128, 64 }, inkWarn = { 255, 128, 64 }, inkErr = { 255, 26, 26 }, pauseInk = { 255, 128, 64 },
    stale = { 255, 26, 26 }, staleDim = { 153, 20, 20 }, staleText = { 255, 64, 64 }, staleRing = { 178, 26, 26 },
    onAccent = { 26, 15, 8 }, onWarning = { 40, 20, 8 }, tabText = { 255, 255, 255 },
    bannerFill = { 60, 40, 0 }, bannerText = { 255, 209, 0 }, combatFill = { 20, 10, 4 }, done = { 26, 255, 26 },
}
for key, value in pairs(C) do C[key] = { value[1] / 255, value[2] / 255, value[3] / 255, 1 } end
-- Slash commands offered by the "/" menu, in groups separated by dividers. A command marked `args`
-- is prefilled for the player to finish; the rest are typed with Enter at once. Pickers they open
-- (/model, /resume) are driven from Keys. Claude Code's come from its documentation; Codex's from
-- codex-rs/tui/src/slash_command.rs. Commands that exit, log out or delete a session are left out.
local COMMANDS = {
    claude = {
        { { "/model", "Choose the model" }, { "/effort", "Set reasoning effort: low, medium, high or max", args = true },
          { "/fast", "Toggle fast mode" }, { "/plan", "Plan before changing anything" } },
        { { "/compact", "Compress the conversation; add a focus if you like", args = true },
          { "/context", "Show context window usage" }, { "/usage", "Show session and plan usage" } },
        { { "/resume", "Reopen an earlier session" }, { "/rewind", "Return to an earlier checkpoint" },
          { "/clear", "Start a new conversation; this tab may mirror your desktop session" } },
        { { "/permissions", "Tool permissions" }, { "/mcp", "MCP servers" }, { "/memory", "Edit memory" },
          { "/config", "Settings" }, { "/help", "Command help" } },
    },
    codex = {
        { { "/model", "Choose the model and reasoning effort" }, { "/permissions", "Choose what Codex is allowed to do" },
          { "/plan", "Switch to Plan mode" } },
        { { "/compact", "Summarize the conversation to stay under the context limit" },
          { "/status", "Session configuration and token usage" }, { "/usage", "Account usage" } },
        { { "/review", "Review changes; add what to review if you like", args = true },
          { "/diff", "Show the git diff, including untracked files" } },
        { { "/new", "Start a new chat" }, { "/resume", "Resume a saved chat" }, { "/fork", "Fork the current chat" },
          { "/mcp", "List MCP tools" }, { "/init", "Create an AGENTS.md" } },
    },
}

local function clamp(value, low, high, fallback)
    if type(value) ~= "number" or value ~= value then value = fallback or low end
    return math.max(low, math.min(high, value))
end
local function plain(value)
    return type(value) == "string" and (value:gsub("|", "||"):gsub("[%z\1-\31\127]", " ")) or ""
end
local function inputText(value)
    return type(value) == "string" and (value:gsub("[%z\1-\31\127]", "")) or ""
end
-- The client's edit boxes store a typed | as || (Blizzard's own AccountLogin.lua undoes the same).
-- Drafts and history keep that form, which SetText round-trips; what is sent or searched is what
-- the player typed.
local function typed(value)
    return type(value) == "string" and (value:gsub("||", "|")) or ""
end
-- Terminal rows carry the daemon's colour runs and escaped pipes (wowtext.js); the copy box wants the plain text back.
local function unmarked(value)
    return (value:gsub("|(.)(%x?%x?%x?%x?%x?%x?%x?%x?)", function(kind, hex)
        if kind == "|" then return "|" .. hex end
        if kind == "c" and #hex == 8 then return "" end
        if kind == "r" then return hex end
        return "|" .. kind .. hex
    end))
end
local function place(widget, parent, x, y, width, height)
    widget:ClearAllPoints()
    widget:SetPoint("TOPLEFT", parent, "TOPLEFT", x, -y)
    widget:SetSize(width, height)
end
local function show(widget, visible) if visible then widget:Show() else widget:Hide() end end
local function rgb(color, alpha) return color[1], color[2], color[3], alpha or color[4] or 1 end
local function paint(texture, color, alpha) texture:SetColorTexture(rgb(color, alpha)) end
local function gradient(texture, orientation, from, to, fromAlpha, toAlpha)
    if texture.SetGradient and _G.CreateColor then
        texture:SetColorTexture(1, 1, 1, 1)
        texture:SetGradient(orientation, _G.CreateColor(from[1], from[2], from[3], fromAlpha or 1),
            _G.CreateColor(to[1], to[2], to[3], toAlpha or 1))
    else
        texture:SetColorTexture(from[1], from[2], from[3], fromAlpha or 1)
    end
end
local function rotate(texture) if texture.SetRotation then texture:SetRotation(math.rad(45)) end end
local function text(parent, size, color, options)
    options = options or {}
    local label = parent:CreateFontString(nil, "OVERLAY")
    label:SetFont(LABEL_FONT, size, "")
    label:SetTextColor(rgb(color or C.text))
    if options.shadow == false then label:SetShadowColor(0, 0, 0, 0) else label:SetShadowColor(0, 0, 0, .9) end
    label:SetShadowOffset(1, -1)
    label:SetJustifyH(options.justify or "LEFT"); label:SetJustifyV("MIDDLE")
    label:SetWordWrap(false); label:SetMaxLines(1); label:SetText("")
    return label
end
local function fill(parent, color, alpha, layer)
    local texture = parent:CreateTexture(nil, layer or "BACKGROUND")
    paint(texture, color, alpha); return texture
end
local function backdrop(frame, edge)
    frame:SetBackdrop({ bgFile = WHITE, edgeFile = WHITE, edgeSize = edge or 1 })
end
-- A stock spellbook icon, cropped of its built-in edge like the client's own icon buttons.
local function book(parent)
    local glyph = CreateFrame("Button", nil, parent)
    glyph.icon = glyph:CreateTexture(nil, "ARTWORK")
    glyph.icon:SetTexture(BOOK_ICON)
    glyph.icon:SetTexCoord(.08, .92, .08, .92)
    glyph.Layout = function(self, size)
        place(self.icon, self, 0, 0, size, size)
    end
    glyph.Paint = function(self, _, _, alpha)
        self.icon:SetVertexColor(1, 1, 1, alpha or 1)
    end
    return glyph
end
local function session(snapshot, id)
    for _, value in ipairs(snapshot.sessions or {}) do if value.id == id then return value end end
    return { id = id, title = id == "codex" and "Codex" or "Claude", lines = {}, status = "Waiting" }
end
local function agentName(id) return id == "codex" and "CODEX" or "CLAUDE" end
-- The status of a tab whose terminal or console has exited or never started, or nil. Its last
-- screen stays on show, but nothing typed reaches it. These are the daemon's own words (pty.js, sessions.js).
local function stopped(value)
    local status = value.status
    return type(status) == "string" and (status:find("^exited") or status == "not started") and status or nil
end

-- A shared border and restrained hover treatment keeps the controls coherent.
local function repaint(widget)
    local tier = widget.tier
    if tier == "primary" then
        local color, factor = widget.accent or C.claude, widget.hover and 1 or .82
        local r, g, b = math.min(1, color[1] * factor), math.min(1, color[2] * factor), math.min(1, color[3] * factor)
        widget:SetBackdropColor(r * .19, g * .19, b * .19, 1); widget:SetBackdropBorderColor(r, g, b, .7)
        widget.label:SetTextColor(rgb(widget.textColor or C.text))
    elseif tier == "tab" then
        if widget.active then
            widget:SetBackdropColor(rgb(C.frameBrass, .18)); widget:SetBackdropBorderColor(rgb(C.frameBrass, .6))
            widget.label:SetTextColor(rgb(C.tabText))
        else
            widget:SetBackdropColor(rgb(C.frameBrass, widget.hover and .13 or 0)); widget:SetBackdropBorderColor(0, 0, 0, 0)
            widget.label:SetTextColor(rgb(widget.hover and C.ink or C.muted))
        end
    elseif tier == "secondary" then
        local border = widget.hover and C.brassBright or widget.accent or C.frameBrass
        widget:SetBackdropColor(rgb(C.body, .7)); widget:SetBackdropBorderColor(rgb(border, .7))
        widget.label:SetTextColor(rgb(widget.textColor or C.text))
    else
        widget:SetBackdropColor(0, 0, 0, 0); widget:SetBackdropBorderColor(0, 0, 0, 0)
        local color, alpha = widget.textColor or C.inkSoft, widget.hover and 1 or .75
        widget.label:SetTextColor(color[1], color[2], color[3], alpha)
        if widget.icon then widget.icon:SetVertexColor(color[1], color[2], color[3], alpha) end
    end
end
local function style(widget, tier, options)
    options = options or {}
    widget.tier, widget.accent, widget.textColor = tier, options.accent, options.textColor
    if options.caption then widget.label:SetText(options.caption) end
    repaint(widget)
end
local function tooltip(widget, body)
    local tip = _G.GameTooltip
    if not tip then return end
    tip:SetOwner(widget, "ANCHOR_TOP")
    tip:SetText(body, 1, 1, 1, 1, true)
    tip:Show()
end
local function hideTooltip(widget)
    local tip = _G.GameTooltip
    if tip and tip:IsOwned(widget) then tip:Hide() end
end
-- The client's red panel button. Its template owns the art, the gold-to-white label and the hover;
-- an open panel is shown with its locked highlight.
local function stockButton(parent, caption, action)
    local widget = CreateFrame("Button", nil, parent, "UIPanelButtonTemplate")
    widget.tier = "stock"; widget:SetText(caption); widget:SetScript("OnClick", action)
    return widget
end
local function lit(widget, on) if on then widget:LockHighlight() else widget:UnlockHighlight() end end
local function button(parent, caption, action, tier, options)
    options = options or {}
    local widget = CreateFrame("Button", nil, parent, "BackdropTemplate")
    backdrop(widget, 1)
    widget.label = text(widget, options.size or 12, nil, { justify = "CENTER", shadow = options.shadow })
    widget.label:SetAllPoints(widget); widget.label:SetText(caption)
    widget:SetScript("OnClick", action)
    widget:SetScript("OnEnter", function(self)
        self.hover = true; repaint(self)
        if self.tooltip then tooltip(self, self.tooltip) end
    end)
    widget:SetScript("OnLeave", function(self) self.hover = nil; repaint(self); hideTooltip(self) end)
    widget:SetScript("OnHide", function(self) self.hover = nil; repaint(self); hideTooltip(self) end)
    style(widget, tier, options)
    return widget
end

function View:Bounds()
    local width = math.max(260, (UIParent:GetWidth() or 1024) - 24)
    local height = math.max(220, (UIParent:GetHeight() or 768) - 24)
    return math.min(260, width), math.min(280, height), math.min(1600, width), math.min(1100, height)
end

function View:Save()
    local point, _, relativePoint, x, y = self.frame:GetPoint(1)
    -- Docking is a setting, not a place the player chose: keep their own position for undocking.
    if self.docked then
        local saved = self.snapshot and self.snapshot.view or {}
        point, relativePoint, x, y = saved.point, saved.relativePoint, saved.x, saved.y
    end
    self.controller:SaveView({ point = point or "CENTER", relativePoint = relativePoint or "CENTER",
        x = x or 0, y = y or 0, width = self.frame:GetWidth(),
        height = self.minimized and self.expandedHeight or self.frame:GetHeight(), minimized = self.minimized })
end

function View:LayoutHeader(width)
    local header, minimized = self.header, self.minimized
    local headerHeight = minimized and BAR or HEADER
    -- The stock art draws the title strip; the toolbar row below it gets the only header backing.
    local rowHeight = headerHeight - TITLE
    local function middle(size) return TITLE + (rowHeight - size) / 2 end
    place(header, self.frame, 0, 0, width, headerHeight)
    place(self.headerBG, header, 0, TITLE, width, rowHeight)
    -- The bar's bottom is the stock metal edge; the rule separates the header only from the terminal.
    place(self.headerEdge, header, PAD, headerHeight - 1, width - 2 * PAD, 1); show(self.headerEdge, not minimized)
    place(self.drag, header, 0, 0, width, headerHeight)
    place(self.titleBar, header, 0, 0, width, TITLE)
    -- Stock title placement: 30 in from the left, clear of the two buttons on the right.
    place(self.brand, self.titleBar, 30, 4, math.max(1, width - 84), 14)
    -- Stock button anchors: the close button sits at the frame's top right, minimize directly left of it.
    self.close:ClearAllPoints(); self.close:SetPoint("TOPRIGHT", self.frame, "TOPRIGHT", -2, 1); self.close:SetSize(24, 24)
    self.minimize:ClearAllPoints(); self.minimize:SetPoint("RIGHT", self.close, "LEFT", 0, 0); self.minimize:SetSize(24, 24)
    local bookSize = minimized and 20 or 26
    place(self.book, header, 12, middle(bookSize), bookSize, bookSize)
    self.book:Layout(bookSize)
    self.divider:Hide(); self.barDivider:Hide()
    local tabX = 12 + bookSize + 10
    local tabHeight = minimized and 22 or 28
    local tabWidth = width < 360 and 60 or 78
    for _, id in ipairs({ "claude", "codex" }) do
        local tab = self.tabs[id]
        place(tab, header, tabX, middle(tabHeight), tabWidth, tabHeight)
        tab.label:SetAllPoints(tab); tab.label:SetText(agentName(id))
        place(tab.indicator, tab, 8, tabHeight - 1, tabWidth - 16, 1)
        place(tab.unread, header, tabX + tabWidth - 4, middle(tabHeight) - 2, 6, 6)
        tab.unread.label:Hide()
        tabX = tabX + tabWidth + 4
    end
    local x = width - 12
    local function right(widget, visible, controlWidth)
        show(widget, visible)
        if visible then
            x = x - controlWidth
            place(widget, header, x, middle(24), controlWidth, 24)
            x = x - 5
        end
    end
    right(self.appearanceButton, not minimized, 22)
    right(self.larger, not minimized and width >= COLLAPSE.font, 24)
    right(self.smaller, not minimized and width >= COLLAPSE.font, 24)
    local wordVisible = width >= (minimized and COLLAPSE.font or COLLAPSE.word)
    show(self.stateWord, wordVisible)
    if wordVisible then
        x = x - 108
        place(self.stateWord, header, x, middle(16), 108, 16)
        x = x - 10
    end
    show(self.gem, width >= 420)
    place(self.gem, header, x - 6, middle(6), 6, 6)
    place(self.gem.diamond, self.gem, 0, 0, 6, 6); place(self.gem.core, self.gem, 1, 1, 4, 4)
    place(self.gem.barLeft, self.gem, 0, 0, 2, 6); place(self.gem.barRight, self.gem, 4, 0, 2, 6)
    if minimized then
        show(self.status, width >= COLLAPSE.word)
        place(self.status, header, tabX + 8, middle(16), math.max(1, x - tabX - 26), 16)
    end
end

function View:LayoutPopovers(width, height, composerY, terminalHeight)
    local content = self.content
    -- Copy: over the terminal, inset by the pad, so the box holds the same rows at the same face.
    local copy, copyWidth, copyHeight = self.copyPanel, width - 2 * PAD, terminalHeight - 12
    place(copy, content, PAD, HEADER + ACCENT + 6, copyWidth, copyHeight)
    place(self.copyTitle, copy, PAD, 3, 44, 16)
    local modes = copyWidth >= 360
    show(self.copyScreen, modes); if not modes then self.copyReply:Hide() end
    place(self.copyScreen, copy, copyWidth - PAD - 16 - 6 - 150, 1, 70, 20)
    place(self.copyReply, copy, copyWidth - PAD - 16 - 6 - 76, 1, 76, 20)
    place(self.copyHint, copy, PAD + 50, 3, math.max(10, copyWidth - 2 * PAD - 50 - 22 - (modes and 156 or 0)), 16)
    place(self.copyClose, copy, copyWidth - PAD - 16, 0, 16, 22)
    place(self.copyRule, copy, PAD, 22, copyWidth - 2 * PAD, 1)
    place(self.copyBox, copy, PAD, 28, copyWidth - 2 * PAD, math.max(1, copyHeight - 28 - PAD))
    -- Write: over the terminal like Copy, with its actions along the bottom.
    local write = self.writePanel
    place(write, content, PAD, HEADER + ACCENT + 6, copyWidth, copyHeight)
    place(self.writeTitle, write, PAD, 3, 60, 16)
    place(self.writeHint, write, PAD + 64, 3, math.max(10, copyWidth - 2 * PAD - 64 - 22), 16)
    place(self.writeClose, write, copyWidth - PAD - 16, 0, 16, 22)
    place(self.writeRule, write, PAD, 22, copyWidth - 2 * PAD, 1)
    place(self.writeBox, write, PAD, 28, copyWidth - 2 * PAD, math.max(1, copyHeight - 28 - 34 - PAD))
    place(self.writeSend, write, copyWidth - PAD - 70, copyHeight - PAD - 24, 70, 22)
    place(self.writeCount, write, PAD, copyHeight - PAD - 24, math.max(10, copyWidth - 2 * PAD - 76), 22)
    -- Appearance: under the header, right edge.
    local panel, panelWidth = self.appearancePanel, math.min(260, width - 2 * PAD)
    local fontRow = width < COLLAPSE.font
    local panelHeight = fontRow and 182 or 148
    place(panel, content, width - PAD - panelWidth, HEADER + ACCENT + 6, panelWidth, panelHeight)
    place(self.appearanceTitle, panel, PAD, 3, panelWidth - 2 * PAD - 22, 16)
    place(self.appearanceClose, panel, panelWidth - PAD - 16, 0, 16, 22)
    place(self.appearanceRule, panel, PAD, 22, panelWidth - 2 * PAD, 1)
    place(self.opacityLabel, panel, PAD, 34, panelWidth - 2 * PAD - 50, 14)
    place(self.opacityValue, panel, panelWidth - PAD - 60, 34, 60, 14)
    place(self.opacitySlider, panel, PAD, 58, panelWidth - 2 * PAD, 14)
    place(self.sliderTrack, self.opacitySlider, 0, 6, panelWidth - 2 * PAD, 3)
    place(self.sliderFill, self.opacitySlider, 0, 6, 0, 3)
    local presetWidth = math.floor((panelWidth - 2 * PAD - 12) / 3)
    for i, preset in ipairs(self.opacityPresets) do place(preset, panel, PAD + (i - 1) * (presetWidth + 6), 82, presetWidth, 24) end
    show(self.fontLabel, fontRow); show(self.panelSmaller, fontRow); show(self.panelLarger, fontRow)
    place(self.fontLabel, panel, PAD, 116, panelWidth - 2 * PAD - 62, 24)
    place(self.panelSmaller, panel, panelWidth - PAD - 50, 117, 22, 22)
    place(self.panelLarger, panel, panelWidth - PAD - 22, 117, 22, 22)
    place(self.allSettings, panel, PAD, fontRow and 151 or 117, panelWidth - 2 * PAD, 24)
    -- Keys: above the composer, right edge.
    local keys, keysWidth = self.keysPanel, math.min(216, width - 2 * PAD)
    local keyHalf = (keysWidth - 2 * PAD - 6) / 2
    local composerEnter = width >= COLLAPSE.keys
    show(self.keysEnter, not composerEnter); show(self.keysCopy, not composerEnter); show(self.keysCommands, not composerEnter)
    local y = 34
    if not composerEnter then
        place(self.keysEnter, keys, PAD, y, keyHalf, 24); place(self.keysCopy, keys, PAD + keyHalf + 6, y, keyHalf, 24); y = y + 30
        place(self.keysCommands, keys, PAD, y, keysWidth - 2 * PAD, 24); y = y + 30
    end
    place(self.controls[2], keys, PAD, y, keysWidth - 2 * PAD, 24)
    local keyThird = (keysWidth - 2 * PAD - 12) / 3
    place(self.controls[3], keys, PAD, y + 30, keyThird, 24)
    place(self.controls[4], keys, PAD + keyThird + 6, y + 30, keyThird, 24)
    place(self.keysFind, keys, PAD + 2 * (keyThird + 6), y + 30, keyThird, 24)
    place(self.controls[5], keys, PAD, y + 64, keysWidth - 2 * PAD, 26)
    local keysHeight = y + 90 + 12
    place(keys, content, width - PAD - keysWidth, math.max(HEADER + ACCENT, composerY - 6 - keysHeight), keysWidth, keysHeight)
    place(self.keysTitle, keys, PAD, 3, keysWidth - 2 * PAD - 22, 16)
    place(self.keysClose, keys, keysWidth - PAD - 16, 0, 16, 22)
    place(self.keysRule, keys, PAD, 22, keysWidth - 2 * PAD, 1)
    -- Context: under the header, left edge.
    local find, findWidth = self.findPanel, math.min(300, width - 2 * PAD)
    local findInner = findWidth - 2 * PAD
    place(find, content, PAD, HEADER + ACCENT + 6, findWidth, 118)
    place(self.findTitle, find, PAD, 3, findInner - 22, 16)
    place(self.findClose, find, findWidth - PAD - 16, 0, 16, 22)
    place(self.findRule, find, PAD, 22, findInner, 1)
    place(self.findBox, find, PAD, 32, findInner, 24)
    local findHalf = (findInner - 6) / 2
    place(self.findOlder, find, PAD, 62, findHalf, 22)
    place(self.findNewer, find, PAD + findHalf + 6, 62, findHalf, 22)
    place(self.findResult, find, PAD, 90, findInner, 18)
    local context, contextWidth = self.contextPanel, math.min(290, width - 2 * PAD)
    local enabled = self.contextEnabled
    local inner = contextWidth - 2 * PAD
    place(self.contextTitle, context, PAD, 3, inner - 20, 16)
    place(self.contextClose, context, contextWidth - PAD - 16, 0, 16, 22)
    place(self.contextRule, context, PAD, 22, inner, 1)
    place(self.contextDiamond, context, PAD, 38, 7, 7)
    place(self.contextStatus, context, PAD + 12, 34, inner - 12, 14)
    show(self.contextPlayer, enabled); show(self.contextQuests, enabled); show(self.contextProgress, enabled)
    show(self.contextErrors, enabled); show(self.contextRefresh, enabled)
    local contextHeight
    if enabled then
        place(self.contextPlayer, context, PAD, 54, inner, 14)
        place(self.contextQuests, context, PAD, 74, inner, 14)
        place(self.contextProgress, context, PAD, 94, inner, 14)
        place(self.contextErrors, context, PAD, 114, inner, 14)
        place(self.contextHint, context, PAD, 134, inner, 34)
        local half = math.floor((inner - 6) / 2)
        place(self.contextToggle, context, PAD, 176, half, 24)
        place(self.contextRefresh, context, PAD + half + 6, 176, inner - half - 6, 24)
        contextHeight = 212
    else
        place(self.contextHint, context, PAD, 54, inner, 17)
        place(self.contextToggle, context, PAD, 79, inner, 24)
        contextHeight = 115
    end
    place(context, content, PAD, HEADER + ACCENT + 6, contextWidth, math.min(contextHeight, height - HEADER - ACCENT - 6))
    -- Guides fit even at the minimum window size; all actions prepare drafts.
    local guide, guideWidth = self.guidePanel, math.min(340, width - 2 * PAD)
    local guideInner, guideHeight = guideWidth - 2 * PAD, 200
    place(guide, content, PAD, math.min(HEADER + ACCENT + 6, math.max(0, height - guideHeight - 6)), guideWidth, guideHeight)
    place(self.guideTitle, guide, PAD, 3, guideInner - 22, 16)
    place(self.guideClose, guide, guideWidth - PAD - 16, 0, 16, 22)
    place(self.guideRule, guide, PAD, 22, guideInner, 1)
    local half = (guideInner - 6) / 2
    place(self.guidePages.quests, guide, PAD, 28, half, 20)
    place(self.guidePages.adventures, guide, PAD + half + 6, 28, half, 20)
    place(self.guideLabel, guide, PAD, 53, guideInner, 14)
    place(self.guideReference, guide, PAD, 70, guideInner, 24)
    place(self.guideQuestLabel, guide, PAD, 99, guideInner, 14)
    local third = (guideInner - 8) / 3
    for i, control in ipairs(self.guideQuestButtons) do place(control, guide, PAD + (i - 1) * (third + 4), 116, third, 22) end
    for i, control in ipairs(self.guideRoleButtons) do place(control, guide, PAD + (i - 1) * (third + 4), 116, third, 22) end
    place(self.guideLootAdd, guide, PAD, 144, half, 22)
    place(self.guideLootPlan, guide, PAD + half + 6, 144, half, 22)
    for i, control in ipairs(self.guideAdventureButtons) do place(control, guide, PAD + (i - 1) * (third + 4), 144, third, 22) end
    place(self.guideHint, guide, PAD, 172, guideInner, 24)
    self:RenderGuidePage()
end

function View:Layout()
    if self.layingOut then return end
    self.layingOut = true
    local frame = self.frame
    local minW, minH, maxW, maxH = self:Bounds()
    local width = clamp(frame:GetWidth(), minW, maxW, 900)
    local height = self.minimized and BAR or clamp(frame:GetHeight(), minH, maxH, 650)
    frame:SetSize(width, height)
    frame:SetResizeBounds(minW, self.minimized and BAR or minH, maxW, maxH)
    self:CropCorners(height)
    self:LayoutHeader(width)
    place(self.accentBar, frame, PAD, HEADER, width - 2 * PAD, ACCENT)
    self.content:SetAllPoints(frame)
    show(self.content, not self.minimized)
    show(self.resize, not self.minimized and not self.locked)
    show(self.accentBar, not self.minimized)
    self:PaintMinimize()
    if not self.minimized then
        local content = self.content
        local footerVisible = true
        local composerY = height - COMPOSER - (footerVisible and FOOTER or 0)
        local bannerVisible = self.fontFallback and not self.bannerDismissed
        local choicesVisible = self.choiceMenu ~= nil and self:State() == "linked" and self.settings.showChoices ~= false
        local terminalBottom = composerY - (bannerVisible and BANNER or 0) - (choicesVisible and CHOICES or 0)
        local terminalHeight = math.max(34, terminalBottom - HEADER - ACCENT)
        place(self.terminal, content, 0, HEADER + ACCENT, width, terminalHeight)
        self.rowBacking:SetAllPoints(self.terminal)
        local lineHeight = self.fontSize + 3
        self.visibleRows = math.min(MAX_ROWS, self.requestedRows or 40, math.max(1, math.floor((terminalHeight - 20) / lineHeight)))
        for i, row in ipairs(self.rows) do
            place(row, self.terminal, PAD, 10 + (i - 1) * lineHeight, width - 2 * PAD, lineHeight)
            show(row, i <= self.visibleRows)
        end
        local smallEmpty = terminalHeight < 170
        local glyphY = math.max(2, math.floor((terminalHeight - 150) / 2))
        place(self.emptyGlyph, self.terminal, math.floor((width - 44) / 2), glyphY, 44, 44); self.emptyGlyph:Layout(44)
        place(self.empty, self.terminal, PAD, smallEmpty and 16 or glyphY + 58, width - 2 * PAD, 22)
        place(self.emptyHint, self.terminal, PAD, smallEmpty and 42 or glyphY + 83, width - 2 * PAD, 32)
        place(self.emptyHint2, self.terminal, PAD, smallEmpty and 79 or glyphY + 120, width - 2 * PAD, 32)
        self.smallEmpty = smallEmpty
        local bannerWidth = math.min(300, width - 2 * PAD)
        place(self.combatBanner, self.terminal, math.floor((width - bannerWidth) / 2), math.floor(terminalHeight * .44) - 15, bannerWidth, 30)
        place(self.combatBanner.barLeft, self.combatBanner, PAD, 9, 3, 12)
        place(self.combatBanner.barRight, self.combatBanner, PAD + 5, 9, 3, 12)
        place(self.combatBanner.label, self.combatBanner, PAD + 14, 0, bannerWidth - PAD - 20, 30)
        local staleWidth = math.min(170, width - 2 * PAD)
        place(self.staleButton, self.terminal, width - PAD - staleWidth, 10, staleWidth, 22)
        local markerWidth = math.min(120, width - 2 * PAD)
        place(self.scrollMarker, self.terminal, width - PAD - markerWidth, terminalHeight - 14, markerWidth, 14)
        show(self.choiceBar, choicesVisible)
        place(self.choiceBar, content, 0, terminalBottom, width, CHOICES)
        self:LayoutChoices(width, choicesVisible)
        show(self.fontBanner, bannerVisible)
        place(self.fontBanner, content, 0, composerY - BANNER, width, BANNER)
        place(self.fontBannerText, self.fontBanner, PAD, 0, math.max(40, width - PAD - 100), BANNER)
        place(self.fontBannerClose, self.fontBanner, width - PAD - 62, 1, 62, 22)
        place(self.composerBG, content, 14, composerY, width - 28, COMPOSER)
        place(self.composerEdge, content, PAD, composerY, width - 2 * PAD, 1)
        local x = width - PAD
        local function right(widget, visible, controlWidth)
            show(widget, visible)
            -- The stock button art is drawn for 22 points; it is centred in the composer.
            if visible then x = x - controlWidth; place(widget, content, x, composerY + 11, controlWidth, 22); x = x - 4 end
        end
        right(self.copyButton, width >= COLLAPSE.keys, 58)
        right(self.keysButton, true, width < 420 and 48 or 56)
        right(self.enterButton, width >= COLLAPSE.keys, 62)
        right(self.send, true, 62)
        right(self.commandsButton, width >= COLLAPSE.keys, 30)
        local labelVisible = width >= COLLAPSE.footer
        show(self.destination, labelVisible); show(self.destinationTick, not labelVisible)
        place(self.destination, content, PAD, composerY + 14, 66, 16)
        place(self.destinationTick, content, PAD, composerY + 14, 3, 16)
        local inputX = PAD + (labelVisible and 72 or 9)
        local inputWidth = math.max(20, x + 6 - 6 - inputX)
        place(self.input, content, inputX, composerY + 10, inputWidth, 24)
        place(self.inputRule, self.input, 0, 23, inputWidth, 1)
        show(self.footer, footerVisible)
        place(self.footer, content, 0, height - FOOTER, width, FOOTER)
        self.footerBG:SetAllPoints(self.footer)
        local contextWidth = width >= 420 and 114 or 64
        place(self.contextButton, self.footer, PAD, 0, contextWidth, 18)
        place(self.contextButton.diamond, self.contextButton, 0, 6, 5, 5)
        self.contextButton.label:ClearAllPoints()
        self.contextButton.label:SetPoint("TOPLEFT", self.contextButton, "TOPLEFT", 10, 0)
        self.contextButton.label:SetSize(contextWidth - 10, 18)
        local counterWidth = width >= 620 and 230 or 0
        show(self.status, counterWidth > 0)
        place(self.status, self.footer, width - PAD - counterWidth, 0, counterWidth, 18)
        self.footerHint:Show()
        local hintX = PAD + contextWidth + 10
        place(self.footerHint, self.footer, hintX, 0, math.max(1, width - PAD - counterWidth - 6 - hintX), 18)
        place(self.resize, frame, width - 22, height - 22, 16, 16)
        self:LayoutPopovers(width, height, composerY, terminalHeight)
    end
    show(self.appearancePanel, not self.minimized and self.openPanel == "appearance")
    show(self.keysPanel, not self.minimized and self.openPanel == "keys")
    show(self.contextPanel, not self.minimized and self.openPanel == "context")
    show(self.copyPanel, not self.minimized and self.openPanel == "copy")
    show(self.findPanel, not self.minimized and self.openPanel == "find")
    show(self.writePanel, not self.minimized and self.openPanel == "write")
    show(self.guidePanel, not self.minimized and self.openPanel == "guide")
    self.layingOut = false
end

function View:ApplyOpacity(value)
    self.opacity = math.floor(clamp(value, 0, 100, 80) + .5)
    local alpha = self.opacity / 100
    local glass = alpha < .5
    self.frame:SetBackdropColor(rgb(C.body, alpha))
    gradient(self.headerBG, "VERTICAL", C.parchHi, C.parchLo, glass and .92 or 1, glass and .92 or 1)
    self.terminal:SetBackdropColor(0, 0, 0, 0); self.terminal:SetBackdropBorderColor(0, 0, 0, 0)
    paint(self.rowBacking, C.rowBacking, .35)
    if glass then paint(self.composerBG, C.rowBacking, .35); paint(self.footerBG, C.rowBacking, .35)
    else paint(self.composerBG, C.parchHi, .06); paint(self.footerBG, C.parchHi, 0) end
    self.input:SetBackdropColor(0, 0, 0, 0); self.input:SetBackdropBorderColor(0, 0, 0, 0)
    for _, panel in ipairs({ self.appearancePanel, self.keysPanel, self.contextPanel, self.copyPanel, self.guidePanel, self.findPanel,
        self.writePanel }) do
        -- Popovers cover terminal text, so they stay near-opaque at every slider value.
        panel:SetBackdropColor(rgb(C.body, .96))
        panel:SetBackdropBorderColor(rgb(C.frameBrass))
    end
    self.opacityValue:SetText(self.opacity .. "%")
    self.settingOpacity = true; self.opacitySlider:SetValue(self.opacity); self.settingOpacity = false
    local trackWidth = self.sliderTrack:GetWidth() or 0
    self.sliderFill:SetSize(math.max(0, trackWidth * alpha), 3)
    self.glass = glass
end

function View:ToggleMinimized()
    self.input:ClearFocus()
    self.frame:StopMovingOrSizing()
    self.openPanel = nil
    if not self.minimized then self.expandedHeight = self.frame:GetHeight() end
    self.minimized = not self.minimized
    self.frame:SetSize(self.frame:GetWidth(), self.minimized and BAR or self.expandedHeight or 650)
    self:Save()
    self:Render(self.snapshot)
end

function View:TogglePanel(panel)
    self.input:ClearFocus()
    if self.minimized then
        self.minimized = false; self.frame:SetSize(self.frame:GetWidth(), self.expandedHeight or 650); self:Save()
    end
    self.openPanel = self.openPanel ~= panel and panel or nil
    self:Layout()
    if self.openPanel == "copy" then self:FillCopy() end
    if self.openPanel == "find" then self.findBox:SetFocus() end
    if self.openPanel == "write" then self.writeBox:SetFocus() end
    if self.openPanel == "guide" then self.guideReference:SetFocus() end
    if self.snapshot then self:RenderKeys() end
end

-- The copy box takes the rows the terminal shows right now, as plain text, and
-- hands them to the keyboard highlighted; it does not follow later renders.
function View:FillCopy(mode)
    local reply = session(self.snapshot or {}, self.activeTab or "claude").reply
    self.copyMode = mode == "reply" and type(reply) == "table" and "reply" or "screen"
    local lines = {}
    if self.copyMode == "reply" then
        for i, line in ipairs(reply) do lines[i] = line end
    else
        for i = 1, self.rowCount or 0 do lines[i] = unmarked(self.rows[i]:GetText() or "") end
    end
    style(self.copyScreen, self.copyMode == "screen" and "primary" or "secondary", { accent = C[self.activeTab or "claude"] })
    style(self.copyReply, self.copyMode == "reply" and "primary" or "secondary", { accent = C[self.activeTab or "claude"] })
    show(self.copyReply, type(reply) == "table")
    self.copyText = table.concat(lines, "\n")
    self.copyBox:SetText(self.copyText)
    self.copyBox:HighlightText()
    self.copyBox:SetFocus()
end

-- Find: the nearest older or newer row containing the text, brought to the top of the pane.
function View:Find(step)
    local tab, query = self.activeTab, typed(inputText(self.findBox:GetText())):lower()
    if not tab or query == "" then self.findResult:SetText("Type text to find"); return false end
    local selected = session(self.snapshot or {}, tab)
    local history = type(selected.history) == "table" and selected.history or {}
    local lines = type(selected.lines) == "table" and selected.lines or {}
    local total = #history + #lines
    local function row(i) return i <= #history and history[i] or lines[i - #history] end
    if self.findQuery ~= query then self.findQuery, self.findIndex = query, nil end
    local from = self.findIndex or (step > 0 and (self.rowOffset or 0) + 1 or (self.rowOffset or 0) + (self.rowCount or 0))
    for i = from - step, step > 0 and 1 or total, -step do
        local value = row(i)
        if type(value) == "string" and unmarked(value):lower():find(query, 1, true) then
            self.findIndex = i
            local visible = self.visibleRows or MAX_ROWS
            local wanted = math.max(0, math.min(math.max(0, total - visible), total - i - visible + 1))
            local current = type(self.snapshot.scroll) == "table" and self.snapshot.scroll.offset or 0
            if wanted ~= current and self.controller.Scroll then self.controller:Scroll(tab, wanted - current) end
            self.findResult:SetText("Row " .. i .. " of " .. total)
            return true
        end
    end
    self.findResult:SetText(step > 0 and "No older match" or "No newer match")
    return false
end

-- The long-prompt editor sends its whole text through the controller's multi-part path.
function View:SendWritten()
    if not self.activeTab or not self.controller.SendLong then return end
    local ok, reason = self.controller:SendLong(self.activeTab, typed(self.writeBox:GetText()))
    if ok then
        self.writeBox:SetText(""); self.openPanel = nil; self:Layout()
        self.message = "Queued for " .. (self.activeTab == "codex" and "Codex" or "Claude")
    else self.message = plain(reason or "Unable to queue; your prompt is retained.") end
    self.writeCount:SetText(self.message); self:RenderStatus()
end

function View:SetFontSize(value)
    value = math.floor(clamp(value, 8, 20, 10))
    if self.fontSize == value then return end
    self.fontSize, self.fontFallback = value, false
    for _, row in ipairs(self.rows) do
        if not row:SetFont(MONO, value, "") then
            self.fontFallback = true; row:SetFont(TERMINAL_FALLBACK, value, "")
        end
    end
    if not self.input:SetFont(MONO, math.max(11, value), "") then
        self.fontFallback = true; self.input:SetFont(TERMINAL_FALLBACK, math.max(11, value), "")
    end
    self.copyBox:SetFont(self.fontFallback and TERMINAL_FALLBACK or MONO, value, "")
    if self.fontValue then self.fontValue:SetText(tostring(value)) end
end

-- The "/" menu: the active tab's commands in a client dropdown anchored to the button that opened it.
function View:OpenCommands(owner)
    local menu, tab = _G.MenuUtil, self.activeTab or "claude"
    if type(menu) ~= "table" or type(menu.CreateContextMenu) ~= "function" then
        self.message = "The client's command menu is unavailable; type the command instead."
        self:RenderStatus(); return false
    end
    menu.CreateContextMenu(owner, function(_, root)
        root:CreateButton("Write a long prompt...", function() self:TogglePanel("write") end)
        root:CreateDivider()
        root:CreateTitle((tab == "codex" and "Codex" or "Claude") .. " commands")
        for index, group in ipairs(COMMANDS[tab]) do
            if index > 1 then root:CreateDivider() end
            for _, entry in ipairs(group) do
                local choice = { command = entry[1], hint = entry[2], args = entry.args }
                local item = root:CreateButton(choice.args and (choice.command .. " ...") or choice.command,
                    function() self:RunCommand(tab, choice) end)
                if item and item.SetTooltip then
                    item:SetTooltip(function(tip) tip:SetText(choice.command, 1, 1, 1, 1, true); tip:AddLine(choice.hint, nil, nil, nil, true) end)
                end
            end
        end
        -- The player's own saved prompts are prefilled, never sent unseen.
        local snippets = self.snapshot and self.snapshot.snippets or {}
        root:CreateDivider()
        root:CreateTitle(#snippets > 0 and "Your snippets" or "No snippets: /witch snippet add <prompt>")
        for _, snippet in ipairs(snippets) do
            local label = #snippet > 40 and (snippet:sub(1, 37) .. "...") or snippet
            local item = root:CreateButton(label, function()
                self:Prefill(snippet, "Snippet ready. Review it, then Send.", "Draft kept. Send or clear it before choosing a snippet.")
            end)
            if item and item.SetTooltip then item:SetTooltip(function(tip) tip:SetText(snippet, 1, 1, 1, 1, true) end) end
        end
    end)
    return true
end

-- Keybinding: open, expand and focus the input, closing any popover over it.
function View:FocusInput()
    if self.minimized then self:ToggleMinimized() end
    self.openPanel = nil; self:Layout()
    self.input:SetFocus()
end

-- A shift-clicked link while typing here. The prompt gets readable text and the link's kind and id;
-- the Guides field keeps the raw link, which it already reads.
function View:InsertLink(link)
    if type(link) ~= "string" then return end
    if self.guideReference:HasFocus() then self.guideReference:Insert(link); return end
    if not self.input:HasFocus() then return end
    local name = link:match("|h%[(.-)%]|h") or link:match("%[(.-)%]")
    local kind, id = link:match("|H(%a+):(%-?%d+)")
    local readable = name and ("[" .. name .. "]" .. (kind and (" (" .. kind .. " " .. id .. ")") or "")) or plain(unmarked(link))
    self.input:Insert(inputText(readable))
end

-- Up and Down walk this tab's sent prompts, newest first; walking past the newest restores the draft.
function View:RecallHistory(step)
    local tab = self.activeTab
    local list = tab and self.history[tab]
    if not list or #list == 0 then return end
    if not self.historyIndex then self.historyStash = inputText(self.input:GetText()); self.historyIndex = 0 end
    self.historyIndex = math.max(0, math.min(#list, self.historyIndex + step))
    local value = self.historyIndex == 0 and self.historyStash or list[#list - self.historyIndex + 1]
    self.recalling = true; self.input:SetText(value or ""); self.recalling = false
    if self.input.SetCursorPosition then self.input:SetCursorPosition(#(value or "")) end
    if self.historyIndex == 0 then self.historyIndex, self.historyStash = nil, nil end
end

function View:RunCommand(tab, choice)
    local name = tab == "codex" and "Codex" or "Claude"
    if choice.args then
        return self:Prefill(choice.command .. " ", "Finish " .. choice.command .. " for " .. name .. ", then Send.",
            "Draft kept. Send or clear it before choosing a command.")
    end
    local ok, reason = self.controller:Send(tab, choice.command)
    self.message = ok and ("Sent " .. choice.command .. " to " .. name) or plain(reason or "Unable to queue the command.")
    self:RenderStatus()
    return ok
end

-- One button per option that fits, numbered as the terminal numbers them; the marked one is lit.
function View:LayoutChoices(width, visible)
    local menu, bar = self.choiceMenu, self.choiceBar
    local labelWidth = width >= COLLAPSE.keys and 96 or 0
    show(self.choiceLabel, visible and labelWidth > 0)
    place(self.choiceLabel, bar, PAD, 0, labelWidth, CHOICES)
    local count = visible and menu and math.min(#menu.options, MAX_CHOICES) or 0
    local x0 = PAD + (labelWidth > 0 and labelWidth + 6 or 0)
    local fits = math.max(1, math.floor((width - PAD - x0 + 4) / (CHOICE_MIN + 4)))
    local shown = math.min(count, fits)
    local buttonWidth = shown > 0 and math.floor((width - PAD - x0 - (shown - 1) * 4) / shown) or 0
    for i, control in ipairs(self.choiceButtons) do
        local on = i <= shown
        show(control, on)
        if on then
            place(control, bar, x0 + (i - 1) * (buttonWidth + 4), 5, buttonWidth, 22)
            -- Labels are terminal text, so their escape codes are shown, never rendered.
            control.option = plain(menu.options[i])
            control:SetText(i .. "  " .. control.option)
            if i == menu.selected then control:LockHighlight() else control:UnlockHighlight() end
        end
    end
    self.choicesShown = shown
end

function View:Choose(index)
    if not self.activeTab or not self.controller.Choose then return end
    local ok, reason = self.controller:Choose(self.activeTab, index)
    self.message = ok and ((self.activeTab == "codex" and "Codex" or "Claude") .. ": option " .. index .. " chosen")
        or plain(reason or "Unable to answer the menu.")
    -- The buttons leave at once; the controller keeps them away until the terminal shows a new screen.
    if ok then self.choiceMenu = nil; self:Layout() end
    self:RenderStatus()
end

-- A tab that wants the player while they look elsewhere: a raid-warning line and its sound.
function View:Alert(id, kind, want)
    want = want or {}
    local name = id == "codex" and "Codex" or "Claude"
    local line = kind == "waiting" and (name .. " needs you") or (name .. " finished")
    local notice, frame = _G.RaidNotice_AddMessage, _G.RaidWarningFrame
    local color = kind == "waiting" and C.stale or C.done
    if want.text ~= false and type(notice) == "function" and frame then
        pcall(notice, frame, line, { r = color[1], g = color[2], b = color[3] })
    end
    local sounds = _G.SOUNDKIT
    if want.sound ~= false and type(_G.PlaySound) == "function" and type(sounds) == "table" and sounds.RAID_WARNING then
        pcall(_G.PlaySound, sounds.RAID_WARNING)
    end
end

-- Window settings from the Options page, applied on every render.
function View:ApplySettings(settings, saved)
    self.settings = settings
    self.frame:SetFrameStrata(LAYERS[settings.layer] or LAYERS.normal)
    local docked = settings.docked == true
    self.locked = docked or settings.locked == true
    if docked then
        self.frame:ClearAllPoints(); self.frame:SetPoint("TOP", UIParent, "TOP", 0, -4)
    elseif self.docked then
        -- Undocking returns the window to the player's own saved place.
        self.frame:ClearAllPoints()
        self.frame:SetPoint(saved.point or "CENTER", UIParent, saved.relativePoint or saved.point or "CENTER",
            clamp(saved.x, -4000, 4000, 0), clamp(saved.y, -4000, 4000, 0))
    end
    self.docked = docked
    -- The client's Escape handler closes the frames named in UISpecialFrames; opt in only.
    local special = _G.UISpecialFrames
    if type(special) == "table" then
        local found
        for i = #special, 1, -1 do if special[i] == "WitchcraftTerminalFrame" then found = i end end
        if settings.escapeCloses == true and not found then special[#special + 1] = "WitchcraftTerminalFrame"
        elseif settings.escapeCloses ~= true and found then table.remove(special, found) end
    end
end

function View:Send()
    if not self.activeTab then return end
    local body = inputText(self.input:GetText())
    if body == "" then self.message = "Type a prompt, or use Enter to accept a terminal choice."; self:RenderStatus(); return end
    local ok, reason = self.controller:Send(self.activeTab, typed(body))
    if ok then
        local list = self.history[self.activeTab]
        if list[#list] ~= body then list[#list + 1] = body end
        while #list > (self.settings.historySize or 50) do table.remove(list, 1) end
        self.historyIndex, self.historyStash = nil, nil
        self.drafts[self.activeTab] = ""; self.input:SetText(""); self.input:ClearFocus()
        self.message = "Queued for " .. (self.activeTab == "codex" and "Codex" or "Claude")
    else self.message = plain(reason or "Unable to queue; your prompt is retained.") end
    self:RenderStatus()
end

function View:Prefill(prompt, ready, kept)
    if self.minimized then self:ToggleMinimized() end
    self.openPanel = nil; self:Layout()
    if inputText(self.input:GetText()) ~= "" then
        self.message = kept or "Draft kept. Send or clear it before choosing a guide action."
        self.input:SetFocus(); self:RenderStatus()
        return false, self.message
    end
    self.input:SetText(prompt); self.drafts[self.activeTab] = prompt
    self.message = ready or "Guide draft ready. Review it, then Send."
    self.input:SetFocus(); self:RenderStatus()
    return true
end

function View:ComposeGuide(kind, detail, useReference)
    local reference = useReference and self.guideReference:GetText() or ""
    if useReference and not reference:find("%S") then
        self.guideHint:SetText("Enter a quest or item above first.")
        self.guideReference:SetFocus()
        return
    end
    local ok, reason = self.controller:ComposeGuide(kind, reference, detail)
    if not ok then
        self.message = plain(reason or "Unable to prepare a guide draft.")
        self.guideHint:SetText(self.message); self:RenderStatus()
    end
end

function View:RenderGuidePage()
    local adventures = self.guidePage == "adventures"
    self.guideLabel:SetText(adventures and "Dungeon or zone (optional)" or "Quest / item name, link or ID")
    self.guideQuestLabel:SetText(adventures and (self.guideRole and ("Rehearsal role: " .. self.guideRole) or "Rehearsal role: choose one")
        or "Quest help - choose spoilers")
    for name, control in pairs(self.guidePages) do
        style(control, self.guidePage == name and "primary" or "secondary", { accent = C.codex })
    end
    for _, control in ipairs(self.guideQuestButtons) do show(control, not adventures) end
    show(self.guideLootAdd, not adventures); show(self.guideLootPlan, not adventures)
    for _, control in ipairs(self.guideRoleButtons) do
        show(control, adventures)
        style(control, self.guideRole == control.role and "primary" or "secondary", { accent = C.codex })
    end
    for _, control in ipairs(self.guideAdventureButtons) do show(control, adventures) end
end

function View:SetGuidePage(page)
    if page ~= "quests" and page ~= "adventures" then return false end
    if page ~= self.guidePage then
        self.guideReferences[self.guidePage] = inputText(self.guideReference:GetText())
        self.guidePage = page
        self.guideReference:SetText(self.guideReferences[page] or "")
    end
    self.guideHint:SetText("Draft only. Review, then Send.")
    self:Layout()
    if self.openPanel == "guide" then self.guideReference:SetFocus() end
    return true
end

function View:ComposeAdventure(kind)
    local reference = kind == "passport" and "" or self.guideReference:GetText()
    if kind == "rehearse" and reference:find("%S") and not self.guideRole then
        self.guideHint:SetText("Choose your rehearsal role above.")
        self.guideReference:ClearFocus()
        return
    end
    local ok, reason = self.controller:ComposeGuide(kind, reference, kind == "rehearse" and self.guideRole or nil)
    if not ok then
        self.message = plain(reason or "Unable to prepare an adventure draft.")
        self.guideHint:SetText(self.message); self:RenderStatus()
    end
end

function View:Action(action)
    if not self.activeTab then return end
    local ok, reason = self.controller:Action(self.activeTab, action)
    self.message = ok and ((self.activeTab == "codex" and "Codex" or "Claude") .. ": " .. action .. " queued")
        or plain(reason or "Unable to queue terminal action.")
    self.openPanel = nil; self:Layout(); self.input:ClearFocus(); self:RenderStatus()
end

function View:Resend()
    if self.controller.Resend then
        local ok, reason = self.controller:Resend()
        self.message = ok and "Retrying retained prompts" or plain(reason or "Unable to resend right now.")
        self:RenderStatus()
    end
end

-- Link state, in priority order: offline > combat > stale > linked.
function View:State()
    local snapshot = self.snapshot or {}
    -- A live session the host cannot hear for now (WoW in the background) is paused, not offline.
    if snapshot.paused then return "paused" end
    if snapshot.connected == false then return "offline" end
    if snapshot.combat then return "combat" end
    if snapshot.stale then return "stale" end
    return "linked"
end

-- "gpt-6-astra ultra · 121k/258k (47%)", or "claude-opus-5-5 · 517k context" when the window is not recorded.
function View:InfoText(tab)
    if self.settings.showStatus == false then return "" end
    local info = session(self.snapshot or {}, tab).info
    if type(info) ~= "table" or not (info.model or info.used) then return "" end
    local function k(n) return n >= 1000000 and string.format("%.1fM", n / 1000000) or (math.floor(n / 1000) .. "k") end
    local head = plain(info.model or "") .. (info.effort and (" " .. plain(info.effort)) or "")
    if not info.used then return head end
    local used = info.window and (k(info.used) .. "/" .. k(info.window) .. " (" .. math.floor(100 * info.used / info.window + .5) .. "%)")
        or (k(info.used) .. " context")
    return head ~= "" and (head .. " \194\183 " .. used) or used
end

function View:RenderStatus()
    local snapshot = self.snapshot or {}
    local state = self:State()
    local active = self.activeTab or "claude"
    local queued = math.floor(clamp(snapshot.queued, 0, 9999, 0))
    self.status:SetText(queued > 0 and (queued .. " queued for " .. agentName(active)) or self:InfoText(active))
    local quiet = self.glass and C.text or (self.minimized and C.inkSoft or C.muted)
    self.status:SetTextColor(rgb(queued > 0 and (self.minimized and C.inkWarn or C.warning) or quiet))
    local status = plain(snapshot.status)
    local selected = session(snapshot, active)
    local halted, name = stopped(selected), active == "codex" and "Codex: " or "Claude: "
    -- A joined session started before its WoW tools were registered cannot answer game questions.
    -- That is advice about the remote session, so the link's own notices and its loss come first.
    local ringNotice = status ~= "" and status ~= "Connected" and status
    local toolless = not halted and not ringNotice and state == "linked" and selected.tools == false
    local hint = self.message or (halted and name .. plain(halted)) or ringNotice
        or (toolless and name .. "no WoW tools. Run mcp-setup --apply, restart Claude, then Witchcraft")
        or (state == "linked" and "Ready" or "Link unavailable")
    self.footerHint:SetText(hint)
    local tone = { combat = C.warning, paused = C.warning, stale = C.staleText, offline = C.stale }
    self.footerHint:SetTextColor(rgb((not self.message and (halted or toolless) and C.warning) or tone[state] or quiet))
end

function View:RenderContext(snapshot)
    local context = type(snapshot.context) == "table" and snapshot.context or {}
    local enabled = context.enabled == true
    if self.contextEnabled ~= enabled then self.contextEnabled = enabled; self:Layout() end
    self.contextButton.label:SetText(self.frame:GetWidth() < 420 and "Context" or (enabled and "Context shared" or "Context paused"))
    self.contextButton.textColor = enabled and C.codex or C.muted
    repaint(self.contextButton)
    paint(self.contextButton.diamond, enabled and C.codex or C.muted, enabled and 1 or .6)
    self.contextStatus:SetText(enabled and "Sharing: on" or "Sharing: off")
    self.contextStatus:SetTextColor(rgb(enabled and C.codex or C.muted))
    paint(self.contextDiamond, enabled and C.codex or C.muted, enabled and 1 or .6)
    local player, quests, progress = context.player or {}, context.quests or {}, context.progress or {}
    local function age(value)
        return type(value) == "number" and (" / " .. math.floor(clamp(value, 0, 99999)) .. "s ago") or ""
    end
    self.contextPlayer:SetText("Character: " .. plain(player.summary or player.status or "Waiting to share") .. age(player.age))
    self.contextQuests:SetText("Quests: " .. (quests.status == "Unavailable" and "Unavailable" or
        type(quests.count) == "number" and tostring(quests.count) .. " tracked" or
        plain(quests.status or "Waiting to share")) .. (quests.truncated and " / partial" or "") .. age(quests.age))
    self.contextProgress:SetText("Progress: " .. plain(progress.summary or progress.status or "Waiting to share") .. age(progress.age))
    -- Errors never go out with a refresh; until an agent asks, say so rather than "waiting".
    local errors = context.errors or {}
    self.contextErrors:SetText("Lua errors: " .. plain(errors.summary or "sent only when an agent asks") .. age(errors.age))
    if enabled then
        style(self.contextToggle, "secondary", { caption = "PAUSE" })
        self.contextHint:SetText("Shares character, quest and progress facts with your desktop agents.")
    else
        style(self.contextToggle, "primary", { caption = "ENABLE", accent = C[self.activeTab or "claude"] })
        self.contextHint:SetText("Sharing is paused.")
    end
    style(self.contextRefresh, "primary", { accent = C[self.activeTab or "claude"] })
end

function View:RenderKeys()
    lit(self.keysButton, self.openPanel == "keys"); lit(self.copyButton, self.openPanel == "copy")
    style(self.appearanceButton, "glyph", self.openPanel == "appearance" and { textColor = C.brassBright } or {})
end

-- Keep `keep` points of a corner atlas, from its top or its bottom, as the client's own corner cropping does.
local function cropCorner(piece, info, keep, fromTop)
    local file = info.file or info.filename
    if not (piece and file and info.height and info.height > 0) then return end
    local cut = math.max(0, math.min(keep, info.height)) / info.height * (info.bottomTexCoord - info.topTexCoord)
    piece:SetTexture(file)
    if fromTop then piece:SetTexCoord(info.leftTexCoord, info.rightTexCoord, info.topTexCoord, info.topTexCoord + cut)
    else piece:SetTexCoord(info.leftTexCoord, info.rightTexCoord, info.bottomTexCoord - cut, info.bottomTexCoord) end
    piece:SetSize(info.width, math.max(.01, math.min(keep, info.height)))
end

-- A single stock top corner is taller than the minimized bar, so the client's UpdateCornerCropping
-- (which trims only the bottom pair) still leaves the top corners hanging below it. Re-apply the
-- full layout, then share the frame's height between the pairs: the top corners keep the title
-- strip and the start of the rail, the bottom corners keep their foot.
function View:CropCorners(height)
    if not self.stockFrame then return end
    local nineSlice, textures = _G.NineSliceUtil, _G.C_Texture
    pcall(nineSlice.ApplyLayoutByName, self.chrome, FRAME_LAYOUT)
    local layout = nineSlice.GetLayout(FRAME_LAYOUT)
    if not (layout and type(textures) == "table" and type(textures.GetAtlasInfo) == "function") then return end
    local info = {}
    for _, name in ipairs({ "TopLeftCorner", "TopRightCorner", "BottomLeftCorner", "BottomRightCorner" }) do
        local ok, value = pcall(textures.GetAtlasInfo, layout[name] and layout[name].atlas)
        if not (ok and type(value) == "table" and value.height) then return end
        info[name] = value
    end
    local topHeight, bottomHeight = info.TopLeftCorner.height, info.BottomLeftCorner.height
    local total = height + (layout.TopLeftCorner.y or 0) - (layout.BottomLeftCorner.y or 0)
    if topHeight + bottomHeight <= total then return end
    local keepTop = math.min(topHeight, math.max(total - bottomHeight, (layout.TopLeftCorner.y or 0) + TITLE + 4))
    local keepBottom = math.max(0, total - keepTop)
    cropCorner(self.chrome.TopLeftCorner, info.TopLeftCorner, keepTop, true)
    cropCorner(self.chrome.TopRightCorner, info.TopRightCorner, keepTop, true)
    cropCorner(self.chrome.BottomLeftCorner, info.BottomLeftCorner, keepBottom, false)
    cropCorner(self.chrome.BottomRightCorner, info.BottomRightCorner, keepBottom, false)
end

-- The stock metal is never tinted; only the fallback edge echoes stale and offline.
function View:PaintBorder(color)
    if not self.stockFrame then self.frame:SetBackdropBorderColor(rgb(color)) end
end

function View:RenderState(snapshot, active)
    local state = self:State()
    local accent, deep = C[active], C[active .. "Deep"]
    local gem = self.gem
    show(gem.diamond, state ~= "combat"); show(gem.core, state == "offline")
    show(gem.barLeft, state == "combat"); show(gem.barRight, state == "combat")
    paint(gem.barLeft, C.pauseInk); paint(gem.barRight, C.pauseInk); paint(gem.core, C.parchLo)
    local staleCount = math.floor(clamp(snapshot.staleCount, 0, 9999, 0))
    if state == "linked" then
        paint(gem.diamond, deep); self.stateWord:SetText("LINKED"); self.stateWord:SetTextColor(rgb(C.ink))
        gradient(self.accentBar, "HORIZONTAL", accent, accent, 1, .15)
        self:PaintBorder(C.frameBrass)
    elseif state == "paused" then
        paint(gem.diamond, C.warning)
        self.stateWord:SetText("PAUSED"); self.stateWord:SetTextColor(rgb(C.inkWarn))
        paint(self.accentBar, C.warning)
        self:PaintBorder(C.frameBrass)
    elseif state == "combat" then
        self.stateWord:SetText("PAUSED · COMBAT"); self.stateWord:SetTextColor(rgb(C.inkWarn))
        paint(self.accentBar, C.warning)
        self:PaintBorder(C.frameBrass)
    elseif state == "stale" then
        paint(gem.diamond, C.staleDim)
        self.stateWord:SetText("STALE · " .. staleCount); self.stateWord:SetTextColor(rgb(C.inkErr))
        paint(self.accentBar, C.stale)
        self:PaintBorder(C.staleDim)
    else
        paint(gem.diamond, C.staleRing)
        self.stateWord:SetText("DISCONNECTED"); self.stateWord:SetTextColor(rgb(C.inkErr))
        paint(self.accentBar, C.stale)
        self:PaintBorder(C.stale)
    end
    show(self.combatBanner, state == "combat" and not self.minimized)
    show(self.staleButton, state == "stale" and not self.minimized and self.controller.Resend ~= nil)
    self.staleButton.label:SetText(staleCount .. " STALE · RESEND")
    local queued = math.floor(clamp(snapshot.queued, 0, 9999, 0))
    if queued > 0 then
        self.send:SetText("Queued")
        paint(self.inputRule, C.warning)
    else
        self.send:SetText("Send")
        paint(self.inputRule, C.brassBright)
    end
end

function View:Render(snapshot)
    self.snapshot = snapshot or {}
    snapshot = self.snapshot
    if self.lastStatus ~= snapshot.status then self.message = nil; self.lastStatus = snapshot.status end
    local active = snapshot.activeTab == "codex" and "codex" or "claude"
    -- A tab that stops (its console closed) replaces any earlier action's message in the footer.
    local halted = stopped(session(snapshot, active))
    if self.lastHalted ~= halted then self.message = nil; self.lastHalted = halted end
    if self.activeTab ~= active then
        if self.activeTab then self.drafts[self.activeTab] = inputText(self.input:GetText()) end
        self.activeTab = active; self.input:SetText(self.drafts[active] or ""); self.input:ClearFocus(); self.message = nil
    end
    local saved = snapshot.view or {}
    if not self.initialized then
        self.initialized = true
        self.minimized = saved.minimized == true
        self.expandedHeight = clamp(saved.height, 280, 1100, 650)
        self.frame:SetSize(clamp(saved.width, 260, 1600, 900), self.minimized and BAR or self.expandedHeight)
        local anchors = { TOPLEFT = true, TOP = true, TOPRIGHT = true, LEFT = true, CENTER = true,
            RIGHT = true, BOTTOMLEFT = true, BOTTOM = true, BOTTOMRIGHT = true }
        local point = anchors[saved.point] and saved.point or "CENTER"
        local relativePoint = anchors[saved.relativePoint] and saved.relativePoint or point
        self.frame:ClearAllPoints()
        self.frame:SetPoint(point, UIParent, relativePoint,
            clamp(saved.x, -4000, 4000, 0), clamp(saved.y, -4000, 4000, 0))
    end
    self:ApplySettings(snapshot.settings or {}, saved)
    self:SetFontSize(snapshot.fontSize or saved.fontSize or 10)
    self.requestedRows = math.floor(clamp(snapshot.rows, 1, MAX_ROWS, 40))
    self.contextEnabled = type(snapshot.context) == "table" and snapshot.context.enabled == true
    local waiting = session(snapshot, active)
    local answered = type(snapshot.answered) == "table" and snapshot.answered[active] == true
    self.choiceMenu = waiting.state == "waiting" and not stopped(waiting) and not answered
        and type(waiting.choices) == "table" and waiting.choices or nil
    self:Layout()
    if self.controller.SetViewportRows then
        snapshot.scroll = self.controller:SetViewportRows(self.visibleRows or MAX_ROWS) or snapshot.scroll
    end
    self:ApplyOpacity(snapshot.opacity)
    local selected = session(snapshot, active)
    local accent = C[active]
    for id, tab in pairs(self.tabs) do
        local isActive = id == active
        local unread = snapshot.unread and snapshot.unread[id] == true
        local attention = snapshot.attention and snapshot.attention[id]
        tab.active = isActive; repaint(tab)
        paint(tab.indicator, C[id]); show(tab.indicator, isActive)
        -- Red: waiting on you. Green: finished. Amber: new output only.
        local badge = attention == "waiting" and C.stale or attention == "done" and C.done or C.warning
        tab.unread:SetBackdropColor(rgb(badge))
        show(tab.unread, unread or attention == "waiting" or attention == "done")
    end
    self.destination:SetText("TO " .. agentName(active)); self.destination:SetTextColor(rgb(accent))
    paint(self.destinationTick, accent)
    self:RenderKeys()
    local lines = type(selected.lines) == "table" and selected.lines or {}
    local history = type(selected.history) == "table" and selected.history or {}
    local scroll = type(snapshot.scroll) == "table" and snapshot.scroll or {}
    -- The rows are history .. lines; the window ends scrollOffset rows above the bottom.
    local historyCount, total = #history, #history + #lines
    local maximum = math.max(0, total - (self.visibleRows or MAX_ROWS))
    local scrollOffset = math.floor(clamp(scroll.offset, 0, maximum, 0))
    local last = total - scrollOffset
    local count = math.min(self.visibleRows or MAX_ROWS, last)
    local offset = last - count
    self.rowOffset, self.rowCount = offset, count
    for i, row in ipairs(self.rows) do
        -- The daemon escapes pipes and adds the color runs (wowtext.js); Ring only rejects controls. Preserve the runs.
        local index = i + offset
        local value = index <= historyCount and history[index] or lines[index - historyCount]
        row:SetText(i <= count and type(value) == "string" and value or "")
        show(row, not self.minimized and i <= count)
    end
    self.scrollMarker:SetText("\226\134\145 " .. scrollOffset .. (scrollOffset == 1 and " line" or " lines"))
    show(self.scrollMarker, scrollOffset > 0 and not self.minimized)
    local offline = snapshot.connected == false
    if offline then
        self.empty:SetText("The cauldron is cold")
        self.emptyHint:SetText("No daemon linked to this tab.")
        self.emptyHint2:SetText("Start the desktop daemon to reconnect.")
    else
        self.empty:SetText("Awaiting terminal")
        self.emptyHint:SetText("Your " .. (active == "codex" and "Codex" or "Claude") .. " session will appear here.")
        self.emptyHint2:SetText("")
    end
    local emptyVisible = total == 0 and not self.minimized
    show(self.empty, emptyVisible); show(self.emptyHint, emptyVisible); show(self.emptyHint2, emptyVisible and offline)
    show(self.emptyGlyph, emptyVisible and offline and not self.smallEmpty)
    self:RenderState(snapshot, active)
    self:RenderStatus()
    self:RenderContext(snapshot)
end

-- This sibling of the terminal window remains visible when the window hides.
-- The same physical-pixel conversion passed the in-game Phase 0 strip probe.
function View:RenderStrip(topColors, heartbeatColors)
    local _, physicalHeight = GetPhysicalScreenSize()
    local unit = 6 * (768 / math.max(1, physicalHeight)) / UIParent:GetEffectiveScale()
    self.strip:SetSize(CELLS * unit, 2 * unit)
    for row = 1, 2 do
        local colors = heartbeatColors
        if row == 1 then colors = topColors end
        for i = 1, CELLS do
            local cell = self.strip.cells[row][i]
            place(cell, self.strip, (i - 1) * unit, (row - 1) * unit, unit, unit)
            local color = type(colors) == "table" and colors[i] or nil
            local valid = type(color) == "table" and type(color[1]) == "number" and type(color[2]) == "number"
                and type(color[3]) == "number"
            cell:SetColorTexture(valid and clamp(color[1], 0, 255) / 255 or 0,
                valid and clamp(color[2], 0, 255) / 255 or 0, valid and clamp(color[3], 0, 255) / 255 or 0, 1)
        end
    end
    show(self.strip, topColors ~= nil or heartbeatColors ~= nil)
end

-- The carrier probe is a separate, explicitly armed surface below the live
-- strip. It is created lazily, stays at the same six physical pixels per cell,
-- and never replaces either terminal/context or heartbeat row.
function View:RenderBurst(rows)
    if rows == nil then
        if self.burst then self.burst:Hide() end
        return
    end
    if not self.burst then
        local burst = CreateFrame("Frame", nil, UIParent)
        burst:SetFrameStrata("TOOLTIP"); burst:SetFrameLevel(9999); burst.cells = {}
        for row = 1, BURST_ROWS do
            burst.cells[row] = {}
            for column = 1, CELLS do burst.cells[row][column] = burst:CreateTexture(nil, "OVERLAY") end
        end
        burst:Hide(); self.burst = burst
    end
    local _, physicalHeight = GetPhysicalScreenSize()
    local unit = 6 * (768 / math.max(1, physicalHeight)) / UIParent:GetEffectiveScale()
    self.burst:ClearAllPoints()
    self.burst:SetPoint("TOPLEFT", UIParent, "TOPLEFT", 0, -2 * unit)
    self.burst:SetSize(CELLS * unit, BURST_ROWS * unit)
    for row = 1, BURST_ROWS do
        local colors = type(rows) == "table" and rows[row] or nil
        for column = 1, CELLS do
            local cell = self.burst.cells[row][column]
            place(cell, self.burst, (column - 1) * unit, (row - 1) * unit, unit, unit)
            local color = type(colors) == "table" and colors[column] or nil
            local valid = type(color) == "table" and type(color[1]) == "number" and type(color[2]) == "number"
                and type(color[3]) == "number"
            cell:SetColorTexture(valid and clamp(color[1], 0, 255) / 255 or 0,
                valid and clamp(color[2], 0, 255) / 255 or 0, valid and clamp(color[3], 0, 255) / 255 or 0, 1)
        end
    end
    self.burst:Show()
end

-- The stock minimize button swaps between the client's condense and expand art.
function View:PaintMinimize()
    local atlas = self.minimized and "RedButton-Expand" or "RedButton-Condense"
    self.minimize:SetNormalAtlas(atlas); self.minimize:SetPushedAtlas(atlas .. "-Pressed")
    self.minimize:SetHighlightAtlas("RedButton-Highlight", "ADD")
end

function View:Show() self.frame:Show() end
function View:Hide() self.input:ClearFocus(); self.frame:Hide() end
function View:IsShown() return self.frame:IsShown() end

function View.Create(controller)
    local self = setmetatable({ controller = controller, rows = {}, drafts = {}, tabs = {}, controls = {}, buttons = {}, settings = {},
        history = { claude = {}, codex = {} } }, View)
    local function makeButton(parent, caption, action, tier, options)
        local widget = button(parent, caption, action, tier, options)
        self.buttons[#self.buttons + 1] = widget; return widget
    end
    local frame = CreateFrame("Frame", "WitchcraftTerminalFrame", UIParent, "BackdropTemplate")
    self.frame = frame
    frame:Hide(); frame:SetSize(900, 650); frame:SetPoint("CENTER", UIParent, "CENTER", 0, 0)
    frame:SetFrameStrata("DIALOG"); frame:SetMovable(true); frame:SetResizable(true)
    frame:SetClampedToScreen(true); frame:EnableMouse(true)
    local level = frame:GetFrameLevel()
    self.chrome = CreateFrame("Frame", nil, frame)
    self.chrome:SetAllPoints(frame); self.chrome:SetFrameLevel(level + 2); self.chrome:EnableMouse(false)
    -- The stock layout anchors its own pieces to the container. Without it, a plain edge keeps the window bounded.
    local nineSlice = _G.NineSliceUtil
    self.stockFrame = type(nineSlice) == "table" and type(nineSlice.GetLayout) == "function"
        and nineSlice.GetLayout(FRAME_LAYOUT) ~= nil and pcall(nineSlice.ApplyLayoutByName, self.chrome, FRAME_LAYOUT)
    -- Stock edge setup reads the layout back from the container.
    self.chrome.layoutType = FRAME_LAYOUT
    if self.stockFrame then frame:SetBackdrop({ bgFile = WHITE })
    else backdrop(frame, 2); frame:SetBackdropBorderColor(rgb(C.frameBrass)) end
    frame:SetBackdropColor(rgb(C.body, .8))
    -- Header strip
    local header = CreateFrame("Frame", nil, frame); header:SetFrameLevel(level + 1); self.header = header
    self.headerBG = header:CreateTexture(nil, "BACKGROUND")
    self.headerEdge = fill(header, C.frameBrass, 1, "BORDER")
    self.drag = CreateFrame("Button", nil, header)
    self.drag:SetFrameLevel(level + 2)
    self.drag:EnableMouse(true); self.drag:RegisterForDrag("LeftButton")
    self.drag:RegisterForClicks("LeftButtonUp")
    self.drag:SetScript("OnDragStart", function() if not self.locked then frame:StartMoving() end end)
    self.drag:SetScript("OnDragStop", function() frame:StopMovingOrSizing(); self:Save() end)
    self.drag:SetScript("OnDoubleClick", function(_, mouseButton)
        if mouseButton == "LeftButton" then self:ToggleMinimized() end
    end)
    self.book = book(header); self.book:SetFrameLevel(level + 3); self.book:Paint(C.ink, C.parchHi, 1)
    self.book:SetScript("OnClick", function()
        self.guideHint:SetText("Draft only. Review, then Send.")
        self:TogglePanel("guide")
    end)
    self.book:SetScript("OnEnter", function(widget) tooltip(widget, "Guides: quests, loot and adventures") end)
    self.book:SetScript("OnLeave", hideTooltip); self.book:SetScript("OnHide", hideTooltip)
    -- The title rides above the stock art, which covers the strip; it takes no mouse so the strip still drags.
    self.titleBar = CreateFrame("Frame", nil, header); self.titleBar:SetFrameLevel(level + 4); self.titleBar:EnableMouse(false)
    self.brand = text(self.titleBar, 12, C.ink, { justify = "CENTER" }); self.brand:SetText("Witchcraft")
    self.divider = fill(header, C.ink, .4, "ARTWORK")
    self.barDivider = fill(header, C.ink, .4, "ARTWORK")
    for _, id in ipairs({ "claude", "codex" }) do
        local tabID = id
        local tab = makeButton(header, agentName(id), function() controller:SelectTab(tabID) end, "tab", { size = 11, shadow = false })
        tab:SetFrameLevel(level + 3)
        tab.indicator = fill(tab, C[id], 1, "OVERLAY")
        tab.unread = CreateFrame("Frame", nil, header, "BackdropTemplate")
        backdrop(tab.unread, 1); tab.unread:SetFrameLevel(level + 4)
        tab.unread:SetBackdropColor(rgb(C.warning)); tab.unread:SetBackdropBorderColor(rgb(C.onWarning))
        tab.unread.label = text(tab.unread, 9, C.onWarning, { justify = "CENTER", shadow = false }); tab.unread.label:SetText("NEW")
        tab.unread:Hide()
        self.tabs[id] = tab
    end
    self.gem = CreateFrame("Frame", nil, header); self.gem:SetFrameLevel(level + 3)
    self.gem.diamond = fill(self.gem, C.claudeDeep, 1, "ARTWORK"); rotate(self.gem.diamond)
    self.gem.core = fill(self.gem, C.parchLo, 1, "OVERLAY"); rotate(self.gem.core)
    self.gem.barLeft = fill(self.gem, C.pauseInk, 1, "ARTWORK"); self.gem.barRight = fill(self.gem, C.pauseInk, 1, "ARTWORK")
    self.stateWord = text(header, 11, C.ink, { shadow = false }); self.stateWord:SetText("LINKED")
    local glyphOptions = { size = 12, shadow = false }
    self.smaller = makeButton(header, "A-", function() controller:SetFontSize(math.max(8, self.fontSize - 1)) end, "glyph", glyphOptions)
    self.larger = makeButton(header, "A+", function() controller:SetFontSize(math.min(20, self.fontSize + 1)) end, "glyph", glyphOptions)
    self.appearanceButton = makeButton(header, "...", function() self:TogglePanel("appearance") end, "glyph", glyphOptions)
    self.appearanceButton.tooltip = "Appearance: opacity, text size and all settings"
    -- The client's own red window buttons. Close keeps the view's Hide so focus and dragging are released first.
    self.close = CreateFrame("Button", nil, frame, "UIPanelCloseButton")
    self.close:SetScript("OnClick", function() self:Hide() end)
    self.minimize = CreateFrame("Button", nil, frame)
    self.minimize:SetScript("OnClick", function() self:ToggleMinimized() end)
    for _, widget in ipairs({ self.smaller, self.larger, self.appearanceButton }) do widget:SetFrameLevel(level + 3) end
    for _, widget in ipairs({ self.minimize, self.close }) do widget:SetFrameLevel(level + 5) end
    self.accentBar = frame:CreateTexture(nil, "ARTWORK")
    -- Body
    self.content = CreateFrame("Frame", nil, frame); self.content:SetFrameLevel(level + 1)
    self.terminal = CreateFrame("Frame", nil, self.content, "BackdropTemplate"); backdrop(self.terminal, 1)
    self.rowBacking = fill(self.terminal, C.rowBacking, .35)
    for i = 1, MAX_ROWS do self.rows[i] = text(self.terminal, 10) end
    self.emptyGlyph = book(self.terminal); self.emptyGlyph:Paint(C.brassBright, C.body, .55)
    self.empty = text(self.terminal, 17, C.text, { justify = "CENTER" })
    self.emptyHint = text(self.terminal, 13, C.muted, { justify = "CENTER" })
    self.emptyHint2 = text(self.terminal, 12, C.muted, { justify = "CENTER" })
    self.emptyHint:SetWordWrap(true); self.emptyHint:SetMaxLines(2)
    self.emptyHint2:SetWordWrap(true); self.emptyHint2:SetMaxLines(2)
    self.combatBanner = CreateFrame("Frame", nil, self.terminal, "BackdropTemplate"); backdrop(self.combatBanner, 1)
    self.combatBanner:SetFrameLevel(level + 6)
    self.combatBanner:SetBackdropColor(rgb(C.combatFill, .92)); self.combatBanner:SetBackdropBorderColor(rgb(C.warning))
    self.combatBanner.barLeft = fill(self.combatBanner, C.warning, 1, "ARTWORK")
    self.combatBanner.barRight = fill(self.combatBanner, C.warning, 1, "ARTWORK")
    self.combatBanner.label = text(self.combatBanner, 12, C.warning, { justify = "CENTER" })
    self.combatBanner.label:SetText("PAUSED FOR COMBAT · ROWS FROZEN"); self.combatBanner:Hide()
    self.staleButton = makeButton(self.terminal, "STALE · RESEND", function() self:Resend() end, "secondary",
        { size = 11, accent = C.stale, textColor = C.staleText })
    self.staleButton:SetFrameLevel(level + 6); self.staleButton:Hide()
    self.scrollMarker = text(self.terminal, 10, C.brassBright, { justify = "RIGHT" }); self.scrollMarker:Hide()
    -- The marker belongs to the terminal and draws an arrow Friz lacks, so it takes the terminal's faces.
    if not self.scrollMarker:SetFont(MONO, 10, "") then self.scrollMarker:SetFont(TERMINAL_FALLBACK, 10, "") end
    self.terminal:EnableMouseWheel(true)
    self.terminal:SetScript("OnMouseWheel", function(_, direction)
        -- Wheel up (positive) shows older rows, three per notch.
        if self.activeTab and controller.Scroll then controller:Scroll(self.activeTab, direction * 3) end
    end)
    -- Font banner
    self.fontBanner = CreateFrame("Frame", nil, self.content, "BackdropTemplate"); backdrop(self.fontBanner, 1)
    self.fontBanner:SetFrameLevel(level + 5)
    self.fontBanner:SetBackdropColor(rgb(C.bannerFill, .92)); self.fontBanner:SetBackdropBorderColor(rgb(C.warning))
    self.fontBannerText = text(self.fontBanner, 12, C.bannerText)
    self.fontBannerText:SetText("Bundled font missing. Using the client's mono. Restart the client to restore DejaVu Sans Mono.")
    self.fontBannerClose = makeButton(self.fontBanner, "DISMISS ×", function() self.bannerDismissed = true; self:Layout() end,
        "glyph", { size = 11, textColor = C.bannerText })
    self.fontBanner:Hide()
    -- Choice strip
    self.choiceBar = CreateFrame("Frame", nil, self.content, "BackdropTemplate"); backdrop(self.choiceBar, 1)
    self.choiceBar:SetFrameLevel(level + 5)
    self.choiceBar:SetBackdropColor(rgb(C.combatFill, .92)); self.choiceBar:SetBackdropBorderColor(rgb(C.frameBrass))
    self.choiceLabel = text(self.choiceBar, 11, C.ink); self.choiceLabel:SetText("Answer:")
    self.choiceButtons = {}
    for i = 1, MAX_CHOICES do
        local index = i
        local control = stockButton(self.choiceBar, tostring(i), function() self:Choose(index) end)
        -- Labels are cut to the button; the whole option is on hover.
        control:SetScript("OnEnter", function(widget) if widget.option then tooltip(widget, index .. ". " .. widget.option) end end)
        control:SetScript("OnLeave", hideTooltip)
        self.choiceButtons[i] = control
    end
    self.choiceBar:Hide()
    -- Composer
    self.composerBG = fill(self.content, C.parchHi, .06)
    self.composerEdge = fill(self.content, C.frameBrass, 1, "BORDER")
    self.destination = text(self.content, 10, C.claude)
    self.destinationTick = fill(self.content, C.claude, 1, "ARTWORK")
    self.input = CreateFrame("EditBox", nil, self.content, "BackdropTemplate")
    backdrop(self.input, 1); self.input:SetAutoFocus(false); self.input:SetMultiLine(false)
    self.input:SetMaxLetters(2048); self.input:SetTextInsets(8, 8, 0, 0); self.input:SetTextColor(rgb(C.text))
    self.input:SetText("")
    self.input:SetScript("OnEnterPressed", function() self:Send() end)
    -- Escape leaves the input and nothing more; the window closes only when asked to.
    self.input:SetScript("OnEscapePressed", function(widget) widget:ClearFocus() end)
    self.input:SetScript("OnKeyDown", function(_, key)
        -- A focused edit box already owns the keyboard, so only these keys are read
        -- here; everything else stays with the edit box's own handling.
        if key == "UP" then self:RecallHistory(1); return elseif key == "DOWN" then self:RecallHistory(-1); return end
        if not self.activeTab or not controller.Scroll then return end
        local page = math.max(1, (self.visibleRows or MAX_ROWS) - 1)
        if key == "PAGEUP" then controller:Scroll(self.activeTab, page)
        elseif key == "PAGEDOWN" then controller:Scroll(self.activeTab, -page)
        elseif key == "END" and controller.ScrollToBottom then controller:ScrollToBottom(self.activeTab) end
    end)
    self.input:SetScript("OnTextChanged", function(widget)
        local value = widget:GetText(); local clean = inputText(value)
        if value ~= clean then widget:SetText(clean) end
        -- Typing leaves the history walk; the next Up starts again from the newest prompt.
        if not self.recalling then self.historyIndex, self.historyStash = nil, nil end
    end)
    self.inputRule = fill(self.input, C.brassBright, 1, "OVERLAY")
    self.send = stockButton(self.content, "Send", function() self:Send() end)
    self.enterButton = stockButton(self.content, "Enter", function() self:Action("enter") end)
    self.controls[1] = self.enterButton
    self.keysButton = stockButton(self.content, "Keys", function() self:TogglePanel("keys") end)
    self.copyButton = stockButton(self.content, "Copy", function() self:TogglePanel("copy") end)
    self.commandsButton = stockButton(self.content, "/", function(widget) self:OpenCommands(widget) end)
    -- Footer
    self.footer = CreateFrame("Frame", nil, self.content)
    self.footerBG = fill(self.footer, C.parchHi, 0)
    self.contextButton = makeButton(self.footer, "WoW context", function() self:TogglePanel("context") end, "glyph",
        { size = 11, textColor = C.muted })
    self.contextButton.label:SetJustifyH("LEFT")
    self.contextButton.diamond = fill(self.contextButton, C.codex, 1, "ARTWORK"); rotate(self.contextButton.diamond)
    self.footerHint = text(self.footer, 11, C.muted)
    self.feedbackHover = CreateFrame("Frame", nil, self.footer)
    self.feedbackHover:SetAllPoints(self.footerHint); self.feedbackHover:EnableMouse(true)
    self.feedbackHover:SetScript("OnEnter", function(widget) tooltip(widget, self.footerHint:GetText()) end)
    self.feedbackHover:SetScript("OnLeave", hideTooltip)
    self.feedbackHover:SetScript("OnHide", hideTooltip)
    self.status = text(self.footer, 11, C.muted, { justify = "RIGHT" })
    self.resize = makeButton(frame, "", function() end, "glyph")
    self.resize.label:SetText("/"); self.resize.textColor = C.brassBright; repaint(self.resize)
    self.resize:SetScript("OnMouseDown", function(_, mouseButton)
        if mouseButton == "LeftButton" then frame:StartSizing("BOTTOMRIGHT") end
    end)
    self.resize:SetScript("OnMouseUp", function(_, mouseButton)
        if mouseButton == "LeftButton" then frame:StopMovingOrSizing(); self:Render(self.snapshot); self:Save() end
    end)
    -- Popovers share one pattern: brass frame, 22-point title row, close glyph.
    local function popover(title, close)
        local panel = CreateFrame("Frame", nil, self.content, "BackdropTemplate"); backdrop(panel, 2)
        panel:SetFrameLevel(level + 20); panel:EnableMouse(true)
        local caption = text(panel, 10, C.ink); caption:SetText(title)
        local closeButton = makeButton(panel, "×", close, "glyph", { size = 13, textColor = C.text })
        local rule = fill(panel, C.brassBright, .35, "ARTWORK")
        panel:Hide()
        return panel, caption, closeButton, rule
    end
    self.appearancePanel, self.appearanceTitle, self.appearanceClose, self.appearanceRule =
        popover("APPEARANCE", function() self:TogglePanel("appearance") end)
    self.opacityLabel = text(self.appearancePanel, 11, C.muted); self.opacityLabel:SetText("Background opacity")
    self.opacityValue = text(self.appearancePanel, 11, C.text, { justify = "RIGHT" })
    self.opacitySlider = CreateFrame("Slider", nil, self.appearancePanel)
    self.opacitySlider:EnableMouse(true)
    self.opacitySlider:SetOrientation("HORIZONTAL"); self.opacitySlider:SetMinMaxValues(0, 100)
    self.opacitySlider:SetValueStep(1); self.opacitySlider:SetObeyStepOnDrag(true)
    self.opacitySlider:SetThumbTexture(WHITE)
    local thumb = self.opacitySlider:GetThumbTexture(); thumb:SetSize(10, 14); thumb:SetVertexColor(rgb(C.brassBright))
    self.sliderTrack = fill(self.opacitySlider, C.muted, .35)
    self.sliderFill = fill(self.opacitySlider, C.brassBright, 1, "BORDER")
    self.opacitySlider:SetScript("OnValueChanged", function(_, value)
        if self.settingOpacity then return end
        local percent = math.floor(clamp(value, 0, 100, 80) + .5)
        if percent ~= self.opacity then controller:SetOpacity(percent) end
    end)
    self.opacityPresets = {}
    for _, pair in ipairs({ { "25%", 25 }, { "65%", 65 }, { "100%", 100 } }) do
        local percent = pair[2]
        self.opacityPresets[#self.opacityPresets + 1] = makeButton(self.appearancePanel, pair[1],
            function() controller:SetOpacity(percent) end, "secondary", { size = 11 })
    end
    self.fontLabel = text(self.appearancePanel, 11, C.muted); self.fontLabel:SetText("Terminal font")
    self.allSettings = makeButton(self.appearancePanel, "ALL SETTINGS...", function()
        self.openPanel = nil; self:Layout(); controller:OpenSettings()
    end, "secondary", { size = 10 })
    self.allSettings.tooltip = "Esc > Options > AddOns > Witchcraft"
    self.panelSmaller = makeButton(self.appearancePanel, "A-", function() controller:SetFontSize(math.max(8, self.fontSize - 1)) end,
        "glyph", { size = 12, textColor = C.text })
    self.panelLarger = makeButton(self.appearancePanel, "A+", function() controller:SetFontSize(math.min(20, self.fontSize + 1)) end,
        "glyph", { size = 12, textColor = C.text })
    self.keysPanel, self.keysTitle, self.keysClose, self.keysRule = popover("KEYS", function() self:TogglePanel("keys") end)
    self.keysEnter = makeButton(self.keysPanel, "ENTER", function() self:Action("enter") end, "secondary", { size = 11 })
    self.keysCopy = makeButton(self.keysPanel, "COPY", function() self:TogglePanel("copy") end, "secondary", { size = 11 })
    self.keysCommands = makeButton(self.keysPanel, "COMMANDS", function(widget) self:OpenCommands(widget) end, "secondary", { size = 11 })
    self.keysFind = makeButton(self.keysPanel, "FIND", function() self:TogglePanel("find") end, "secondary", { size = 11 })
    for _, pair in ipairs({ { "ESCAPE", "escape" }, { "UP", "up" }, { "DOWN", "down" }, { "INTERRUPT", "interrupt" } }) do
        local action = pair[2]
        self.controls[#self.controls + 1] = makeButton(self.keysPanel, pair[1], function() self:Action(action) end,
            action == "interrupt" and "primary" or "secondary", { size = 11, accent = action == "interrupt" and C.warning or nil })
    end
    self.contextPanel, self.contextTitle, self.contextClose, self.contextRule =
        popover("WOW CONTEXT", function() self:TogglePanel("context") end)
    self.contextDiamond = fill(self.contextPanel, C.codex, 1, "ARTWORK"); rotate(self.contextDiamond)
    self.contextStatus = text(self.contextPanel, 12, C.codex)
    self.contextPlayer = text(self.contextPanel, 12)
    self.contextQuests = text(self.contextPanel, 12)
    self.contextProgress = text(self.contextPanel, 12)
    self.contextErrors = text(self.contextPanel, 12)
    self.contextHint = text(self.contextPanel, 11, C.muted)
    self.contextHint:SetWordWrap(true); self.contextHint:SetMaxLines(2); self.contextHint:SetJustifyV("TOP")
    self.contextToggle = makeButton(self.contextPanel, "PAUSE", function()
        controller:SetContextEnabled(not (self.snapshot.context and self.snapshot.context.enabled))
    end, "secondary", { size = 11 })
    self.contextRefresh = makeButton(self.contextPanel, "REFRESH", function() controller:RefreshContext() end, "primary",
        { size = 11, accent = C.claude })
    self.guidePanel, self.guideTitle, self.guideClose, self.guideRule =
        popover("GUIDES", function() self:TogglePanel("guide") end)
    self.guidePage, self.guideReferences, self.guidePages = "quests", {}, {}
    for _, choice in ipairs({ { "quests", "QUEST / LOOT" }, { "adventures", "ADVENTURES" } }) do
        local page = choice[1]
        self.guidePages[page] = makeButton(self.guidePanel, choice[2], function() self:SetGuidePage(page) end,
            "secondary", { size = 10 })
    end
    self.guideLabel = text(self.guidePanel, 11, C.muted); self.guideLabel:SetText("Quest / item name, link or ID")
    self.guideReference = CreateFrame("EditBox", nil, self.guidePanel, "BackdropTemplate")
    backdrop(self.guideReference, 1)
    self.guideReference:SetBackdropColor(rgb(C.rowBacking)); self.guideReference:SetBackdropBorderColor(rgb(C.frameBrass))
    self.guideReference:SetFont(LABEL_FONT, 12, ""); self.guideReference:SetTextColor(rgb(C.text))
    self.guideReference:SetAutoFocus(false); self.guideReference:SetMultiLine(false)
    self.guideReference:SetMaxLetters(512); self.guideReference:SetTextInsets(6, 6, 0, 0); self.guideReference:SetText("")
    self.guideReference:SetScript("OnEscapePressed", function() self:TogglePanel("guide") end)
    self.guideReference:SetScript("OnEnterPressed", function() self.guideReference:ClearFocus() end)
    self.guideReference:SetScript("OnTextChanged", function(widget)
        local value = widget:GetText(); local clean = inputText(value)
        if value ~= clean then widget:SetText(clean) end
        self.guideHint:SetText("Draft only. Review, then Send.")
    end)
    self.guideQuestLabel = text(self.guidePanel, 11, C.muted); self.guideQuestLabel:SetText("Quest help - choose spoilers")
    self.guideQuestButtons = {}
    for _, choice in ipairs({ { "NUDGE", "hint" }, { "DETAILS", "details" }, { "SOLUTION", "solution" } }) do
        local detail = choice[2]
        self.guideQuestButtons[#self.guideQuestButtons + 1] = makeButton(self.guidePanel, choice[1],
            function() self:ComposeGuide("quest", detail, true) end, "secondary", { size = 10 })
    end
    self.guideQuestButtons[1].tooltip = "A small nudge without solution or story spoilers"
    self.guideQuestButtons[2].tooltip = "Explain blockers and prerequisites without a walkthrough"
    self.guideQuestButtons[3].tooltip = "Explicitly request the full available solution"
    self.guideLootAdd = makeButton(self.guidePanel, "LOOT GOAL", function() self:ComposeGuide("loot", nil, true) end,
        "secondary", { size = 10 })
    self.guideLootAdd.tooltip = "Prepare a request to save this item as a personal loot goal"
    self.guideLootPlan = makeButton(self.guidePanel, "MY PLAN", function() self:ComposeGuide("loot", nil, false) end,
        "secondary", { size = 10 })
    self.guideLootPlan.tooltip = "Prepare a request for sources shared by your saved loot goals"
    self.guideRoleButtons = {}
    for _, role in ipairs({ "tank", "healer", "damage" }) do
        local chosen = role
        local control = makeButton(self.guidePanel, role:upper(), function()
            self.guideRole = chosen; self:RenderGuidePage()
            self.guideHint:SetText("Role selected. Choose Rehearse.")
        end, "secondary", { size = 9 })
        control.role = role
        control.tooltip = "Choose " .. role .. " for your rehearsal"
        self.guideRoleButtons[#self.guideRoleButtons + 1] = control
    end
    self.guideAdventureButtons = {}
    for _, choice in ipairs({ { "REHEARSE", "rehearse" }, { "WHILE HERE", "nearby" }, { "PASSPORT", "passport" } }) do
        local kind = choice[2]
        self.guideAdventureButtons[#self.guideAdventureButtons + 1] = makeButton(self.guidePanel, choice[1],
            function() self:ComposeAdventure(kind) end, "secondary", { size = 9 })
    end
    self.guideAdventureButtons[1].tooltip = "Prepare a dungeon lesson; leave the name empty to choose a supported dungeon"
    self.guideAdventureButtons[2].tooltip = "Find detours in the zone entered above, or your current zone when empty"
    self.guideAdventureButtons[3].tooltip = "View your personal milestones and campaigns without adding any completion stamps"
    self.guideHint = text(self.guidePanel, 11, C.muted); self.guideHint:SetText("Draft only. Review, then Send.")
    self.guideHint:SetWordWrap(true); self.guideHint:SetMaxLines(2); self.guideHint:SetJustifyV("TOP")
    self.guidePanel:SetScript("OnHide", function() self.guideReference:ClearFocus() end)
    -- Copy: FontStrings cannot be selected, so the visible rows are offered in a read-only edit box.
    self.writePanel, self.writeTitle, self.writeClose, self.writeRule = popover("WRITE", function() self:TogglePanel("write") end)
    self.writeHint = text(self.writePanel, 11, C.muted); self.writeHint:SetText("Enter adds a line; Send submits it as one prompt")
    self.writeBox = CreateFrame("EditBox", nil, self.writePanel)
    self.writeBox:SetAutoFocus(false); self.writeBox:SetMultiLine(true); self.writeBox:SetMaxLetters(4600)
    self.writeBox:SetFont(MONO, 12, ""); self.writeBox:SetTextColor(rgb(C.text)); self.writeBox:SetText("")
    self.writeBox:SetScript("OnEscapePressed", function() self:TogglePanel("write") end)
    self.writeBox:SetScript("OnTextChanged", function(widget)
        self.writeCount:SetText(#(widget:GetText() or "") .. " / 4600 bytes")
    end)
    self.writeSend = stockButton(self.writePanel, "Send", function() self:SendWritten() end)
    self.writeCount = text(self.writePanel, 11, C.muted); self.writeCount:SetText("0 / 4600 bytes")
    self.writePanel:SetScript("OnHide", function() self.writeBox:ClearFocus() end)
    self.findPanel, self.findTitle, self.findClose, self.findRule = popover("FIND", function() self:TogglePanel("find") end)
    self.findBox = CreateFrame("EditBox", nil, self.findPanel, "BackdropTemplate"); backdrop(self.findBox, 1)
    self.findBox:SetBackdropColor(rgb(C.rowBacking)); self.findBox:SetBackdropBorderColor(rgb(C.frameBrass))
    self.findBox:SetFont(LABEL_FONT, 12, ""); self.findBox:SetTextColor(rgb(C.text))
    self.findBox:SetAutoFocus(false); self.findBox:SetMultiLine(false); self.findBox:SetMaxLetters(120)
    self.findBox:SetTextInsets(6, 6, 0, 0); self.findBox:SetText("")
    self.findBox:SetScript("OnEnterPressed", function() self:Find(1) end)
    self.findBox:SetScript("OnEscapePressed", function() self:TogglePanel("find") end)
    self.findOlder = makeButton(self.findPanel, "OLDER", function() self:Find(1) end, "secondary", { size = 11 })
    self.findNewer = makeButton(self.findPanel, "NEWER", function() self:Find(-1) end, "secondary", { size = 11 })
    self.findResult = text(self.findPanel, 11, C.muted); self.findResult:SetText("Enter searches older rows")
    self.findPanel:SetScript("OnHide", function() self.findBox:ClearFocus() end)
    self.copyPanel, self.copyTitle, self.copyClose, self.copyRule = popover("COPY", function() self:TogglePanel("copy") end)
    self.copyHint = text(self.copyPanel, 11, C.muted); self.copyHint:SetText("Ctrl+C copies the highlighted text")
    self.copyScreen = makeButton(self.copyPanel, "SCREEN", function() self:FillCopy("screen") end, "secondary", { size = 10 })
    self.copyReply = makeButton(self.copyPanel, "LAST REPLY", function() self:FillCopy("reply") end, "secondary", { size = 10 })
    self.copyReply.tooltip = "The agent's last reply, read from its own session file"
    self.copyText = ""
    self.copyBox = CreateFrame("EditBox", nil, self.copyPanel)
    self.copyBox:SetAutoFocus(false); self.copyBox:SetMultiLine(true); self.copyBox:SetMaxLetters(0)
    self.copyBox:SetTextColor(rgb(C.text)); self.copyBox:SetText("")
    self.copyBox:SetScript("OnEscapePressed", function() self:TogglePanel("copy") end)
    self.copyBox:SetScript("OnTextChanged", function(widget)
        if widget:GetText() ~= self.copyText then widget:SetText(self.copyText) end
    end)
    self.copyPanel:SetScript("OnHide", function() self.copyBox:ClearFocus() end)
    frame:SetScript("OnSizeChanged", function()
        if self.initialized and not self.layingOut then self:Render(self.snapshot) end
    end)
    frame:SetScript("OnHide", function()
        self.input:ClearFocus(); frame:StopMovingOrSizing()
        self.openPanel = nil; self.appearancePanel:Hide(); self.keysPanel:Hide()
        self.contextPanel:Hide(); self.copyPanel:Hide(); self.guidePanel:Hide(); self.findPanel:Hide(); self.writePanel:Hide()
        -- Every hide, whether the close button or another addon, shares the controller's visibility
        -- state. Core Hide is idempotent and retains any pending outbound strip.
        if self.initialized and self.controller.Hide then self.controller:Hide() end
    end)
    self.strip = CreateFrame("Frame", nil, UIParent)
    self.strip:SetPoint("TOPLEFT", UIParent, "TOPLEFT", 0, 0)
    self.strip:SetFrameStrata("TOOLTIP"); self.strip:SetFrameLevel(10000); self.strip.cells = { {}, {} }
    for row = 1, 2 do
        for i = 1, CELLS do self.strip.cells[row][i] = self.strip:CreateTexture(nil, "OVERLAY") end
    end
    self.strip:Hide()
    -- Shift-clicking an item, quest or spell while typing here inserts it, as it does for chat.
    local chat, hook = _G.ChatFrameUtil, _G.hooksecurefunc
    if type(hook) == "function" and type(chat) == "table" and type(chat.InsertLink) == "function" then
        hook(chat, "InsertLink", function(link) self:InsertLink(link) end)
    elseif type(hook) == "function" and type(_G.ChatEdit_InsertLink) == "function" then
        hook("ChatEdit_InsertLink", function(link) self:InsertLink(link) end)
    end
    self:SetFontSize(10); self:Layout(); self:ApplyOpacity(80)
    return self
end
