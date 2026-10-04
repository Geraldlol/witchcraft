-- Stop-and-wait outbound carrier over the client-owned Cooldown Viewer layout
-- cache. The carrier only changes decoded top-level field 127 and preserves
-- fields 1-4. It has no file, network, targeting, or protected-action API.
local addonName, ns = ...
local Cooldown = {}
ns.CooldownCarrier = Cooldown
local methods = {}
methods.__index = methods

local PROTOCOL, LAYOUT_ENCODING, CURRENT_LAYOUT_VERSION = 2, 1, 5
local MAX_SEQ, MAX_PAYLOAD, MAX_PARTS, MAX_MESSAGE = 16777215, 512, 16, 8192
local MAX_SLOT, HEADER = 9999, 28 -- bytes before the payload; the CRC-32 follows the payload
local MAX_FILE, MAX_COMPRESSED, MAX_CBOR = 131072, 98304, 65536
local MAX_NODES, MAX_DEPTH, MAX_COLLECTION, MAX_QUEUE = 20000, 16, 10000, 8
local WRITE_INTERVAL, ACK_TIMEOUT = 1, 30
local ZERO = "00000000"
local kindCodes, codeKinds = { context = 1, heartbeat = 2 }, { [1] = "context", [2] = "heartbeat" }

local function integer(value, low, high)
    return type(value) == "number" and value == math.floor(value) and value >= low and value <= high
end

local function hexField(value, allowZero)
    return type(value) == "string" and #value == 8 and (allowZero or value ~= ZERO)
        and value:match("^[0-9a-f]+$") ~= nil
end

local function hex8(value)
    return hexField(value, false)
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

local function u16(value)
    return string.char(math.floor(value / 256), value % 256)
end

local function u24(value)
    return string.char(math.floor(value / 65536), math.floor(value / 256) % 256, value % 256)
end

local function u32(value)
    return u16(math.floor(value / 65536)) .. u16(value % 65536)
end

local function read16(value, offset)
    local a, b = value:byte(offset, offset + 1)
    return a and b and a * 256 + b or nil
end

local function read24(value, offset)
    local a, b, c = value:byte(offset, offset + 2)
    return a and b and c and a * 65536 + b * 256 + c or nil
end

local function read32(value, offset)
    local high, low = read16(value, offset), read16(value, offset + 2)
    return high and low and high * 65536 + low or nil
end

