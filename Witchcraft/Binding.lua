-- Stop-and-wait host carrier over one verified-empty binding. No carrier frame
-- is ever executed: its CLICK target deliberately names no created frame.
local _, ns = ...
local Binding = {}
ns.Binding = Binding
local methods = {}
methods.__index = methods

local KEYS = { "CTRL-ALT-SHIFT-F12", "CTRL-ALT-SHIFT-F11", "CTRL-ALT-SHIFT-F10", "CTRL-ALT-SHIFT-F9" }
local ZERO, PROBE = "00000000", "PFAM_BIND_PROBE"
local ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
local MAX_SEQ, MAX_PAYLOAD = 16777215, 32
local tabCodes = { claude = 0, codex = 1 }
local actionCodes = { text = 0, enter = 1, interrupt = 2, escape = 3, up = 4, down = 5 }

local function integer(value, low, high)
    return type(value) == "number" and value == math.floor(value) and value >= low and value <= high
end

local function hex8(value, zero)
    return type(value) == "string" and #value == 8 and value:match("^[0-9a-f]+$") ~= nil
        and (zero or value ~= ZERO)
end

local function bxor(left, right)
    local output, bit = 0, 1
    for _ = 1, 32 do
        local a, b = left % 2, right % 2
        if a ~= b then output = output + bit end
        left, right, bit = (left - a) / 2, (right - b) / 2, bit * 2
    end
    return output
end

local function crc32(value)
    local crc = 4294967295
    for index = 1, #value do
        crc = bxor(crc, value:byte(index))
        for _ = 1, 8 do
            if crc % 2 == 1 then crc = bxor(math.floor(crc / 2), 3988292384)
            else crc = math.floor(crc / 2) end
        end
    end
    return bxor(crc, 4294967295)
end

