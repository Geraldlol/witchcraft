-- Lua errors, warnings and blocked actions, kept for the assistants to ask about. Loaded before
-- every other Witchcraft file so it hooks as early as it can. It chains to the handler it found, so
-- Blizzard's error frame (or whichever handler was first) keeps working. Nothing here sends: the
-- `errors` context domain reads this store only when a host want names it.
-- luacheck: globals seterrorhandler GetCallstackHeight GetErrorCallstackHeight
local _, ns = ...
local Errors = {}
ns.Errors = Errors
local methods = {}
methods.__index = methods

local MAX_ENTRIES, MAX_MESSAGE, MAX_STACK, MAX_FRAMES, MAX_COUNT, MAX_STAMP = 20, 240, 200, 3, 999999, 2147483647
local KINDS = { error = true, warning = true, blocked = true, forbidden = true }
local UNREADABLE = "<unreadable>"
Errors.MAX_ENTRIES, Errors.UNREADABLE = MAX_ENTRIES, UNREADABLE

local function integer(value, low, high)
    return type(value) == "number" and value == math.floor(value) and value >= low and value <= high
end

-- A byte bound that never splits a UTF-8 sequence; the wire encoder validates the rest.
local function cut(value, limit)
    if #value <= limit then return value end
    local stop = limit
    while stop > 0 and value:byte(stop + 1) >= 128 and value:byte(stop + 1) < 192 do stop = stop - 1 end
    return value:sub(1, stop)
end

function Errors.New(env)
    return setmetatable({ env = env or {}, buffer = {}, session = 0 }, methods)
end

-- A value from an error or event is looked at only once it is known to be an ordinary string.
function methods:Readable(value)
    if type(value) ~= "string" then return false end
    local env = self.env
    if type(env.IsSecret) == "function" then
        local ok, secret = pcall(env.IsSecret, value)
        if not ok or secret then return false end
    end
    if type(env.CanAccess) == "function" then
        local ok, accessible = pcall(env.CanAccess, value)
        if not ok or not accessible then return false end
    end
    return true
end

function methods:Now()
    local ok, value = pcall(self.env.time or function() return 0 end)
    if not ok or not integer(value, 0, MAX_STAMP) then return 0 end
    return value
end

local function clean(value)
    value = value:gsub("|c%x%x%x%x%x%x%x%x", ""):gsub("|r", ""):gsub("|H.-|h(.-)|h", "%1"):gsub("|T.-|t", "")
    return (value:gsub("[%z\1-\31\127]", " "))
end

