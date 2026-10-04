-- Experimental, opt-in ordinary-addon state carrier. Loading this file does nothing.
-- luacheck: globals GetBuildInfo UnitGUID issecure
local _, ns = ...
local State = {}
ns.AddonsState = State
local methods = {}
methods.__index = methods
local names = {}
for index = 0, 255 do names[#names + 1] = string.format("WitchcraftStateBit%03d", index) end
names[257] = "WitchcraftStateCommit"
local INTERVAL, ACK_TIMEOUT, TTL = 2, 30, 900

local function integer(value, low, high)
    return type(value) == "number" and value == math.floor(value) and value >= low and value <= high
end
local function sessionValid(value)
    return type(value) == "string" and #value == 16 and value:match("^[0-9a-f]+$") ~= nil
        and value ~= "0000000000000000"
end
local function bxor(left, right)
    local value, bit = 0, 1
    for _ = 1, 32 do
        local a, b = left % 2, right % 2
        if a ~= b then value = value + bit end
        left, right, bit = math.floor(left / 2), math.floor(right / 2), bit * 2
    end
    return value
end
local function crc32(bytes)
    local value = 4294967295
    for index = 1, #bytes do
        value = bxor(value, bytes:byte(index))
        for _ = 1, 8 do
            if value % 2 == 1 then value = bxor(math.floor(value / 2), 3988292384)
            else value = math.floor(value / 2) end
        end
    end
    return bxor(value, 4294967295)
end
local function u16(value) return string.char(math.floor(value / 256), value % 256) end
function State.Encode(frame)
    if type(frame) ~= "table" or not sessionValid(frame.session) or not integer(frame.seq, 1, 65535)
        or not integer(frame.message, 1, 65535) or not integer(frame.part, 1, 64)
        or not integer(frame.count, frame.part, 64) or type(frame.payload) ~= "string"
        or #frame.payload < 1 or #frame.payload > 8 or (frame.part < frame.count and #frame.payload ~= 8) then
        return nil, "invalid state frame"
    end
    local session = frame.session:gsub("..", function(hex) return string.char(tonumber(hex, 16)) end)
    local body = "FS" .. string.char(1, #frame.payload) .. session .. u16(frame.seq) .. u16(frame.message)
        .. string.char(frame.part, frame.count) .. frame.payload .. string.rep("\000", 10 - #frame.payload)
    local crc = crc32(body)
    return body .. u16(math.floor(crc / 65536)) .. u16(crc % 65536)
end

function State.NativeAPI()
    local api = {}
    for _, name in ipairs({ "GetAddOnEnableState", "DoesAddOnExist", "IsAddOnLoaded", "GetAddOnSecurity",
        "EnableAddOn", "DisableAddOn", "SaveAddOns" }) do api[name] = C_AddOns and C_AddOns[name] end
    api.Build, api.Character, api.Insecure, api.Combat, api.Now = GetBuildInfo, UnitGUID, issecure, InCombatLockdown, GetTime
    return api
end
function State.New(api)
    return setmetatable({ api = api or State.NativeAPI(), status = "off", lastSave = -1000000000 }, methods)
end
local function call(api, ...)
    if type(api) ~= "function" then return false end
    return pcall(api, ...)
end
function methods:Now()
    local ok, value = call(self.api.Now)
    if not ok or type(value) ~= "number" or value ~= value or value == math.huge or value == -math.huge then return nil end
    return value
end
function methods:Read(name)
    local ok, value = call(self.api.GetAddOnEnableState, name, self.journal.character)
    if ok and (value == 0 or value == 2) then return value end
end
function methods:Gate()
    local ok, observed = ns.Evidence.Check(self.api.Build)
    if not ok then
        return false, "requires evidence build " .. ns.Evidence.Label() .. " / " .. ns.Evidence.interface
            .. "; client is " .. observed
    end
    local identityOK, secure = call(self.api.Insecure)
    local combatOK, combat = call(self.api.Combat)
    local characterOK, character = call(self.api.Character, "player")
    local securityOK, security = call(self.api.GetAddOnSecurity, "Witchcraft")
    if not identityOK or secure ~= false or not combatOK or combat ~= false or not characterOK
        or type(character) ~= "string" or #character < 1 or #character > 128 or not securityOK or security ~= 1 then
        return false, "ordinary identity, character or out-of-combat gate unavailable"
    end
    if self.journal and character ~= self.journal.character then return false, "character changed" end
    for _, name in ipairs(names) do
        local existsOK, exists = call(self.api.DoesAddOnExist, name)
        local loadedOK, loaded, loading = call(self.api.IsAddOnLoaded, name)
        local secOK, sec = call(self.api.GetAddOnSecurity, name)
        if not existsOK or exists ~= true or not loadedOK or loaded ~= false or loading ~= false
            or not secOK or sec ~= 1 then return false, "bank missing, loaded, loading or not ordinary" end
    end
    for _, name in ipairs({ "GetAddOnEnableState", "EnableAddOn", "DisableAddOn", "SaveAddOns" }) do
        if type(self.api[name]) ~= "function" then return false, "required state API missing" end
    end
    return true, character
end
function methods:Fail(reason)
    self.status, self.fault = "quarantined", reason
    return false, reason
end
function methods:Owned()
    for index, name in ipairs(names) do
        if self:Read(name) ~= self.journal.expected[index] then return false end
    end
    return true
end
function methods:Set(index, value)
    if self.journal.expected[index] == value then return true end
    local setter = value == 2 and self.api.EnableAddOn or self.api.DisableAddOn
    local ok, result = call(setter, names[index], self.journal.character)
    local observed = self:Read(names[index])
    if observed == value then self.journal.expected[index] = value end
    return ok and result == nil and observed == value
end
function methods:Save(now)
    self.lastSave = now -- failures consume the rate budget as well
    local ok, value = call(self.api.SaveAddOns)
    return ok and value == nil
end
function methods:Start(session, journal)
    if self.journal or type(journal) ~= "table" or next(journal) ~= nil or not sessionValid(session) then
        return false, "fresh session and empty caller-owned journal required"
    end
    local ok, character = self:Gate()
    if not ok then return false, character end
    local now = self:Now()
    if not now then return false, "clock unavailable" end
    local original = {}
    for index, name in ipairs(names) do
        local readOK, value = call(self.api.GetAddOnEnableState, name, character)
        if not readOK or (value ~= 0 and value ~= 2) then return false, "ambiguous bank enable state" end
        original[index] = value
    end
    journal.schema, journal.character, journal.session = 1, character, session
    journal.original, journal.expected, journal.phase = original, {}, "idle"
    for index = 1, 257 do journal.expected[index] = original[index] end
    self.journal, self.seq, self.message, self.status = journal, 1, 0, "ready"
    return true
end
function methods:Queue(payload)
    if self.status ~= "ready" or self.active or type(payload) ~= "string" or #payload < 1 or #payload > 512 then
        return false, "carrier unavailable, busy or payload outside 1..512 bytes"
    end
    local count = math.ceil(#payload / 8)
    if self.seq + count - 1 > 65535 or self.message == 65535 then return false, "fresh session required before sequence exhaustion" end
    local now = self:Now()
    if not now then return false, "clock unavailable" end
    self.message = self.message + 1
    self.active = { payload = payload, count = count, part = 1, started = now }
    self.journal.phase, self.status = "invalidate", "sending"
    return true
end
function methods:Acknowledge(session, seq)
    if self.status ~= "waiting" or session ~= self.journal.session or seq ~= self.seq then return false end
    self.seq = self.seq + 1
    self.active.part = self.active.part + 1
    if self.active.part > self.active.count then
        self.active, self.status, self.journal.phase = nil, "ready", "idle"
    else self.status, self.journal.phase = "sending", "invalidate" end
    return true
end
function methods:RequestRestore()
    if not self.journal or self.status == "restored" then return false, "no active snapshot" end
    self.active, self.status, self.fault, self.journal.phase = nil, "restoring", nil, "restore-invalidate"
    return true
end
-- Attach a retained journal ONLY for restoration, never to resume an old session.
function methods:Recover(journal)
    if self.journal or type(journal) ~= "table" or journal.schema ~= 1 or not sessionValid(journal.session)
        or type(journal.character) ~= "string" or #journal.character < 1 or #journal.character > 128
        or type(journal.original) ~= "table" or type(journal.expected) ~= "table" then return false end
    for index = 1, 257 do
        if (journal.original[index] ~= 0 and journal.original[index] ~= 2)
            or (journal.expected[index] ~= 0 and journal.expected[index] ~= 2) then return false end
    end
    self.journal = journal
    return self:RequestRestore()
end
function methods:Pump()
    if self.status ~= "sending" and self.status ~= "waiting" and self.status ~= "restoring" then return false end
    local now = self:Now()
    if not now then return self:Fail("clock unavailable") end
    if self.active and now - self.active.started > TTL then return self:Fail("message expired; restore bank") end
    if self.status == "waiting" then
        if now - self.sentAt > ACK_TIMEOUT then return self:Fail("host ACK timeout; restore bank") end
        return false
    end
    if now - self.lastSave < INTERVAL then return false, "rate limited" end
    local ok, reason = self:Gate()
    if not ok then return false, reason end
    if not self:Owned() then return self:Fail("bank ownership changed; preserve snapshot") end
    self.lastSave = now -- a partial setter failure also consumes the phase budget
    local phase = self.journal.phase
    if phase == "invalidate" or phase == "restore-invalidate" then
        if not self:Set(257, 0) or not self:Save(now) then return self:Fail("commit invalidation failed") end
        self.journal.phase = phase == "invalidate" and "data" or "restore-data"
    elseif phase == "data" or phase == "restore-data" then
        local bytes
        if phase == "data" then
            local active = self.active
            bytes = State.Encode({ session = self.journal.session, seq = self.seq, message = self.message,
                part = active.part, count = active.count, payload = active.payload:sub((active.part - 1) * 8 + 1, active.part * 8) })
        end
        for index = 1, 256 do
            local value = phase == "restore-data" and self.journal.original[index]
                or math.floor(bytes:byte(math.floor((index - 1) / 8) + 1) / 2 ^ (7 - (index - 1) % 8)) % 2 * 2
            if not self:Set(index, value) then return self:Fail("bank data write failed") end
        end
        if not self:Save(now) then return self:Fail("bank data save failed") end
        self.journal.phase = phase == "data" and "commit" or "restore-commit"
    elseif phase == "commit" or phase == "restore-commit" then
        local value = phase == "commit" and 2 or self.journal.original[257]
        if not self:Set(257, value) or not self:Save(now) then return self:Fail("commit save failed") end
        if phase == "commit" then
            self.status, self.sentAt, self.journal.phase = "waiting", now, "waiting"
        else self.status, self.journal.phase = "restored", "restored" end
    else return self:Fail("unknown journal phase") end
    return true
end
State.Names = names
State.CRC32 = crc32