local function fromHex(value)
    if not hexField(value, true) then return nil end
    local output = {}
    for index = 1, 8, 2 do output[#output + 1] = string.char(tonumber(value:sub(index, index + 1), 16)) end
    return table.concat(output)
end

local function toHex(value)
    return (value:gsub(".", function(byte) return string.format("%02x", byte:byte()) end))
end

-- Protocol 2: FC, protocol, kind, epoch, nonce, uiNonce, seq (3), message (3), part, count,
-- slot (2), payload length (2), payload, CRC-32 over everything before it. Every frame
-- advertises demand through slot, the addon's next ring sequence number. A heartbeat is
-- one byte of flags with message 0, and only a heartbeat may carry zero session ids: that
-- is the bootstrap before the addon has a host session. Data frames carry the real ids.
local function frameFor(frame)
    local kind = kindCodes[frame.kind]
    local heartbeat = frame.kind == "heartbeat"
    local zeroIds = frame.epoch == ZERO and frame.nonce == ZERO
    if not kind or not hexField(frame.epoch, heartbeat) or not hexField(frame.nonce, heartbeat)
        or (frame.epoch == ZERO) ~= (frame.nonce == ZERO) or not hex8(frame.uiNonce)
        or not integer(frame.seq, 1, MAX_SEQ) or not integer(frame.slot, 1, MAX_SLOT)
        or not integer(frame.part, 1, MAX_PARTS) or not integer(frame.count, frame.part, MAX_PARTS)
        or type(frame.payload) ~= "string" or #frame.payload < 1 or #frame.payload > MAX_PAYLOAD
        or (frame.part < frame.count and #frame.payload ~= MAX_PAYLOAD) then return nil end
    if heartbeat then
        if frame.message ~= 0 or frame.part ~= 1 or frame.count ~= 1 or #frame.payload ~= 1 then return nil end
    elseif zeroIds or not integer(frame.message, 1, MAX_SEQ) then return nil end
    local body = "FC" .. string.char(PROTOCOL, kind) .. fromHex(frame.epoch) .. fromHex(frame.nonce)
        .. fromHex(frame.uiNonce) .. u24(frame.seq) .. u24(frame.message)
        .. string.char(frame.part, frame.count) .. u16(frame.slot) .. u16(#frame.payload) .. frame.payload
    return body .. u32(crc32(body))
end

-- Cleanup has to recognise a frame this addon wrote under any protocol it has ever used: a
-- version change is exactly when a leftover is found, and the current parser refuses an older one
-- by design. The marker plus a checksum over the body identify ours without reading its contents.
-- This never admits data; only parseFrame does that.
local function ourFrame(wire)
    return type(wire) == "string" and #wire >= 8 and #wire <= HEADER + MAX_PAYLOAD + 4
        and wire:sub(1, 2) == "FC" and crc32(wire:sub(1, -5)) == read32(wire, #wire - 3)
end

local function parseFrame(wire)
    if type(wire) ~= "string" or #wire < HEADER + 5 or #wire > HEADER + MAX_PAYLOAD + 4 or wire:sub(1, 2) ~= "FC"
        or wire:byte(3) ~= PROTOCOL or crc32(wire:sub(1, -5)) ~= read32(wire, #wire - 3) then return nil end
    local length = read16(wire, 27)
    if not length or #wire ~= HEADER + 4 + length then return nil end
    local kind = codeKinds[wire:byte(4)]
    local frame = { epoch = toHex(wire:sub(5, 8)), nonce = toHex(wire:sub(9, 12)),
        uiNonce = toHex(wire:sub(13, 16)), seq = read24(wire, 17), message = read24(wire, 20),
        part = wire:byte(23), count = wire:byte(24), slot = read16(wire, 25), kind = kind,
        payload = wire:sub(HEADER + 1, HEADER + length) }
    return frameFor(frame) == wire and frame or nil
end

local function accessible(api, value)
    if type(api.Accessible) ~= "function" then return false end
    local ok, result = pcall(api.Accessible, value)
    return ok and result == true
end

local function validateValue(api, value, state, depth)
    state.nodes = state.nodes + 1
    if state.nodes > MAX_NODES or depth > MAX_DEPTH or not accessible(api, value) then return false end
    local kind = type(value)
    if kind == "nil" or kind == "boolean" then return true end
    if kind == "number" then return value == value and value ~= math.huge and value ~= -math.huge end
    if kind == "string" then
        state.bytes = state.bytes + #value
        return #value <= MAX_CBOR and state.bytes <= MAX_CBOR
    end
    if kind ~= "table" or getmetatable(value) ~= nil or state.seen[value] then return false end
    state.seen[value] = true
    local count = 0
    for key, child in pairs(value) do
        count = count + 1
        if count > MAX_COLLECTION or (type(key) ~= "string" and type(key) ~= "number")
            or (type(key) == "number" and (key ~= key or key == math.huge or key == -math.huge))
            or not validateValue(api, key, state, depth + 1)
            or not validateValue(api, child, state, depth + 1) then state.seen[value] = nil return false end
    end
    state.seen[value] = nil
    return true
end

local function validRoot(api, data)
    if type(data) ~= "table" or getmetatable(data) ~= nil
        or not integer(data[1], 1, CURRENT_LAYOUT_VERSION)
        or (data[2] ~= nil and type(data[2]) ~= "table")
        or (data[3] ~= nil and type(data[3]) ~= "table")
        or (data[4] ~= nil and type(data[4]) ~= "table")
        or (data[127] ~= nil and type(data[127]) ~= "string") then return false end
    for key in pairs(data) do
        if key ~= 1 and key ~= 2 and key ~= 3 and key ~= 4 and key ~= 127 then return false end
    end
    return validateValue(api, data, { nodes = 0, bytes = 0, seen = {} }, 0)
end

local function equalValue(left, right, seen)
    if type(left) ~= type(right) then return false end
    if type(left) ~= "table" then return left == right end
    seen = seen or {}
    if seen[left] then return seen[left] == right end
    seen[left] = right
    for key, value in pairs(left) do if not equalValue(value, right[key], seen) then return false end end
    for key in pairs(right) do if left[key] == nil then return false end end
    return true
end

local function cloneValue(value, seen)
    if type(value) ~= "table" then return value end
    seen = seen or {}
    if seen[value] then return nil end
    local output = {}
    seen[value] = output
    for key, child in pairs(value) do
        local keyCopy, childCopy = cloneValue(key, seen), cloneValue(child, seen)
        if keyCopy == nil or childCopy == nil then return nil end
        output[keyCopy] = childCopy
    end
    return output
end

local function sameLayout(left, right)
    for field = 1, 4 do if not equalValue(left[field], right[field]) then return false end end
    return true
end

local function emptyLayout()
    return { [1] = CURRENT_LAYOUT_VERSION, [2] = {}, [3] = {}, [4] = {} }
end

local function decodeLayout(api, raw)
    if type(raw) ~= "string" or not accessible(api, raw) or #raw > MAX_FILE then return nil, nil, "layout envelope" end
    if raw == "" then return emptyLayout(), true end
    if raw:sub(1, 2) ~= tostring(LAYOUT_ENCODING) .. "|" or raw:find("|", 3, true)
        or not raw:sub(3):match("^[A-Za-z0-9+/]+=?=?$") or #raw:sub(3) % 4 ~= 0 then
        return nil, nil, "layout envelope"
    end
    local ok, compressed = pcall(api.DecodeBase64, raw:sub(3))
    if not ok or type(compressed) ~= "string" or not accessible(api, compressed) or #compressed < 1
        or #compressed > MAX_COMPRESSED then return nil, nil, "layout base64" end
    local canonicalOk, canonical = pcall(api.EncodeBase64, compressed)
    if not canonicalOk or canonical ~= raw:sub(3) then return nil, nil, "noncanonical layout base64" end
    local inflatedOk, inflated = pcall(api.Decompress, compressed)
    if not inflatedOk or type(inflated) ~= "string" or not accessible(api, inflated)
        or #inflated > MAX_CBOR then return nil, nil, "layout deflate" end
    local dataOk, data = pcall(api.DeserializeCBOR, inflated)
    if not dataOk or not validRoot(api, data) then return nil, nil, "layout cbor" end
    return data, false
end

local function encodeLayout(api, data)
    if not validRoot(api, data) then return nil, "layout shape" end
    local function once()
        local cbor = api.SerializeCBOR(data)
        if type(cbor) ~= "string" or not accessible(api, cbor) or #cbor > MAX_CBOR then error("cbor") end
        local compressed = api.Compress(cbor)
        if type(compressed) ~= "string" or not accessible(api, compressed) or #compressed > MAX_COMPRESSED then error("deflate") end
        local encoded = api.EncodeBase64(compressed)
        if type(encoded) ~= "string" or not accessible(api, encoded) then error("base64") end
        local output = tostring(LAYOUT_ENCODING) .. "|" .. encoded
        if #output > MAX_FILE then error("file") end
        return output
    end
    local firstOk, first = pcall(once)
    local secondOk, second = pcall(once)
    if not firstOk or not secondOk or first ~= second then return nil, "nondeterministic codec" end
    local decoded = decodeLayout(api, first)
    if not decoded or not sameLayout(decoded, data) or decoded[127] ~= data[127] then return nil, "codec round trip" end
    return first
end

function Cooldown.NativeAPI()
    local encoding, viewer = C_EncodingUtil, C_CooldownViewer
    local compression = Enum and Enum.CompressionMethod and Enum.CompressionMethod.Deflate
    return {
        Now = GetTimePreciseSec or GetTime,
        Build = GetBuildInfo,
        Combat = InCombatLockdown,
        Insecure = function() return type(issecure) == "function" and issecure() == false end,
        SurfaceUntainted = function()
            if type(issecurevariable) ~= "function" then return false end
            return issecurevariable(viewer, "GetLayoutData") and issecurevariable(viewer, "SetLayoutData")
                and issecurevariable(encoding, "SerializeCBOR") and issecurevariable(encoding, "DeserializeCBOR")
        end,
        Accessible = function(value)
            if type(issecretvalue) == "function" and issecretvalue(value) then return false end
            return type(canaccessvalue) ~= "function" or canaccessvalue(value)
        end,
        Security = function() return C_AddOns.GetAddOnSecurity(addonName) end,
        GetLayoutData = viewer.GetLayoutData,
        SetLayoutData = viewer.SetLayoutData,
        EncodeBase64 = encoding.EncodeBase64,
        DecodeBase64 = encoding.DecodeBase64,
        SerializeCBOR = encoding.SerializeCBOR,
        DeserializeCBOR = encoding.DeserializeCBOR,
        Compress = function(value) return encoding.CompressString(value, compression) end,
        Decompress = function(value) return encoding.DecompressString(value, compression) end,
        Deflate = compression,
    }
end

function Cooldown.New(api)
    return setmetatable({ api = api or Cooldown.NativeAPI(), status = "stopped", nextSeq = 1,
        nextMessage = 1, queue = {}, queuedBytes = 0, lastWriteAt = -1000000000 }, methods)
end

function methods:Now()
    local ok, value = pcall(self.api.Now or function() return 0 end)
    return ok and type(value) == "number" and value == value and value or 0
end

-- Quarantine is otherwise terminal: Start accepts only a stopped or restored carrier, so
-- without this a single ownership loss would silence the transport for the whole session.
function methods:Reset()
    if self.outstanding then return false, "carrier still owns a frame" end
    self.quarantined, self.status = nil, "stopped"
    self.queue, self.queuedBytes, self.active = {}, 0, nil
    -- Sequence and message numbers belong to the host session, not to this object's life:
    -- the host keeps counting across a restart, so rewinding here would strand every later frame.
    return true
end

-- Diagnostics: the controller may attach a trace; the carrier never depends on it.
function methods:Note(text)
    if type(self.onTrace) == "function" then pcall(self.onTrace, text) end
end

function methods:Quarantine(reason)
    self.quarantined, self.status = reason or "carrier ownership changed", "quarantined"
    self:Note("quarantine: " .. self.quarantined)
    return false, self.quarantined
end

function methods:Gate()
    local api = self.api
    if type(api.Build) ~= "function" or type(api.Security) ~= "function" or type(api.Combat) ~= "function"
        or type(api.Insecure) ~= "function" or type(api.SurfaceUntainted) ~= "function"
        or type(api.GetLayoutData) ~= "function" or type(api.SetLayoutData) ~= "function"
        or type(api.EncodeBase64) ~= "function" or type(api.DecodeBase64) ~= "function"
        or type(api.SerializeCBOR) ~= "function" or type(api.DeserializeCBOR) ~= "function"
        or type(api.Compress) ~= "function" or type(api.Decompress) ~= "function"
        or type(api.Deflate) ~= "number" then return false, "cooldown carrier APIs unavailable" end
    local buildOk, observed = ns.Evidence.Check(api.Build)
    local securityOk, security = pcall(api.Security)
    local combatOk, combat = pcall(api.Combat)
    local insecureOk, insecure = pcall(api.Insecure)
    local surfaceOk, untainted = pcall(api.SurfaceUntainted)
    if not buildOk then
        return false, "unsupported client build " .. observed .. " (checked: " .. ns.Evidence.Label() .. ")"
    end
    if not securityOk or security ~= 1 or not insecureOk or insecure ~= true or not surfaceOk or untainted ~= true then
        return false, "ordinary addon or taint gate failed"
    end
    if not combatOk or combat == true then return false, "cooldown carrier waits for combat to end" end
    return true
end

function methods:Read()
    local ok, raw = pcall(self.api.GetLayoutData)
    if not ok then return nil, nil, "layout read failed" end
    return decodeLayout(self.api, raw)
end

function methods:SetExact(value)
    local ok = pcall(self.api.SetLayoutData, value)
    if not ok then return false end
    local readOk, readback = pcall(self.api.GetLayoutData)
    return readOk and readback == value
end

-- A frame that verifies as ours was left behind by a session that ended before its
-- acknowledgement, such as a reload with a write outstanding. Nothing else ever clears it,
-- and while it sits there every start is refused, so start hands it back. A value that is
-- not a checksummed Witchcraft frame is not ours and is never touched.
function methods:ScrubStale(data)
    if not ourFrame(data[127]) then return false, "cooldown layout field 127 is already occupied" end
    local now = self:Now()
    if now - self.lastWriteAt < WRITE_INTERVAL then return false, "carrier rate limit" end
    data[127] = nil
    local target, reason
    if sameLayout(data, emptyLayout()) then target = ""
    else
        target, reason = encodeLayout(self.api, data)
        if not target then return false, reason end
    end
    self.lastWriteAt = now
    if not self:SetExact(target) then return false, "stale carrier frame scrub readback mismatch" end
    return true
end

function methods:Start(session)
    if self.status ~= "stopped" and self.status ~= "restored" then return false, "carrier already started" end
    local gate, reason = self:Gate()
    if not gate then return false, reason end
    if type(session) ~= "table" or not hex8(session.epoch) or not hex8(session.nonce)
        or not hex8(session.uiNonce) then return false, "invalid carrier session" end
    local data, _, readReason = self:Read()
    if not data then return false, readReason end
    -- Our own bootstrap heartbeat is not stale: nobody waits for it, and the next frame
    -- simply replaces it. Anything else left in the field is scrubbed as before.
    if data[127] ~= nil and not (self.heartbeat and data[127] == self.heartbeat.wire) then
        local scrubbed, scrubReason = self:ScrubStale(data)
        if not scrubbed then return false, scrubReason end
    end
    local sameSession = self.epoch == session.epoch and self.nonce == session.nonce and self.uiNonce == session.uiNonce
    self.epoch, self.nonce, self.uiNonce = session.epoch, session.nonce, session.uiNonce
    if sameSession then
        -- A restart inside one host session continues the numbering, and the host's published
        -- acknowledgement may be ahead of what this side saw before it gave up on a frame.
        local ack = integer(session.ack, 0, MAX_SEQ) and session.ack or 0
        if ack > self.lastAck then self.lastAck = ack end
        if self.lastAck + 1 > self.nextSeq then self.nextSeq = self.lastAck + 1 end
    else
        self.nextSeq, self.nextMessage, self.lastAck = 1, 1, 0
    end
    self.queue, self.queuedBytes, self.active, self.outstanding, self.quarantined = {}, 0, nil, nil, nil
    self.status = "ready"
    return true
end

function methods:Queue(kind, payload)
    if self.status ~= "ready" and self.status ~= "waiting" then return false, "carrier is not ready" end
    if not kindCodes[kind] or type(payload) ~= "string" or #payload < 1 or #payload > MAX_MESSAGE
        or not accessible(self.api, payload) or #self.queue >= MAX_QUEUE
        or self.queuedBytes + #payload > MAX_QUEUE * MAX_MESSAGE then return false, "invalid or full carrier queue" end
    local chunks = {}
    for offset = 1, #payload, MAX_PAYLOAD do chunks[#chunks + 1] = payload:sub(offset, offset + MAX_PAYLOAD - 1) end
    if #chunks > MAX_PARTS or self.nextMessage + #self.queue > MAX_SEQ then return false, "carrier sequence exhausted" end
    self.queue[#self.queue + 1] = { kind = kind, payload = payload, chunks = chunks }
    self.queuedBytes = self.queuedBytes + #payload
    return true
end

-- A context message names itself, mirroring the binding lane's body. The carrier's own
-- frame counter is not the addon's message id, so without this the host would
-- acknowledge a number the addon never sent and the handshake could never complete.
local function contextBody(id, text)
    if type(id) ~= "number" or id ~= math.floor(id) or id < 1 or id > 262143
        or type(text) ~= "string" or #text < 1 then return nil end
    return "C" .. u24(id) .. text
end

function methods:OfferContext(id, text)
    local body = contextBody(id, text)
    if not body then return false, "invalid context message" end
    return self:Queue("context", body)
end

-- Before a host session exists the carrier knows only the UI nonce; that is enough for a
-- zero-id heartbeat, which is how the daemon first learns which ring slot to write.
function methods:Bootstrap(uiNonce)
    if self.status ~= "stopped" and self.status ~= "restored" then return false, "carrier already started" end
    if not hex8(uiNonce) then return false, "invalid carrier ui nonce" end
    self.uiNonce = uiNonce
    return true
end

-- A heartbeat advertises the ring's demand while the carrier has nothing to send. It is
-- never outstanding and never acknowledged: the next frame of any kind replaces it. It is
-- written only into an empty field or over a Witchcraft heartbeat, under the same combat and
-- write-rate gates as a data frame, and never while a data frame is outstanding.
function methods:Heartbeat(slot, flags)
    if self.quarantined then return false, self.quarantined end
    if self.outstanding then return false, "waiting for host acknowledgement" end
    if self.active or #self.queue > 0 then return false, "carrier has data to send" end
    local bootstrap = self.status == "stopped" or self.status == "restored"
    if not bootstrap and self.status ~= "ready" then return false, "carrier is not ready" end
    if not hex8(self.uiNonce) then return false, "carrier has no ui nonce" end
    if not integer(slot, 1, MAX_SLOT) or not integer(flags, 0, 255) then return false, "invalid carrier heartbeat" end
    local gate, reason = self:Gate()
    if not gate then return false, reason end
    -- Before a host session the carrier owns nothing worth protecting, and the host cannot send the
    -- chunk that would clear a quarantine until a heartbeat names a slot. A failure there is a
    -- refusal the next offer retries; once a session exists the usual ownership rules apply.
    local function fail(failReason)
        if bootstrap then return false, failReason end
        return self:Quarantine(failReason)
    end
    local now = self:Now()
    if now - self.lastWriteAt < WRITE_INTERVAL then return false, "carrier rate limit" end
    local data, wasEmpty, readReason = self:Read()
    if not data then return fail(readReason) end
    local previous, baseline = self.heartbeat
    if data[127] == nil then baseline = cloneValue(data)
    elseif previous and data[127] == previous.wire then baseline, wasEmpty = previous.baseline, previous.wasEmpty
    else
        -- Another UI session's heartbeat is replaceable because nobody ever waits on one. In
        -- bootstrap there is no session of ours to protect either, so any leftover of ours goes.
        local held = parseFrame(data[127])
        local replaceable = (held and held.kind == "heartbeat") or (bootstrap and ourFrame(data[127]))
        if not replaceable then return false, "cooldown layout field 127 is already occupied" end
        -- A heartbeat from an earlier UI session (a reload) is replaced outright; the layout
        -- beneath it is what a cleanup later restores.
        data[127] = nil
        baseline, wasEmpty = cloneValue(data), sameLayout(data, emptyLayout())
    end
    if not baseline then return fail("layout snapshot failed") end
    local wire = frameFor({ epoch = bootstrap and ZERO or self.epoch, nonce = bootstrap and ZERO or self.nonce,
        uiNonce = self.uiNonce, seq = self.nextSeq, message = 0, part = 1, count = 1, slot = slot,
        kind = "heartbeat", payload = string.char(flags) })
    if not wire then return fail("carrier frame build failed") end
    data[127] = wire
    local encoded, encodeReason = encodeLayout(self.api, data)
    if not encoded then return fail(encodeReason) end
    self.lastWriteAt = now -- failed attempts consume the write-rate budget too
    self.heartbeat = { wire = wire, wasEmpty = wasEmpty, baseline = baseline }
    if not self:SetExact(encoded) then return fail("layout write readback mismatch") end
    self:Note(string.format("heartbeat slot=%d", slot))
    return true
end

function methods:Pump(delivered, slot)
    if self.quarantined then return false, self.quarantined end
    if self.status ~= "ready" and self.status ~= "waiting" then return false, "carrier is not ready" end
    if not integer(slot, 1, MAX_SLOT) then return false, "invalid carrier slot" end
    local gate, reason = self:Gate()
    if not gate then return false, reason end
    local now = self:Now()
    if self.outstanding then
        -- An acknowledgement can only arrive in a delivered chunk. With a delivery count the
        -- timeout needs two chunks since the write (the first may predate the host's accept)
        -- and the elapsed time; without one it is the plain wall-clock rule.
        local since = type(delivered) == "number" and type(self.outstanding.deliveredAtSend) == "number"
            and delivered - self.outstanding.deliveredAtSend or math.huge
        if now - self.outstanding.sentAt > ACK_TIMEOUT and since >= 2 then
            return self:Quarantine("host acknowledgement timed out")
        end
        -- A waiting frame is the only thing that can tell the host which slot the addon wants: the
        -- field holds one frame, so no heartbeat can go out beside it, and tabbed out the strip is
        -- unreadable. When the ring moves on, the frame re-advertises; otherwise the host keeps
        -- writing a slot the addon has already read and the acknowledgement never arrives.
        if slot ~= self.outstanding.slot then return self:Readvertise(slot, now) end
        return false, "waiting for host acknowledgement"
    end
    if now - self.lastWriteAt < WRITE_INTERVAL then return false, "carrier rate limit" end
    if not self.active then
        self.active = table.remove(self.queue, 1)
        if not self.active then return false, "carrier queue empty" end
        self.queuedBytes = self.queuedBytes - #self.active.payload
        self.active.part, self.active.message = 1, self.nextMessage
    end
    if self.nextSeq > MAX_SEQ then return self:Quarantine("carrier sequence exhausted") end
    local data, wasEmpty, readReason = self:Read()
    if not data then return self:Quarantine(readReason) end
    -- A field holding our own heartbeat is free: the data frame replaces it and inherits
    -- the layout snapshot taken before the heartbeat, which is what a cleanup restores.
    local heartbeat = self.heartbeat
    if data[127] ~= nil then
        if not heartbeat or data[127] ~= heartbeat.wire then
            return self:Quarantine("cooldown layout field 127 ownership changed")
        end
    else heartbeat = nil end
    local frame = { epoch = self.epoch, nonce = self.nonce, uiNonce = self.uiNonce,
        seq = self.nextSeq, message = self.active.message, part = self.active.part, slot = slot,
        count = #self.active.chunks, kind = self.active.kind, payload = self.active.chunks[self.active.part] }
    local wire = frameFor(frame)
    if not wire then return self:Quarantine("carrier frame build failed") end
    local baseline
    if heartbeat then baseline, wasEmpty = heartbeat.baseline, heartbeat.wasEmpty
    else baseline = cloneValue(data) end
    if not baseline then return self:Quarantine("layout snapshot failed") end
    data[127] = wire
    local encoded, encodeReason = encodeLayout(self.api, data)
    if not encoded then return self:Quarantine(encodeReason) end
    local checksum = read32(wire, #wire - 3)
    self.outstanding = { wire = wire, checksum = checksum, checksums = { [checksum] = true }, seq = self.nextSeq,
        frame = frame, slot = slot, sentAt = now, wasEmpty = wasEmpty, baseline = baseline,
        deliveredAtSend = type(delivered) == "number" and delivered or nil }
    self.lastWriteAt = now -- failed attempts consume the write-rate budget too
    if not self:SetExact(encoded) then return self:Quarantine("layout write readback mismatch") end
    self.heartbeat, self.status = nil, "waiting"
    self:Note(string.format("data seq=%d msg=%d part=%d/%d slot=%d", frame.seq, frame.message, frame.part, frame.count, slot))
    return true
end

-- Rewrites the waiting frame to name `slot`: same session, sequence, message and payload. The host
-- may acknowledge any version it read, so every version's checksum stays acceptable.
function methods:Readvertise(slot, now)
    local outstanding = self.outstanding
    if now - self.lastWriteAt < WRITE_INTERVAL then return false, "carrier rate limit" end
    local data, _, readReason = self:Read()
    if not data then return self:Quarantine(readReason) end
    if data[127] ~= outstanding.wire then return self:Quarantine("cooldown layout field 127 ownership changed") end
    local frame = {}
    for key, value in pairs(outstanding.frame) do frame[key] = value end
    frame.slot = slot
    local wire = frameFor(frame)
    if not wire then return self:Quarantine("carrier frame build failed") end
    data[127] = wire
    local encoded, encodeReason = encodeLayout(self.api, data)
    if not encoded then return self:Quarantine(encodeReason) end
    self.lastWriteAt = now -- failed attempts consume the write-rate budget too
    if not self:SetExact(encoded) then return self:Quarantine("layout write readback mismatch") end
    outstanding.wire, outstanding.slot, outstanding.frame = wire, slot, frame
    outstanding.checksums[read32(wire, #wire - 3)] = true
    self:Note(string.format("readvertise seq=%d slot=%d", frame.seq, slot))
    return true
end

-- Clears whichever of our frames the field holds, a data frame or a heartbeat, and
-- restores the layout beneath it.
function methods:ClearOwned()
    if not self.outstanding and not self.heartbeat then return true end
    local data, _, reason = self:Read()
    if not data then return self:Quarantine(reason) end
    local field = data[127]
    if field == nil then self.outstanding, self.heartbeat = nil, nil return true end
    local owned
    if self.outstanding and field == self.outstanding.wire then owned = self.outstanding
    elseif self.heartbeat and field == self.heartbeat.wire then owned = self.heartbeat end
    if not owned then return self:Quarantine("cooldown layout field 127 ownership changed") end
    local now = self:Now()
    if now - self.lastWriteAt < WRITE_INTERVAL then return false, "carrier rate limit" end
    data[127] = nil
    local target
    if owned.wasEmpty and sameLayout(data, owned.baseline) then target = ""
    else
        target, reason = encodeLayout(self.api, data)
        if not target then return self:Quarantine(reason) end
    end
    self.lastWriteAt = now -- failed attempts consume the write-rate budget too
    if not self:SetExact(target) then return self:Quarantine("layout cleanup readback mismatch") end
    self.outstanding, self.heartbeat = nil, nil
    self:Note("cleared field 127")
    return true
end

function methods:AcceptHost(result)
    if type(result) ~= "table" or result.cooldownProtocol ~= PROTOCOL
        or result.epoch ~= self.epoch or result.cooldownNonce ~= self.nonce
        or not integer(result.cooldownAck, 0, MAX_SEQ)
        or not integer(result.cooldownChecksum, 0, 4294967295) then return false, "invalid carrier acknowledgement" end
    local outstanding = self.outstanding
    -- The ring can deliver an acknowledgement after the frame it names has gone (a restart cleared
    -- it). Adopting the number keeps this side ahead of the host, which will refuse a sequence it
    -- has already acknowledged; without this the next frame would reuse one and stall the lane.
    if not outstanding then
        if result.cooldownAck <= (self.lastAck or 0) then return false, "stale carrier acknowledgement" end
        self.lastAck = result.cooldownAck
        if result.cooldownAck + 1 > self.nextSeq then self.nextSeq = result.cooldownAck + 1 end
        return false, "acknowledgement adopted"
    end
    if result.cooldownAck < outstanding.seq then return false, "stale carrier acknowledgement" end
    if result.cooldownAck > outstanding.seq or not outstanding.checksums[result.cooldownChecksum] then
        return self:Quarantine("carrier acknowledgement mismatch")
    end
    local cleared, clearReason = self:ClearOwned()
    if not cleared then return false, clearReason or self.quarantined end
    self.lastAck, self.nextSeq = result.cooldownAck, outstanding.seq + 1
    if self.active.part == #self.active.chunks then
        self.nextMessage, self.active = self.active.message + 1, nil
    else self.active.part = self.active.part + 1 end
    self.status = "ready"
    self:Note(string.format("ack %d accepted", result.cooldownAck))
    return true
end

function methods:RestoreOwned()
    if not self.outstanding and not self.heartbeat then
        self.queue, self.active, self.queuedBytes, self.status = {}, nil, 0, "restored"
        return true
    end
    local gate, reason = self:Gate()
    if not gate then return false, reason end
    local cleared, clearReason = self:ClearOwned()
    if not cleared then return false, clearReason or self.quarantined end
    self.queue, self.active, self.queuedBytes, self.status = {}, nil, 0, "restored"
    return true
end

Cooldown.Protocol = PROTOCOL
Cooldown.Field = 127
Cooldown.MaxPayload = MAX_PAYLOAD
Cooldown.MaxParts = MAX_PARTS
Cooldown.MaxSlot = MAX_SLOT
Cooldown.CRC32 = crc32
Cooldown.ContextBody = contextBody
Cooldown.Frame = frameFor
Cooldown.ParseFrame = parseFrame
Cooldown.DecodeLayout = decodeLayout
Cooldown.EncodeLayout = encodeLayout