local function base32(value)
    local output, accumulator, bits = {}, 0, 0
    for index = 1, #value do
        accumulator, bits = accumulator * 256 + value:byte(index), bits + 8
        while bits >= 5 do
            bits = bits - 5
            local digit = math.floor(accumulator / 2 ^ bits)
            output[#output + 1] = ALPHABET:sub(digit + 1, digit + 1)
            accumulator = accumulator % 2 ^ bits
        end
    end
    if bits > 0 then
        local digit = accumulator * 2 ^ (5 - bits)
        output[#output + 1] = ALPHABET:sub(digit + 1, digit + 1)
    end
    return table.concat(output)
end

local function unbase32(value)
    if type(value) ~= "string" or value == "" or value:match("^[A-Z2-7]+$") == nil then return nil end
    local output, accumulator, bits = {}, 0, 0
    for index = 1, #value do
        local digit = ALPHABET:find(value:sub(index, index), 1, true)
        if not digit then return nil end
        accumulator, bits = accumulator * 32 + digit - 1, bits + 5
        if bits >= 8 then
            bits = bits - 8
            output[#output + 1] = string.char(math.floor(accumulator / 2 ^ bits))
            accumulator = accumulator % 2 ^ bits
        end
    end
    local decoded = table.concat(output)
    if accumulator ~= 0 or base32(decoded) ~= value then return nil end
    return decoded
end

local function actionFor(frame)
    if not hex8(frame.epoch, frame.epoch == ZERO) or not hex8(frame.nonce, frame.nonce == ZERO)
        or (frame.epoch == ZERO) ~= (frame.nonce == ZERO) or not hex8(frame.uiNonce)
        or not integer(frame.slot, 1, 9999) or not integer(frame.seq, 1, MAX_SEQ)
        or not integer(frame.part, 1, 32) or not integer(frame.count, frame.part, 32)
        or type(frame.payload) ~= "string" or #frame.payload < 1 or #frame.payload > MAX_PAYLOAD then return nil end
    local core = string.format("WitchcraftCarrier_V1_%s_%s_%s_%04X_%06X_%02X_%02X_%s",
        frame.epoch:upper(), frame.nonce:upper(), frame.uiNonce:upper(), frame.slot, frame.seq,
        frame.part, frame.count, base32(frame.payload))
    return string.format("CLICK %s_%08X:LeftButton", core, crc32(core))
end

local function parseAction(action)
    if type(action) ~= "string" then return nil end
    local epoch, nonce, uiNonce, slot, seq, part, count, encoded, checksum = action:match(
        "^CLICK WitchcraftCarrier_V1_([0-9A-F]+)_([0-9A-F]+)_([0-9A-F]+)_([0-9A-F]+)_([0-9A-F]+)_([0-9A-F]+)_([0-9A-F]+)_([A-Z2-7]+)_([0-9A-F]+):LeftButton$")
    if not epoch or #epoch ~= 8 or #nonce ~= 8 or #uiNonce ~= 8 or #slot ~= 4 or #seq ~= 6
        or #part ~= 2 or #count ~= 2 or #checksum ~= 8 then return nil end
    local payload = unbase32(encoded)
    if not payload or #payload < 1 or #payload > MAX_PAYLOAD then return nil end
    local frame = { epoch = epoch:lower(), nonce = nonce:lower(), uiNonce = uiNonce:lower(),
        slot = tonumber(slot, 16), seq = tonumber(seq, 16), part = tonumber(part, 16),
        count = tonumber(count, 16), payload = payload }
    local exact = actionFor(frame)
    if exact ~= action or tonumber(checksum, 16) ~= crc32(exact:match("^CLICK (.-)_[0-9A-F]+:LeftButton$")) then return nil end
    frame.action = action
    return frame
end

local function u24(value)
    return string.char(math.floor(value / 65536), math.floor(value / 256) % 256, value % 256)
end

local function chunks(value)
    local result = {}
    for offset = 1, #value, MAX_PAYLOAD do result[#result + 1] = value:sub(offset, offset + MAX_PAYLOAD - 1) end
    return #result <= 32 and result or nil
end

function Binding.NativeAPI()
    return {
        GetBindingAction = GetBindingAction,
        SetBinding = SetBinding,
        SaveBindings = SaveBindings,
        GetCurrentBindingSet = GetCurrentBindingSet,
        InCombatLockdown = InCombatLockdown,
        Now = GetTime,
    }
end

function Binding.New(api)
    return setmetatable({ api = api or Binding.NativeAPI(), nextSeq = 1, status = "Probe not run",
        lastWriteAt = -1000000000 }, methods)
end

function methods:Now()
    local ok, value = pcall(self.api.Now or function() return 0 end)
    return ok and type(value) == "number" and value == value and value or 0
end

function methods:Combat()
    local ok, value = pcall(self.api.InCombatLockdown or function() return false end)
    return not ok or value == true
end

function methods:Quarantine(reason)
    self.enabled, self.active, self.quarantined = false, nil, reason or "carrier ownership changed"
    self.status = "Quarantined: " .. self.quarantined
    return false, self.status
end

function methods:CurrentSet()
    if type(self.api.GetCurrentBindingSet) ~= "function" then return nil end
    local ok, value = pcall(self.api.GetCurrentBindingSet)
    return ok and value or nil
end

function methods:GetAction(key)
    if type(self.api.GetBindingAction) ~= "function" then return nil end
    local ok, value = pcall(self.api.GetBindingAction, key)
    return ok and value or nil
end

function methods:Save()
    if type(self.api.SaveBindings) ~= "function" then return false end
    local current = self:CurrentSet()
    if current == nil or (self.bindingSet ~= nil and current ~= self.bindingSet) then return false end
    local ok, saved = pcall(self.api.SaveBindings, current)
    -- Legacy SaveBindings call sites do not consume a result. A thrown error or
    -- explicit false fails here; nil remains provisional until the host sees
    -- the exact stable file line and returns the LoD acknowledgement.
    return ok and saved ~= false
end

function methods:ClearExact(key, action)
    if self:Combat() then return false, "cleanup waits for combat to end" end
    if self.bindingSet ~= nil and self:CurrentSet() ~= self.bindingSet then return self:Quarantine("binding set changed") end
    if self:GetAction(key) ~= action then return self:Quarantine("reserved key ownership changed") end
    self.mutating = true
    local ok, cleared = pcall(self.api.SetBinding or function() return false end, key, nil)
    local empty = ok and cleared and self:GetAction(key) == ""
    local saved = empty and self:Save()
    self.mutating = nil
    if not empty or not saved then return self:Quarantine("carrier cleanup failed") end
    self.lastWriteAt = self:Now()
    return true
end

function methods:StartupScrub()
    if self:Combat() then return false, "Binding probe requires leaving combat" end
    if self.quarantined then return false, self.status end
    local current = self:CurrentSet()
    if current == nil then return false, "Binding APIs unavailable" end
    self.bindingSet = current
    local changed = false
    self.mutating = true
    for _, key in ipairs(KEYS) do
        local action = self:GetAction(key)
        if action and parseAction(action) then
            local ok, cleared = pcall(self.api.SetBinding or function() return false end, key, nil)
            if not ok or not cleared or self:GetAction(key) ~= "" then
                self.mutating = nil
                return self:Quarantine("startup carrier scrub failed")
            end
            changed = true
        end
    end
    local saved = not changed or self:Save()
    self.mutating = nil
    if not saved then return self:Quarantine("startup carrier scrub save failed") end
    if changed then self.lastWriteAt = self:Now() end
    return true
end

function methods:RollbackClaim(key, action)
    if self:GetAction(key) ~= action then return self:Quarantine("reserved key changed during claim") end
    local ok, cleared = pcall(self.api.SetBinding or function() return false end, key, nil)
    if not ok or not cleared or self:GetAction(key) ~= "" or not self:Save() then
        return self:Quarantine("failed carrier claim could not be restored")
    end
    self.lastWriteAt = self:Now()
    return false, "Carrier frame was not persisted"
end

function methods:Claim(frame)
    if self:Combat() then return false, "Carrier paused in combat" end
    if self.quarantined then return false, self.status end
    if self.bindingSet == nil or self:CurrentSet() ~= self.bindingSet then return self:Quarantine("binding set changed") end
    local key
    for _, candidate in ipairs(KEYS) do if self:GetAction(candidate) == "" then key = candidate; break end end
    if not key then return false, "No reserved carrier key is unbound" end
    local action = actionFor(frame)
    if not action then return false, "Invalid carrier frame" end
    self.mutating = true
    local ok, set = pcall(self.api.SetBinding or function() return false end, key, action)
    if not ok or not set then self.mutating = nil; return false, "SetBinding rejected the carrier frame" end
    if self:GetAction(key) ~= action then self.mutating = nil; return self:Quarantine("carrier readback mismatch") end
    if not self:Save() then
        local restored, reason = self:RollbackClaim(key, action)
        self.mutating = nil
        return restored, reason
    end
    self.mutating = nil
    self.lastWriteAt = self:Now()
    self.outstanding = { key = key, action = action, seq = frame.seq, probe = self.active.probe == true }
    self.status = self.outstanding.probe and "Probe persisted; waiting for host" or "Carrier frame persisted"
    return true
end

function methods:Begin(kind, body, identity)
    if self.active or self.outstanding then return false, "Carrier busy" end
    local parts = chunks(body)
    if not parts then return false, "Carrier message exceeds frame budget" end
    self.active = { kind = kind, identity = identity, chunks = parts, part = 1, probe = kind == "probe" }
    return true
end

function methods:Probe(uiNonce)
    if not hex8(uiNonce) then return false, "Invalid UI probe nonce" end
    if self.outstanding or self.active then return false, "Carrier busy" end
    local ok, reason = self:StartupScrub()
    if not ok then return false, reason end
    self.enabled, self.epoch, self.nonce, self.uiNonce, self.nextSeq = false, nil, nil, uiNonce, 1
    return self:Begin("probe", PROBE, "probe:" .. uiNonce), reason
end

function methods:OfferInput(message)
    if not self.enabled or self.active or self.outstanding or type(message) ~= "table"
        or message.epoch ~= self.epoch or not integer(message.id, 1, 262143)
        or tabCodes[message.tab] == nil or actionCodes[message.action] == nil or type(message.text) ~= "string" then return false end
    local body = "I" .. u24(message.id) .. string.char(tabCodes[message.tab], actionCodes[message.action]) .. message.text
    if #body > 610 then return false end
    return self:Begin("input", body, "input:" .. message.epoch .. ":" .. message.id)
end

function methods:OfferContext(message)
    if not self.enabled or self.active or self.outstanding or type(message) ~= "table"
        or message.epoch ~= self.epoch or message.uiNonce ~= self.uiNonce or not integer(message.id, 1, 262143)
        or type(message.text) ~= "string" or #message.text > 580 then return false end
    return self:Begin("context", "C" .. u24(message.id) .. message.text,
        "context:" .. message.epoch .. ":" .. message.id)
end

function methods:Pump(slot)
    if self.quarantined or self.outstanding or not self.active then return false end
    if self:Combat() then self.status = "Carrier paused in combat"; return false end
    if self:Now() - self.lastWriteAt < 1 then return false end
    local active = self.active
    local frame = { epoch = active.probe and ZERO or self.epoch, nonce = active.probe and ZERO or self.nonce,
        uiNonce = self.uiNonce or active.identity:sub(-8), slot = slot, seq = self.nextSeq,
        part = active.part, count = #active.chunks, payload = active.chunks[active.part] }
    local claimed, reason = self:Claim(frame)
    -- A refused claim retries every tick; without this the reason is never visible in game.
    if not claimed and reason and not self.quarantined then self.status = reason end
    return claimed, reason
end

function methods:AcceptHost(result)
    if type(result) ~= "table" or result.bindingProtocol ~= 1 or not hex8(result.bindingNonce)
        or not integer(result.bindingAck, 0, MAX_SEQ) or not hex8(result.epoch) then return false end
    local outstanding = self.outstanding
    if not outstanding then
        if self.enabled and (result.epoch ~= self.epoch or result.bindingNonce ~= self.nonce) then
            self.enabled, self.active, self.status = false, nil, "Host changed; run /witch bindprobe"
        end
        return false
    end
    if not outstanding.probe and (result.epoch ~= self.epoch or result.bindingNonce ~= self.nonce) then
        local cleaned = self:ClearExact(outstanding.key, outstanding.action)
        if cleaned then
            self.outstanding, self.active, self.enabled = nil, nil, false
            self.status = "Host changed; run /witch bindprobe"
        end
        return false
    end
    if result.bindingAck < outstanding.seq then return false end
    if result.bindingAck > outstanding.seq then return self:Quarantine("carrier acknowledgement jumped") end
    local cleaned = self:ClearExact(outstanding.key, outstanding.action)
    if not cleaned then return false end
    self.outstanding = nil
    if outstanding.probe then
        self.epoch, self.nonce, self.enabled = result.epoch, result.bindingNonce, true
        self.nextSeq, self.active, self.status = result.bindingAck + 1, nil, "Carrier ready"
        return true, "probe"
    end
    self.nextSeq = outstanding.seq + 1
    self.active.part = self.active.part + 1
    if self.active.part > #self.active.chunks then self.active, self.status = nil, "Carrier ready" end
    return true, "frame"
end

function methods:OnBindingsChanged()
    if self.mutating or self.quarantined then return true end
    if self.bindingSet ~= nil and self:CurrentSet() ~= self.bindingSet then return self:Quarantine("binding set changed") end
    if self.outstanding and self:GetAction(self.outstanding.key) ~= self.outstanding.action then
        return self:Quarantine("reserved key ownership changed")
    end
    return true
end

function methods:Stop()
    if not self.outstanding then self.active, self.enabled = nil, false; return true end
    if self:Combat() then self.status = "Carrier cleanup deferred until reload"; return false end
    local ok = self:ClearExact(self.outstanding.key, self.outstanding.action)
    if ok then self.outstanding, self.active, self.enabled = nil, nil, false end
    return ok
end

function methods:Busy()
    return not self.quarantined and (self.active ~= nil or self.outstanding ~= nil)
end

function methods:Snapshot()
    return { status = self.status, enabled = self.enabled == true, quarantined = self.quarantined,
        seq = self.nextSeq, busy = self:Busy() }
end

Binding.Keys, Binding.ActionFor, Binding.ParseAction = KEYS, actionFor, parseAction
