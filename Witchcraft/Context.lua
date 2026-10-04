-- Read-only, bounded game context. Native payloads cross the secrecy predicate
-- before type checks, field access, comparisons, formatting or serialization.
local _, ns = ...
local Context = {}
ns.Context = Context
local methods = {}
methods.__index = methods
local MAX_DATA_BYTES, MAX_QUESTS, MAX_OBJECTIVES, MAX_ERROR_PARTS = 490, 10, 4, 8

local function ordinary(api, value)
    if type(api.IsSecret) ~= "function" then return false, "guard-missing" end
    local ok, secret = pcall(api.IsSecret, value)
    if not ok or secret then return false, "restricted" end
    return true
end

local function read(api, name, ...)
    if type(api[name]) ~= "function" then return nil, "missing" end
    local ok, value = pcall(api[name], ...)
    if not ok then return nil, "unavailable" end
    local allowed, reason = ordinary(api, value)
    if not allowed then return nil, reason end
    if value == nil then return nil, "unavailable" end
    return value
end

-- Some natives answer with several values at once; each one still crosses the
-- secrecy predicate before it is looked at.
local function readMulti(api, name, ...)
    if type(api[name]) ~= "function" then return nil, "missing" end
    local results = { pcall(api[name], ...) }
    if not results[1] then return nil, "unavailable" end
    return results
end

local function pick(api, results, index)
    local value = results[index + 1]
    local allowed, reason = ordinary(api, value)
    if not allowed then return nil, reason end
    if value == nil then return nil, "unavailable" end
    return value
end

local function readableTable(api, value)
    local allowed, reason = ordinary(api, value)
    if not allowed then return false, reason end
    if type(value) ~= "table" then return false, "invalid" end
    if type(api.CanAccessTable) ~= "function" then return false, "guard-missing" end
    local ok, accessible = pcall(api.CanAccessTable, value)
    if not ok or not accessible then return false, "restricted" end
    if getmetatable(value) ~= nil then return false, "invalid" end
    return true
end

local function field(api, value, key)
    local allowed, reason = readableTable(api, value)
    if not allowed then return nil, reason end
    local ok, result = pcall(rawget, value, key)
    if not ok then return nil, "unavailable" end
    allowed, reason = ordinary(api, result)
    if not allowed then return nil, reason end
    return result
end

-- Validate UTF-8 while retaining whole codepoints within a byte limit.
local function prefix(value, limit)
    local position, last = 1, 0
    while position <= #value do
        local first, count = value:byte(position), 1
        if first >= 194 and first <= 223 then count = 2
        elseif first >= 224 and first <= 239 then count = 3
        elseif first >= 240 and first <= 244 then count = 4
        elseif first >= 128 then return nil end
        if position + count - 1 > #value then return nil end
        for offset = 1, count - 1 do
            local byte = value:byte(position + offset)
            if byte < 128 or byte > 191 then return nil end
        end
        local second = value:byte(position + 1)
        if (first == 224 and second < 160) or (first == 237 and second > 159)
            or (first == 240 and second < 144) or (first == 244 and second > 143) then return nil end
        if position + count - 1 <= limit then last = position + count - 1 end
        position = position + count
    end
    return value:sub(1, last), last < #value
end

local function text(value, limit, allowEmpty)
    if type(value) ~= "string" then return nil, "invalid" end
    value = value:gsub("[%z\1-\31\127]", " "):gsub("\194[\128-\159]", " ")
    local result, truncated = prefix(value, limit)
    if not result or (not allowEmpty and result == "") then return nil, "invalid" end
    return result, nil, truncated
end

local function number(value, low, high)
    if type(value) ~= "number" or value ~= value or value < low or value > high or value % 1 ~= 0 then
        return nil, "invalid"
    end
    return value
end

local function quote(value)
    return '"' .. value:gsub('[%z\1-\31\\"]', function(character)
        if character == '"' then return '\\"' end
        if character == '\\' then return '\\\\' end
        return string.format("\\u%04x", character:byte())
    end) .. '"'
end

