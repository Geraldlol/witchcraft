-- Sequential, single-use addon slots. This module has no native API reads.
local _, ns = ...
local Ring = {}
ns.Ring = Ring
local methods = {}
methods.__index = methods

local function integer(value, low, high)
    return type(value) == "number" and value == math.floor(value) and value >= low and value <= high
end

local function plain(value)
    return type(value) == "table" and getmetatable(value) == nil
end

local function epoch(value)
    return type(value) == "string" and #value == 8 and value:match("^%x+$") ~= nil and value ~= "00000000"
end

local function array(value, limit)
    if not plain(value) then return false end
    local count = 0
    for key in pairs(value) do
        if not integer(key, 1, limit) then return false end
        count = count + 1
        if count > limit then return false end
    end
    for i = 1, count do if value[i] == nil then return false end end
    return true, count
end

-- An optional one-line label no longer than `limit` bytes.
local function shortText(text, limit)
    return text == nil or (type(text) == "string" and #text <= limit and not text:find("[%z\1-\31\127]"))
end

local function sessions(value, rows)
    local valid, count = array(value, 2)
    if not valid or count ~= 2 then return nil, "sessions" end
    local copied, seen = {}, {}
    for _, session in ipairs(value) do
        if not plain(session) or (session.id ~= "claude" and session.id ~= "codex") or seen[session.id] then
            return nil, "session identity"
        end
        if type(session.title) ~= "string" or #session.title > 80 or session.title:find("[%z\1-\31\127]") then
            return nil, "session title"
        end
        if type(session.status) ~= "string" or #session.status > 120 or session.status:find("[%z\1-\31\127]") then
            return nil, "session status"
        end
        local linesOK, lineCount = array(session.lines, rows)
        if not linesOK then return nil, "session lines" end
        local lines, total = {}, 0
        for i = 1, lineCount do
            local line = session.lines[i]
            if type(line) ~= "string" or #line > 8192 or line:find("[%z\1-\31\127]") then return nil, "line" end
            total = total + #line
            if total > 300000 then return nil, "screen size" end
            lines[i] = line
        end
        -- Scrollback rows above the viewport, oldest first. The field is optional so an
        -- older daemon's chunk still validates; it shares the per-session byte budget.
        local history = {}
        if session.history ~= nil then
            local historyOK, historyCount = array(session.history, 1000)
            if not historyOK then return nil, "history" end
            for i = 1, historyCount do
                local row = session.history[i]
                if type(row) ~= "string" or #row > 8192 or row:find("[%z\1-\31\127]") then return nil, "history" end
                total = total + #row
                if total > 300000 then return nil, "screen size" end
                history[i] = row
            end
        end
        -- Lines that have left the daemon's viewport since its session began. A reader parked in
        -- history anchors on this, so a malformed counter refuses the chunk rather than sliding it.
        if session.scrolled ~= nil and not integer(session.scrolled, 0, 2147483647) then return nil, "scrolled" end
        -- What the screen says the agent is doing, and the menu it is waiting on. Advisory:
        -- an unknown state or malformed menu is dropped, never refusing the screen.
        local state = (session.state == "working" or session.state == "waiting" or session.state == "idle") and session.state or nil
        local choices, raw = nil, session.choices
        if state == "waiting" and plain(raw) then
            local optionsOK, optionCount = array(raw.options, 9)
            if optionsOK and optionCount >= 2 and integer(raw.selected, 1, optionCount) then
                choices = { options = {}, selected = raw.selected }
                for i = 1, optionCount do
                    local label = raw.options[i]
                    if type(label) ~= "string" or #label > 240 or label:find("[%z\1-\31\127]") then choices = nil; break end
                    choices.options[i] = label
                end
            end
        end
        if state == "waiting" and not choices then state = nil end
        -- The model and context from the agent's own session files, and its last reply as lines.
        local info, rawInfo = nil, session.info
        if plain(rawInfo) and shortText(rawInfo.model, 64) and shortText(rawInfo.effort, 16)
            and (rawInfo.used == nil or integer(rawInfo.used, 0, 1e10)) and (rawInfo.window == nil or integer(rawInfo.window, 1, 1e10)) then
            info = { model = rawInfo.model, effort = rawInfo.effort, used = rawInfo.used, window = rawInfo.window }
        end
        local reply
        local replyOK, replyCount = array(session.reply, 200)
        if replyOK and replyCount > 0 then
            reply = {}
            for i = 1, replyCount do
                local line = session.reply[i]
                if type(line) ~= "string" or #line > 1600 or line:find("[%z\1-\31\127]") then reply = nil; break end
                reply[i] = line
            end
        end
        -- tools is false only for a joined session whose own WoW MCP server never announced itself;
        -- any other value claims nothing. (`x and false or nil` would always give nil.)
        local tools
        if session.tools == false then tools = false end
        copied[#copied + 1] = { id = session.id, title = session.title, status = session.status,
            lines = lines, history = history, scrolled = session.scrolled or 0,
            state = state, choices = choices, info = info, reply = reply, tools = tools }
        seen[session.id] = true
    end
    if copied[1].id ~= "claude" then copied[1], copied[2] = copied[2], copied[1] end
    return copied
end

Ring.Integer, Ring.Epoch, Ring.Plain, Ring.Array, Ring.Sessions = integer, epoch, plain, array, sessions

function Ring.New(options)
    options = options or {}
    return setmetatable({
        nextSeq = 1, ringSize = integer(options.ringSize, 1, 9999) and options.ringSize or 3000,
        baseDelay = 1, delay = 1, status = "Waiting for host", ack = 0, retired = {}, retiredCount = 0,
        epoch = epoch(options.epoch) and options.epoch:lower() or nil, accepted = 0,
        uiNonce = options.uiNonce, contextAck = 0, bindingAck = 0,
    }, methods):SetHz(options.hz or 1)
end

function methods:SetHz(hz)
    if type(hz) ~= "number" or hz ~= hz or hz < 0.125 or hz > 2 then return nil, "Rate must be 0.125 to 2 Hz" end
    self.baseDelay = 1 / hz
    self.delay = self.baseDelay
    return self
end

function methods:Next()
    if self:Exhausted() then return nil end
    return self.nextSeq, string.format("Witchcraft_Chunk_%04d", self.nextSeq)
end

function methods:Exhausted() return self.nextSeq > self.ringSize end

function methods:Reject(reason)
    self.status, self.delay = "Rejected chunk: " .. reason, 8
    return { accepted = false, reason = reason, delay = self.delay, changed = false }
end

function methods:OnChunk(payload)
    if not plain(payload) or payload.protocol ~= 1 then return self:Reject("protocol") end
    if not integer(payload.seq, 1, 9999) or payload.seq ~= self.nextSeq then return self:Reject("sequence") end
    if not integer(payload.ringSize, payload.seq, 9999) then return self:Reject("ring size") end
    if payload.ready == false then
        self.ringSize, self.nextSeq = payload.ringSize, self.nextSeq + 1
        self.status, self.delay = "Waiting for host", 8
        return { accepted = true, placeholder = true, changed = false, delay = 8 }
    end
    if payload.ready ~= true or not epoch(payload.epoch) or type(payload.changed) ~= "boolean" then
        return self:Reject("host envelope")
    end
    if not epoch(payload.uiNonce) or payload.uiNonce:lower() ~= self.uiNonce then return self:Reject("previous UI session") end
    if not integer(payload.ack, 0, 262143) or not integer(payload.cols, 1, 160) or not integer(payload.rows, 1, 60) then
        return self:Reject("dimensions or acknowledgement")
    end
    -- Protocol 4 carries contextWant plus the mask of domains it asks for (1 player, 2 quests,
    -- 4 progress, 8 errors): context is captured on demand, never on a timer. The four fields
    -- are validated as one unit. A whole protocol 2 or 3 extension is still a valid envelope;
    -- the controller reports it as unsupported rather than losing the terminals to an older daemon.
    if payload.contextProtocol ~= nil or payload.contextAck ~= nil or payload.contextWant ~= nil
        or payload.contextWantMask ~= nil then
        local ackOK = integer(payload.contextAck, 0, 262143) and integer(payload.contextWant, 0, 262143)
        local legacy = ackOK and ((payload.contextProtocol == 2 and payload.contextWantMask == nil)
            or (payload.contextProtocol == 3 and integer(payload.contextWantMask, 0, 7)))
        if not legacy and (payload.contextProtocol ~= 4 or not ackOK or not integer(payload.contextWantMask, 0, 15)) then
            return self:Reject("context extension")
        end
    end
    if payload.bindingProtocol ~= nil or payload.bindingNonce ~= nil or payload.bindingAck ~= nil then
        if payload.bindingProtocol ~= 1 or not epoch(payload.bindingNonce)
            or not integer(payload.bindingAck, 0, 16777215) then return self:Reject("binding extension") end
    end
    if payload.cooldownProtocol ~= nil or payload.cooldownNonce ~= nil
        or payload.cooldownAck ~= nil or payload.cooldownChecksum ~= nil then
        if payload.cooldownProtocol ~= 2 or not epoch(payload.cooldownNonce)
            or not integer(payload.cooldownAck, 0, 16777215)
            or not integer(payload.cooldownChecksum, 0, 4294967295) then
            return self:Reject("cooldown extension")
        end
    end
    local incomingEpoch = payload.epoch:lower()
    if self.retired[incomingEpoch] then return self:Reject("retired host") end
    if incomingEpoch == self.epoch and payload.ack < self.ack then return self:Reject("acknowledgement regression") end
    if incomingEpoch == self.epoch and payload.contextProtocol == 4 and payload.contextAck < self.contextAck then
        return self:Reject("context acknowledgement regression")
    end
    if incomingEpoch == self.epoch and payload.bindingProtocol == 1 and payload.bindingNonce == self.bindingNonce
        and payload.bindingAck < self.bindingAck then return self:Reject("binding acknowledgement regression") end
    local copied, reason = sessions(payload.sessions, payload.rows)
    if not copied then return self:Reject(reason) end
    local newEpoch = self.epoch ~= incomingEpoch
    if newEpoch and self.epoch and self.retiredCount >= 64 then return self:Reject("host restart limit; reload manually") end
    if newEpoch and self.epoch then
        self.retired[self.epoch], self.retiredCount = true, self.retiredCount + 1
    end
    self.epoch, self.ack = incomingEpoch, payload.ack
    self.contextProtocol = payload.contextProtocol
    local negotiated = payload.contextProtocol == 4
    self.contextAck = negotiated and payload.contextAck or (newEpoch and 0 or self.contextAck)
    self.contextWant = negotiated and payload.contextWant or (newEpoch and 0 or self.contextWant)
    self.contextWantMask = negotiated and payload.contextWantMask or (newEpoch and 0 or self.contextWantMask)
    local newBindingSession = newEpoch or self.bindingNonce ~= payload.bindingNonce
    self.bindingProtocol, self.bindingNonce = payload.bindingProtocol, payload.bindingNonce
    self.bindingAck = payload.bindingAck or (newBindingSession and 0 or self.bindingAck)
    self.ringSize, self.nextSeq, self.accepted = payload.ringSize, self.nextSeq + 1, self.accepted + 1
    self.delay = (payload.changed or newEpoch) and self.baseDelay or math.min(8, self.delay * 2)
    self.status = "Connected"
    return {
        accepted = true, changed = payload.changed, delay = self.delay, newEpoch = newEpoch,
        epoch = incomingEpoch, ack = payload.ack, cols = payload.cols, rows = payload.rows, sessions = copied,
        contextProtocol = payload.contextProtocol, contextAck = payload.contextAck, contextWant = payload.contextWant,
        contextWantMask = payload.contextWantMask,
        bindingProtocol = payload.bindingProtocol, bindingNonce = payload.bindingNonce, bindingAck = payload.bindingAck,
        cooldownProtocol = payload.cooldownProtocol, cooldownNonce = payload.cooldownNonce,
        cooldownAck = payload.cooldownAck, cooldownChecksum = payload.cooldownChecksum,
    }
end

-- A successfully loaded file is spent even if it never called our receiver, or
-- called it with an invalid envelope. Failed/missing loads stay at the same slot.
function methods:Consumed(seq, loaded)
    if seq ~= self.nextSeq then return end
    self.delay = 8
    if loaded then
        self.nextSeq = self.nextSeq + 1
        self.status = "Empty or invalid chunk"
    else
        self.status = "Chunk unavailable; run witchcraft init and restart client"
    end
end

function methods:Snapshot()
    return { nextSeq = self.nextSeq, seq = self.nextSeq - 1, ringSize = self.ringSize, epoch = self.epoch,
        delay = self.delay, ack = self.ack, status = self.status, accepted = self.accepted, exhausted = self:Exhausted(),
        bindingProtocol = self.bindingProtocol, bindingNonce = self.bindingNonce, bindingAck = self.bindingAck }
end
