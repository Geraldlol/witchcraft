local ns, test, equal = ...

local function suggestions()
    return {
        macro = { id = string.rep("a", 32), name = "Mark", body = "#showtooltip\n/say Ready" },
        route = { id = string.rep("b", 32), name = "Patrol",
            points = { { mapID = 1429, x = 0, y = 100, label = "First stop" } } },
    }
end

local function receive(actions)
    local ring = ns.Ring.New({ uiNonce = "abcdef01" })
    local result = ring:OnChunk(ns.TestPayload(1, { playerActions = actions }))
    assert(result.accepted)
    return result.playerActions
end

test("a terminal frame exposes only a bounded tool name and never raw tool arguments", function()
    for _, sample in ipairs({ { "exec_command", true }, { "mcp__wow__get-quests", true }, { "", false },
        { "Bash /private/file", false }, { "|Hitem:1", false }, { string.rep("a", 65), false } }) do
        local ring = ns.Ring.New({ uiNonce = "abcdef01" })
        local frame = ns.TestPayload(1)
        frame.sessions[1].activity = sample[1]
        local result = ring:OnChunk(frame)
        assert(result.accepted)
        equal(result.sessions[1].activity, sample[2] and sample[1] or nil)
    end
end)

test("optional player suggestions copy bounded literal data without blocking terminal updates", function()
    equal(receive(nil), nil)
    local input = suggestions()
    local copied = receive(input)
    input.route.points[1].label = "changed"
    equal(copied.route.points[1].label, "First stop")
    equal(copied.macro.body, "#showtooltip\n/say Ready")
    for _, change in ipairs({
        function(m) m.id = "wrong" end,
        function(m) m.name = string.rep("é", 9) end,
        function(m) m.body = string.rep("x", 256) end,
        function(m) m.body = "/say abc\r/run xyz" end,
        function(m) m.body = "\255" end,
    }) do
        input = suggestions()
        change(input.macro)
        copied = receive(input)
        equal(copied.macro, nil); equal(copied.route.name, "Patrol")
    end
    for _, change in ipairs({
        function(r) r.points[1].x = 0/0 end,
        function(r) r.points[1].y = 101 end,
        function(r) r.points[1].mapID = 0 end,
        function(r) r.points[1].label = "\n" end,
        function(r) r.points[3] = r.points[1] end,
        function(r) r.points = {} end,
    }) do
        input = suggestions()
        change(input.route)
        copied = receive(input)
        equal(copied.route, nil); equal(copied.macro.name, "Mark")
    end
end)

test("player suggestions wait for an explicit command, deduplicate notices, and expire with their session", function()
    local c, s = ns.TestControllerFixture()
    local oldMacro, oldRoute = ns.MacroProposal, ns.Route
    local preview, hidden, map, cleared = 0, 0, 0, 0
    ns.MacroProposal = { Show = function(m) equal(m.name, "Mark"); preview = preview + 1; return true end,
        Hide = function() hidden = hidden + 1 end }
    ns.Route = { Show = function(r) equal(r.name, "Patrol"); map = map + 1; return true end,
        Clear = function() cleared = cleared + 1 end }
    local ok, err = pcall(function()
        local proposals = suggestions()
        s:Accept({ playerActions = proposals })
        assert(c:Snapshot().hasRoute and c:Snapshot().hasMacro)
        local notices = #s.printed
        s:Accept({ playerActions = proposals }); equal(#s.printed, notices)
        equal(preview, 0); equal(map, 0)
        c:HandleSlash("macro"); c:HandleSlash("route")
        equal(preview, 1); equal(map, 1)
        c:HandleSlash("route clear"); equal(cleared, 1)
        proposals.macro.id = string.rep("c", 32)
        s:Accept({ playerActions = proposals }); equal(hidden, 1)
        s:Accept({ epoch = "aabbccdd" }); equal(hidden, 2)
        assert(not c:Snapshot().hasRoute and not c:Snapshot().hasMacro)
        c:HandleSlash("macro"); equal(preview, 1)
        c:Stop()
    end)
    ns.MacroProposal, ns.Route = oldMacro, oldRoute
    assert(ok, err)
end)