-- Deliberately accepts only constructed arrays/scalars, not arbitrary game
-- records. It is bounded independently of the transport's packet-size check.
function Context.Encode(value)
    local active, nodes = {}, 0
    local function encode(item, depth)
        nodes = nodes + 1
        if nodes > 256 or depth > 8 then error("context structure exceeds bounds") end
        if type(issecretvalue) == "function" and issecretvalue(item) then error("restricted context value") end
        local kind = type(item)
        if kind == "string" then
            if #item > 2048 or not prefix(item, #item) then error("invalid context string") end
            return quote(item)
        end
        if kind == "boolean" then return item and "true" or "false" end
        if kind == "number" then
            if not number(item, 0, 2147483647) then error("invalid context number") end
            return string.format("%.0f", item)
        end
        if kind ~= "table" or getmetatable(item) ~= nil or active[item] then error("invalid context array") end
        active[item] = true
        local length, count, result = #item, 0, {}
        for key in pairs(item) do
            if type(key) ~= "number" or key % 1 ~= 0 or key < 1 or key > length then error("invalid context key") end
            count = count + 1
        end
        if count ~= length or length > 64 then error("invalid context array length") end
        for index = 1, length do result[index] = encode(item[index], depth + 1) end
        active[item] = nil
        return "[" .. table.concat(result, ",") .. "]"
    end
    local ok, result = pcall(encode, value, 0)
    if not ok then return nil, "invalid context value" end
    if #result > 4096 then return nil, "context encoding exceeds bounds" end
    return result
end

function Context.NativeAPI()
    local api = { IsSecret = issecretvalue, CanAccessTable = canaccesstable }
    local function bind(name, fn, argument)
        if type(fn) == "function" then
            if argument then api[name] = function() return fn(argument) end
            else api[name] = fn end
        end
    end
    bind("GetPlayerName", UnitName, "player")
    bind("GetPlayerClass", UnitClass, "player")
    bind("GetPlayerLevel", UnitLevel, "player")
    bind("GetZone", GetZoneText)
    bind("GetSubzone", GetSubZoneText)
    if type(C_Map) == "table" then bind("GetMapID", C_Map.GetBestMapForUnit, "player") end
    if type(C_QuestLog) == "table" then
        bind("GetTrackedCount", C_QuestLog.GetNumQuestWatches)
        bind("GetTrackedQuestID", C_QuestLog.GetQuestIDForQuestWatchIndex)
        bind("GetQuestTitle", C_QuestLog.GetTitleForQuestID)
        bind("IsQuestComplete", C_QuestLog.IsComplete)
        bind("GetQuestObjectives", C_QuestLog.GetQuestObjectives)
    end
    bind("GetMoney", GetMoney)
    bind("GetPlayerXP", UnitXP, "player")
    bind("GetPlayerXPMax", UnitXPMax, "player")
    bind("GetRestedXP", GetXPExhaustion)
    bind("IsInInstance", IsInInstance)
    bind("GetInstanceInfo", GetInstanceInfo)
    bind("GetGroupSize", GetNumGroupMembers)
    bind("GetPlayerRole", UnitGroupRolesAssigned, "player")
    bind("IsPlayerDeadOrGhost", UnitIsDeadOrGhost, "player")
    bind("IsPlayerGhost", UnitIsGhost, "player")
    bind("IsPlayerInCombat", UnitAffectingCombat, "player")
    api.Errors = ns.Errors and ns.Errors.default
    return api
end

function Context.New(api)
    return setmetatable({ api = api or Context.NativeAPI() }, methods)
end

