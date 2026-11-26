-- Stop-and-wait host carrier over Logs/General.log. Each frame is one C_Log line, followed in the same
-- script run by padding that fills the client's log buffer, so the frame reaches the disk at once.
-- Nothing here touches key bindings or protected state, so it carries in combat.
-- luacheck: read globals C_Log
local _, ns = ...
local Binding = ns.Binding
local LogCarrier = {}
ns.LogCarrier = LogCarrier
local methods = {}
methods.__index = methods

local ZERO, PROBE, MAX_SEQ = Binding.ZERO, Binding.PROBE, Binding.MAX_SEQ
local integer, hex8, u24, crc32, base32 = Binding.Integer, Binding.Hex8, Binding.U24, Binding.Crc32, Binding.Base32
local tabCodes, actionCodes = Binding.TabCodes, Binding.ActionCodes
local MAX_BODY, PAD_LINES, RESEND_FIRST, RESEND_CEILING = 610, 25, 5, 60
-- About 100,000 bytes after a frame line push the client's ~96 KiB log buffer out.
local PAD = "WCLP" .. string.rep("0", 3996)
local UNAVAILABLE = "Log carrier unavailable on this client"
-- A new host epoch is probed again by the controller; a lane lost within the same epoch is not.
local HOST_CHANGED, LANE_LOST = "Host changed; waiting for a new probe", "Host changed; /reload to probe again"

-- The one sequence-0 frame is a heartbeat: a session's ids and a body of "H" and a flags byte of 0..3.
local function heartbeatShape(frame)
    return frame.seq == 0 and frame.epoch ~= ZERO and type(frame.payload) == "string" and #frame.payload == 2
        and frame.payload:sub(1, 1) == "H" and frame.payload:byte(2) <= 3
end

-- WCL1_<epoch>_<nonce>_<ui>_<slot>_<seq>_<base32 payload>_<crc32 of everything before it>, or nil.
local function frameText(frame)
    if type(frame) ~= "table" or not hex8(frame.epoch, frame.epoch == ZERO) or not hex8(frame.nonce, frame.nonce == ZERO)
        or (frame.epoch == ZERO) ~= (frame.nonce == ZERO) or not hex8(frame.uiNonce)
        or not integer(frame.slot, 1, 9999) or not integer(frame.seq, heartbeatShape(frame) and 0 or 1, MAX_SEQ)
        or type(frame.payload) ~= "string" or #frame.payload < 1 or #frame.payload > MAX_BODY then return nil end
    local core = string.format("WCL1_%s_%s_%s_%04X_%06X_%s", frame.epoch:upper(), frame.nonce:upper(),
        frame.uiNonce:upper(), frame.slot, frame.seq, base32(frame.payload))
    return string.format("%s_%08X", core, crc32(core))
end

LogCarrier.FrameText, LogCarrier.PAD, LogCarrier.PAD_LINES = frameText, PAD, PAD_LINES

function LogCarrier.NativeAPI()
    return { LogMessage = C_Log and C_Log.LogMessage, InCombatLockdown = InCombatLockdown, Now = GetTime }
end

function LogCarrier.New(api)
    return setmetatable({ api = api or LogCarrier.NativeAPI(), nextSeq = 1, status = "Probe not run",
        lastWriteAt = -1000000000, combatSafe = true }, methods)
end

function methods:Now()
    local ok, value = pcall(self.api.Now or self.api.GetTime or function() return 0 end)
    return ok and type(value) == "number" and value == value and value or 0
end

-- Kept for Core's use; nothing in this carrier waits for combat to end.
function methods:Combat()
    local ok, value = pcall(self.api.InCombatLockdown or function() return false end)
    return not ok or value == true
end

function methods:Quarantine(reason)
    self.heartbeat = nil
    self.enabled, self.active, self.quarantined = false, nil, reason or "carrier ownership changed"
    self.status = "Quarantined: " .. self.quarantined
    return false, self.status
end

-- Logs one frame line and its padding in this script run. Returns the line, or false and the reason.
-- A frame line logged before its padding failed is still logged (it may reach the disk later), so it
-- comes back as the line and the reason.
function methods:Write(frame)
    local line = frameText(frame)
    if not line then return false, "Invalid carrier frame" end
    local log = self.api.LogMessage
    if type(log) ~= "function" then return false, UNAVAILABLE end
    if not pcall(log, line) then return false, UNAVAILABLE end
    self.lastWriteAt = self:Now()
    local padded = pcall(function()
        for _ = 1, PAD_LINES do log(PAD) end
    end)
    if not padded then return line, UNAVAILABLE end
    return line
end

