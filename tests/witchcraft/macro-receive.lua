local ns, test, equal = ...

local function suggestion()
    return { id = string.rep("a", 32), name = "Mark", body = "#showtooltip\n/say Ready" }
end

local function receive(fields)
    local ring = ns.Ring.New({ uiNonce = "abcdef01" })
    local result = ring:OnChunk(ns.TestPayload(1, fields))
    assert(result.accepted)
    return result.macroProposal
end

test("a macro proposal carries a bounded literal copy and malformed or unrelated fields leave the terminal usable", function()
    equal(receive({}), nil)
    local input = suggestion()
    local copied = receive({ macroProposal = input })
    input.body = "changed"
    equal(copied.body, "#showtooltip\n/say Ready")
    for _, change in ipairs({
        function(m) m.id = "wrong" end,
        function(m) m.name = string.rep("é", 9) end,
        function(m) m.body = string.rep("x", 256) end,
        function(m) m.body = "/say abc\r/run xyz" end,
        function(m) m.body = "\255" end,
    }) do
        input = suggestion()
        change(input)
        equal(receive({ macroProposal = input }), nil)
    end
end)

test("a legacy route-only frame still displays its terminal screen and drops the retired payload", function()
    local ring = ns.Ring.New({ uiNonce = "abcdef01" })
    local frame = ns.TestPayload(1, { playerActions = { route = { id = string.rep("b", 32), name = "Patrol",
        points = { { mapID = 1429, x = 25, y = 30, label = "First stop" } } } } })
    local result = ring:OnChunk(frame)
    assert(result.accepted)
    equal(result.sessions[1].lines[1], frame.sessions[1].lines[1])
    equal(result.playerActions, nil)
    equal(result.macroProposal, nil)
end)

test("macro proposals wait for explicit review, deduplicate notices, and close an obsolete preview", function()
    local c, s = ns.TestControllerFixture()
    local original = ns.MacroProposal
    local preview, hidden = 0, 0
    ns.MacroProposal = { Show = function(m) equal(m.name, "Mark"); preview = preview + 1; return true end,
        Hide = function() hidden = hidden + 1 end }
    local ok, err = pcall(function()
        local macro = suggestion()
        s:Accept({ macroProposal = macro })
        assert(c:Snapshot().hasMacro)
        local notices = #s.printed
        s:Accept({ macroProposal = macro })
        equal(#s.printed, notices)
        equal(preview, 0)
        c:HandleSlash("macro")
        equal(preview, 1)
        macro.id = string.rep("c", 32)
        s:Accept({ macroProposal = macro })
        equal(hidden, 1)
        s:Accept({ epoch = "aabbccdd" })
        equal(hidden, 2)
        assert(not c:Snapshot().hasMacro)
        c:HandleSlash("macro")
        equal(preview, 1)
        c:Stop()
    end)
    ns.MacroProposal = original
    assert(ok, err)
end)
