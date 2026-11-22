local ns, test, equal = ...

local function store()
    return ns.Errors.New({ time = function() return 200 end })
end

local function command(errors, input)
    local lines = {}
    errors:Command(input, function(line) lines[#lines + 1] = line end)
    return table.concat(lines, "\n")
end

test("numbered error watches follow the row shown, survive eviction, and count only fresh exact matches", function()
    local errors, db = store(), {}
    errors:Attach(db)
    errors:Record("error", "same message", "First.lua:8")
    errors:Record("error", "same message", "Other.lua:9")
    local listed = command(errors, "list")
    assert(listed:find("2. [error x1] same message  First.lua:8", 1, true))
    errors:Record("warning", "another event")
    command(errors, "watch 2")
    equal(db.errorWatch.frame, "First.lua:8")
    equal(db.errorWatch.total, 0)
    errors:Record("warning", "same message", "First.lua:8")
    errors:Record("error", "same message", "Other.lua:9")
    errors:Record("error", "other message", "First.lua:8")
    for i = 1, 23 do errors:Record("error", "unrelated " .. i) end
    equal(#errors:Newest(), 20)
    equal(db.errorWatch.total, 0)
    errors:Record("error", "same message", "First.lua:8")
    equal(db.errorWatch.total, 1)
end)

local function startupLoad(others)
    local db, before = {}, store()
    before:Attach(db)
    before:Record("error", "trouble", "A.lua:1")
    command(before, "watch")
    local after = store()
    after:Record("error", "trouble", "A.lua:1")
    for i = 1, others do after:Record("error", "startup " .. i) end
    after:Attach(db)
    return after, db
end

test("a watched startup error that fits the 20-entry buffer counts with no overflow notice", function()
    local after = startupLoad(19)
    equal(after.watchInLoad, 1)
    assert(not command(after, "status"):find("overflowed", 1, true))
end)

test("a watched startup error evicted from the 20-entry buffer is reported as a possibly incomplete count", function()
    local after = startupLoad(20)
    equal(after.watchInLoad, 0)
    assert(command(after, "status"):find("Startup errors overflowed the 20-entry buffer on UI load 2, "
        .. "so counts from that load on may be incomplete.", 1, true))
    command(after, "unwatch")
    equal(after.watch, nil, "removing the watch drops the notice")
    command(after, "watch")
    assert(not command(after, "status"):find("overflowed", 1, true), "a watch selected after startup counts in full")
end)

test("the overflow mark is saved with the watch and keeps the first overflowing load", function()
    local after, db = startupLoad(20)
    equal(db.errorWatch.partial, 2)
    command(after, "checked")
    local sentence = "Startup errors overflowed the 20-entry buffer on UI load 2, so counts from that load on may be incomplete."
    -- A later load without overflow reads the mark back from the saved watch.
    local quiet = store()
    quiet:Attach(db)
    equal(quiet.session, 3)
    assert(command(quiet, "status"):find(sentence, 1, true))
    -- A later overflow does not move the mark.
    local again = store()
    for i = 1, 21 do again:Record("error", "startup " .. i) end
    again:Attach(db)
    equal(again.session, 4); equal(db.errorWatch.partial, 2)
    assert(command(again, "status"):find(sentence, 1, true))
end)

test("watched startup errors count once and a marked attempt remains a point-in-time record through reload", function()
    local before, db = store(), {}
    before:Attach(db)
    before:Record("error", "trouble", "A.lua:1")
    command(before, "watch")
    before:Record("error", "trouble", "A.lua:1")
    local after = store()
    after:Record("error", "trouble", "A.lua:1")
    after:Record("error", "trouble", "A.lua:1")
    after:Attach(db)
    equal(db.errorWatch.total, 3)
    equal(after.watchInLoad, 2)
    assert(command(after, "status"):find("No reproduction attempt marked", 1, true))
    command(after, "checked")
    equal(db.errorWatch.check.session, 2)
    equal(db.errorWatch.check.total, 3)
    equal(db.errorWatch.check.inLoad, 2)
    after:Record("error", "trouble", "A.lua:1")
    local quiet = store()
    quiet:Attach(db)
    local report = command(quiet, "status")
    assert(report:find("4 matches since selection (UI load 1). 0 this load (UI load 3).", 1, true))
    assert(report:find("attempt on UI load 2: 2 matches in that load by then (3 since selection)", 1, true))
    assert(report:find("3 new matches in the marked interval. 1 since that checkpoint.", 1, true))
    command(quiet, "checked")
    equal(db.errorWatch.check.session, 3)
    equal(db.errorWatch.check.inLoad, 0)
    equal(db.errorWatch.check.interval, 1)
    command(quiet, "checked")
    equal(db.errorWatch.check.interval, 0)
end)

test("invalid and future watches leave the addon and error history usable", function()
    local function marked(partial)
        return { version = 1, kind = "error", message = "m", frame = "", startSession = 1, total = 0, sinceCheck = 0,
            partial = partial }
    end
    local readable = store()
    readable:Attach({ errorWatch = marked(1) })
    assert(command(readable, "status"):find("overflowed the 20-entry buffer on UI load 1", 1, true))
    for _, saved in ipairs({ false, { version = 2 }, { version = 1, total = "bad" }, marked("x"), marked(0) }) do
        local errors, db = store(), { errorWatch = saved }
        errors:Attach(db)
        errors:Record("error", "retained")
        assert(command(errors, "watch"):find("unreadable", 1, true))
        equal(db.errorWatch, saved)
        command(errors, "unwatch")
        equal(#errors:Newest(), 1)
        command(errors, "watch")
        equal(db.errorWatch.message, "retained")
        command(errors, "clear")
        equal(db.errorWatch, nil)
        equal(#errors:Newest(), 0)
    end
end)
