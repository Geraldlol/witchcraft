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
    assert(c:SendLong("claude", "short prompt")); equal(c.global.outbox[1].text, "short prompt", "one short line is an ordinary send")
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
    equal(#c.global.outbox, 1); equal(c.global.outbox[1].prompt, nil); equal(c.global.outbox[1].text, "a    b")
    assert(c:SendLong("claude", "def f():\n\tif x:\n\t\treturn 1\n"))
    equal(c.global.outbox[2].prompt, true)
    equal(ns.Prompts.Group(c.global.outbox, c.global.outbox[2]), "def f():\n    if x:\n        return 1\n",
        "tab indentation survives as four spaces per tab")
    local before = #c.global.outbox
    assert(c:SendLong("claude", "a\0b\27c\127d"))
    equal(#c.global.outbox, before + 1); equal(c.global.outbox[before + 1].text, "abcd", "NUL, ESC and DEL are removed")
    ok, reason = c:SendLong("claude", "\0\1\27\127")
    equal(ok, false); equal(reason, "Nothing to send")
    equal(#c.global.outbox, before + 1)
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
    -- Resetting contextBlocked and occupying all keys also lets the strip take over.
    c.binding.contextBlocked = nil
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