-- A heartbeat (sequence 0) names only the ring slot this UI session wants next. The host never
-- acknowledges it, and a logged line needs no cleanup.
function methods:Heartbeat(slot, flags)
    if self.quarantined then return false, self.status end
    if not self.enabled or not self.epoch or not self.nonce then return false, "carrier has no host session" end
    if self.outstanding then return false, "waiting for host acknowledgement" end
    if self.active then return false, "carrier has data to send" end
    if self:Now() - self.lastWriteAt < 1 then return false, "carrier rate limit" end
    if not integer(slot, 1, 9999) or not integer(flags, 0, 3) then return false, "Invalid carrier frame" end
    local beat = self.heartbeat
    if beat and beat.slot == slot and beat.flags == flags then return false, "heartbeat unchanged" end
    local line, reason = self:Write({ epoch = self.epoch, nonce = self.nonce, uiNonce = self.uiNonce, slot = slot,
        seq = 0, payload = "H" .. string.char(flags) })
    -- A third value tells the controller the write itself failed, unlike the refusals above. A heartbeat
    -- whose padding failed is not recorded, so it is offered again; a repeated heartbeat is harmless.
    if not line or reason then self.status = reason; return false, reason, true end
    if self.status == UNAVAILABLE then self.status = "Carrier ready" end
    self.heartbeat = { slot = slot, flags = flags }
    return true
end

function methods:ClearHeartbeat()
    self.heartbeat = nil
    return true
end

function methods:Begin(kind, body, identity)
    if self.active or self.outstanding then return false, "Carrier busy" end
    if type(body) ~= "string" or #body < 1 or #body > MAX_BODY then return false, "Carrier message exceeds frame budget" end
    self.active = { kind = kind, identity = identity, body = body, probe = kind == "probe" }
    return true
end

function methods:Probe(uiNonce)
    if not hex8(uiNonce) then return false, "Invalid UI probe nonce" end
    if self.outstanding or self.active then return false, "Carrier busy" end
    -- The host takes one probe per session; a second would restart the sequence it has already consumed.
    if self.probed then return false, "Log carrier was already probed in this host session; /reload to probe again" end
    if self.quarantined then return false, self.status end
    if type(self.api.LogMessage) ~= "function" then self.status = UNAVAILABLE; return false, UNAVAILABLE end
    self.enabled, self.epoch, self.nonce, self.uiNonce, self.nextSeq = false, nil, nil, uiNonce, 1
    self.contextBlocked, self.inputBlocked, self.heartbeat = nil, nil, nil
    return self:Begin("probe", PROBE, "probe:" .. uiNonce)
end

function methods:OfferInput(message)
    if not self.enabled or self.active or self.outstanding or type(message) ~= "table"
        or message.epoch ~= self.epoch or not integer(message.id, 1, 262143)
        or tabCodes[message.tab] == nil or actionCodes[message.action] == nil or type(message.text) ~= "string" then return false end
    local body = "I" .. u24(message.id) .. string.char(tabCodes[message.tab], actionCodes[message.action]) .. message.text
    if #body > MAX_BODY then return false end
    return self:Begin("input", body, "input:" .. message.epoch .. ":" .. message.id)
end

function methods:OfferContext(message)
    if not self.enabled or self.active or self.outstanding or type(message) ~= "table"
        or message.epoch ~= self.epoch or message.uiNonce ~= self.uiNonce or not integer(message.id, 1, 262143)
        or type(message.text) ~= "string" or #message.text > 580 then return false end
    return self:Begin("context", "C" .. u24(message.id) .. message.text,
        "context:" .. message.epoch .. ":" .. message.id)
end

-- Drops a buffered item whose message the controller no longer queues. A logged data frame is never
-- released before its acknowledgement, since the host may already have consumed its sequence: the item
-- is marked and AcceptHost ends it. A logged probe or an unlogged item is dropped at once.
function methods:Cancel(identity)
    if not self.active or self.active.identity ~= identity then return false end
    if self.outstanding and not self.outstanding.probe then
        self.active.abandoned, self.status = true, "Carrier waiting for host acknowledgement"
        return false
    end
    self.outstanding, self.active, self.status = nil, nil, "Carrier ready"
    return true
end