-- Top frames only, without the AddOns prefix and the brackets the client puts round a path.
function methods:Frames(stack)
    local frames, total = {}, 0
    if not self:Readable(stack) then return frames end
    for line in stack:gmatch("[^\n]+") do
        if #frames >= MAX_FRAMES then break end
        if not line:find("Witchcraft/Errors.lua", 1, true) then
            line = clean(line):gsub("Interface/AddOns/", ""):gsub("^%[([^%]]*)%]", "%1"):gsub("^%s+", "")
            if line ~= "" then
                line = cut(line, MAX_STACK - total)
                if line == "" then break end
                frames[#frames + 1], total = line, total + #line
            end
        end
    end
    return frames
end

local function key(entry) return entry.kind .. "\0" .. entry.message .. "\0" .. (entry.stack[1] or "") end

-- Keep the selected identity apart from the capped history so evicting an old
-- row (or saturating its lifetime count) does not lose new occurrences.
local function validWatch(watch)
    if type(watch) ~= "table" or getmetatable(watch) ~= nil or watch.version ~= 1
        or not KINDS[watch.kind] or type(watch.message) ~= "string" or #watch.message > MAX_MESSAGE
        or type(watch.frame) ~= "string" or #watch.frame > MAX_STACK
        or not integer(watch.startSession, 1, MAX_STAMP) or not integer(watch.total, 0, MAX_COUNT)
        or not integer(watch.sinceCheck, 0, watch.total) then return false end
    local check = watch.check
    return check == nil or (type(check) == "table" and getmetatable(check) == nil
        and integer(check.session, 1, MAX_STAMP) and integer(check.total, 0, watch.total)
        and integer(check.inLoad, 0, check.total) and integer(check.interval, 0, check.total))
end

function methods:List() return self.global and self.global.errors or self.buffer end

-- The list is kept in the order entries were last seen, oldest first.
function methods:Merge(entry)
    local watch = self.watch
    if watch and entry.kind == watch.kind and entry.message == watch.message and (entry.stack[1] or "") == watch.frame then
        watch.total = math.min(MAX_COUNT, watch.total + entry.count)
        watch.sinceCheck = math.min(MAX_COUNT, watch.sinceCheck + entry.count)
        self.watchInLoad = math.min(MAX_COUNT, self.watchInLoad + entry.count)
    end
    local list = self:List()
    for index, existing in ipairs(list) do
        if key(existing) == key(entry) then
            table.remove(list, index)
            existing.count = math.min(MAX_COUNT, existing.count + entry.count)
            existing.first, existing.last = math.min(existing.first, entry.first), math.max(existing.last, entry.last)
            existing.session = entry.session
            entry = existing
            break
        end
    end
    list[#list + 1] = entry
    while #list > MAX_ENTRIES do table.remove(list, 1) end
end

function methods:Add(kind, message, stack)
    local now = self:Now()
    message = self:Readable(message) and cut(clean(message), MAX_MESSAGE) or UNREADABLE
    self:Merge({ kind = kind, message = message, stack = self:Frames(stack), count = 1,
        first = now, last = now, session = self.global and self.session or nil })
end

-- Never throws, and an error raised while recording is dropped rather than recorded.
function methods:Record(kind, message, stack)
    if self.recording or not KINDS[kind] then return false end
    self.recording = true
    local ok = pcall(self.Add, self, kind, message, stack)
    self.recording = false
    return ok
end

function methods:Event(event, first, second)
    if event == "LUA_WARNING" then return self:Record("warning", first) end
    local kind = event == "ADDON_ACTION_BLOCKED" and "blocked" or event == "ADDON_ACTION_FORBIDDEN" and "forbidden"
    if not kind then return false end
    local message = self:Readable(first) and self:Readable(second) and (first .. " called " .. second) or nil
    return self:Record(kind, message)
end

local function validEntry(entry)
    if type(entry) ~= "table" or getmetatable(entry) ~= nil or not KINDS[entry.kind]
        or type(entry.message) ~= "string" or #entry.message > MAX_MESSAGE or type(entry.stack) ~= "table"
        or #entry.stack > MAX_FRAMES or not integer(entry.count, 1, MAX_COUNT)
        or not integer(entry.first, 0, MAX_STAMP) or not integer(entry.last, entry.first, MAX_STAMP)
        or not integer(entry.session, 0, MAX_STAMP) then return false end
    local total = 0
    for index, frame in pairs(entry.stack) do
        if not integer(index, 1, #entry.stack) or type(frame) ~= "string" then return false end
        total = total + #frame
    end
    return total <= MAX_STACK
end

-- Takes the saved list (replacing an invalid one: a bad error log is no reason to disable
-- Witchcraft), counts this load, and moves anything seen before the database existed into it.
function methods:Attach(global)
    local saved = global.errors
    local valid = type(saved) == "table" and #saved <= MAX_ENTRIES
    if valid then
        for index, entry in pairs(saved) do
            if not integer(index, 1, #saved) or not validEntry(entry) then valid = false; break end
        end
    end
    if not valid then saved = {} end
    table.sort(saved, function(left, right) return left.last < right.last end)
    local session = integer(global.errorSession, 0, MAX_STAMP - 1) and global.errorSession or 0
    global.errors, global.errorSession = saved, session + 1
    self.global, self.session = global, session + 1
    self.watch = validWatch(global.errorWatch) and global.errorWatch or nil
    self.watchInLoad, self.listed = 0, nil
    local buffered = self.buffer
    self.buffer = {}
    for _, entry in ipairs(buffered) do entry.session = self.session; self:Merge(entry) end
end

-- Newest first, as copies.
function methods:Newest()
    local list, result = self:List(), {}
    for index = #list, 1, -1 do
        local entry, stack = list[index], {}
        for position, frame in ipairs(entry.stack) do stack[position] = frame end
        result[#result + 1] = { kind = entry.kind, message = entry.message, stack = stack, count = entry.count,
            first = entry.first, last = entry.last, session = entry.session or self.session }
    end
    return result
end

function methods:Clear()
    if self.global then self.global.errors = {} else self.buffer = {} end
    self:Unwatch()
end

function methods:Unwatch()
    if self.global then self.global.errorWatch = nil end
    self.watch, self.listed, self.watchInLoad = nil, nil, 0
end

local function display(value) return (value:gsub("|", "||")) end
local function countText(value) return tostring(value) .. (value == MAX_COUNT and "+" or "") end

function methods:WatchStatus(emit)
    local watch = self.watch
    if not watch then emit("No active error watch. Use /witch errors list to select one."); return end
    emit(string.format("Watching [%s] %s", watch.kind, display(watch.message)))
    if watch.frame ~= "" then emit(display(watch.frame)) end
    emit(string.format("%s matches since selection (UI load %d). %s this load (UI load %d).",
        countText(watch.total), watch.startSession, countText(self.watchInLoad), self.session))
    local check = watch.check
    if check then
        emit(string.format("Last player-marked attempt on UI load %d: %s matches in that load by then (%s since selection).",
            check.session, countText(check.inLoad), countText(check.total)))
        emit(string.format("%s new matches in the marked interval. %s since that checkpoint.",
            countText(check.interval), countText(watch.sinceCheck)))
    else
        emit("No reproduction attempt marked. After repeating the steps, use /witch errors checked.")
    end
end

local usage = "/witch errors list | watch <number> | status | checked | unwatch | clear"

function methods:Command(arg, emit)
    local action, number = arg:lower():match("^(%S*)%s*(.-)$")
    if action == "watch" then
        if not self.global then emit("Error history has not loaded yet."); return end
        if self.global.errorWatch ~= nil and not self.watch then
            emit("Saved watch is unreadable. Use /witch errors unwatch to discard it."); return
        end
        local entry
        if number == "" then entry = self:Newest()[1]
        elseif number:match("^%d%d?$") and self.listed then entry = self.listed[tonumber(number)] end
        if not entry then emit("Use /witch errors list, then /witch errors watch <number>."); return end
        self.watch = { version = 1, kind = entry.kind, message = entry.message, frame = entry.stack[1] or "",
            startSession = self.session, total = 0, sinceCheck = 0 }
        self.global.errorWatch, self.watchInLoad = self.watch, 0
        self:WatchStatus(emit)
        return
    end
    if number ~= "" then emit(usage); return end
    if action == "clear" then self:Clear(); emit("Errors cleared"); return end
    if action == "unwatch" then self:Unwatch(); emit("Error watch removed."); return end
    if action == "checked" or action == "status" then
        if action == "checked" and self.watch then
            self.watch.check = { session = self.session, total = self.watch.total, inLoad = self.watchInLoad, interval = self.watch.sinceCheck }
            self.watch.sinceCheck = 0
        end
        self:WatchStatus(emit)
        return
    end
    if action ~= "list" and action ~= "" then emit(usage); return end
    local list = self:Newest()
    if action == "list" then self.listed = list end -- Numbering stays stable while new errors arrive.
    if #list == 0 then emit("No Lua errors stored"); return end
    if action == "list" then
        for i, entry in ipairs(list) do
            local frame = entry.stack[1]
            emit(string.format("%d. [%s x%s] %s%s", i, entry.kind, countText(entry.count), display(entry.message),
                frame and ("  " .. display(frame)) or ""))
        end
        emit("Select a row with /witch errors watch <number>.")
    else
        local newest = list[1]
        emit(string.format("Lua errors: %d stored. Newest [%s x%s, UI load %d]", #list, newest.kind, countText(newest.count), newest.session))
        emit(display(newest.message))
        if newest.stack[1] then emit(display(newest.stack[1])) end
        if self.watch then self:WatchStatus(emit) end
        emit(usage)
    end
end

function methods:Stack()
    local env = self.env
    if type(env.debugstack) ~= "function" then return nil end
    -- The same level Blizzard's handler derives: the frames above the error, not above us.
    local level = 3
    if type(env.GetCallstackHeight) == "function" and type(env.GetErrorCallstackHeight) == "function" then
        local current, failed = env.GetCallstackHeight(), env.GetErrorCallstackHeight()
        if integer(current, 1, 100000) and integer(failed, 1, 100000) then level = math.max(1, current - (failed - 1)) end
    end
    return env.debugstack(level)
end

function Errors.Install(store, api)
    if type(api.geterrorhandler) ~= "function" or type(api.seterrorhandler) ~= "function" then return false end
    local found, previous = pcall(api.geterrorhandler)
    if not found then return false end
    local function handler(message, ...)
        local captured, stack = pcall(store.Stack, store)
        store:Record("error", message, captured and stack or nil)
        if type(previous) == "function" then return previous(message, ...) end
    end
    if not pcall(api.seterrorhandler, handler) then return false end
    if type(api.CreateFrame) == "function" then
        local ok, frame = pcall(api.CreateFrame, "Frame")
        if ok and frame then
            for _, event in ipairs({ "LUA_WARNING", "ADDON_ACTION_BLOCKED", "ADDON_ACTION_FORBIDDEN" }) do
                pcall(frame.RegisterEvent, frame, event)
            end
            frame:SetScript("OnEvent", function(_, event, ...) store:Event(event, ...) end)
        end
    end
    return true
end

Errors.default = Errors.New({ time = time, debugstack = debugstack, IsSecret = issecretvalue, CanAccess = canaccessvalue,
    GetCallstackHeight = GetCallstackHeight, GetErrorCallstackHeight = GetErrorCallstackHeight })
Errors.Install(Errors.default, { geterrorhandler = geterrorhandler, seterrorhandler = seterrorhandler, CreateFrame = CreateFrame })
