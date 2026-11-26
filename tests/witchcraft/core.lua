local ns, test, equal = ...
local payload = ns.TestPayload
local function fixture(global, apiOverrides)
    local state = { timers = {}, loads = {}, printed = {}, reloads = 0, confirms = 0, combat = false, rendered = 0 }
    local controller
    local api = {
        Context = false,
        UINonce = function() return "abcdef01" end,
        InCombatLockdown = function() return state.combat end,
        Print = function(message) state.printed[#state.printed + 1] = message end,
        ReloadUI = function() state.reloads = state.reloads + 1 end,
        ConfirmReload = function(accept) state.confirm, state.confirms = accept, state.confirms + 1 end,
        LoadAddOn = function(name)
            state.loads[#state.loads + 1] = name
            if state.loader then return state.loader(controller, name) end
            if state.nextPayload then controller:ReceiveChunk(state.nextPayload) end
            return true
        end,
        IsAddOnLoaded = function() return state.loaded == true end,
        NewTimer = function(delay, callback)
            local timer = { delay = delay, cancelled = 0 }
            function timer:Cancel() self.cancelled = self.cancelled + 1; if state.onCancel then state.onCancel() end end
            function timer:Fire() callback() end
            state.timers[#state.timers + 1] = timer
            if state.onTimer then state.onTimer(timer) end
            return timer
        end,
        CreateView = function()
            return {
                Render = function(_, snapshot) state.rendered = state.rendered + 1; state.snapshot = snapshot end,
                Show = function() state.shown = true end,
                Hide = function() state.shown = false end,
                Prefill = function(_, prompt)
                    if state.draft and state.draft ~= "" then return false, "Draft kept" end
                    state.draft = prompt; state.draftTab = state.snapshot.activeTab; return true
                end,
                TogglePanel = function(view, panel) view.openPanel = panel; state.panel = panel end,
                SetMinimized = function(_, minimized) state.minimized = minimized end,
                ResetLayout = function() state.resetLayouts = (state.resetLayouts or 0) + 1; state.minimized = false end,
                RenderStrip = function(_, top, heartbeat) state.top, state.heartbeat = top, heartbeat end,
                RenderBurst = function(_, rows)
                    state.burst = rows
                    state.burstRenders = (state.burstRenders or 0) + 1
                end,
            }
        end,
    }
    for key, value in pairs(apiOverrides or {}) do api[key] = value end
    controller = ns.Core.New(global or {}, api)
    function state:Accept(overrides)
        self.nextPayload = payload(controller.ring.nextSeq, overrides)
        controller:LoadTick()
        self.nextPayload = nil
    end
    controller:Start()
    return controller, state
end
ns.TestControllerFixture = fixture

test("guide slash commands compose into the selected tab without queueing or replacing drafts", function()
    local c, s = fixture()
    c:Hide(); c:SelectTab("codex")
    c:HandleSlash("quest 166")
    equal(s.shown, true); equal(s.draftTab, "codex"); equal(#c.global.outbox, 0)
    assert(s.draft:find("only a small nudge", 1, true) and s.draft:find("solution and story spoilers hidden", 1, true))
    local original = s.draft
    c:HandleSlash("loot 5191"); equal(s.draft, original); equal(s.printed[#s.printed], "Draft kept")
    s.draft = ""
    c:HandleSlash("quest details The Defias Brotherhood")
    assert(s.draft:find("blockers and prerequisites", 1, true) and s.draft:find("walkthrough and story spoilers hidden", 1, true))
    s.draft = ""
    c:HandleSlash("quest solution 166")
    assert(s.draft:find("explicitly want the full available solution", 1, true))
    s.draft = ""
    c:HandleSlash("loot 5191")
    assert(s.draft:find("Save this item as an active loot goal in my personal profile: 5191", 1, true))
    s.draft = ""
    c:HandleSlash("loot")
    assert(s.draft:find("Show my saved loot plan from the personal profile", 1, true) and not s.draft:find("Save this item", 1, true))
    equal(#c.global.outbox, 0)
    c:HandleSlash("guide"); equal(s.panel, "guide")
    c:Stop()
    equal(c:ComposeGuide("loot", ""), false); equal(c:OpenGuide(), false)
end)

test("guide references preserve complete UTF-8, accept links and bound every prompt below the transport limit", function()
    local build = ns.Core.GuidePrompt
    local quest = assert(build("quest", "|cffffff00|Hquest:166:10|h[The Defias Brotherhood]|h|r", "hint"))
    assert(quest:find("quest: 166.", 1, true))
    local item = assert(build("loot", "|cff0070dd|Hitem:5191::::::::::|h[Cruel Barb]|h|r"))
    assert(item:find("personal profile: 5191.", 1, true))
    for _, detail in ipairs({ "hint", "details", "solution" }) do
        local prompt = assert(build("quest", string.rep("x", 160), detail))
        assert(#prompt <= 600 and ns.Pixel.ValidText(prompt))
        assert(prompt:find("local reference guide", 1, true) and prompt:find("current character and tracked quest context", 1, true))
        assert(prompt:find("ambiguous", 1, true) and prompt:find("unknown requirements", 1, true)
            and prompt:find("unverified Forever", 1, true))
        assert(not prompt:find("wow_", 1, true), "guide drafts express the player's request without tool syntax")
    end
    for _, reference in ipairs({ "", string.rep("x", 160) }) do
        local prompt = assert(build("loot", reference))
        assert(#prompt <= 600 and ns.Pixel.ValidText(prompt))
        assert(prompt:find("local reference guide", 1, true) and prompt:find("current character context", 1, true)
            and prompt:find("unverified Forever", 1, true) and not prompt:find("wow_", 1, true))
    end
    equal(build("quest", "", "hint"), nil)
    equal(build("quest", string.rep("x", 161), "hint"), nil)
    equal(build("quest", "bad\nquest", "hint"), nil)
    equal(build("quest", "\255", "hint"), nil)
    equal(build("quest", "166", "all"), nil)
    local unicode = "\208\159\209\128\208\184\208\178\209\150\209\130"
    assert(assert(build("quest", unicode, "hint")):find(unicode, 1, true))
end)

test("adventure slash commands prepare read requests without choosing roles or claiming completions", function()
    local c, s = fixture()
    c:Hide(); c:SelectTab("codex")
    c:HandleSlash("rehearse healer The Deadmines")
    equal(s.shown, true); equal(s.draftTab, "codex")
    assert(s.draft:find("dungeon: The Deadmines", 1, true) and s.draft:find("chosen role is healer", 1, true))
    assert(s.draft:find("does not prove a dungeon clear", 1, true))
    local before = s.draft
    c:HandleSlash("passport"); equal(s.draft, before); equal(s.printed[#s.printed], "Draft kept")
    s.draft = ""; c:HandleSlash("rehearse The Deadmines")
    assert(s.draft:find("Ask me to choose tank, healer or damage", 1, true))
    s.draft = ""; c:HandleSlash("rehearse")
    assert(s.draft:find("dungeons supported", 1, true) and s.draft:find("let me choose one", 1, true))
    s.draft = ""; c:HandleSlash("rehearse TANK")
    assert(s.draft:find("dungeons supported", 1, true) and s.draft:find("chosen role is tank", 1, true))
    s.draft = ""; c:HandleSlash("nearby")
    assert(s.draft:find("current zone", 1, true) and s.draft:find("unavailable or historical", 1, true))
    s.draft = ""; c:HandleSlash("nearby Westfall")
    assert(s.draft:find("zone: Westfall", 1, true) and s.draft:find("spoiler-light hints", 1, true))
    s.draft = ""; c:HandleSlash("passport")
    assert(s.draft:find("supported campaigns", 1, true) and s.draft:find("Do not change my passport", 1, true))
    equal(#c.global.outbox, 0)
    c:Stop(); equal(c:ComposeGuide("rehearse", "The Deadmines", "tank"), false)
end)

test("adventure drafts use natural language and stay bounded for every role and reference", function()
    local build = ns.Core.GuidePrompt
    for _, reference in ipairs({ "", string.rep("x", 160), "\208\159\209\128\208\184\208\178\209\150\209\130" }) do
        for _, role in ipairs({ false, "tank", "healer", "damage" }) do
            local prompt = assert(build("rehearse", reference, role or nil))
            assert(#prompt <= 600 and ns.Pixel.ValidText(prompt), "rehearsal prompt exceeds transport limit: " .. #prompt)
            assert(not prompt:find("wow_", 1, true) and not prompt:find("answerChoice", 1, true))
            if reference ~= "" then assert(prompt:find("Keep quiz answers hidden", 1, true)) end
        end
        for _, kind in ipairs({ "nearby", "passport" }) do
            local prompt = assert(build(kind, reference))
            assert(#prompt <= 600 and ns.Pixel.ValidText(prompt) and not prompt:find("wow_", 1, true))
        end
    end
    equal(build("rehearse", "The Deadmines", "dps"), nil)
    for _, kind in ipairs({ "rehearse", "nearby", "passport" }) do
        equal(build(kind, string.rep("x", 161)), nil)
        equal(build(kind, "bad\nreference"), nil)
        equal(build(kind, "\255"), nil)
    end
end)

local function screens(claude, codex)
    local sessions = payload().sessions
    sessions[1].lines, sessions[2].lines = claude, codex
    return sessions
end

test("controller unread starts with a baseline even for a saved host and collapsed view", function()
    local c, s = fixture({ epoch = "1234abcd", view = { minimized = true } })
    equal(c:Snapshot().unread.claude, false); equal(c:Snapshot().unread.codex, false)
    s:Accept()
    equal(c:Snapshot().unread.claude, false); equal(c:Snapshot().unread.codex, false)
    s:Accept({ sessions = screens({ "new Claude output" }, { "three" }) })
    equal(c:Snapshot().unread.claude, true); equal(c:Snapshot().unread.codex, false)
end)

test("controller unread follows per-tab text and remains until that output is viewed", function()
    local c, s = fixture()
    s:Accept()
    local updated = screens({ "Claude response" }, { "Codex response" })
    s:Accept({ sessions = updated, changed = false })
    equal(c:Snapshot().unread.claude, false); equal(c:Snapshot().unread.codex, true)
    s:Accept({ sessions = updated, changed = true, ack = 3 })
    equal(c:Snapshot().unread.codex, true)
    c:SelectTab("codex")
    equal(c:Snapshot().unread.codex, false); equal(s.snapshot.unread.codex, false)
    updated[2].status = "exited (0)"
    c:SelectTab("claude"); s:Accept({ sessions = updated, ack = 3 })
    equal(c:Snapshot().unread.codex, false, "status or acknowledgement changes are not output")
    local snapshot = c:Snapshot(); snapshot.unread.claude = true
    equal(c:Snapshot().unread.claude, false, "snapshot does not expose mutable unread state")
end)

test("controller unread ignores color and padding redraws while preserving literal color-like text", function()
    local c, s = fixture()
    s:Accept({ sessions = screens({ "one" }, { "|cffff0000ready ||cffffffff literal||r|r   ", "   " }) })
    s:Accept({ sessions = screens({ "one" }, { "|cff00ff00ready ||cffffffff literal||r|r" }) })
    equal(c:Snapshot().unread.codex, false)
    s:Accept({ sessions = screens({ "one" }, { "|cff00ff00ready ||c00000000 literal||r|r" }) })
    equal(c:Snapshot().unread.codex, true, "literal pipes are terminal content")
end)

test("controller collapsed tabs retain unread until selected output is expanded", function()
    local c, s = fixture()
    s:Accept(); c:SaveView({ minimized = true })
    local updated = screens({ "Claude update" }, { "Codex update" })
    s:Accept({ sessions = updated })
    equal(c:Snapshot().unread.claude, true); equal(c:Snapshot().unread.codex, true)
    c:SelectTab("codex"); s:Accept({ sessions = updated })
    equal(c:Snapshot().unread.claude, true); equal(c:Snapshot().unread.codex, true)
    c:SaveView({ minimized = false })
    equal(c:Snapshot().unread.claude, true); equal(c:Snapshot().unread.codex, false)
    equal(s.snapshot.unread.codex, false, "expansion refreshes the badge immediately")
    c:SelectTab("claude")
    equal(c:Snapshot().unread.claude, false)
end)

test("controller hidden output stays unread through tab and layout changes until reopened", function()
    local c, s = fixture()
    s:Accept(); assert(c:Send("claude", "keep delivery active")); c:Hide()
    local updated = screens({ "Claude hidden update" }, { "Codex hidden update" })
    s:Accept({ sessions = updated })
    equal(c:Snapshot().unread.claude, true); equal(c:Snapshot().unread.codex, true)
    c:SelectTab("codex"); c:SaveView({ minimized = false })
    equal(c:Snapshot().unread.codex, true); equal(s.shown, false)
    s:Accept({ sessions = updated, ack = 1 })
    equal(c:Snapshot().unread.codex, true); equal(c:WantStream(), false)
    c:Toggle()
    equal(c:Snapshot().unread.codex, false); equal(c:Snapshot().unread.claude, true)
    c:Hide(); local loads = #s.loads; c:LoadTick()
    equal(#s.loads, loads, "notifications do not enable a hidden idle stream")
end)

test("controller unread ignores rejected chunks and resets on host or UI session changes", function()
    local global = {}
    local c, s = fixture(global)
    s:Accept()
    s:Accept({ sessions = screens({ "one", "two" }, { "rejected output" }), uiNonce = "55555555" })
    equal(c:Snapshot().unread.codex, false)
    s:Accept({ sessions = screens({ "one", "two" }, { "accepted output" }) })
    equal(c:Snapshot().unread.codex, true)
    s:Accept({ epoch = "87654321", sessions = screens({ "new host" }, { "new host" }) })
    equal(c:Snapshot().unread.claude, false); equal(c:Snapshot().unread.codex, false)
    s:Accept({ epoch = "87654321", sessions = screens({ "new host" }, { "new response" }) })
    equal(c:Snapshot().unread.codex, true)
    equal(global.unread, nil); equal(global.screenText, nil)
    local fresh, freshState = fixture(global)
    equal(fresh:Snapshot().unread.codex, false)
    freshState:Accept({ epoch = "87654321", sessions = screens({ "new host" }, { "new response" }) })
    equal(fresh:Snapshot().unread.codex, false, "reloaded screens start with an unread baseline")
end)

test("controller hidden MCP streaming keeps unread output until the selected tab is shown", function()
    local c, s = fixture({ contextEnabled = true }, { Context = { Capture = function() return {} end } })
    s:Accept({ contextProtocol = 4, contextAck = 0, contextWant = 0, contextWantMask = 0 }); c:Hide()
    equal(#c.global.outbox, 0); equal(c:WantStream(), true)
    s:Accept({ contextProtocol = 4, contextAck = 0, contextWant = 0, contextWantMask = 0,
        sessions = screens({ "Claude update" }, { "Codex update" }) })
    equal(c:Snapshot().unread.claude, true); equal(c:Snapshot().unread.codex, true)
    c:SelectTab("codex"); equal(c:Snapshot().unread.codex, true)
    c:Toggle()
    equal(c:Snapshot().unread.codex, false); equal(c:Snapshot().unread.claude, true)
    equal(c.contextProtocol, 4); equal(c:Snapshot().context.enabled, true)
end)

test("controller opacity applies immediately, preserves zero and rejects invalid settings", function()
    local c, s = fixture()
    equal(c:Snapshot().opacity, 80)
    assert(c:SetOpacity(0)); equal(c.global.opacity, 0); equal(s.snapshot.opacity, 0)
    local rendered = s.rendered
    assert(c:SetOpacity(0)); equal(s.rendered, rendered)
    assert(c:SetOpacity(64.7)); equal(c.global.opacity, 65); equal(s.snapshot.opacity, 65)
    assert(c:SetOpacity(100)); equal(c.global.opacity, 100)
    for _, value in ipairs({ -1, 101, math.huge, -math.huge, 0/0, "65", false }) do
        equal(c:SetOpacity(value), false); equal(c.global.opacity, 100)
    end
    equal(c:SetOpacity(nil), false)
    c:HandleSlash("opacity 25"); equal(s.snapshot.opacity, 25)
    c:HandleSlash("opacity nope"); equal(c.global.opacity, 25)
    assert(s.printed[#s.printed]:find("opacity", 1, true))
    equal(s.reloads, 0); equal(#s.loads, 0)
    equal(#c.global.outbox, 0)
end)

test("controller boot is disconnected, loads only requested slot, and accepts two screens", function()
    local c, s = fixture()
    equal(c:Send("claude", "hi"), false)
    equal(c:ReceiveChunk(payload()), false)
    s:Accept()
    equal(s.loads[1], "Witchcraft_Chunk_0001")
    equal(c.connected, true); equal(c.sessions[2].id, "codex")
    equal(c.global.nextSeq, 2); equal(c.global.epoch, "1234abcd")
    equal(c:ReceiveChunk(payload(2)), false)
end)

test("a two-session host drops a saved Copilot selection and refuses input to Copilot", function()
    local c, s = fixture({ activeTab = "copilot" })
    s:Accept()
    equal(c.connected, true); equal(c.global.activeTab, "claude")
    local ok, reason = c:Queue("copilot", "text", "hello")
    equal(ok, false); equal(reason, "That terminal is not available")
    equal(#c.global.outbox, 0)
    assert(c:Queue("codex", "text", "hello"))
    -- A saved Copilot message from an earlier host is dropped by Resend, never requeued to this one.
    -- A requeue that does not fit the ID space fails before the saved queue changes.
    c.global.outbox = { { epoch = "deadbeef", id = 1, tab = "copilot", action = "text", text = "old" },
        { epoch = "deadbeef", id = 2, tab = "codex", action = "text", text = "keep" } }
    local savedNextId = c.global.nextId
    c.global.nextId = 262144
    local ok2, reason2 = c:Resend()
    equal(ok2, false); equal(reason2, "Message ID limit reached"); equal(#c.global.outbox, 2)
    c.global.nextId = savedNextId
    assert(c:Resend())
    equal(#c.global.outbox, 1); equal(c.global.outbox[1].tab, "codex"); equal(c.global.outbox[1].epoch, c.global.epoch)
    assert(c.notice:find("dropped 1", 1, true))
    -- A current-epoch Copilot message left by an earlier addon build is dropped on the next accepted chunk.
    c.global.outbox = { { epoch = c.global.epoch, id = c.global.nextId, tab = "copilot", action = "text", text = "legacy" },
        { epoch = c.global.epoch, id = c.global.nextId + 1, tab = "claude", action = "text", text = "keep" } }
    c.global.nextId = c.global.nextId + 2
    -- A carrier transmission of the dropped message is cancelled, as is one left without a queued message.
    local identity = "input:" .. c.global.epoch .. ":" .. c.global.outbox[1].id
    c.binding = { enabled = true, active = { kind = "input", identity = identity }, cancelled = {},
        Cancel = function(self, cancelled) self.cancelled[#self.cancelled + 1] = cancelled; self.active = nil; return true end,
        Busy = function(self) return self.active ~= nil end, AcceptHost = function() return false end,
        Pump = function() end, OfferInput = function() return false end, OfferContext = function() return false end,
        Snapshot = function() return { status = "fake", enabled = true } end, Stop = function() return true end }
    local printedBefore = #s.printed
    s:Accept()
    equal(#c.global.outbox, 1); equal(c.global.outbox[1].tab, "claude")
    assert(#s.printed > printedBefore and s.printed[#s.printed]:find("dropped 1 queued", 1, true))
    equal(c.binding.cancelled[1], identity)
    c.binding.active = { kind = "input", identity = "input:" .. c.global.outbox[1].epoch .. ":" .. c.global.outbox[1].id }
    c:BindingTick()
    equal(#c.binding.cancelled, 1, "a queued message keeps its transmission")
    local orphan = "input:" .. c.global.epoch .. ":999"
    c.binding.active = { kind = "input", identity = orphan }
    c:BindingTick()
    equal(c.binding.cancelled[2], orphan)
end)

test("a started Copilot session switches its tab on once per host epoch", function()
    local c, s = fixture()
    local function sessions(status)
        local list = payload().sessions
        list[3] = { id = "copilot", title = "Copilot", status = status, lines = {} }
        return list
    end
    local function tabs() return table.concat(c:Snapshot().tabs, ",") end
    local function reveals()
        local count = 0
        for _, line in ipairs(s.printed) do if line:find("shows the Copilot tab", 1, true) then count = count + 1 end end
        return count
    end
    -- A two-session host and a Copilot the daemon has not started leave the tab off.
    s:Accept()
    s:Accept({ sessions = sessions("not started") })
    s:Accept({ sessions = sessions("Waiting for host") })
    equal(c:Setting("tabCopilot"), false); equal(tabs(), "claude,codex"); equal(reveals(), 0)
    equal(c.global.copilotRevealedEpoch, nil)
    -- The first started Copilot of a host epoch switches the tab on and says so.
    s:Accept({ sessions = sessions("running") })
    equal(c:Setting("tabCopilot"), true); equal(tabs(), "claude,codex,copilot"); equal(reveals(), 1)
    equal(c.global.copilotRevealedEpoch, "1234abcd")
    -- Hidden again, it stays hidden for the rest of that host epoch.
    assert(c:SetSetting("tabCopilot", false))
    s:Accept({ sessions = sessions("running") })
    equal(c:Setting("tabCopilot"), false, "revealed once per host epoch"); equal(tabs(), "claude,codex"); equal(reveals(), 1)
    -- A new host epoch with a started Copilot switches it on again.
    s:Accept({ epoch = "87654321", sessions = sessions("running") })
    equal(c:Setting("tabCopilot"), true); equal(tabs(), "claude,codex,copilot"); equal(reveals(), 2)
end)

test("a started AGY session switches its tab on once per host epoch and /witch tab toggles visibility", function()
    local c, s = fixture()
    local function sessions(status)
        local list = payload().sessions
        list[3] = { id = "copilot", title = "Copilot", status = "not started", lines = {} }
        list[4] = { id = "agy", title = "AGY", status = status, lines = {} }
        return list
    end
    local function tabs() return table.concat(c:Snapshot().tabs, ",") end
    s:Accept({ sessions = sessions("not started") })
    equal(c:Setting("tabAgy"), false); equal(tabs(), "claude,codex")
    s:Accept({ sessions = sessions("running") })
    equal(c:Setting("tabAgy"), true); equal(tabs(), "claude,codex,agy")
    equal(c.global.agyRevealedEpoch, "1234abcd")
    c:HandleSlash("tab agy off")
    equal(c:Setting("tabAgy"), false); equal(tabs(), "claude,codex")
    c:HandleSlash("tab agy")
    equal(c:Setting("tabAgy"), true); equal(tabs(), "claude,codex,agy")
    c:HandleSlash("tabs")
    assert(s.printed[#s.printed]:find("AGY=on", 1, true))
end)

test("controller wrong nonce cannot acknowledge cached data after UI reload", function()
    local g = { epoch = "1234abcd", reloadAwaitHost = true, outbox = {
        { id = 1, epoch = "1234abcd", tab = "claude", action = "text", text = "retain" } }, nextId = 2 }
    local c, s = fixture(g)
    s:Accept({ uiNonce = "55555555", ack = 1 })
    equal(c.ring.nextSeq, 2); equal(c.connected, false); equal(#g.outbox, 1); equal(g.reloadAwaitHost, true)
    s:Accept({ ack = 1 })
    equal(c.connected, true); equal(#g.outbox, 0); equal(g.reloadAwaitHost, false)
end)

test("controller queue routes tabs, enforces bounds, and never reloads per message", function()
    local c, s = fixture()
    s:Accept()
    equal(c:Send("claude", "hello"), true); equal(c:Send("codex", "world"), true)
    equal(c.global.outbox[1].tab, "claude"); equal(c.global.outbox[2].tab, "codex")
    for _, action in ipairs({ "enter", "escape", "interrupt", "up", "down" }) do equal(c:Action("codex", action), true) end
    equal(c:Send("codex", ""), false); equal(c:Send("codex", "one\ntwo"), false)
    equal(c:Send("codex", string.rep("x", 601)), false); equal(c:Send("bad", "x"), false)
    equal(c:Action("codex", "execute"), false); equal(c:Send("codex", "\255"), false)
    while #c.global.outbox < 64 do assert(c:Send("claude", "queued")) end
    equal(c:Send("claude", "overflow"), false); equal(c.global.nextId, 65)
    equal(s.reloads, 0)
end)

test("controller pixel cycles oldest pending until matching epoch acknowledgement", function()
    local c, s = fixture()
    s:Accept()
    assert(c:Send("claude", "first")); assert(c:Send("codex", "second"))
    c:PixelTick(); equal(#s.top, 22); equal(#s.heartbeat, 22)
    local key = c.pixelMessage
    for _ = 1, 20 do c:PixelTick(); equal(c.pixelMessage, key) end
    equal(#c.global.outbox, 2)
    s:Accept({ ack = 1 }); equal(#c.global.outbox, 1)
    c:PixelTick(); equal(c.pixelMessage, "1234abcd:2")
    s:Accept({ ack = 2 }); c:PixelTick()
    equal(#c.global.outbox, 0); equal(s.top, nil); equal(#s.heartbeat, 22)
end)

test("controller host restart retains stale intent until explicit resend", function()
    local c, s = fixture()
    s:Accept(); assert(c:Send("claude", "old host intent"))
    s:Accept({ epoch = "87654321" })
    equal(#c.global.outbox, 1); equal(c:Snapshot().stale, true); equal(c:Snapshot().staleCount, 1)
    c:PixelTick(); equal(s.top, nil)
    assert(c:Send("codex", "new host intent"))
    c:PixelTick(); equal(c.pixelMessage, "87654321:2")
    assert(c:Resend())
    equal(c:Snapshot().stale, false); equal(c:Snapshot().staleCount, 0); equal(c.global.outbox[2].text, "old host intent")
    equal(c.global.outbox[2].id, 3); equal(c.global.outbox[2].epoch, "87654321")
end)

test("controller combat pauses loader but keeps outbound and heartbeat alive", function()
    local c, s = fixture()
    s:Accept(); assert(c:Send("codex", "combat text"))
    local oldLoad = c.timers.load.handle
    s.combat = true; c:OnEvent("PLAYER_REGEN_DISABLED")
    oldLoad:Fire(); c:LoadTick(); equal(#s.loads, 1)
    c:PixelTick(); equal(#s.top, 22); equal(#s.heartbeat, 22)
    equal(c:Snapshot().combat, true)
    s.combat = false; c:OnEvent("PLAYER_REGEN_ENABLED")
    equal(c.timers.load.handle.delay, 1)
    s.nextPayload = payload(2, { ack = 1 }); c.timers.load.handle:Fire()
    equal(#s.loads, 2); equal(#c.global.outbox, 0)
end)

test("keep updating in combat survives the combat-start event, not only a direct load", function()
    local c, s = fixture()
    s:Accept()
    assert(c:SetSetting("combatUpdates", true))
    local loads = #s.loads
    s.combat = true; c:OnEvent("PLAYER_REGEN_DISABLED")
    assert(c.timers.load, "the load timer stays armed when the fight starts")
    s.nextPayload = payload(2); c.timers.load.handle:Fire()
    equal(#s.loads, loads + 1, "the next update loads mid-fight")
end)

test("controller exhausted live ring asks before reloading, once, outside combat", function()
    local c, s = fixture({ ringSize = 1 })
    s:Accept({ ringSize = 1 })
    s.combat = true; c:LoadTick(); equal(c:MaybeReload(), false)
    equal(s.reloads, 0); equal(c.reloadPending, false); equal(s.confirms, 0)
    s.combat = false; c:LoadTick()
    equal(c.reloadPending, true); equal(s.reloads, 0, "an exhausted ring never reloads by itself")
    equal(s.confirms, 1); equal(type(s.confirm), "function")
    assert(s.printed[#s.printed]:find("reload to continue", 1, true), s.printed[#s.printed])
    assert(s.snapshot.status:find("/witch reload", 1, true), s.snapshot.status)
    c:HandleSlash("status")
    assert(s.printed[#s.printed - 1]:find(" / reload pending", 1, true), s.printed[#s.printed - 1])
    c:LoadTick(); equal(c:MaybeReload(), false); equal(s.confirms, 1, "a pending confirmation is not raised again")
    assert(c:Queue("claude", "text", "still typing"))
    assert(c:Snapshot().status:find("/witch reload", 1, true), "input after Not now keeps the reload notice in the footer")
    c:HandleSlash("resend")
    assert(c:Snapshot().status:find("/witch reload", 1, true), "a resend notice does not cover the reload notice")
    s.confirm()
    equal(s.reloads, 1); equal(c.reloadPending, false); equal(c.global.reloadAwaitHost, false)
    local fresh, freshState = fixture({ ringSize = 1, reloadAwaitHost = true })
    freshState:Accept({ ringSize = 1, uiNonce = "55555555" })
    fresh:LoadTick(); equal(freshState.reloads, 0); equal(freshState.confirms, 0); equal(fresh.reloadPending, false)
end)

test("controller absent host placeholder exhaustion never creates automatic reload loop", function()
    local c, s = fixture({ ringSize = 1 })
    s.nextPayload = { protocol = 1, seq = 1, ringSize = 1, ready = false }
    c:LoadTick(); c:LoadTick(); equal(s.reloads, 0)
    equal(c.ring.accepted, 0); equal(c.connected, false)
    s.combat = true; c:Reset(); equal(s.reloads, 0)
    s.combat = false; c:OnEvent("PLAYER_REGEN_ENABLED"); equal(s.reloads, 1)
end)

test("controller hide pauses idle stream, pending delivery survives hide, disable cancels all", function()
    local c, s = fixture()
    c:Toggle(); equal(c.timers.load, nil); equal(c.timers.pixel, nil); equal(s.heartbeat, nil)
    c:Toggle(); s:Accept(); assert(c:Send("claude", "send hidden"))
    c:Toggle(); equal(c.visible, false); assert(c.timers.load); assert(c.timers.pixel)
    c:PixelTick(); equal(#s.heartbeat, 22); equal(s.shown, false)
    local load, pixel = c.timers.load.handle, c.timers.pixel.handle
    c:Stop(); load:Fire(); pixel:Fire()
    equal(c.timers.load, nil); equal(c.timers.pixel, nil); equal(s.top, nil)
    equal(c:ReceiveChunk(payload(2)), false)
    c:Start(); equal(c.ring.nextSeq, 2); equal(c.uiNonce, "abcdef01")
end)

test("controller canceled timer callback cannot reenter a later owner generation", function()
    local c, s = fixture()
    local old = c.timers.load.handle
    c:Stop(); c:Start(); old:Fire(); equal(#s.loads, 0)
    s.loader = function(owner) owner:Stop(); return true end
    c:LoadTick(); equal(c.ring.nextSeq, 1); equal(c.timers.load, nil)
    c:Start()
    s.onTimer = function() c:Stop() end
    c:Schedule("load", 1, c.LoadTick)
    equal(c.timers.load, nil); equal(s.timers[#s.timers].cancelled, 1)
end)

test("controller settings are bounded, copied, and input exits idle backoff", function()
    local c, s = fixture()
    s:Accept(); s:Accept({ changed = false }); s:Accept({ changed = false }); s:Accept({ changed = false })
    equal(c.ring.delay, 8)
    assert(c:Send("claude", "wake")); equal(c.ring.delay, 1); equal(c.timers.load.handle.delay, 1)
    local view = { width = 700, height = 500, x = 5, y = 7, point = "CENTER", minimized = false }
    assert(c:SaveView(view)); view.width = 1; equal(c.global.view.width, 700)
    equal(c:SaveView({ width = -1 }), false); equal(c:SetFontSize(7), false)
    assert(c:SetFontSize(14)); equal(c.global.fontSize, 14)
    assert(c:SelectTab("codex")); equal(c.global.activeTab, "codex")
    equal(c:SelectTab("other"), false)
    c:HandleSlash("calibrate"); c:PixelTick(); equal(s.top[1][1], 255)
    c:HandleSlash("calibrate off"); equal(c.calibrating, false)
end)

test("controller burst probe slash cycles owned pages, corrupts deliberately and stops cleanly", function()
    local c, s = fixture()
    c:HandleSlash("burstprobe 750")
    assert(c.burstProbe); equal(c.burstProbe.dwell, .75); equal(c.burstProbe.corrupt, false)
    equal(#c.burstProbe.pages, 3); equal(#s.burst, 22); equal(s.burst, c.burstProbe.pages[1])
    equal(c.timers.burst.handle.delay, .75)
    local clean = s.burst[1][7][1]

    c:Hide(); equal(c:WantStream(), true, "armed carrier keeps its timers while the terminal is hidden")
    c.timers.burst.handle:Fire(); equal(s.burst, c.burstProbe.pages[2])
    c.timers.burst.handle:Fire(); equal(s.burst, c.burstProbe.pages[3])
    c.timers.burst.handle:Fire(); equal(s.burst, c.burstProbe.pages[1])

    local cleanTimer = c.timers.burst.handle
    c:HandleSlash("burstprobe corrupt")
    equal(cleanTimer.cancelled, 1); assert(c.burstProbe); equal(c.burstProbe.corrupt, true)
    equal(c.burstProbe.dwell, 1); equal(c.timers.burst.handle.delay, 1)
    equal(s.burst[1][7][1] == clean, false, "corrupt mode changes its owned first frame")

    local corruptTimer = c.timers.burst.handle
    c:HandleSlash("burstprobe off")
    equal(corruptTimer.cancelled, 1); equal(c.burstProbe, nil); equal(c.timers.burst, nil); equal(s.burst, nil)
    equal(c:WantStream(), false)
    assert(s.printed[#s.printed]:find("hidden", 1, true))

    c:HandleSlash("burstprobe 199")
    equal(c.burstProbe, nil); assert(s.printed[#s.printed]:find("200%-2000", 1, false))
    c:HandleSlash("burstprobe banana")
    equal(c.burstProbe, nil); assert(s.printed[#s.printed]:find("corrupt, or off", 1, true))
end)

test("controller clears physical strip when a hidden terminal receives its final acknowledgement", function()
    local c, s = fixture()
    s:Accept(); assert(c:Send("claude", "finish hidden")); c:Toggle()
    c:PixelTick(); assert(s.top); assert(s.heartbeat)
    -- Simulate the owned callback edge, which releases its timer before loading.
    s.nextPayload = payload(2, { ack = 1 })
    c.timers.load.handle:Fire()
    equal(#c.global.outbox, 0); equal(s.top, nil); equal(s.heartbeat, nil)
    equal(c.timers.load, nil); equal(c.timers.pixel, nil)
    c:HandleSlash("calibrate"); c:PixelTick(); assert(s.top)
    c:HandleSlash("calibrate off"); c:PixelTick(); equal(s.top, nil)
end)

test("controller explicit combat reset resumes even while the panel is hidden", function()
    local c, s = fixture()
    c:Toggle(); s.combat = true
    c:Reset(); equal(s.reloads, 0); equal(c.resetRequested, true)
    s.combat = false; c:OnEvent("PLAYER_REGEN_ENABLED"); equal(s.reloads, 1)
end)

test("controller missing loader retries same slot; thrown but spent slot advances safely", function()
    local c, s = fixture()
    s.loader = function() return false end
    c:LoadTick(); equal(c.ring.nextSeq, 1); equal(c.ring.delay, 8)
    s.loaded = true; s.loader = function() error("mock chunk failed") end
    c:LoadTick(); equal(c.ring.nextSeq, 2); equal(c.connected, false)
    s.loader = function(owner)
        equal(owner:ReceiveChunk(payload(2)), true)
        equal(owner:ReceiveChunk(payload(3)), false)
        return true
    end
    c:LoadTick(); equal(c.ring.nextSeq, 3); equal(c.ring.accepted, 1)
end)

test("controller user-hide is idempotent and later chunks do not reopen the window", function()
    local c, s = fixture()
    s:Accept(); assert(c:Send("claude", "keep delivering"))
    c:Hide(); c:Hide()
    equal(c.visible, false); equal(s.shown, false)
    assert(c.timers.pixel); assert(c.timers.load)
    s:Accept({ ack = 1 })
    equal(c.visible, false); equal(s.shown, false); equal(c.timers.pixel, nil)
    c:Render(); equal(s.shown, false)
    c:Toggle(); equal(c.visible, true); equal(s.shown, true)
end)

test("controller scroll offsets live per tab in memory, clamp to history, snap on send and survive chunks", function()
    local c, s = fixture()
    c:SetViewportRows(1)
    local function history(count)
        local rows = {}
        for i = 1, count do rows[i] = "old " .. i end
        return rows
    end
    local sessions = screens({ "one" }, { "two" })
    sessions[1].history = history(10)
    s:Accept({ sessions = sessions })
    equal(c:Snapshot().scroll.offset, 0)
    equal(#c:Snapshot().sessions[1].history, 10, "sessions keep their history for the view")
    assert(c:Scroll("claude", 3)); equal(c:Snapshot().scroll.offset, 3); equal(s.snapshot.scroll.offset, 3)
    assert(c:Scroll("claude", 100)); equal(c:Snapshot().scroll.offset, 10, "scrolling up clamps to the history length")
    assert(c:Scroll("claude", -4)); equal(c:Snapshot().scroll.offset, 6)
    assert(c:Scroll("claude", -100)); equal(c:Snapshot().scroll.offset, 0, "scrolling down clamps to the bottom")
    equal(c:Scroll("other", 1), false); equal(c:Scroll("claude", "3"), false); equal(c:Scroll("claude", 0 / 0), false)
    local rendered = s.rendered
    assert(c:Scroll("claude", -1)); equal(s.rendered, rendered, "an unchanged offset does not redraw")
    assert(c:Scroll("claude", 5)); assert(c:Scroll("codex", 5))
    c:SelectTab("codex")
    equal(c:Snapshot().scroll.offset, 0)
    equal(#c:Snapshot().sessions[2].history, 0, "a tab without history cannot scroll")
    c:SelectTab("claude"); equal(c:Snapshot().scroll.offset, 5, "each tab keeps its own offset")
    sessions[1].history = history(12)
    s:Accept({ sessions = sessions })
    equal(c:Snapshot().scroll.offset, 5, "a new chunk keeps the offset")
    sessions[1].history = history(2)
    s:Accept({ sessions = sessions })
    equal(c:Snapshot().scroll.offset, 2, "a shorter history clamps the offset")
    equal(s.snapshot.scroll.offset, 2, "the chunk render already carries the clamped offset")
    assert(c:ScrollToBottom("claude")); equal(c:Snapshot().scroll.offset, 0)
    equal(c:ScrollToBottom("other"), false)
    sessions[1].history = history(8)
    s:Accept({ sessions = sessions })
    assert(c:Scroll("claude", 4)); assert(c:Send("claude", "hello"))
    equal(c:Snapshot().scroll.offset, 0, "sending input snaps to the bottom")
    assert(c:Scroll("claude", 4)); equal(c:Send("claude", ""), false)
    equal(c:Snapshot().scroll.offset, 4, "a rejected send leaves the view alone")
    equal(c.global.scroll, nil, "offsets are never persisted")
    for key in pairs(c.global) do assert(not tostring(key):find("scroll", 1, true), "offsets are never persisted") end
end)

test("a reader scrolled into history keeps its own rows while new output scrolls beneath", function()
    local c, s = fixture()
    c:SetViewportRows(1)
    local function history(count)
        local rows = {}
        for i = 1, count do rows[i] = "old " .. i end
        return rows
    end
    local sessions = screens({ "one" }, { "two" })
    sessions[1].history, sessions[1].scrolled = history(10), 4
    s:Accept({ sessions = sessions })
    assert(c:Scroll("claude", 5)); equal(c:Snapshot().scroll.offset, 5)

    -- Three more lines left the viewport, so the rows being read are three further from the bottom.
    sessions[1].history, sessions[1].scrolled = history(13), 7
    s:Accept({ sessions = sessions })
    equal(c:Snapshot().scroll.offset, 8, "the window follows its own rows instead of sliding")

    -- A reader at the bottom follows new output, as a terminal does.
    assert(c:ScrollToBottom("claude"))
    sessions[1].scrolled = 9
    s:Accept({ sessions = sessions })
    equal(c:Snapshot().scroll.offset, 0, "the bottom is not pushed into history")

    -- A daemon restart begins its count again; a counter that went backwards moves nothing.
    assert(c:Scroll("claude", 4))
    sessions[1].scrolled = 1
    s:Accept({ sessions = sessions })
    equal(c:Snapshot().scroll.offset, 4)

    -- An anchored offset still clamps to the history that actually arrived.
    sessions[1].history, sessions[1].scrolled = history(5), 40
    s:Accept({ sessions = sessions })
    equal(c:Snapshot().scroll.offset, 5)
    equal(c:Snapshot().scroll.max, 5, "the controller reports the current viewport bound")
end)

test("cropped live rows are reachable and resize keeps controller and view scroll in agreement", function()
    local c, s = fixture()
    local f = assert(loadfile("tests/witchcraft/view.lua"))()({ fixture = true })
    local ok, err = xpcall(function()
        c.view, f.view.controller = f.view, c
        function f.controller:Scroll(tab, delta) return c:Scroll(tab, delta) end
        local rows = {}
        for i = 1, 40 do rows[i] = "row " .. i end
        s:Accept({ sessions = screens(rows, { "short screen" }) })
        f.view.frame:SetSize(580, 280)
        local visible = f.view.visibleRows
        assert(visible > 0 and visible < #rows, "the small window must crop the live screen")
        local overflow = #rows - visible
        equal(f.view.rows[1]:GetText(), "row " .. (overflow + 1))
        equal(c:Snapshot().scroll.max, overflow)
        f.view.terminal.scripts.OnMouseWheel(f.view.terminal, 100)
        equal(c:Snapshot().scroll.offset, overflow)
        equal(f.view.rows[1]:GetText(), "row 1")
        equal(f.view.rows[visible]:GetText(), "row " .. visible)
        c:SelectTab("codex"); equal(c:Snapshot().scroll.max, 0)
        c:SelectTab("claude"); equal(c:Snapshot().scroll.offset, overflow)
        f.view.frame:SetSize(900, 720)
        equal(f.view.visibleRows, #rows, "the expanded window fits the complete live screen")
        equal(c:Snapshot().scroll.offset, 0, "growing the viewport clamps stored state")
        equal(f.view.rows[1]:GetText(), "row 1"); equal(f.view.rows[40]:GetText(), "row 40")
        f.view.frame:SetSize(580, 280)
        c:SetFontSize(20)
        equal(c:Snapshot().scroll.max, 40 - f.view.visibleRows)
        c:Scroll("claude", 100); equal(f.view.rows[1]:GetText(), "row 1")
        s:Accept({ sessions = screens({ "replacement" }, { "short screen" }) })
        equal(c:Snapshot().scroll.offset, 0); equal(c:Snapshot().scroll.max, 0)
        equal(f.view.rows[1]:GetText(), "replacement")

        c:SetFontSize(10); f.view.frame:SetSize(900, 720)
        local histories, shortRows = {}, {}
        for i = 1, 50 do histories[i] = "history " .. i end
        for i = 1, 10 do shortRows[i] = "short row " .. i end
        local sessions = screens(rows, { "other" })
        sessions[1].history = histories
        s:Accept({ sessions = sessions }); c:Scroll("claude", 100)
        equal(c:Snapshot().scroll.offset, 50); equal(f.view.rows[1]:GetText(), "history 1")
        sessions[1].lines = shortRows
        s:Accept({ sessions = sessions, rows = 10 })
        equal(f.view.visibleRows, 10)
        equal(c:Snapshot().scroll.offset, 50, "host row shrink does not clamp against the previous viewport")
        equal(f.view.rows[1]:GetText(), "history 1")
    end, debug.traceback)
    f.restore(); assert(ok, err)
end)

test("a tab that starts waiting or stops working alerts once, only when the player is not looking at it", function()
    local c, s = fixture()
    local alerts = {}
    c.view.Alert = function(_, id, kind) alerts[#alerts + 1] = id .. ":" .. kind end
    local sessions = screens({ "one" }, { "two" })
    sessions[1].state, sessions[2].state = "idle", "working"
    s:Accept({ sessions = sessions })
    equal(#alerts, 0, "the first screen of a host is a baseline")
    sessions[2].state = "idle"; s:Accept({ sessions = sessions })
    equal(alerts[1], "codex:done"); equal(c:Snapshot().attention.codex, "done")
    s:Accept({ sessions = sessions }); equal(#alerts, 1, "an unchanged state does not repeat the alert")
    sessions[2].state, sessions[2].choices = "waiting", { options = { "Yes", "Yes, always", "No" }, selected = 2 }
    s:Accept({ sessions = sessions })
    equal(alerts[2], "codex:waiting"); equal(c:Snapshot().attention.codex, "waiting")
    c:SelectTab("codex")
    equal(c:Snapshot().attention.codex, false, "looking at the tab clears its attention")
    sessions[1].state = "working"; s:Accept({ sessions = sessions })
    sessions[1].state = "idle"; s:Accept({ sessions = sessions })
    equal(alerts[3], "claude:done", "the other tab still alerts")
    sessions[2].state, sessions[2].choices = "working", nil; s:Accept({ sessions = sessions })
    sessions[2].state = "idle"; s:Accept({ sessions = sessions })
    equal(#alerts, 3, "the tab being looked at never alerts")
end)

test("a choice moves from the marked option with arrow keys, then Enter, and refuses stale menus", function()
    local clock = { now = 0 }
    local c, s = fixture(nil, { GetTime = function() return clock.now end })
    local sessions = screens({ "one" }, { "two" })
    sessions[2].state, sessions[2].choices = "waiting", { options = { "Yes", "Yes, always", "No" }, selected = 2 }
    s:Accept({ sessions = sessions })
    -- Each answer is delivered, and the same menu is asked again once the settle time has passed.
    local function answer(index, nextScreen)
        assert(c:Choose("codex", index))
        local list = {}
        for _, message in ipairs(c.global.outbox) do list[#list + 1] = message.tab .. ":" .. message.action end
        sessions[2].lines = { nextScreen }
        s:Accept({ sessions = sessions, ack = c.global.outbox[#c.global.outbox].id })
        clock.now = clock.now + 2
        return table.concat(list, ",")
    end
    equal(answer(3, "menu again"), "codex:down,codex:enter")
    equal(answer(1, "menu once more"), "codex:up,codex:enter")
    equal(answer(2, "and again"), "codex:enter", "the marked option needs only Enter")
    equal(c:Choose("codex", 4), false); equal(c:Choose("codex", 1.5), false)
    equal(c:Choose("claude", 1), false, "a tab without a menu has nothing to choose")
    equal(#c.global.outbox, 0, "refused choices queue nothing")
end)

test("a menu is answered once: repeat clicks are refused until the terminal has moved on", function()
    local clock = { now = 100 }
    local c, s = fixture(nil, { GetTime = function() return clock.now end })
    local sessions = screens({ "one" }, { "Task A (3s)", "Allow this command?" })
    sessions[2].state, sessions[2].choices = "waiting", { options = { "Yes", "Yes, don't ask again", "No" }, selected = 1 }
    s:Accept({ sessions = sessions })
    assert(c:Choose("codex", 1))
    local queued = #c.global.outbox
    local ok, reason = c:Choose("codex", 2)
    equal(ok, false, "a second click must not queue an answer for the next prompt")
    assert(type(reason) == "string" and reason:find("still on its way", 1, true), tostring(reason))
    equal(#c.global.outbox, queued)
    equal(c:Snapshot().answered.codex, true, "the view hides the buttons while Choose would refuse")
    -- The chunk that acknowledges the answer still shows the menu, and an unrelated line has ticked.
    local delivered = c.global.outbox[#c.global.outbox].id
    sessions[2].lines = { "Task A (4s)", "Allow this command?" }
    s:Accept({ sessions = sessions, ack = delivered })
    clock.now = 101
    sessions[2].lines = { "Task A (5s)", "Allow this command?" }
    s:Accept({ sessions = sessions, ack = delivered })
    ok, reason = c:Choose("codex", 2)
    equal(ok, false, "a ticking timer is not the terminal answering")
    assert(type(reason) == "string" and reason:find("Already answered", 1, true), tostring(reason))
    -- Two seconds after delivery the same menu is a new question: the next of several parallel
    -- tool calls, or the CLI ignoring the keys.
    clock.now = 102
    equal(c:Snapshot().answered.codex, false)
    assert(c:Choose("codex", 1), "the identical next prompt can be answered")
end)

test("an answered menu that the terminal replaces can be answered again when it comes back", function()
    local c, s = fixture()
    local sessions = screens({ "one" }, { "Pick a model" })
    sessions[2].state, sessions[2].choices = "waiting", { options = { "Opus", "Sonnet" }, selected = 1 }
    s:Accept({ sessions = sessions })
    assert(c:Choose("codex", 1))
    local delivered = c.global.outbox[#c.global.outbox].id
    sessions[2].state, sessions[2].choices, sessions[2].lines = "idle", nil, { "Model set" }
    s:Accept({ sessions = sessions, ack = delivered })
    sessions[2].state, sessions[2].choices = "waiting", { options = { "Opus", "Sonnet" }, selected = 1 }
    sessions[2].lines = { "Pick a model" }
    s:Accept({ sessions = sessions, ack = delivered })
    equal(c:Snapshot().answered.codex, false)
    assert(c:Choose("codex", 2), "the same menu opened again is a new question")
end)

test("the choice buttons stay away while a typed prompt for that tab is still on its way", function()
    local c, s = fixture()
    local sessions = screens({ "one" }, { "Allow?" })
    sessions[2].state, sessions[2].choices = "waiting", { options = { "Yes", "No" }, selected = 1 }
    s:Accept({ sessions = sessions })
    assert(c:Send("codex", "hello"))
    equal(c:Snapshot().answered.codex, true)
    local ok, reason = c:Choose("codex", 1)
    equal(ok, false); assert(type(reason) == "string" and reason:find("Input for this tab", 1, true), tostring(reason))
end)

test("a choice is refused while an arrow key for that tab is still on its way", function()
    local c, s = fixture()
    local sessions = screens({ "one" }, { "Pick one" })
    sessions[2].state, sessions[2].choices = "waiting", { options = { "A", "B", "C" }, selected = 1 }
    s:Accept({ sessions = sessions })
    assert(c:Action("codex", "down"))
    equal(c:Choose("codex", 2), false, "down, then the moves computed from the old marker, would select C")
    equal(#c.global.outbox, 1)
end)

test("input for a tab that is no longer running is refused in game instead of queued and dropped later", function()
    local c, s = fixture()
    local sessions = screens({ "one" }, { "last screen" })
    sessions[2].status = "exited (console 9 closed)"
    s:Accept({ sessions = sessions })
    local ok, reason = c:Send("codex", "continue")
    equal(ok, false); assert(type(reason) == "string" and reason:find("exited", 1, true), tostring(reason))
    equal(c:Action("codex", "enter"), false, "keys are refused too")
    equal(#c.global.outbox, 0)
    assert(c:Send("claude", "still here"), "the other tab is unaffected")
end)

test("a tab that is no longer running cannot answer the menu it last showed", function()
    local c, s = fixture()
    local sessions = screens({ "one" }, { "two" })
    sessions[2].state, sessions[2].choices = "waiting", { options = { "Yes", "No" }, selected = 1 }
    sessions[2].status = "exited (console 9 closed)"
    s:Accept({ sessions = sessions })
    local ok, reason = c:Choose("codex", 1)
    equal(ok, false); assert(type(reason) == "string" and reason:find("exited", 1, true), tostring(reason))
    equal(#c.global.outbox, 0, "nothing is queued for a console that has closed")
end)

test("snippets are bounded, persisted and managed from the slash command", function()
    local c, s = fixture()
    equal(#c:Snapshot().snippets, 0)
    c:HandleSlash("snippet add   Run the tests  "); equal(c.global.snippets[1], "Run the tests")
    equal(s.printed[#s.printed], "Snippet 1 saved"); equal(s.snapshot.snippets[1], "Run the tests")
    local copy = c:Snapshot(); copy.snippets[1] = "changed"
    equal(c.global.snippets[1], "Run the tests", "the snapshot does not expose the saved list")
    equal(c:AddSnippet(""), false); equal(c:AddSnippet(string.rep("x", 601)), false); equal(c:AddSnippet("a\nb"), false)
    for i = 2, 20 do assert(c:AddSnippet("snippet " .. i)) end
    equal(c:AddSnippet("one too many"), false)
    c:HandleSlash("snippet remove 2"); equal(#c.global.snippets, 19); equal(c.global.snippets[2], "snippet 3")
    c:HandleSlash("snippet remove 99"); equal(s.printed[#s.printed], "No snippet 99")
    c:HandleSlash("snippet list"); equal(s.printed[#s.printed], "19. snippet 20")
    equal(ns.Persistence.Validate({ global = { snippets = { "ok", 5 } } }), false)
    equal(ns.Persistence.Validate({ global = { snippets = { "bad\1" } } }), false)
    equal(ns.Persistence.Validate({ global = { snippets = { "fine" } } }), true)
end)

test("keybinding actions open and focus, switch tabs, and interrupt the selected agent", function()
    local c, s = fixture()
    s:Accept()
    local focused = 0
    c.view.FocusInput = function() focused = focused + 1 end
    c:Hide(); assert(c:FocusInput()); equal(c.visible, true); equal(focused, 1)
    c:NextTab(); equal(c.global.activeTab, "codex"); c:NextTab(); equal(c.global.activeTab, "claude")
    assert(c:Interrupt())
    local last = c.global.outbox[#c.global.outbox]
    equal(last.tab, "claude"); equal(last.action, "interrupt")
end)

test("a hidden tab is not listed, cycled or selected, and one tab always stays visible", function()
    local c, s = fixture()
    s:Accept()
    equal(table.concat(c:Snapshot().tabs, ","), "claude,codex")
    assert(c:SetSetting("tabCodex", false))
    equal(table.concat(c:Snapshot().tabs, ","), "claude")
    c:NextTab(); equal(c.global.activeTab, "claude", "a hidden tab is skipped when cycling")
    local ok, reason = c:SelectTab("codex")
    equal(ok, false); equal(reason, "That tab is hidden"); equal(c.global.activeTab, "claude")
    -- Copilot is off by default, so Claude is the last visible tab and cannot be hidden.
    ok, reason = c:SetSetting("tabClaude", false)
    equal(ok, false); equal(reason, "At least one tab stays visible"); equal(c:Setting("tabClaude"), true)
    assert(c:SetSetting("tabCodex", true)); assert(c:SelectTab("codex"))
    assert(c:SetSetting("tabCodex", false))
    equal(c.global.activeTab, "claude", "hiding the selected tab moves to the first visible one")
    equal(c:SetSetting("tabClaude", "yes"), false, "a tab setting takes a boolean")
    -- Switched on, Copilot is listed with no Copilot session at all and can be the only tab left.
    assert(c:SetSetting("tabCopilot", true))
    equal(table.concat(c:Snapshot().tabs, ","), "claude,copilot")
    assert(c:SetSetting("tabClaude", false))
    equal(table.concat(c:Snapshot().tabs, ","), "copilot"); equal(c.global.activeTab, "copilot")
    ok, reason = c:SetSetting("tabCopilot", false)
    equal(ok, false); equal(reason, "At least one tab stays visible")
    -- An older host without Copilot leaves it the only tab: still listed and selected, and input to it is refused.
    s:Accept()
    equal(table.concat(c:Snapshot().tabs, ","), "copilot"); equal(c.global.activeTab, "copilot")
    ok, reason = c:Queue("copilot", "text", "x")
    equal(ok, false); equal(reason, "That terminal is not available")
    -- A saved file with only Copilot switched on lists Copilot before any host starts it.
    local fresh = fixture({ settings = { tabClaude = false, tabCodex = false, tabCopilot = true } })
    equal(table.concat(fresh:Snapshot().tabs, ","), "copilot")
    -- A saved selection on a tab hidden since it was saved moves to the first tab still shown on load.
    local moved = fixture({ activeTab = "codex", settings = { tabCodex = false } })
    equal(moved.global.activeTab, "claude")
end)

test("a long or multi-line prompt queues as marked parts on UTF-8 boundaries, whole or not at all", function()
    local c, s = fixture()
    s:Accept()
    s:Accept({ promptProtocol = 1, promptResults = {} })
    assert(c:SendLong("claude", "short prompt")); equal(c.global.outbox[1].prompt, true, "one short line takes the receipt path")
    equal(ns.Prompts.Group(c.global.outbox, c.global.outbox[1]), "short prompt")
    assert(c:SendLong("codex", "first line\r\nsecond line\n"))
    equal(ns.Prompts.Group(c.global.outbox, c.global.outbox[2]), "first line\nsecond line\n", "newlines and the final line survive")
    local long = string.rep("\195\169", 700) -- 1400 bytes of a two-byte letter
    local before = #c.global.outbox
    assert(c:SendLong("claude", long))
    local parts = {}
    for i = before + 1, #c.global.outbox do parts[#parts + 1] = c.global.outbox[i].text end
    equal(#parts, 3)
    local joined = ns.Prompts.Group(c.global.outbox, c.global.outbox[before + 1])
    equal(joined, long, "the parts rejoin to the prompt")
    for _, part in ipairs(parts) do
        assert(#part <= 600 and ns.Pixel.ValidText(part), "each part is a valid carrier text")
    end
    local queued = #c.global.outbox
    equal(c:SendLong("claude", string.rep("x", 4700)), false, "text beyond the byte budget is refused")
    equal(c:SendLong("claude", "   "), false)
    equal(#c.global.outbox, queued, "a refused prompt queues nothing")
end)

test("SendLong cleans pasted tabs and control bytes and names the waiting host", function()
    local idle = fixture()
    local ok, reason = idle:SendLong("claude", "first line\nsecond line")
    equal(ok, false); equal(reason, "Wait for the terminal host", "a multi-line draft before the host connects")
    local old, olds = fixture()
    olds:Accept()
    ok, reason = old:SendLong("claude", "first line\nsecond line")
    equal(ok, false); equal(reason, "Update the desktop daemon to send this prompt; the draft is retained")
    local c, s = fixture()
    s:Accept()
    s:Accept({ promptProtocol = 1, promptResults = {} })
    assert(c:SendLong("claude", "a\tb"))
    equal(#c.global.outbox, 1); equal(c.global.outbox[1].prompt, true)
    equal(ns.Prompts.Group(c.global.outbox, c.global.outbox[1]), "a    b")
    assert(c:SendLong("claude", "def f():\n\tif x:\n\t\treturn 1\n"))
    equal(c.global.outbox[2].prompt, true)
    equal(ns.Prompts.Group(c.global.outbox, c.global.outbox[2]), "def f():\n    if x:\n        return 1\n",
        "tab indentation survives as four spaces per tab")
    local before = #c.global.outbox
    assert(c:SendLong("claude", "a\0b\27c\127d"))
    equal(#c.global.outbox, before + 1)
    equal(ns.Prompts.Group(c.global.outbox, c.global.outbox[before + 1]), "abcd", "NUL, ESC and DEL are removed")
    ok, reason = c:SendLong("claude", "\0\1\27\127")
    equal(ok, false); equal(reason, "Nothing to send")
    equal(#c.global.outbox, before + 1)
end)

test("a short prompt to a current host takes the receipt path, so one the host could not deliver stays for resend", function()
    local c, s = fixture()
    s:Accept()
    s:Accept({ promptProtocol = 1, promptResults = {} })
    assert(c:SendLong("claude", string.rep("x", 600)))
    local rows = {}
    for i, message in ipairs(c.global.outbox) do rows[i] = message; equal(message.prompt, true) end
    assert(#rows >= 1)
    equal(ns.Prompts.Group(c.global.outbox, rows[1]), string.rep("x", 600))
    -- The host acknowledges the prompt without a submitted receipt (the terminal could not take it).
    s:Accept({ promptProtocol = 1, promptResults = {}, ack = rows[#rows].id })
    equal(#c.global.outbox, #rows, "an undelivered short prompt is not dropped")
    for i, message in ipairs(c.global.outbox) do equal(message, rows[i]); equal(message.review, "unconfirmed") end
    -- A short line the host confirms as submitted leaves the outbox.
    local done, ds = fixture()
    ds:Accept()
    ds:Accept({ promptProtocol = 1, promptResults = {} })
    assert(done:SendLong("claude", "short prompt"))
    local sent = done.global.outbox[#done.global.outbox]
    equal(sent.prompt, true)
    ds:Accept({ promptProtocol = 1, promptResults = { sent.id }, ack = sent.id })
    equal(#done.global.outbox, 0, "a confirmed short prompt is finished")
    -- With a current host a line over 600 bytes is a multi-part prompt rather than a refusal.
    assert(done:SendLong("claude", string.rep("y", 601)))
    equal(#done.global.outbox, 2); equal(done.global.outbox[1].prompt, true); equal(done.global.outbox[2].prompt, true)
end)

test("an older host keeps short prompts on the plain path and refuses a line over 600 bytes", function()
    local old, olds = fixture()
    olds:Accept()
    equal(old.promptProtocol, nil)
    assert(old:SendLong("claude", string.rep("x", 600)))
    equal(#old.global.outbox, 1); equal(old.global.outbox[1].prompt, nil); equal(old.global.outbox[1].text, string.rep("x", 600))
    local ok, reason = old:SendLong("claude", string.rep("y", 601))
    equal(ok, false); equal(reason, "Update the desktop daemon to send this prompt; the draft is retained")
    equal(#old.global.outbox, 1)
end)

test("a short prompt retained from a current host resends plain to an older host; a multi-line one stays", function()
    local c, s = fixture()
    s:Accept()
    s:Accept({ promptProtocol = 1, promptResults = {} })
    assert(c:SendLong("claude", "short prompt"))
    local kept = c.global.outbox[1]
    equal(#c.global.outbox, 1); equal(kept.prompt, true)
    -- The host restarts as an older daemon: the prompt group is retained under the earlier epoch.
    s:Accept({ epoch = "87654321" })
    equal(c.promptProtocol, nil); equal(c:Retained(kept.id), kept)
    assert(c:Resend(kept.id))
    equal(#c.global.outbox, 1, "the retained rows leave as the plain row is queued")
    local row = c.global.outbox[1]
    assert(row ~= kept, "the old row is gone")
    equal(row.action, "text"); equal(row.text, "short prompt"); equal(row.prompt, nil); equal(row.epoch, "87654321")
    -- A retained multi-line prompt still needs a current host.
    local m, ms = fixture()
    ms:Accept()
    ms:Accept({ promptProtocol = 1, promptResults = {} })
    assert(m:SendLong("claude", "first line\nsecond line"))
    local rows = {}
    for i, message in ipairs(m.global.outbox) do rows[i] = message end
    ms:Accept({ epoch = "87654321" })
    local ok, reason = m:Resend(rows[1].id)
    equal(ok, false); equal(reason, "Update the desktop daemon to send this prompt; the draft is retained")
    equal(#m.global.outbox, #rows)
    for i, message in ipairs(m.global.outbox) do equal(message, rows[i], "the retained rows stay") end
end)

test("settings default, validate, persist and apply through one controller path", function()
    local c, s = fixture()
    equal(c:Setting("layer"), "normal"); equal(c:Setting("escapeCloses"), false); equal(c:Setting("historySize"), 50)
    equal(c:Snapshot().settings.minimap, true)
    local shown
    c.api.SetMinimapShown = function(value) shown = value end
    assert(c:SetSetting("minimap", false)); equal(shown, false); equal(s.snapshot.settings.minimap, false)
    for key, bad in pairs({ layer = "sideways", locked = "yes", historySize = 30, nothing = true }) do
        equal(c:SetSetting(key, bad), false, "refused " .. key)
    end
    equal(c:Setting("layer"), "normal")
    local copy = c:Snapshot().settings; copy.layer = "top"
    equal(c:Setting("layer"), "normal", "the snapshot does not expose the saved settings")
    equal(ns.Persistence.Validate({ global = { settings = { layer = "top", futureKey = { 1 } } } }), true, "unknown keys are kept")
    equal(ns.Persistence.Validate({ global = { settings = { layer = "sideways" } } }), false)
    equal(ns.Persistence.Validate({ global = { settings = "on" } }), false)
    local hidden = fixture({ settings = { openOnLoad = false } })
    equal(hidden.visible, false, "open on load can be turned off")
end)

test("keep updating in combat lifts only the inbound pause", function()
    local c, s = fixture()
    s:Accept()
    s.combat = true
    equal(c:InboundPaused(), true); equal(c:Snapshot().combat, true)
    local loads = #s.loads
    c:LoadTick(); equal(#s.loads, loads, "combat freezes terminal updates by default")
    assert(c:SetSetting("combatUpdates", true))
    equal(c:InboundPaused(), false); equal(c:Snapshot().combat, false, "the view is not told to freeze")
    c:LoadTick(); equal(#s.loads, loads + 1, "updates keep loading in combat")
    equal(c:HeartbeatFlags() % 2, 1, "the host still hears the real combat state")
    equal(c:OpenSettings(), false); equal(s.printed[#s.printed], "Witchcraft settings open after combat")
    s.combat = false
    c.api.OpenSettings = function() return true end
    assert(c:OpenSettings())
end)

test("alert settings choose the text, the sound and whether finishing counts", function()
    local c, s = fixture()
    local alerts = {}
    c.view.Alert = function(_, id, kind, show) alerts[#alerts + 1] = { id = id, kind = kind, show = show } end
    local sessions = screens({ "one" }, { "two" })
    sessions[2].state = "working"; s:Accept({ sessions = sessions })
    assert(c:SetSetting("alertFinished", false))
    sessions[2].state = "idle"; s:Accept({ sessions = sessions })
    equal(#alerts, 0, "finishing is silent when only needs-you alerts are wanted")
    equal(c:Snapshot().attention.codex, false)
    assert(c:SetSetting("alertSound", false))
    sessions[2].state, sessions[2].choices = "waiting", { options = { "Yes", "No" }, selected = 1 }
    s:Accept({ sessions = sessions })
    equal(alerts[1].kind, "waiting"); equal(alerts[1].show.text, true); equal(alerts[1].show.sound, false)
    assert(c:SetSetting("alertText", false))
    sessions[2].state, sessions[2].choices = "working", nil; s:Accept({ sessions = sessions })
    sessions[2].state, sessions[2].choices = "waiting", { options = { "Yes", "No" }, selected = 1 }
    s:Accept({ sessions = sessions })
    equal(#alerts, 1, "with text and sound off no alert is shown")
    equal(c:Snapshot().attention.codex, "waiting", "the tab badge still says why")
end)

test("the trace records why a loaded slot was refused, and a repeating refusal once", function()
    local c, s = fixture()
    s:Accept()
    local before = #c.global.trace
    s:Accept({ rows = 61 })
    local refused = c.global.trace[#c.global.trace]
    assert(refused:find("refused: Rejected chunk", 1, true), "the ring's own reason survives: " .. refused)
    assert(#c.global.trace > before)
    c:Trace("carrier pump: waiting", "pump"); local count = #c.global.trace
    c:Trace("carrier pump: waiting", "pump"); equal(#c.global.trace, count, "an unchanged refusal is recorded once")
    for i = 1, 700 do c:Trace("line " .. i) end
    equal(#c.global.trace, 600, "the trace is bounded")
    c:HandleSlash("trace"); equal(s.printed[#s.printed]:match("line 700$"), "line 700")
end)

test("a slot the host has not written, after a live session, is a pause that retries quickly", function()
    local c, s = fixture()
    s:Accept({ rows = 61 })
    equal(c:Snapshot().paused, false, "a session that never linked is not paused")
    s:Accept()
    equal(c:Snapshot().paused, false); equal(c:Snapshot().connected, true)
    s:Accept({ rows = 61 })
    local snap = c:Snapshot()
    equal(snap.paused, true); equal(c.ring.delay, 2, "the next slot is tried soon, not after eight seconds")
    assert(snap.status:find("background", 1, true), "the footer explains the pause")
    s:Accept({ ready = false, changed = nil })
    equal(c:Snapshot().paused, true, "a placeholder slot is the same pause"); equal(c.ring.delay, 4)
    for index, delay in ipairs({ 8, 16, 30, 30 }) do
        s:Accept(index % 2 == 1 and { rows = 61 } or { ready = false, changed = nil })
        equal(c.ring.delay, delay, "each further silent slot doubles the retry, up to the ceiling")
    end
    s:Accept()
    equal(c:Snapshot().paused, false, "the next accepted chunk ends the pause"); equal(c:Snapshot().connected, true)
    s:Accept({ rows = 61 })
    equal(c.ring.delay, 2, "an accepted chunk resets the next stall to a quick retry")
end)

test("the ring warns once at 90% used", function()
    local c, s = fixture({ ringSize = 10 })
    local function printed(needle)
        local count = 0
        for _, line in ipairs(s.printed) do if line:find(needle, 1, true) then count = count + 1 end end
        return count
    end
    while c.ring.nextSeq < 9 do s:Accept({ ringSize = 10 }) end
    equal(printed("ring 90% used"), 0, "eight of ten slots used is below the line")
    s:Accept({ ringSize = 10 }); equal(c.ring.nextSeq, 10)
    equal(printed("ring 90% used (9 of 10 slots)"), 1)
    s:Accept({ ringSize = 10 }); equal(c.ring.nextSeq, 11)
    equal(printed("ring 90% used"), 1, "the warning prints once per UI session")
end)

test("a stalled or file-driven link advertises the ring slot on the binding carrier", function()
    local c, s = fixture()
    c.binding = { enabled = true, beats = {}, Busy = function() return false end, AcceptHost = function() return false end,
        Pump = function() end, OfferInput = function() return false end, OfferContext = function() return false end,
        Snapshot = function() return { status = "fake", enabled = true } end, Stop = function() return true end,
        Cancel = function() return true end,
        Heartbeat = function(self, slot, flags) self.beats[#self.beats + 1] = { slot, flags }; return true end }
    local beats = c.binding.beats
    s:Accept({ cursorLane = "strip" })
    equal(c.cursorLane, "strip"); equal(#beats, 0, "the strip moves the cursor, so the carrier stays quiet")
    s:Accept({ cursorLane = "file" })
    equal(c.cursorLane, "file"); equal(#beats, 1)
    equal(beats[1][1], c.ring.nextSeq); equal(beats[1][2], 0)
    c:HandleSlash("status")
    local printed = table.concat(s.printed, "\n")
    assert(printed:find("cursor file", 1, true), printed)
    -- A busy carrier sends nothing; the heartbeat waits for the data frame to finish.
    c.binding.Busy = function() return true end
    s:Accept({ cursorLane = "file" })
    equal(#beats, 1)
    c.binding.Busy = function() return false end
    -- A placeholder after a live session is the stall: no lane is known, and the slot is still advertised.
    local before = #beats
    s:Accept({ ready = false, changed = nil })
    equal(c:Snapshot().paused, true); equal(c.cursorLane, nil)
    assert(#beats > before); equal(beats[#beats][1], c.ring.nextSeq)
end)

test("the controller loads the error store and /witch errors lists or clears it", function()
    local now = { value = 100 }
    local store = ns.Errors.New({ time = function() return now.value end })
    store:Record("error", "before load", "Hello/Hello.lua:3: in main chunk")
    local c, s = fixture({ errorSession = 6 }, { Errors = store })
    equal(c.global.errorSession, 7); equal(#c.global.errors, 1, "errors seen before load are kept")
    now.value = 160
    c:HandleSlash("errors")
    local printed = table.concat(s.printed, "\n")
    assert(printed:find("1 stored", 1, true), printed)
    assert(printed:find("before load", 1, true) and printed:find("Hello/Hello.lua:3", 1, true), printed)
    c:HandleSlash("errors clear")
    equal(#c.global.errors, 0); equal(s.printed[#s.printed], "Errors cleared")
    c:HandleSlash("errors")
    equal(s.printed[#s.printed], "No Lua errors stored")
end)

test("the pixel strip stands aside for context while the binding carrier is active, and takes over on key occupation or ACK timeout", function()
    local clock = { now = 10 }
    local c, s = fixture(nil, { GetTime = function() return clock.now end, Context = { Capture = function() return { { true } } end } })
    local offered, hasKey, pumpResult = {}, true, true
    c.binding = { enabled = true, quarantined = false, lastWriteAt = 0,
        Now = function() return clock.now end,
        HasKey = function() return hasKey end,
        Busy = function(self) return self.active ~= nil or self.outstanding ~= nil end,
        AcceptHost = function() return false end,
        Pump = function(self)
            if self.active and not self.outstanding and pumpResult then
                self.outstanding = { seq = 1, sentAt = clock.now }
                return true
            end
            return false
        end,
        OfferInput = function() return false end,
        OfferContext = function(self, msg)
            offered[#offered + 1] = msg.id
            self.active = { kind = "context", identity = "context:" .. msg.id }
            return true
        end,
        Snapshot = function() return { status = "ready", enabled = true } end,
        Stop = function() return true end,
        Cancel = function(self) self.active, self.outstanding = nil, nil; return true end,
        Heartbeat = function() return true end }
    s:Accept({ contextProtocol = 4, contextAck = 0, contextWant = 1, contextWantMask = 1 })
    c:ContextTick()
    assert(c.contextPending, "context snapshot is pending")
    c:BindingTick()
    equal(#offered, 1, "BindingTick offered the context frame to the binding carrier")
    c:PixelTick()
    equal(s.top, nil, "PixelTick stands aside while BindingContextActive() is true")
    -- After 5 seconds without a host ACK on the binding frame, the optical strip takes over.
    clock.now = 15
    c:BindingTick()
    equal(c.binding.contextBlocked, true, "ACK timeout blocks the binding context lane until the host answers")
    assert(s.top ~= nil, "PixelTick immediately transmits context after binding ACK timeout")
    -- For a row the strip has not taken (mark and row flag reset), occupying all keys also lets the strip take over.
    c.binding.contextBlocked, c.contextPending.viaStrip = nil, nil
    hasKey = false
    s.top = nil
    c:PixelTick()
    assert(s.top ~= nil, "PixelTick takes over when all reserved binding keys are occupied")
    -- If a key appeared available before Pump but the claim failed inside Pump, the strip takes over.
    hasKey, pumpResult = true, false
    s.top = nil
    c:BindingTick()
    equal(c.binding.contextBlocked, true, "failed key claim during Pump falls back to the optical strip")
    assert(s.top ~= nil, "PixelTick transmits context after failed key claim")
end)

test("autoBindProbe qualifies the binding carrier once per host session outside combat and bindprobe off releases any claimed key", function()
    local c, s = fixture({ settings = { autoBindProbe = true, combatUpdates = true } })
    local probes, stopped = 0, 0
    c.binding = { enabled = false, quarantined = false, Busy = function() return false end,
        AcceptHost = function() return false end, Pump = function() end,
        Probe = function(_, nonce) probes = probes + 1; equal(nonce, c.uiNonce); return true end,
        Snapshot = function() return { status = "idle", enabled = false } end,
        Stop = function() stopped = stopped + 1; return true end, Cancel = function() return true end }
    s.combat = true
    s:Accept({ epoch = "11111111" })
    equal(probes, 0, "autoBindProbe waits while in combat")
    s.combat = false
    c:OnEvent("PLAYER_REGEN_ENABLED")
    equal(probes, 1, "autoBindProbe fires when combat ends")
    s:Accept({ epoch = "11111111" })
    equal(probes, 1, "autoBindProbe runs only once per host epoch")
    s:Accept({ epoch = "22222222" })
    equal(probes, 2, "a new host epoch triggers a fresh probe")
    c:HandleSlash("bindprobe off")
    equal(c:Setting("autoBindProbe"), false)
    equal(stopped, 1, "bindprobe off immediately stops the carrier and restores any claimed probe key, once")
    c:HandleSlash("bindprobe auto")
    equal(c:Setting("autoBindProbe"), true)
    -- A carrier the option qualified stops when the option is turned off.
    s:Accept({ epoch = "33333333" })
    equal(probes, 3)
    assert(c:SetSetting("autoBindProbe", false))
    equal(stopped, 2, "turning the option off stops an auto-qualified carrier")
    -- A carrier qualified by hand stays up when the option is turned off, even after an earlier auto probe.
    assert(c:SetSetting("autoBindProbe", true))
    s:Accept({ epoch = "44444444" })
    equal(probes, 4)
    c:HandleSlash("bindprobe")
    equal(probes, 5)
    assert(c:SetSetting("autoBindProbe", false))
    equal(stopped, 2, "turning the option off leaves a hand-qualified carrier alone")
    c:HandleSlash("bindprobe off")
    equal(stopped, 3, "an explicit bindprobe off still stops a hand-qualified carrier")
end)

test("/witch cols and /witch context clear-journal route as control actions to a running session, cap at 160, and expire on host restart", function()
    local c, s = fixture()
    local codexOnly = screens({ "claude idle" }, { "codex live" })
    codexOnly[1].status = "not started"
    codexOnly[2].status = "running"
    s:Accept({ sessions = codexOnly })
    equal(c.global.activeTab, "claude", "activeTab is still claude in a Codex-only session")
    c.view.FittedCols = function() return 160 end
    c:HandleSlash("cols 132")
    local first = c.global.outbox[#c.global.outbox]
    equal(first.action, "control")
    equal(first.tab, "codex", "control requests target a running session instead of an inactive claude tab")
    equal(first.text, "cols=132")
    equal(s.printed[#s.printed], "Terminal width request queued (132 columns)")
    c:HandleSlash("cols 160")
    equal(c.global.outbox[#c.global.outbox].text, "cols=160")
    c:HandleSlash("cols 161")
    equal(s.printed[#s.printed], "Columns must be 40 to 160, or fit")
    c:HandleSlash("cols fit")
    equal(c.global.outbox[#c.global.outbox].text, "cols=160")
    c:HandleSlash("cols 20")
    equal(s.printed[#s.printed], "Columns must be 40 to 160, or fit")
    c:HandleSlash("context clear-journal")
    local clearMsg = c.global.outbox[#c.global.outbox]
    equal(clearMsg.action, "control")
    equal(clearMsg.tab, "codex")
    equal(clearMsg.text, "clear-journal")
    equal(s.printed[#s.printed], "Session journal clear queued")
    -- Queue an ordinary prompt alongside the control messages, then restart the host.
    assert(c:Send("codex", "keep this prompt"))
    s:Accept({ epoch = "87654321", sessions = codexOnly })
    equal(#c.global.outbox, 1, "control requests expire when the host changes")
    equal(c.global.outbox[1].action, "text")
    equal(c.global.outbox[1].text, "keep this prompt")
    assert(c:Resend())
    equal(#c.global.outbox, 1)
    equal(c.global.outbox[1].text, "keep this prompt")
end)

test("combatWindow hides or minimizes during combat and restores cleanly afterward without overriding manual changes", function()
    local c, s = fixture({ settings = { combatWindow = "hide" } })
    s:Accept()
    equal(c.visible, true)
    s.combat = true; c:OnEvent("PLAYER_REGEN_DISABLED")
    equal(c.visible, false); equal(s.shown, false)
    s.combat = false; c:OnEvent("PLAYER_REGEN_ENABLED")
    equal(c.visible, true); equal(s.shown, true, "auto-hidden window reopens after combat")
    -- If the window was already closed before combat, leaving combat leaves it closed.
    c:Hide()
    s.combat = true; c:OnEvent("PLAYER_REGEN_DISABLED")
    s.combat = false; c:OnEvent("PLAYER_REGEN_ENABLED")
    equal(c.visible, false, "already-closed window stays closed after combat")
    -- Minimize mode collapses only an expanded visible window and restores it after combat.
    c:SetVisible(true)
    assert(c:SetSetting("combatWindow", "minimize"))
    s.combat = true; c:OnEvent("PLAYER_REGEN_DISABLED")
    equal(c.global.view.minimized, true); equal(s.minimized, true)
    -- Unread output arrives while collapsed in combat.
    c:SetSetting("combatUpdates", true)
    s:Accept({ sessions = screens({ "combat reply" }, { "three" }) })
    equal(c:Snapshot().unread.claude, true, "collapsed combat bar tracks unread output")
    s.combat = false; c:OnEvent("PLAYER_REGEN_ENABLED")
    equal(c.global.view.minimized, false); equal(s.minimized, false)
    equal(c:Snapshot().unread.claude, false, "restoring expanded view marks active tab read")
end)

-- A binding carrier double: healthy and enabled unless told otherwise.
local function carrierMock(fields)
    local carrier = { enabled = true, quarantined = false, lastWriteAt = 0, beats = 0,
        HasKey = function(self) return self.hasKey ~= false end,
        Busy = function(self) return self.active ~= nil or self.outstanding ~= nil end,
        AcceptHost = function() return false end,
        Pump = function() return false end,
        OfferInput = function(self, message)
            self.active = { kind = "input", identity = "input:" .. message.epoch .. ":" .. message.id }
            return true
        end,
        OfferContext = function() return false end,
        Snapshot = function(self) return { status = "fake", enabled = self.enabled == true } end,
        Stop = function() return true end,
        Cancel = function(self) self.active, self.outstanding = nil, nil; return true end,
        Heartbeat = function(self) self.beats = self.beats + 1; return true end,
        OnBindingsChanged = function() return true end }
    for key, value in pairs(fields or {}) do carrier[key] = value end
    return carrier
end

local STRIP_OFF = "Pixel strip is off and the file link is not ready; /witch strip fallback"

test("stripMode fallback hides the strip only while the binding carrier carries everything, and off never draws it", function()
    local c, s = fixture({ settings = { stripMode = "fallback" } })
    c.binding = carrierMock()
    -- Before connecting, fallback still shows the strip so bootstrap can proceed.
    c:PixelTick()
    assert(s.heartbeat ~= nil, "strip stays visible before host connection")
    -- Connected, with a binding carrier that can carry input, context and the heartbeat: the strip hides.
    s:Accept({ cursorLane = "strip" })
    equal(c:StripActive(), false)
    equal(s.top, nil); equal(s.heartbeat, nil)
    assert(c.binding.beats >= 1, "binding carrier advertises the ring slot when the strip is hidden")
    -- The binding carrier writes nothing in combat, so fallback brings the strip back.
    s.combat = true; c:OnEvent("PLAYER_REGEN_DISABLED")
    c:PixelTick()
    assert(s.heartbeat ~= nil, "fallback strip reappears during combat")
    s.combat = false; c:OnEvent("PLAYER_REGEN_ENABLED")
    equal(s.heartbeat, nil, "fallback strip hides again when combat ends")
    -- A disabled carrier brings the strip back in fallback.
    c.binding.enabled = false
    equal(c:StripActive(), true, "fallback never hides the strip without a carrier")
    -- Off never draws the strip outside calibration, and says so while nothing else can deliver.
    c:HandleSlash("strip off")
    equal(c:Setting("stripMode"), "off")
    c:PixelTick()
    equal(s.heartbeat, nil)
    equal(c:Snapshot().status, STRIP_OFF)
    c:HandleSlash("calibrate")
    c:PixelTick()
    assert(s.top ~= nil and s.heartbeat ~= nil, "calibration always overrides stripMode off")
    c:HandleSlash("calibrate off")
    c:PixelTick()
    equal(s.top, nil); equal(s.heartbeat, nil)
end)

test("fallback draws queued input while only the cooldown carrier is active", function()
    local c, s = fixture({ settings = { stripMode = "fallback" } })
    c.binding = carrierMock({ enabled = false })
    s:Accept()
    c.CooldownActive = function() return true end
    equal(c:StripActive(), true, "the cooldown carrier never carries input, so it never hides the strip")
    assert(c:Send("codex", "hello"))
    s.top = nil; c:PixelTick()
    assert(s.top ~= nil, "the queued prompt is drawn on the strip")
end)

test("fallback shows the strip whenever the binding carrier cannot carry input", function()
    local c, s = fixture({ settings = { stripMode = "fallback" } })
    c.binding = carrierMock()
    s:Accept()
    equal(c:StripActive(), false, "a carrier that can carry everything hides the strip")
    c.binding.hasKey = false
    equal(c:StripActive(), true, "every reserved key occupied")
    c.binding.hasKey = nil; c.binding.inputBlocked = true
    equal(c:StripActive(), true, "an input frame refused or unanswered")
    c.binding.inputBlocked = nil; c.binding.contextBlocked = true
    equal(c:StripActive(), true, "a context frame refused or unanswered")
    c.binding.contextBlocked = nil; c.binding.quarantined = true
    equal(c:StripActive(), true, "a quarantined carrier")
end)

test("BindingTick marks the carrier on an unanswered or refused input claim and keeps the input", function()
    local clock = { now = 10 }
    local c, s = fixture({ settings = { stripMode = "fallback" } }, { GetTime = function() return clock.now end })
    c.binding = carrierMock({ Now = function() return clock.now end,
        Pump = function(self)
            if self.active and not self.outstanding then self.outstanding = { seq = 1, sentAt = clock.now }; return true end
            return false
        end })
    s:Accept()
    assert(c:Send("codex", "hello"))
    c:BindingTick()
    local identity = c.binding.active.identity
    equal(c.binding.inputBlocked, nil, "a fresh claim is not marked")
    equal(c.timers.pixel, nil, "the strip stays hidden while the carrier carries the prompt")
    clock.now = 15
    c:BindingTick()
    equal(c.binding.inputBlocked, true, "an input acknowledgement older than the timeout marks the carrier")
    equal(c.binding.active.identity, identity, "the input stays with the carrier")
    equal(#c.global.outbox, 1)
    equal(c:StripActive(), true)
    assert(c.timers.pixel ~= nil, "the strip is scheduled to carry the prompt as well")
    -- A refused claim: the carrier keeps the input and is marked.
    c.binding.inputBlocked, c.binding.outstanding = nil, nil
    c.binding.Pump = function() return false, "SetBinding rejected the carrier frame" end
    c:BindingTick()
    equal(c.binding.inputBlocked, true, "a refused input claim marks the carrier")
    equal(c.binding.active.identity, identity)
end)

test("stripMode off refuses prompts and says so while the binding carrier cannot deliver them", function()
    local c, s = fixture({ settings = { stripMode = "off" } })
    c.binding = carrierMock({ enabled = false })
    equal(c:Snapshot().status, STRIP_OFF, "a cold start in off says why nothing will send")
    local ok, reason = c:Send("codex", "hello")
    equal(ok, false); equal(reason, STRIP_OFF, "a cold start in off names the remedy; waiting for the host would not help")
    ok, reason = c:Send("codex", "line one\nline two")
    equal(ok, false); equal(reason, STRIP_OFF, "a multi-line draft gets the same sentence")
    s:Accept()
    local nextId = c.global.nextId
    ok, reason = c:Send("codex", "hello")
    equal(ok, false); equal(reason, STRIP_OFF)
    equal(#c.global.outbox, 0); equal(c.global.nextId, nextId)
    equal(c:Snapshot().status, STRIP_OFF)
    c.binding.enabled = true
    assert(c:Send("codex", "hello"), "a ready carrier takes the prompt")
    equal(#c.global.outbox, 1)
    assert(c:Snapshot().status ~= STRIP_OFF)
    -- A prompt already queued when the carrier stops is reported too.
    c.binding.quarantined = true
    equal(c:Snapshot().status, STRIP_OFF)
end)

test("fallback restarts the strip tick when the binding carrier stops carrying", function()
    local c, s = fixture({ settings = { stripMode = "fallback" } })
    c.binding = carrierMock({ OnBindingsChanged = function(self) self.quarantined = true; return false end })
    s:Accept()
    equal(c.timers.pixel, nil, "the strip is hidden behind a carrier that carries everything")
    c:OnEvent("UPDATE_BINDINGS")
    equal(c:StripActive(), true)
    assert(c.timers.pixel ~= nil, "a quarantine through UPDATE_BINDINGS restarts the strip")
    -- A host change seen in BindingTick.
    c.binding.quarantined = false; c:SyncStrip()
    equal(c.timers.pixel, nil)
    c.binding.enabled = false
    c:BindingTick()
    assert(c.timers.pixel ~= nil, "a carrier disabled by a host change restarts the strip in BindingTick")
    -- And one seen in LoadTick, through an accepted host result.
    c.binding.enabled = true; c:SyncStrip()
    equal(c.timers.pixel, nil)
    c.binding.AcceptHost = function(self) self.enabled = false; return false end
    s:Accept()
    assert(c.timers.pixel ~= nil, "a host change in an accepted result restarts the strip")
end)

test("in mode always the strip helper schedules and cancels nothing", function()
    local c, s = fixture()
    c.binding = carrierMock({ OnBindingsChanged = function(self) self.quarantined = true; return false end })
    s:Accept()
    local pixel, created, cancelled = c.timers.pixel, #s.timers, 0
    s.onCancel = function() cancelled = cancelled + 1 end
    c:SyncStrip()
    c:OnEvent("UPDATE_BINDINGS")
    c.binding.quarantined, c.binding.enabled = false, false
    c:SyncStrip()
    equal(c.timers.pixel, pixel); equal(#s.timers, created); equal(cancelled, 0)
    equal(c.stripHidden, nil)
end)

test("a combat minimize never reaches the saved layout through logout, reload or stop", function()
    local c, s = fixture({ settings = { combatWindow = "minimize" } })
    s:Accept()
    s.combat = true; c:OnEvent("PLAYER_REGEN_DISABLED")
    equal(c.global.view.minimized, true); equal(s.minimized, true)
    c:OnEvent("PLAYER_LOGOUT")
    equal(c.global.view.minimized, false, "logout and /reload save the layout the player chose")
    local c2, s2 = fixture({ settings = { combatWindow = "minimize" } })
    s2:Accept()
    s2.combat = true; c2:OnEvent("PLAYER_REGEN_DISABLED")
    equal(c2.global.view.minimized, true)
    c2:Stop()
    equal(c2.global.view.minimized, false, "stop restores it too")
    -- A window the player minimized before combat stays minimized.
    local c3, s3 = fixture({ settings = { combatWindow = "minimize" } })
    s3:Accept()
    assert(c3:SaveView({ point = "CENTER", relativePoint = "CENTER", x = 0, y = 0, width = 900, height = 650, minimized = true }))
    s3.combat = true; c3:OnEvent("PLAYER_REGEN_DISABLED")
    c3:OnEvent("PLAYER_LOGOUT")
    equal(c3.global.view.minimized, true, "a hand minimize survives logout")
    c3:Stop()
    equal(c3.global.view.minimized, true, "a hand minimize survives stop")
end)

test("windowScale checks the range before rounding, through SetSetting and /witch scale", function()
    local c, s = fixture()
    for _, value in ipairs({ 79.5, 140.49, 79, 141 }) do
        local ok, reason = c:SetSetting("windowScale", value)
        equal(ok, false, "refused " .. value); equal(reason, "Window scale must be 80 to 140 percent")
        equal(c:Setting("windowScale"), 100)
    end
    for _, case in ipairs({ { 80, 80 }, { 100.4, 100 }, { 140, 140 } }) do
        assert(c:SetSetting("windowScale", case[1])); equal(c:Setting("windowScale"), case[2])
    end
    assert(c:SetSetting("windowScale", 100))
    for _, value in ipairs({ "79.5", "140.49", "79", "141" }) do
        c:HandleSlash("scale " .. value)
        equal(c:Setting("windowScale"), 100, "/witch scale " .. value)
        equal(s.printed[#s.printed], "Window scale must be 80 to 140 percent")
    end
    for _, case in ipairs({ { "80", 80 }, { "100.4", 100 }, { "140", 140 } }) do
        c:HandleSlash("scale " .. case[1]); equal(c:Setting("windowScale"), case[2], "/witch scale " .. case[1])
    end
end)

test("alertChannel chat, alertSoundStyle, SetHz, scale and resetpos route through the controller", function()
    local c, s = fixture({ settings = { alertChannel = "chat", alertSoundStyle = "ping" } })
    local alerts = {}
    c.view.Alert = function(_, id, kind, want) alerts[#alerts + 1] = { id = id, kind = kind, want = want } end
    local sessions = screens({ "one" }, { "two" })
    sessions[2].state = "working"; s:Accept({ sessions = sessions })
    sessions[2].state = "idle"; s:Accept({ sessions = sessions })
    equal(s.printed[#s.printed], "Codex finished", "chat channel prints alert text to chat")
    equal(#alerts, 1); equal(alerts[1].want.text, false, "chat channel suppresses center-screen raid text")
    equal(alerts[1].want.sound, true); equal(alerts[1].want.soundStyle, "ping")

    c:HandleSlash("hz 0.5")
    equal(c.global.hz, 0.5); equal(c.ring.baseDelay, 2)
    c:HandleSlash("scale 120")
    equal(c:Setting("windowScale"), 120)
    c:HandleSlash("scale 300")
    equal(c:Setting("windowScale"), 120)
    assert(s.printed[#s.printed]:find("80 to 140", 1, true))

    assert(c:SetSetting("docked", true))
    assert(c:SetSetting("locked", true))
    c:SaveView({ point = "TOPLEFT", relativePoint = "TOPLEFT", x = 300, y = -200, width = 500, height = 400, minimized = true })
    c:Hide()
    c:HandleSlash("resetpos")
    equal(c.visible, true)
    equal(c:Setting("docked"), false); equal(c:Setting("locked"), false); equal(c:Setting("windowScale"), 100)
    equal(c.global.view.point, "CENTER"); equal(c.global.view.width, 900); equal(c.global.view.height, 650)
    equal(c.global.view.minimized, false); equal(s.resetLayouts, 1)
    assert(c:SetMinimapAngle(-45)); equal(c.global.minimapAngle, 315)
end)

test("UPDATE_BINDINGS inside a carrier write leaves the strip, its timer and the heartbeat alone", function()
    local c, s = fixture({ settings = { stripMode = "fallback" } })
    local changed = 0
    c.binding = carrierMock({ hasKey = false, OnBindingsChanged = function() changed = changed + 1; return true end })
    s:Accept()
    local pixel = c.timers.pixel
    assert(pixel ~= nil, "the strip draws while every reserved key is occupied")
    -- The write in progress frees a key: outside a write this event would hide the strip and offer a heartbeat.
    c.binding.hasKey, c.binding.mutating = nil, true
    local beats, created, cancelled = c.binding.beats, #s.timers, 0
    s.onCancel = function() cancelled = cancelled + 1 end
    c:OnEvent("UPDATE_BINDINGS")
    equal(c.binding.beats, beats, "no heartbeat inside the write")
    equal(c.timers.pixel, pixel); equal(#s.timers, created); equal(cancelled, 0)
    equal(changed, 0, "the carrier's own write is not checked from inside it")
    c.binding.mutating = nil
    c:OnEvent("UPDATE_BINDINGS")
    equal(changed, 1); equal(c.timers.pixel, nil); equal(c.binding.beats, beats + 1)
end)

test("an input mark expires after its window, doubles on the next failure, resets on an acknowledgement and is capped", function()
    local clock = { now = 100 }
    local c, s = fixture({ settings = { stripMode = "fallback" } }, { GetTime = function() return clock.now end })
    c.binding = carrierMock({ Now = function() return clock.now end,
        Pump = function() return false, "SetBinding rejected the carrier frame" end })
    s:Accept()
    equal(c:StripActive(), false)
    assert(c:Send("codex", "hello"))
    c:BindingTick()
    equal(c.binding.inputBlocked, true, "a refused input claim marks the carrier")
    equal(c.bindingRetryAt, 130, "for 30 seconds")
    clock.now = 110; c:BindingTick()
    equal(c.bindingRetryAt, 130, "a claim refused again inside the window does not extend it")
    -- The strip delivers the message first; the input is cancelled and nothing else would clear the mark.
    s:Accept({ ack = c.global.outbox[1].id })
    equal(#c.global.outbox, 0)
    clock.now = 129; c:BindingTick()
    equal(c.binding.active, nil, "the delivered input is cancelled")
    equal(c.binding.inputBlocked, true); equal(c.bindingRetryAt, 130); equal(c:StripActive(), true)
    clock.now = 130; c:BindingTick()
    equal(c.binding.inputBlocked, nil, "the mark expires")
    equal(c:StripActive(), false, "fallback hides the strip again")
    assert(c:SetSetting("stripMode", "off"))
    assert(c:Send("codex", "again"), "off takes prompts again")
    clock.now = 200; c:BindingTick()
    equal(c.binding.inputBlocked, true); equal(c.bindingRetryAt, 260, "a second failure blocks for 60 seconds")
    c.binding.AcceptHost = function(self) self.inputBlocked = nil; return true, "frame" end
    s:Accept({ ack = c.global.ack })
    equal(c.bindingRetryDelay, 30, "an accepted acknowledgement resets the window")
    for _ = 1, 8 do c.binding.inputBlocked = nil; c:BlockBinding() end
    equal(c.bindingRetryDelay, 480); equal(c.bindingRetryAt - clock.now, 480, "the window never exceeds 480 seconds")
end)

test("a refused input claim is not tried again before its retry time, and the input stays buffered", function()
    local clock, pumps = { now = 100 }, 0
    local c, s = fixture({ settings = { stripMode = "fallback" } }, { GetTime = function() return clock.now end })
    c.binding = carrierMock({ Now = function() return clock.now end,
        Pump = function() pumps = pumps + 1; return false, "SetBinding rejected the carrier frame" end })
    s:Accept()
    assert(c:Send("codex", "hello"))
    c:BindingTick()
    equal(pumps, 1); equal(c.bindingRetryAt, 130)
    for now = 101, 129 do clock.now = now; c:BindingTick() end
    equal(pumps, 1, "no claim attempt inside the retry window")
    assert(c.binding.active and c.binding.active.kind == "input", "the input stays buffered")
    equal(c:StripActive(), true, "the strip carries it meanwhile")
    clock.now = 130; c:BindingTick()
    equal(pumps, 2, "one attempt once the window has passed"); equal(c.bindingRetryAt, 190)
end)

test("a carrier quarantined between ticks brings the fallback strip back on the next binding tick", function()
    local c, s = fixture({ settings = { stripMode = "fallback" } })
    c.binding = carrierMock({ Heartbeat = function() return false, "heartbeat unchanged" end })
    s:Accept()
    equal(c:StripActive(), false); equal(c.timers.pixel, nil)
    c.binding.enabled, c.binding.quarantined = false, "carrier cleanup failed"
    c:BindingTick()
    equal(c:StripActive(), true)
    assert(c.timers.pixel ~= nil, "the pixel tick is scheduled by the binding tick")
end)

test("a heartbeat write that fails marks the carrier and brings the fallback strip straight back", function()
    local c, s = fixture({ settings = { stripMode = "fallback" } })
    c.binding = carrierMock({ Heartbeat = function() return false, "x", true end })
    s:Accept()
    equal(c.binding.inputBlocked, true)
    equal(c:StripActive(), true)
    assert(c.timers.pixel ~= nil, "the strip is scheduled again at once")
    local c2, s2 = fixture({ settings = { stripMode = "fallback" } })
    c2.binding = carrierMock({ Heartbeat = function() return false, "heartbeat unchanged" end })
    s2:Accept()
    equal(c2.binding.inputBlocked, nil); equal(c2:StripActive(), false, "a benign refusal keeps the strip hidden")
    equal(c2.timers.pixel, nil)
end)

test("in mode always a placeholder, a stalled load and combat exit leave the pixel timer as it was", function()
    for _, hidden in ipairs({ false, true }) do
        for _, case in ipairs({ "placeholder", "stall", "regen" }) do
            local c, s = fixture()
            c.binding = carrierMock()
            s:Accept()
            if hidden then
                c:Hide()
                -- A probe in flight keeps the controller streaming with the window hidden.
                c.binding.active = { kind = "probe", identity = "probe:abcdef01" }
            end
            local pixel = c.timers.pixel
            equal(pixel ~= nil, not hidden)
            if case == "placeholder" then s:Accept({ ready = false, changed = nil })
            elseif case == "stall" then c:LoadTick(); equal(c.stalled, true)
            else c:OnEvent("PLAYER_REGEN_ENABLED") end
            equal(c.timers.pixel, pixel, case .. (hidden and " with the window hidden" or ""))
        end
    end
end)

test("a real binding carrier on the production adapter's GetTime writes a heartbeat after its probe", function()
    local clock, actions = { now = 100 }, {}
    local c, s = fixture({ settings = { stripMode = "fallback" } }, {
        GetTime = function() return clock.now end,
        GetBindingAction = function(key) return actions[key] or "" end,
        SetBinding = function(key, action) actions[key] = action; return true end,
        SaveBindings = function() return true end,
        GetCurrentBindingSet = function() return 1 end })
    equal(c.binding.api.Now, nil, "the carrier gets the adapter, which has GetTime and no Now")
    s:Accept()
    c:HandleSlash("bindprobe")
    c.timers.binding.handle:Fire()
    assert(c.binding.outstanding and c.binding.outstanding.probe, "the probe frame is written")
    s:Accept({ bindingProtocol = 1, bindingNonce = "89abcdef", bindingAck = 1 })
    equal(c.binding.enabled, true, "the probe is acknowledged")
    equal(c:StripActive(), false)
    clock.now = 102
    local written, reason = c:OfferBindingHeartbeat()
    equal(written, true, tostring(reason))
    equal(ns.Binding.ParseAction(actions[ns.Binding.Keys[1]]).seq, 0, "the key holds a heartbeat frame")
end)

test("a context write that quarantines the carrier ends the tick cleanly and the fallback strip takes over", function()
    local clock, actions = { now = 100 }, {}
    local c, s = fixture({ settings = { stripMode = "fallback" } }, {
        GetTime = function() return clock.now end,
        GetBindingAction = function(key) return actions[key] or "" end,
        SetBinding = function(key, action) actions[key] = action; return true end,
        SaveBindings = function() return true end,
        GetCurrentBindingSet = function() return 1 end,
        Context = { Capture = function() return { { true } } end } })
    s:Accept()
    c:HandleSlash("bindprobe")
    c.timers.binding.handle:Fire()
    s:Accept({ bindingProtocol = 1, bindingNonce = "89abcdef", bindingAck = 1,
        contextProtocol = 4, contextAck = 0, contextWant = 1, contextWantMask = 1 })
    clock.now = 102
    equal(c:OfferBindingHeartbeat(), true)
    local key = ns.Binding.Keys[1]
    -- The user rebinds the key that holds the heartbeat, then context is due before the next host chunk.
    actions[key] = "JUMP"
    clock.now = 104
    c:ContextTick()
    assert(c.contextPending, "a context message is waiting for a carrier")
    c:BindingTick()
    assert(c.binding.quarantined, "the changed key quarantines the carrier")
    equal(c.binding.active, nil)
    equal(actions[key], "JUMP", "the user's binding is left alone")
    equal(c:StripActive(), true, "fallback draws the strip once the carrier is quarantined")
    assert(c.timers.pixel, "the pixel tick is running again")
end)

test("fallback restarts the pixel tick when demand returns while the strip shows; always leaves it alone", function()
    for _, mode in ipairs({ "fallback", "always" }) do
        -- The fixture has no context source, which stands in for context disabled and acknowledged.
        local c, s = fixture({ settings = { stripMode = mode } })
        c.binding = carrierMock({ Probe = function(self)
            self.enabled, self.active = false, { kind = "probe", identity = "probe:abcdef01" }
            return true
        end })
        s:Accept()
        c:Hide()
        if c.timers.pixel then c.timers.pixel.handle:Fire() end
        equal(c.timers.pixel, nil, mode .. ": the tick stops while nothing is wanted")
        c.binding.hasKey = false
        c:BindingTick()
        equal(c:WantStream(), false); equal(c:StripActive(), true)
        equal(c.stripHidden, nil, mode); equal(c.timers.pixel, nil, mode)
        c:HandleSlash("bindprobe")
        equal(c:WantStream(), true); equal(c:StripActive(), true)
        c.timers.binding.handle:Fire()
        if mode == "fallback" then
            assert(c.timers.pixel ~= nil, "BindingTick restarts the strip once the probe wants it")
            c:CancelTimer("pixel")
            c.timers.load.handle:Fire()
            assert(c.timers.pixel ~= nil, "LoadTick restarts it too")
        else
            equal(c.timers.pixel, nil, "always: BindingTick schedules nothing")
            c.timers.load.handle:Fire()
            equal(c.timers.pixel, nil, "always: LoadTick schedules nothing")
        end
    end
end)

test("an input the strip delivered while its claim was outstanding keeps the claim until its acknowledgement", function()
    local clock, actions = { now = 100 }, {}
    local c, s = fixture({ settings = { stripMode = "fallback" } }, {
        GetTime = function() return clock.now end,
        GetBindingAction = function(key) return actions[key] or "" end,
        SetBinding = function(key, action) actions[key] = action; return true end,
        SaveBindings = function() return true end,
        GetCurrentBindingSet = function() return 1 end })
    s:Accept()
    c:HandleSlash("bindprobe")
    c.timers.binding.handle:Fire()
    s:Accept({ bindingProtocol = 1, bindingNonce = "89abcdef", bindingAck = 1 })
    equal(c.binding.enabled, true); equal(c:StripActive(), false)
    assert(c:Send("codex", "first"))
    clock.now = 101; c:BindingTick()
    local claimed = c.binding.outstanding
    assert(claimed and not claimed.probe, "input A is claimed"); equal(claimed.seq, 2)
    -- No binding acknowledgement: the carrier is marked and the strip carries A.
    clock.now = 106; c:BindingTick()
    equal(c.binding.inputBlocked, true); equal(c.bindingRetryAt, 136); equal(c:StripActive(), true)
    assert(c:Send("codex", "second"))
    clock.now = 135
    s:Accept({ ack = c.global.outbox[1].id })
    c:BindingTick()
    equal(c.binding.outstanding, claimed, "the delivered input's claim stays outstanding")
    equal(actions[claimed.key], claimed.action, "its key still holds A")
    -- The mark expires; the late acknowledgement marks the carrier again, so the strip stays.
    for now = 136, 140 do
        clock.now = now; c:BindingTick()
        equal(c.binding.outstanding, claimed, "no other claim at " .. now)
        equal(c:StripActive(), true, "the strip draws at " .. now)
    end
    clock.now = 141
    s:Accept({ ack = c.global.ack, bindingProtocol = 1, bindingNonce = "89abcdef", bindingAck = 2 })
    equal(c.binding.outstanding, nil, "the acknowledgement releases A"); equal(actions[claimed.key], nil)
    clock.now = 142; c:BindingTick()
    assert(c.binding.outstanding, "the next prompt is claimed"); equal(c.binding.outstanding.seq, 3, "after A's sequence")
end)

test("a host change in combat that could not clear the old frame is finished by the binding tick after combat", function()
    local clock, actions = { now = 100 }, {}
    local c, s = fixture({ settings = { stripMode = "fallback", combatUpdates = true } }, {
        GetTime = function() return clock.now end,
        GetBindingAction = function(key) return actions[key] or "" end,
        SetBinding = function(key, action) actions[key] = action; return true end,
        SaveBindings = function() return true end,
        GetCurrentBindingSet = function() return 1 end })
    s:Accept()
    c:HandleSlash("bindprobe")
    c.timers.binding.handle:Fire()
    s:Accept({ bindingProtocol = 1, bindingNonce = "89abcdef", bindingAck = 1 })
    assert(c:Send("codex", "first"))
    clock.now = 101; c:BindingTick()
    local claimed = c.binding.outstanding
    assert(claimed and not claimed.probe, "the input is claimed")
    s.combat = true
    clock.now = 102
    s:Accept({ epoch = "2222aaaa", bindingProtocol = 1, bindingNonce = "99999999", bindingAck = 0 })
    equal(c.binding.enabled, false, "the old host's carrier ends at once")
    equal(c.binding.outstanding, claimed, "its frame waits for combat to end")
    s.combat = false
    clock.now = 103; c:BindingTick()
    equal(c.binding.outstanding, nil, "the binding tick clears the frame without another host result")
    equal(actions[claimed.key], nil); equal(c.binding:Busy(), false)
end)

test("a context row not across the carrier by half its deadline is handed to the strip, except in mode off", function()
    for _, mode in ipairs({ "fallback", "off" }) do
        local clock = { now = 10 }
        local c, s = fixture({ settings = { stripMode = mode } },
            { GetTime = function() return clock.now end, Context = { Capture = function() return { { true } } end } })
        local cancels = 0
        c.binding = carrierMock({ Now = function() return clock.now end,
            Pump = function(self)
                if self.active and not self.outstanding then self.outstanding = { seq = 2, sentAt = clock.now }; return true end
                return false
            end,
            OfferContext = function(self, msg) self.active = { kind = "context", identity = "context:" .. msg.id }; return true end,
            Cancel = function(self) cancels = cancels + 1; self.active, self.outstanding = nil, nil; return true end })
        s:Accept({ contextProtocol = 4, contextAck = 0, contextWant = 1, contextWantMask = 1 })
        c:ContextTick()
        assert(c.contextPending, mode .. ": a context row is pending")
        -- Each frame is acknowledged inside the 5 s timeout, but the row is still not across.
        for now = 11, 24 do clock.now = now; c.binding.outstanding = nil; c:BindingTick() end
        equal(c.binding.contextBlocked, nil, mode .. ": the carrier keeps the row before the budget")
        assert(c.binding.active, mode .. ": the row is still in the carrier")
        clock.now = 25; c.binding.outstanding = nil; c:BindingTick()
        if mode == "off" then
            equal(c.binding.contextBlocked, nil, "off has no strip to hand the row to"); equal(cancels, 0)
        else
            equal(c.binding.contextBlocked, true, "the row is handed to the strip"); equal(cancels, 1)
            equal(c:StripActive(), true); assert(s.top ~= nil, "the strip transmits the row at once")
        end
    end
end)

test("in mode off a context row the binding carrier is still sending is not retried at its 30 s deadline", function()
    local clock = { now = 10 }
    local c, s = fixture({ settings = { stripMode = "off" } },
        { GetTime = function() return clock.now end, Context = { Capture = function() return { { true } } end } })
    c.binding = carrierMock({ Now = function() return clock.now end,
        Pump = function(self)
            if self.active and not self.outstanding then self.outstanding = { seq = 2, sentAt = clock.now }; return true end
            return false
        end,
        OfferContext = function(self, msg) self.active = { kind = "context", identity = "context:" .. msg.id }; return true end })
    s:Accept({ contextProtocol = 4, contextAck = 0, contextWant = 1, contextWantMask = 1 })
    c:ContextTick()
    local pending = assert(c.contextPending, "a context row is pending")
    -- Every frame is acknowledged in time; the row simply needs more than 30 s of frames.
    for now = 11, 45 do clock.now = now; c.binding.outstanding = nil; c:BindingTick(); c:ContextTick() end
    equal(c.contextPending, pending, "the row the carrier is sending is not replaced")
    c.binding.active, c.binding.outstanding = nil, nil
    clock.now = 60; c:ContextTick()
    equal(c.contextPending, pending, "the host's acknowledgement has 30 s from the last frame")
    clock.now = 76; c:ContextTick()
    assert(c.contextPending ~= pending, "a row the carrier no longer holds is retried at its deadline")
end)

test("a context mark with no frame outstanding expires after 30 s and the carrier is tried again", function()
    local clock, offers = { now = 10 }, 0
    local c, s = fixture({ settings = { stripMode = "off" } },
        { GetTime = function() return clock.now end, Context = { Capture = function() return { { true } } end } })
    c.binding = carrierMock({ Now = function() return clock.now end,
        -- Every claim is refused until second 41.
        Pump = function(self)
            if clock.now < 41 or not self.active or self.outstanding then return false end
            self.outstanding = { seq = 2, sentAt = clock.now }
            return true
        end,
        OfferContext = function(self, msg)
            offers = offers + 1
            self.active = { kind = "context", identity = "context:" .. msg.id }
            return true
        end })
    s:Accept({ contextProtocol = 4, contextAck = 0, contextWant = 1, contextWantMask = 1 })
    c:ContextTick()
    assert(c.contextPending, "a context row is pending")
    clock.now = 11; c:BindingTick()
    equal(c.binding.contextBlocked, true, "the refused claim marks the carrier"); equal(offers, 1)
    equal(c:BindingCarries(), false)
    clock.now = 40; c:BindingTick()
    equal(c.binding.contextBlocked, true, "the mark holds for 30 s"); equal(offers, 1)
    clock.now = 41; c:BindingTick()
    equal(offers, 2, "the row is offered to the carrier again")
    equal(c.binding.contextBlocked, nil); equal(c:BindingCarries(), true)
end)

test("an expired input mark clears only on a tick that can try the carrier again", function()
    local clock = { now = 100 }
    local c, s = fixture({ settings = { stripMode = "fallback" } }, { GetTime = function() return clock.now end })
    c.binding = carrierMock({ Now = function() return clock.now end })
    s:Accept()
    -- The window has passed, but the carrier wrote half a second ago and cannot be tried on this tick.
    c.binding.inputBlocked, c.bindingRetryAt, c.binding.lastWriteAt = true, 100, 99.5
    c:BindingTick()
    equal(c.binding.inputBlocked, true, "the mark stays, so fallback keeps the strip")
    equal(c:StripActive(), true)
    clock.now = 101; c:BindingTick()
    equal(c.binding.inputBlocked, nil, "a tick that can try the carrier clears it")
end)

test("a context row handed to the strip stays with the strip when a late acknowledgement clears the mark", function()
    local clock, offers = { now = 10 }, 0
    local c, s = fixture({ settings = { stripMode = "fallback" } },
        { GetTime = function() return clock.now end, Context = { Capture = function() return { { true } } end } })
    c.binding = carrierMock({ Now = function() return clock.now end,
        Pump = function(self)
            if self.active and not self.outstanding then self.outstanding = { seq = 2, sentAt = clock.now }; return true end
            return false
        end,
        OfferContext = function(self, msg)
            offers = offers + 1
            self.active = { kind = "context", identity = "context:" .. msg.id }
            return true
        end,
        -- As the real carrier: a claimed frame is only marked abandoned.
        Cancel = function(self)
            if self.outstanding then self.active.abandoned = true; return false end
            self.active = nil
            return true
        end })
    s:Accept({ contextProtocol = 4, contextAck = 0, contextWant = 1, contextWantMask = 1 })
    c:ContextTick()
    local pending = assert(c.contextPending, "a context row is pending")
    for now = 11, 24 do clock.now = now; c.binding.outstanding = nil; c:BindingTick() end
    clock.now = 25; c:BindingTick()
    equal(c.binding.contextBlocked, true, "the slow row is handed to the strip with a frame still outstanding")
    assert(c.binding.outstanding and c.binding.active.abandoned)
    -- The acknowledgement for that frame arrives a second later and clears the mark, as AcceptHost does.
    c.binding.outstanding, c.binding.active, c.binding.contextBlocked = nil, nil, nil
    clock.now = 26; c:BindingTick()
    equal(offers, 1, "the row is not handed back to the carrier")
    equal(c.contextPending, pending)
    equal(c:BindingContextActive(), false, "the strip does not stand aside for it")
    equal(c:StripActive(), true, "fallback keeps the strip drawn while it carries the row")
end)

test("a context frame whose acknowledgement times out is cancelled and handed to the strip once", function()
  for _, combat in ipairs({ false, true }) do
    local clock, actions = { now = 100 }, {}
    local c, s = fixture({ settings = { stripMode = "fallback" } }, {
        GetTime = function() return clock.now end,
        GetBindingAction = function(key) return actions[key] or "" end,
        SetBinding = function(key, action) actions[key] = action; return true end,
        SaveBindings = function() return true end,
        GetCurrentBindingSet = function() return 1 end,
        Context = { Capture = function() return { { true } } end } })
    s:Accept()
    c:HandleSlash("bindprobe")
    c.timers.binding.handle:Fire()
    s:Accept({ bindingProtocol = 1, bindingNonce = "89abcdef", bindingAck = 1,
        contextProtocol = 4, contextAck = 0, contextWant = 1, contextWantMask = 1 })
    clock.now = 102
    c:ContextTick()
    assert(c.contextPending, "a context message is waiting for a carrier")
    c:BindingTick()
    local claimed = c.binding.outstanding
    assert(claimed and c.binding.active and c.binding.active.kind == "context", "the context frame is claimed")
    local cancels, pixels = 0, 0
    local cancel, pixel = c.binding.Cancel, c.PixelTick
    c.binding.Cancel = function(...) cancels = cancels + 1; return cancel(...) end
    c.PixelTick = function(...) pixels = pixels + 1; return pixel(...) end
    s.combat = combat
    for now = 107, 111 do clock.now = now; c:BindingTick() end
    local where = combat and " in combat" or ""
    equal(c.binding.contextBlocked, true)
    equal(c.binding.outstanding, claimed, "the timed-out frame stays claimed until its acknowledgement" .. where)
    equal(cancels, 1, "Cancel runs once" .. where); equal(pixels, 1, "PixelTick runs once" .. where)
  end
end)

test("resetpos on a stopped controller resets the View it kept, so Start does not bring the old size back", function()
    local c, s = fixture()
    c:SaveView({ point = "TOPLEFT", relativePoint = "TOPLEFT", x = 300, y = -200, width = 500, height = 400, minimized = false })
    c:Stop()
    assert(c.view, "the stopped controller keeps its View")
    c:HandleSlash("resetpos")
    equal(s.resetLayouts, 1, "the kept View is reset")
    equal(c.global.view.width, 900); equal(c.global.view.height, 650)
    equal(c.active, false, "resetpos does not start the controller")
end)

test("a heartbeat write that fails again after its mark expired renews the mark before BindingTick clears it", function()
    local clock = { now = 100 }
    local c, s = fixture({ settings = { stripMode = "fallback" } }, { GetTime = function() return clock.now end })
    local calls = 0
    c.binding = carrierMock({ Heartbeat = function() calls = calls + 1; return false, "x", true end })
    s:Accept({ cursorLane = "file" })
    if not c.binding.inputBlocked then c:OfferBindingHeartbeat() end
    equal(c.binding.inputBlocked, true); equal(c.bindingRetryAt, 130)
    clock.now = 131
    local before = calls
    s:Accept({ cursorLane = "file" })
    equal(calls, before + 1, "LoadTick retries the heartbeat once its window has passed")
    equal(c.binding.inputBlocked, true); equal(c.bindingRetryAt, 191, "the mark is renewed for the doubled 60 seconds")
    c:BindingTick()
    equal(c.binding.inputBlocked, true, "BindingTick keeps the renewed mark")
    equal(c:StripActive(), true, "fallback still draws the strip")
end)

test("a failed binding heartbeat write waits out its retry window before the next attempt", function()
    for _, case in ipairs({ { mode = "off" }, { mode = "fallback", lane = "file" } }) do
        local clock = { now = 100 }
        local c, s = fixture({ settings = { stripMode = case.mode } }, { GetTime = function() return clock.now end })
        local calls = 0
        c.binding = carrierMock({ Heartbeat = function() calls = calls + 1; return false, "x", true end })
        s:Accept({ cursorLane = case.lane })
        if not c.binding.inputBlocked then c:OfferBindingHeartbeat() end
        equal(c.binding.inputBlocked, true, case.mode); equal(c.bindingRetryAt, 130, case.mode)
        local before = calls
        for now = 101, 129 do
            clock.now = now
            equal(c:OfferBindingHeartbeat(), false, case.mode .. " at " .. now)
        end
        equal(calls, before, case.mode .. ": no write inside the retry window")
        clock.now = 130; c:BindingTick(); c:OfferBindingHeartbeat()
        equal(calls, before + 1, case.mode .. ": one attempt after the window")
    end
end)

test("an input mark alone does not stop the heartbeat a stalled strip needs", function()
    local clock = { now = 100 }
    local c, s = fixture(nil, { GetTime = function() return clock.now end })
    local calls = 0
    c.binding = carrierMock({ Heartbeat = function() calls = calls + 1; return true end })
    s:Accept({})
    c.binding.inputBlocked, c.bindingRetryAt, c.stalled = true, 130, true
    local before = calls
    clock.now = 101
    equal(c:OfferBindingHeartbeat(), true, "the heartbeat is offered while only an input mark stands")
    equal(calls, before + 1, "one heartbeat write")
end)

test("Stop undoes a combat minimize in the View too, so a later drag cannot save it", function()
    local c, s = fixture({ settings = { combatWindow = "minimize" } })
    s:Accept()
    s.combat = true; c:OnEvent("PLAYER_REGEN_DISABLED")
    equal(s.minimized, true); equal(c.global.view.minimized, true)
    c:Stop()
    equal(s.minimized, false, "the View is restored"); equal(c.global.view.minimized, false)
    s.combat = false; c:Start()
    -- A drag saves the layout the View shows.
    assert(c:SaveView({ point = "CENTER", relativePoint = "CENTER", x = 10, y = 0, width = 900, height = 650,
        minimized = s.minimized }))
    equal(c.global.view.minimized, false)
end)

-- The log carrier on a mocked C_Log.LogMessage that records every line.
local function logLane(settings)
    local lines = {}
    local c, s = fixture({ settings = settings }, { LogAPI = { LogMessage = function(text) lines[#lines + 1] = text end } })
    return c, s, lines
end

local function printedLine(s, text)
    for _, line in ipairs(s.printed) do if line == text then return true end end
    return false
end

test("fileLane log constructs the log carrier; binding or an unset lane keeps the binding carrier", function()
    local c = logLane({ fileLane = "log" })
    equal(c.binding.combatSafe, true); equal(c.binding.HasKey, nil); equal(c.binding.status, "Probe not run")
    c = fixture({ settings = { fileLane = "binding" } })
    equal(c.binding.combatSafe, nil); assert(c.binding.HasKey ~= nil, "the binding carrier")
    c = fixture()
    equal(c.binding.combatSafe, nil); equal(c:Setting("fileLane"), "binding")
end)

test("the log lane probes itself without autoBindProbe, in combat, and once ready carries in combat", function()
    local c, s, lines = logLane({ fileLane = "log", stripMode = "fallback", combatUpdates = true })
    equal(c:Setting("autoBindProbe"), false)
    s.combat = true; c:OnEvent("PLAYER_REGEN_DISABLED")
    s:Accept()
    assert(c.binding.active and c.binding.active.probe, "the probe starts in combat without autoBindProbe")
    if c.timers.binding then c.timers.binding.handle:Fire() end
    assert(c.binding.outstanding and c.binding.outstanding.probe, "the probe frame is logged in combat")
    equal(#lines, 26, "one frame line and its padding")
    s:Accept({ logProtocol = 1, logNonce = "89abcdef", logAck = 1 })
    equal(c.binding.enabled, true, "the probe is acknowledged")
    assert(printedLine(s, "Witchcraft log carrier proved host decode and ACK"))
    equal(c:BindingCarries(), true, "the ready log carrier carries in combat")
    equal(c:StripActive(), false, "fallback keeps the strip hidden in combat")
end)

test("in mode off the log lane refuses a prompt before it is ready and accepts one after, in combat too", function()
    local c, s = logLane({ fileLane = "log", stripMode = "off", combatUpdates = true })
    s.combat = true; c:OnEvent("PLAYER_REGEN_DISABLED")
    local ok, reason = c:Send("codex", "hello")
    equal(ok, false); equal(reason, STRIP_OFF)
    s:Accept()
    ok, reason = c:Send("codex", "hello")
    equal(ok, false); equal(reason, STRIP_OFF, "a probe still waiting is not ready")
    if c.timers.binding then c.timers.binding.handle:Fire() end
    s:Accept({ logProtocol = 1, logNonce = "89abcdef", logAck = 1 })
    assert(c:Send("codex", "hello"), "a ready log carrier takes the prompt in combat")
    equal(#c.global.outbox, 1)
end)

test("with the strip off the log lane probes before the link, once, and the link makes it ready", function()
    -- The default fixture starts with no host epoch saved; the second run starts with one.
    for _, saved in ipairs({ false, "1234abcd" }) do
        local lines = {}
        local c, s = fixture({ epoch = saved or nil, settings = { fileLane = "log", stripMode = "off" } },
            { LogAPI = { LogMessage = function(text) lines[#lines + 1] = text end } })
        equal(c.global.epoch, saved or nil, "the saved epoch")
        assert(not c.connected, "never linked")
        assert(c.binding.active and c.binding.active.probe, "the probe is the carrier's active item")
        c.timers.binding.handle:Fire()
        equal(#lines, 26, "one frame line and its padding")
        equal(lines[1], ns.LogCarrier.FrameText({ epoch = "00000000", nonce = "00000000", uiNonce = "abcdef01",
            slot = c.ring.nextSeq, seq = 1, payload = ns.Binding.PROBE }), "the frame names the next ring slot")
        equal(c:MaybeAutoBindProbe(), false); equal(#lines, 26, "one cold probe per UI session")
        s:Accept({ logProtocol = 1, logNonce = "89abcdef", logAck = 1 })
        equal(c.connected, true); equal(c.binding.enabled, true)
        assert(c:Send("codex", "hello"), "a ready log carrier takes the prompt")
    end
end)

test("an acknowledged cold probe counts for its host epoch: a lost lane waits for /reload, a new epoch probes", function()
    local c, s, lines = logLane({ fileLane = "log", stripMode = "off" })
    local function probes()
        local count = 0
        for _, line in ipairs(lines) do
            if line:find("^WCL1_00000000_00000000_") then count = count + 1 end
        end
        return count
    end
    c.timers.binding.handle:Fire()
    equal(probes(), 1, "the cold probe is logged")
    s:Accept({ logProtocol = 1, logNonce = "89abcdef", logAck = 1 })
    equal(c.binding.enabled, true)
    local epoch = c.global.epoch
    equal(c.autoProbedEpoch, epoch, "the acknowledging host epoch")
    s:Accept({ logProtocol = 1, logNonce = "76543210", logAck = 0 })
    equal(c.global.epoch, epoch, "the same host epoch")
    equal(c.binding.enabled, false); equal(c.binding.status, "Host changed; /reload to probe again")
    for _ = 1, 3 do
        if c.timers.binding then c.timers.binding.handle:Fire() end
        s:Accept({ logProtocol = 1, logNonce = "76543210", logAck = 0 })
    end
    if c.timers.binding then c.timers.binding.handle:Fire() end
    equal(c.binding.active, nil, "no probe waits"); equal(probes(), 1, "no new probe within the same epoch")
    assert(epoch ~= "87654321")
    s:Accept({ epoch = "87654321", logProtocol = 1, logNonce = "76543210", logAck = 0 })
    assert(c.binding.active and c.binding.active.probe, "a new epoch starts a new probe")
end)

test("in modes always and fallback the log lane logs nothing before the first accepted chunk", function()
    for _, mode in ipairs({ "always", "fallback" }) do
        local c, s, lines = logLane({ fileLane = "log", stripMode = mode })
        equal(c.binding.active, nil, mode); equal(c:MaybeAutoBindProbe(), false, mode)
        if c.timers.binding then c.timers.binding.handle:Fire() end
        equal(#lines, 0, mode)
        s:Accept()
        assert(c.binding.active and c.binding.active.probe, mode .. ": the link starts the probe")
    end
end)

test("with the strip off the binding lane still waits for the link before its opt-in probe", function()
    local c = fixture({ settings = { fileLane = "binding", stripMode = "off", autoBindProbe = true } })
    equal(c.binding.active, nil); equal(c:MaybeAutoBindProbe(), false); equal(c.coldProbed, nil)
end)

test("switching to mode off while unlinked starts the log carrier's probe", function()
    local c, _, lines = logLane({ fileLane = "log", stripMode = "always" })
    equal(c.binding.active, nil)
    assert(c:SetSetting("stripMode", "off"))
    assert(c.binding.active and c.binding.active.probe, "the probe goes before the link")
    equal(c.timers.load.handle.delay, 1, "the host gets a second to answer the cold probe")
    c.timers.binding.handle:Fire()
    equal(#lines, 26)
end)

test("/witch filelane saves a lane for the next reload, rejects anything else, and status names the lane", function()
    local c, s = fixture()
    c:HandleSlash("filelane log")
    equal(c:Setting("fileLane"), "log"); equal(s.printed[#s.printed], "Witchcraft file lane: log; /reload to apply")
    equal(c.binding.combatSafe, nil, "no swap at run time")
    c:HandleSlash("filelane pigeon")
    equal(c:Setting("fileLane"), "log"); equal(s.printed[#s.printed], "Usage: /witch filelane log|binding")
    c:HandleSlash("status")
    assert(s.printed[#s.printed]:find("^Witchcraft lanes: binding "), s.printed[#s.printed])
    local d, t = logLane({ fileLane = "log" })
    d:HandleSlash("status")
    assert(t.printed[#t.printed]:find("^Witchcraft lanes: log Probe not run"), t.printed[#t.printed])
end)

test("a client without C_Log.LogMessage names the log carrier unavailable in status", function()
    local c, s = fixture({ settings = { fileLane = "log" } }, { LogAPI = {} })
    s:Accept()
    c:HandleSlash("status")
    local line = s.printed[#s.printed]
    equal(line:find("Witchcraft lanes: log Log carrier unavailable on this client |", 1, true), 1, line)
end)

test("the autoBindProbe option and /witch bindprobe off leave a ready log carrier running", function()
    local c, s = logLane({ fileLane = "log" })
    s:Accept()
    if c.timers.binding then c.timers.binding.handle:Fire() end
    s:Accept({ logProtocol = 1, logNonce = "89abcdef", logAck = 1 })
    equal(c.binding.enabled, true)
    c:SetSetting("autoBindProbe", true)
    c:SetSetting("autoBindProbe", false)
    equal(c.binding.enabled, true, "the option does not stop the log carrier")
    c:HandleSlash("bindprobe off")
    equal(c.binding.enabled, true, "bindprobe off does not stop the log carrier")
    equal(c:Setting("autoBindProbe"), false, "the setting is still saved")
end)

test("/witch bindprobe on the log lane names the log carrier probe", function()
    local c, s = logLane({ fileLane = "log" })
    c:HandleSlash("bindprobe")
    equal(s.printed[#s.printed], "Log carrier probe started; waiting for host ACK")
end)