-- Logs the active item once, then logs the same frame again, naming the slot passed in, while no
-- acknowledgement has come: after 5 s, then at doubling intervals up to 60 s. Only a first send
-- returns true; sentAt keeps its time, so the controller's acknowledgement timeout still applies.
function methods:Pump(slot)
    if self.quarantined or not self.active then return false end
    local now, sent = self:Now(), self.outstanding
    if sent then
        if now < sent.resendAt then return false end
        local line, reason = self:Write({ epoch = sent.epoch, nonce = sent.nonce, uiNonce = sent.uiNonce, slot = slot,
            seq = sent.seq, payload = sent.payload })
        sent.resendDelay = math.min(sent.resendDelay * 2, RESEND_CEILING)
        sent.resendAt = now + sent.resendDelay
        if not line or reason then self.status = reason end
        return false
    end
    if now - self.lastWriteAt < 1 then return false end
    local active = self.active
    local frame = { epoch = active.probe and ZERO or self.epoch, nonce = active.probe and ZERO or self.nonce,
        uiNonce = self.uiNonce or active.identity:sub(-8), slot = slot, seq = self.nextSeq, payload = active.body }
    local line, reason = self:Write(frame)
    -- A refused write retries every tick; without this the reason is never visible in game.
    if not line then self.status = reason; return false, reason end
    self.outstanding = { seq = frame.seq, probe = active.probe == true, sentAt = now, epoch = frame.epoch,
        nonce = frame.nonce, uiNonce = frame.uiNonce, payload = frame.payload,
        resendDelay = RESEND_FIRST, resendAt = now + RESEND_FIRST }
    self.heartbeat = nil
    -- A frame line whose padding failed is logged all the same; the re-log schedule delivers it later.
    self.status = reason or (self.outstanding.probe and "Probe logged; waiting for host" or "Carrier frame logged")
    -- From here the host may read the probe, whether or not its acknowledgement is ever processed.
    if self.outstanding.probe then self.probed = true end
    return true
end

-- While the controller loads no chunk no acknowledgement can come, so the outstanding frame (data or
-- probe) is not logged again before RESEND_FIRST seconds from now. resendDelay keeps its value.
function methods:HoldResend()
    local sent = self.outstanding
    if not sent then return false end
    sent.resendAt = math.max(sent.resendAt, self:Now() + RESEND_FIRST)
    return true
end

-- Remembers the host session the last result named. A new one forgets the logged probe, unless that
-- probe is still waiting, where the new host can read it.
function methods:TrackHost(epoch, nonce)
    local changed = (self.hostEpoch ~= nil and epoch ~= self.hostEpoch)
        or (nonce ~= nil and self.hostNonce ~= nil and nonce ~= self.hostNonce)
    self.hostEpoch, self.hostNonce = epoch, nonce or (not changed and self.hostNonce or nil)
    if changed and not (self.outstanding and self.outstanding.probe) then self.probed = nil end
end

function methods:AcceptHost(result)
    if type(result) ~= "table" or not hex8(result.epoch) then return false end
    -- A host that leaves the log fields out still names its epoch, which is enough to see it change.
    local speaks = result.logProtocol == 1 and hex8(result.logNonce) and integer(result.logAck, 0, MAX_SEQ)
    -- A result naming another UI session carries that session's acknowledgement, not this one's.
    local mine = result.logUi == nil or result.logUi == self.uiNonce
    self:TrackHost(result.epoch, speaks and result.logNonce or nil)
    local other = result.epoch ~= self.epoch or (speaks and (result.logNonce ~= self.nonce or not mine))
    local lost = result.epoch ~= self.epoch and HOST_CHANGED or LANE_LOST
    local outstanding = self.outstanding
    if not outstanding then
        if self.enabled and other then
            self.enabled, self.active, self.heartbeat, self.status = false, nil, nil, lost
        end
        return false
    end
    if not outstanding.probe and other then
        -- The old host's carrier ends at once; a logged line needs no cleanup.
        self.enabled, self.outstanding, self.active, self.heartbeat, self.status = false, nil, nil, nil, lost
        return false
    end
    if not speaks then return false end
    -- Only a probe gets here with another UI session named: the host has not taken it yet.
    if not mine then return false end
    if result.logAck < outstanding.seq then return false end
    if result.logAck > outstanding.seq then return self:Quarantine("carrier acknowledgement jumped") end
    self.outstanding, self.contextBlocked, self.inputBlocked = nil, nil, nil
    if self.quarantined or not self.active then return false end
    if outstanding.probe then
        self.epoch, self.nonce, self.enabled = result.epoch, result.logNonce, true
        self.nextSeq, self.active, self.status = result.logAck + 1, nil, "Carrier ready"
        return true, "probe"
    end
    -- One message is one frame, so an acknowledged frame ends its item, cancelled or not.
    self.nextSeq, self.active, self.status = outstanding.seq + 1, nil, "Carrier ready"
    return true, "frame"
end

function methods:OnBindingsChanged() return true end

function methods:Stop()
    self.heartbeat, self.active, self.outstanding, self.enabled = nil, nil, nil, false
    return true
end

function methods:Busy()
    return not self.quarantined and (self.active ~= nil or self.outstanding ~= nil)
end

function methods:Snapshot()
    return { status = self.status, enabled = self.enabled == true, quarantined = self.quarantined,
        seq = self.nextSeq, busy = self:Busy(), heartbeatSlot = self.heartbeat and self.heartbeat.slot or nil }
end