local function player(api)
    local output, unavailable = {}, {}
    local fields = {
        { "name", "GetPlayerName", "text" }, { "class", "GetPlayerClass", "text" },
        { "level", "GetPlayerLevel", "level" }, { "mapId", "GetMapID", "map" },
        { "zone", "GetZone", "text" }, { "subzone", "GetSubzone", "empty" },
    }
    for index, definition in ipairs(fields) do
        local value, reason = read(api, definition[2])
        if not reason then
            if definition[3] == "level" then value, reason = number(value, 1, 1000)
            elseif definition[3] == "map" then value, reason = number(value, 1, 2147483647)
            else
                local clipped
                value, reason, clipped = text(value, 40, definition[3] == "empty")
                if clipped then unavailable[#unavailable + 1] = definition[1] .. ":truncated" end
            end
        end
        output[index] = value or false
        if reason then unavailable[#unavailable + 1] = definition[1] .. ":" .. reason end
    end
    output[7] = unavailable
    return { output }
end

local function questRow(api, id)
    local title, reason = read(api, "GetQuestTitle", id)
    local truncated = false
    if not reason then title, reason, truncated = text(title, 64) end
    if reason then return nil, reason end
    local complete, completeReason = read(api, "IsQuestComplete", id)
    if completeReason or type(complete) ~= "boolean" then return nil, completeReason or "invalid" end
    local raw, objectiveReason = read(api, "GetQuestObjectives", id)
    if objectiveReason then return nil, objectiveReason end
    local allowed, tableReason = readableTable(api, raw)
    if not allowed then return nil, tableReason end
    local objectives = {}
    for index = 1, MAX_OBJECTIVES + 1 do
        local source, rowReason = field(api, raw, index)
        if rowReason then return nil, rowReason end
        if source == nil then break end
        if index > MAX_OBJECTIVES then truncated = true; break end
        local label, labelReason = field(api, source, "text")
        local clipped
        if not labelReason then label, labelReason, clipped = text(label, 64) end
        if labelReason then return nil, labelReason end
        local fulfilled, fulfilledReason = field(api, source, "numFulfilled")
        local required, requiredReason = field(api, source, "numRequired")
        local finished, finishedReason = field(api, source, "finished")
        if fulfilledReason or requiredReason or finishedReason then
            return nil, fulfilledReason or requiredReason or finishedReason
        end
        if type(finished) ~= "boolean" then return nil, "invalid" end
        -- Missing numeric progress is explicit; never invent zero completion.
        if fulfilled ~= nil then fulfilled, fulfilledReason = number(fulfilled, 0, 2147483647) end
        if required ~= nil then required, requiredReason = number(required, 0, 2147483647) end
        if fulfilledReason or requiredReason then return nil, "invalid" end
        objectives[#objectives + 1] = { label, fulfilled or false, required or false, finished }
        truncated = truncated or clipped
    end
    return { id, title, complete, objectives, truncated }
end

local function quests(api)
    local count, reason = read(api, "GetTrackedCount")
    if not reason then count, reason = number(count, 0, 1000) end
    if reason then return { { false, reason, 0, false, {} } } end
    if count == 0 then return { { true, "", 0, false, {} } } end
    local result, seen, partial = {}, {}, count > MAX_QUESTS
    for index = 1, math.min(count, MAX_QUESTS) do
        local id, idReason = read(api, "GetTrackedQuestID", index)
        if not idReason then id, idReason = number(id, 1, 2147483647) end
        if idReason then return { { false, idReason, count, true, {} } } end
        if seen[id] then return { { false, "duplicate-quest", count, true, {} } } end
        seen[id] = true
        local row, rowReason = questRow(api, id)
        if rowReason then return { { false, rowReason, count, true, {} } } end
        local part = { true, "", count, partial or row[5], { row } }
        while #assert(Context.Encode(part)) > MAX_DATA_BYTES and #row[4] > 0 do
            table.remove(row[4])
            row[5], part[4] = true, true
        end
        result[#result + 1] = part
    end
    for _, part in ipairs(result) do partial = partial or part[4] end
    for _, part in ipairs(result) do part[4] = partial end
    return result
end

-- The player's own money, experience and situation. Captured on request only.
local function progress(api)
    local output, unavailable = {}, {}
    local function miss(name, reason)
        if reason and #unavailable < 14 then unavailable[#unavailable + 1] = (name .. ":" .. reason):sub(1, 64) end
    end
    local function boolean(value)
        if type(value) ~= "boolean" then return nil, "invalid" end
        return value
    end
    local function clip(name, value, limit)
        local result, reason, truncated = text(value, limit)
        if truncated then miss(name, "truncated") end
        return result, reason
    end

    local money, moneyReason = read(api, "GetMoney")
    if not moneyReason then money, moneyReason = number(money, 0, 2147483647) end
    miss("money", moneyReason)

    local xp, xpReason = read(api, "GetPlayerXP")
    if not xpReason then xp, xpReason = number(xp, 0, 2147483647) end
    local xpMax, xpMaxReason = read(api, "GetPlayerXPMax")
    if not xpMaxReason then xpMax, xpMaxReason = number(xpMax, 0, 2147483647) end
    -- A zero maximum is the level cap (or disabled experience), not zero progress.
    if not xpMaxReason and xpMax == 0 then xp, xpMax, xpReason, xpMaxReason = nil, nil, "cap", "cap" end
    miss("xp", xpReason); miss("xpMax", xpMaxReason)

    local rested, restedReason
    local restedResults, restedReadReason = readMulti(api, "GetRestedXP")
    if restedReadReason then restedReason = restedReadReason
    else
        rested, restedReason = pick(api, restedResults, 1)
        -- Documented: nil means no rested bonus.
        if restedReason == "unavailable" then rested, restedReason = 0, nil end
        if not restedReason then rested, restedReason = number(rested, 0, 2147483647) end
    end
    miss("rested", restedReason)

    local inInstance, instanceType, inInstanceReason, instanceTypeReason
    local instanceResults, instanceReadReason = readMulti(api, "IsInInstance")
    if instanceReadReason then inInstanceReason, instanceTypeReason = instanceReadReason, instanceReadReason
    else
        inInstance, inInstanceReason = pick(api, instanceResults, 1)
        if not inInstanceReason then inInstance, inInstanceReason = boolean(inInstance) end
        instanceType, instanceTypeReason = pick(api, instanceResults, 2)
        if not instanceTypeReason then instanceType, instanceTypeReason = clip("instanceType", instanceType, 16) end
    end
    miss("inInstance", inInstanceReason); miss("instanceType", instanceTypeReason)

    local instanceName, difficulty
    if inInstance == true then
        local infoResults, infoReason = readMulti(api, "GetInstanceInfo")
        local nameReason, difficultyReason = infoReason, infoReason
        if not infoReason then
            instanceName, nameReason = pick(api, infoResults, 1)
            if not nameReason then instanceName, nameReason = clip("instanceName", instanceName, 40) end
            difficulty, difficultyReason = pick(api, infoResults, 4)
            if not difficultyReason then difficulty, difficultyReason = clip("difficulty", difficulty, 24) end
        end
        miss("instanceName", nameReason); miss("difficulty", difficultyReason)
    end

    local groupSize, groupReason = read(api, "GetGroupSize")
    if not groupReason then groupSize, groupReason = number(groupSize, 0, 1000) end
    miss("groupSize", groupReason)

    local role
    if groupSize and groupSize > 0 then
        local roleReason
        role, roleReason = read(api, "GetPlayerRole")
        if not roleReason then role, roleReason = clip("role", role, 8) end
        miss("role", roleReason)
    end

    local flags = {}
    for index, definition in ipairs({ { "dead", "IsPlayerDeadOrGhost" }, { "ghost", "IsPlayerGhost" },
        { "combat", "IsPlayerInCombat" } }) do
        local value, reason = read(api, definition[2])
        if not reason then value, reason = boolean(value) end
        flags[index] = value
        miss(definition[1], reason)
    end

    output[1], output[2], output[3], output[4] = money or false, xp or false, xpMax or false, rested or false
    output[5], output[6] = inInstance or false, instanceType or false
    output[7], output[8] = instanceName or false, difficulty or false
    output[9], output[10] = groupSize or false, role or false
    output[11], output[12], output[13] = flags[1] or false, flags[2] or false, flags[3] or false
    output[14] = unavailable
    return { output }
end

-- The newest stored errors, one per part, shaped like quests so the host assembles both alike:
-- [available, reason, storedCount, truncated, [row]], row = [kind, message, stack, count,
-- firstAgo, lastAgo, reloadsAgo]. Ages replace clock times, so no wall clock crosses the wire.
local function errors(store)
    if type(store) ~= "table" or type(store.Newest) ~= "function" then return { { false, "unavailable", 0, false, {} } } end
    local ok, entries = pcall(store.Newest, store)
    if not ok or type(entries) ~= "table" then return { { false, "unavailable", 0, false, {} } } end
    local stored, now, session = #entries, store:Now(), store.session or 0
    if stored == 0 then return { { true, "", 0, false, {} } } end
    local result, partial = {}, stored > MAX_ERROR_PARTS
    local function ago(stamp) return math.max(0, math.min(2147483647, now - stamp)) end
    for index = 1, math.min(stored, MAX_ERROR_PARTS) do
        local entry, stack = entries[index], {}
        local message = text(entry.message, 240, true) or "<unreadable>"
        for _, frame in ipairs(entry.stack) do
            local line = text(frame, 200)
            if line then stack[#stack + 1] = line end
        end
        local row = { entry.kind, message, stack, entry.count, ago(entry.first), ago(entry.last),
            math.max(0, session - entry.session) }
        local part = { true, "", stored, partial, { row } }
        while #assert(Context.Encode(part)) > MAX_DATA_BYTES do
            if #stack > 0 then table.remove(stack) else row[2] = prefix(row[2], math.max(0, #row[2] - 16)) end
            part[4] = true
        end
        result[#result + 1] = part
    end
    for _, part in ipairs(result) do partial = partial or part[4] end
    for _, part in ipairs(result) do part[4] = partial end
    return result
end

function methods:Capture(domain)
    if domain == "player" then return player(self.api) end
    if domain == "quests" then return quests(self.api) end
    if domain == "progress" then return progress(self.api) end
    if domain == "errors" then return errors(self.api.Errors) end
    return nil, "unknown context domain"
end

Context.MAX_DATA_BYTES = MAX_DATA_BYTES
