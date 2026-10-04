-- Native lifecycle adapter plus a separately constructible controller. The two
-- terminals carry user input only; no received terminal text is evaluated here.
local _, ns = ...
local Core, Persistence = {}, {}
ns.Core, ns.Persistence = Core, Persistence
local methods = {}
methods.__index = methods
local BUILD = "stock-frame-20260923-1"
local Ring = ns.Ring
local Binding = ns.Binding
local CooldownCarrier = ns.CooldownCarrier
local integer, plain, epoch = Ring.Integer, Ring.Plain, Ring.Epoch
local actions = { text = true, enter = true, interrupt = true, escape = true, up = true, down = true }
-- A bootstrap heartbeat with no host answering is a settings write nobody reads, so its cadence
-- backs off from the ring's own toward a two-minute floor until something proves a host is there.
local HEARTBEAT_BASE, HEARTBEAT_CEILING = 8, 120
-- Seconds between slot loads while the host cannot hear this client (WoW in the background).
local PAUSED_RETRY = 2
-- Capture order: progress is one cheap part and answers "how far to level", so it precedes
-- the multi-part quest batch. Errors come last and only when a want names them. Bits are the
-- chunk's contextWantMask.
local contextOrder = { { 1, "player" }, { 4, "progress" }, { 2, "quests" }, { 8, "errors" } }
local points = { TOPLEFT = true, TOP = true, TOPRIGHT = true, LEFT = true, CENTER = true,
    RIGHT = true, BOTTOMLEFT = true, BOTTOM = true, BOTTOMRIGHT = true }

local function finite(value, low, high)
    return type(value) == "number" and value == value and value >= low and value <= high
end

local function hasBit(mask, bit)
    return math.floor(mask / bit) % 2 == 1
end

local function coins(copper)
    return string.format("%dg %ds %dc", math.floor(copper / 10000), math.floor(copper / 100) % 100, copper % 100)
end

local function validView(value)
    if not plain(value) then return false end
    for _, key in ipairs({ "point", "relativePoint" }) do
        if value[key] ~= nil and not points[value[key]] then return false end
    end
    for _, key in ipairs({ "x", "y" }) do
        if value[key] ~= nil and not finite(value[key], -10000, 10000) then return false end
    end
    for _, key in ipairs({ "width", "height" }) do
        if value[key] ~= nil and not finite(value[key], 100, 10000) then return false end
    end
    if value.minimized ~= nil and type(value.minimized) ~= "boolean" then return false end
    return true
end

-- Player preferences, shown on the client's Options > AddOns > Witchcraft page. A key with
-- `values` takes only those; the rest take a value of their default's type.
local SETTINGS = {
    layer = { default = "normal", values = { top = true, normal = true, back = true } },
    locked = { default = false }, docked = { default = false }, escapeCloses = { default = false },
    openOnLoad = { default = true },
    alertText = { default = true }, alertSound = { default = true }, alertFinished = { default = true },
    combatUpdates = { default = false }, showChoices = { default = true }, showStatus = { default = true },
    minimap = { default = true }, historySize = { default = 50, values = { [20] = true, [50] = true, [100] = true } },
}
local function validSetting(key, value)
    local spec = SETTINGS[key]
    if not spec then return false end
    if spec.values then return spec.values[value] == true end
    return type(value) == type(spec.default)
end
ns.Settings = SETTINGS

local function validMessage(message)
    if not plain(message) or not integer(message.id, 1, 262143) or not epoch(message.epoch) then return false end
    if message.tab ~= "claude" and message.tab ~= "codex" then return false end
    if not actions[message.action] or type(message.text) ~= "string" or #message.text > 600 then return false end
    if not ns.Pixel.ValidText(message.text) or (message.action ~= "text" and message.text ~= "") then return false end
    if message.action == "text" and message.text == "" then return false end
    return true
end

-- Validate before AceDB attaches defaults/metatables or replaces a scalar root.
-- Unknown probe fields and AceDB scopes remain owned by AceDB.
function Persistence.Validate(raw)
    if raw == nil then return true end
    if not plain(raw) then return false, "SavedVariables root is malformed" end
    for _, key in ipairs({ "profiles", "profileKeys", "char", "realm", "class", "race", "faction", "factionrealm", "locale", "namespaces" }) do
        if raw[key] ~= nil and not plain(raw[key]) then return false, "Malformed AceDB scope" end
        local count = 0
        for name, value in pairs(raw[key] or {}) do
            count = count + 1
            if count > 256 or type(name) ~= "string" or #name > 256
                or (key == "profileKeys" and type(value) ~= "string")
                or (key ~= "profileKeys" and not plain(value)) then return false, "Malformed AceDB scope entry" end
        end
    end
    local global = raw.global
    if global == nil then return true end
    if not plain(global) then return false, "SavedVariables global is malformed" end
    if global.schema ~= nil and global.schema ~= 1 then return false, "Unsupported Witchcraft database schema" end
    if global.epoch ~= nil and not epoch(global.epoch) then return false, "Invalid saved host epoch" end
    if global.ack ~= nil and not integer(global.ack, 0, 262143) then return false, "Invalid saved acknowledgement" end
    if global.nextId ~= nil and not integer(global.nextId, 1, 262144) then return false, "Invalid next message ID" end
    if global.nextSeq ~= nil and not integer(global.nextSeq, 1, 10000) then return false, "Invalid saved ring cursor" end
    if global.ringSize ~= nil and not integer(global.ringSize, 1, 9999) then return false, "Invalid saved ring size" end
    if global.fontSize ~= nil and not integer(global.fontSize, 8, 20) then return false, "Invalid font size" end
    if global.opacity ~= nil and not integer(global.opacity, 0, 100) then return false, "Invalid background opacity" end
    if global.contextEnabled ~= nil and type(global.contextEnabled) ~= "boolean" then return false, "Invalid context preference" end
    if global.settings ~= nil then
        if not Ring.Plain(global.settings) then return false, "Invalid saved settings" end
        -- Unknown keys are kept for a newer build; known ones must hold a valid value.
        for key, value in pairs(global.settings) do
            if SETTINGS[key] and not validSetting(key, value) then return false, "Invalid saved setting " .. tostring(key) end
        end
    end
    if global.trace ~= nil and not Ring.Array(global.trace, 600) then return false, "Invalid saved trace" end
    if global.snippets ~= nil then
        if not Ring.Array(global.snippets, 20) then return false, "Invalid saved snippets" end
        for _, snippet in ipairs(global.snippets) do
            if type(snippet) ~= "string" or snippet == "" or #snippet > 600 or snippet:find("[%z\1-\31\127]") then
                return false, "Invalid saved snippet"
            end
        end
    end
    if global.hz ~= nil and not finite(global.hz, 0.125, 2) then return false, "Invalid stream rate" end
    if global.activeTab ~= nil and global.activeTab ~= "claude" and global.activeTab ~= "codex" then return false, "Invalid tab" end
    if global.view ~= nil and not validView(global.view) then return false, "Invalid saved layout" end
    if global.reloadAwaitHost ~= nil and type(global.reloadAwaitHost) ~= "boolean" then return false, "Invalid reload state" end
    if global.outbox ~= nil then
        if not Ring.Array(global.outbox, 64) then return false, "Invalid saved outbox" end
        local maximum = 0
        for _, message in ipairs(global.outbox) do
            if not validMessage(message) or message.id <= maximum then return false, "Invalid saved message order" end
            maximum = message.id
        end
        if global.nextId ~= nil and global.nextId <= maximum then return false, "Message ID would be reused" end
    end
    return true
end

function Persistence.Initialize(global)
    global.schema = 1
    global.outbox, global.view = global.outbox or {}, global.view or {}
    global.ack, global.nextSeq = global.ack or 0, global.nextSeq or 1
    local maximum = global.ack
    for _, message in ipairs(global.outbox) do maximum = math.max(maximum, message.id) end
    global.nextId = math.max(global.nextId or 1, maximum + 1)
    global.activeTab, global.fontSize, global.hz = global.activeTab or "claude", global.fontSize or 10, global.hz or 1
    if global.opacity == nil then global.opacity = 80 end
    if global.contextEnabled == nil then global.contextEnabled = true end
    global.snippets = global.snippets or {}
    global.trace = global.trace or {}
    global.settings = global.settings or {}
    for key, spec in pairs(SETTINGS) do
        if global.settings[key] == nil then global.settings[key] = spec.default end
    end
    return global
end

local function emptySessions()
    return { { id = "claude", title = "Claude", lines = {}, status = "Waiting for host" },
        { id = "codex", title = "Codex", lines = {}, status = "Waiting for host" } }
end

-- Seconds after an answer's delivery before an identical menu counts as a new question (see AnswerPending).
local ANSWER_SETTLE = 2
-- A menu as the terminal draws it: its options and the marked one.
local function choiceKey(choices)
    if type(choices) ~= "table" or type(choices.options) ~= "table" then return "" end
    return table.concat(choices.options, "\n") .. "\n" .. tostring(choices.selected)
end

-- The status of a tab whose terminal or console has exited or never started, or nil: nothing typed
-- reaches it. These are the daemon's own words (pty.js, sessions.js).
local function stoppedStatus(status)
    return type(status) == "string" and (status:find("^exited") or status == "not started") and status or nil
end

local function screenText(lines)
    local text = {}
    for i, line in ipairs(lines) do
        -- The daemon escapes literal pipes before adding its color spans. Keep
        -- those literals while ignoring color-only redraws and terminal padding.
        line = line:gsub("||", "\0"):gsub("|c%x%x%x%x%x%x%x%x", ""):gsub("|r", "")
        text[i] = line:gsub("%z", "|"):gsub(" +$", "")
    end
    while text[#text] == "" do text[#text] = nil end
    return table.concat(text, "\n")
end

function Core.New(global, api)
    api = api or {}
    local nonce = api.UINonce and api.UINonce() or string.format("%04x%04x", math.random(0, 65535), math.random(0, 65535))
    if nonce == "00000000" then nonce = "00000001" end
    assert(epoch(nonce), "UI nonce must be eight nonzero hex digits")
    local self = setmetatable({ global = Persistence.Initialize(global), api = api, uiNonce = nonce:lower(),
        active = false, visible = false, generation = 0, timers = {}, connected = false, calibrating = false }, methods)
    self.ring = Ring.New({ ringSize = global.ringSize, epoch = global.epoch, hz = global.hz, uiNonce = self.uiNonce })
    -- Terminal output is ephemeral. Preserve legacy cache fields, if any, but
    -- never load them into the view or write new output to SavedVariables.
    self.sessions = emptySessions()
    self.unread, self.screenText = { claude = false, codex = false }, {}
    -- The state each agent's screen last reported, and why a tab wants the player: "waiting" on a
    -- choice menu or "done" after working. Both clear when the player looks at that tab.
    self.agentStates, self.attention = {}, { claude = false, codex = false }
    -- Each tab's last answered menu, until the terminal moves on (see AnswerPending).
    self.answered = {}
    self.cols, self.rows = 120, 40
    -- Scrollback position per tab, in rows above the bottom. Memory only: a reload
    -- starts at the live rows, and SavedVariables never carries terminal state.
    self.scroll = { claude = 0, codex = 0 }
    self.scrolledAt = { claude = 0, codex = 0 }
    self.heartbeatBackoff, self.heartbeatNextAt = HEARTBEAT_BASE, 0
    if api.Context ~= nil then self.context = api.Context
    elseif ns.Context then self.context = ns.Context.New() end
    -- Errors.lua has been recording since it loaded; the saved list joins it here.
    if api.Errors ~= nil then self.errors = api.Errors or nil
    elseif ns.Errors then self.errors = ns.Errors.default end
    if self.errors then self.errors:Attach(self.global) end
    self.contextNextID, self.contextRevision, self.contextNextAt = 1, 0, 0
    self.contextStatus, self.contextDomains, self.contextPublished = "Waiting for host", {}, {}
    self.contextOffPending = self.context and not self.global.contextEnabled or nil
    if api.Binding ~= false and Binding then self.binding = Binding.New(api.BindingAPI or api) end
    if api.Cooldown ~= false and CooldownCarrier then
        if api.Cooldown then self.cooldown = api.Cooldown
        else
            local carrierAPI = api.CooldownAPI
            if not carrierAPI then
                -- The native factory dereferences client globals, so a missing surface must not throw.
                local ok, native = pcall(CooldownCarrier.NativeAPI)
                carrierAPI = ok and native or nil
            end
            if carrierAPI then self.cooldown = CooldownCarrier.New(carrierAPI) end
        end
        -- Before a host session exists the carrier can still send zero-id heartbeats, which
        -- is how the daemon learns the ring slot while the game is in the background.
        if self.cooldown then
            self.cooldown.onTrace = function(text) self:Trace("carrier " .. text) end
            self.cooldown:Bootstrap(self.uiNonce)
        end
    end
    return self
end

-- The carrier only exists while a host session does, and it is restarted rather than
-- left quarantined, so one ownership loss cannot silence the transport for the session.
function methods:AcceptCooldownHost(result)
    local carrier = self.cooldown
    if not carrier then return end
    if result.cooldownProtocol ~= CooldownCarrier.Protocol or not result.cooldownNonce then return end
    if carrier.status == "quarantined" then
        -- Hand any owned frame back first. Reset refuses while one is held, and it must, or a
        -- live field 127 would be forgotten rather than restored. If the gate blocks (combat,
        -- rate limit) the frame stays owned and the next snapshot tries again.
        carrier:RestoreOwned()
        if not carrier:Reset() then return end
    end
    if carrier.status == "stopped" or carrier.status == "restored"
        or carrier.epoch ~= result.epoch or carrier.nonce ~= result.cooldownNonce then
        if carrier.status ~= "stopped" and carrier.status ~= "restored" then carrier:RestoreOwned() end
        if carrier.status == "stopped" or carrier.status == "restored" then
            local started, reason = carrier:Start({ epoch = result.epoch, nonce = result.cooldownNonce,
                uiNonce = self.uiNonce, ack = result.cooldownAck })
            -- A refusal is otherwise invisible; /witch status shows it.
            self.cooldownStartReason = not started and reason or nil
            -- A client patch is the one refusal the player must hear about: it silently leaves
            -- only the screen strip, which stops whenever WoW is in the background.
            local observed = not started and not self.buildAnnounced
                and tostring(reason):match("^unsupported client build (%S+)")
            if observed then
                self.buildAnnounced = true
                self:Print(string.format("Witchcraft: the client is now %s; the fast link stays off until that build"
                    .. " is checked (last checked %s). Typing still works over the screen strip.",
                    observed, ns.Evidence.Label()))
            end
        end
        return
    end
    carrier:AcceptHost(result)
end

-- The carrier owns outbound context only while it holds a live host session.
function methods:CooldownActive()
    local carrier = self.cooldown
    return carrier ~= nil and not carrier.quarantined
        and (carrier.status == "ready" or carrier.status == "waiting")
end

-- Writes are self-rate-limited and combat-gated, so this may run on a plain cadence.
function methods:CooldownTick()
    local carrier = self.cooldown
    if not self.active or not carrier then return end
    if self:CooldownActive() and not carrier.active and self.contextPending then
        carrier:OfferContext(self.contextPending.id, self.contextPending.text)
    end
    -- The ring's accepted count lets the carrier tell a stalled ring from a silent host;
    -- every frame advertises the ring's next slot so the daemon knows where to write.
    if self:CooldownActive() then
        local pumped, reason = carrier:Pump(self.ring.accepted, self.ring.nextSeq)
        if not pumped and reason then self:Trace("carrier pump: " .. tostring(reason), "pump") end
    end
    if self.active and self.cooldown then self:Schedule("cooldown", 1, self.CooldownTick) end
end

-- The strip's heartbeat and the carrier's heartbeat carry the same flags.
function methods:HeartbeatFlags()
    return (self:Combat() and 1 or 0) + (self.reloading and 2 or 0)
end

-- The carrier's demand signal: offered after every consumed chunk and on flag changes, so
-- the daemon keeps writing the ring while the game is in the background. The carrier
-- itself declines while a data frame is outstanding, in combat, or inside its write rate.
function methods:ResetHeartbeatBackoff()
    self.heartbeatBackoff, self.heartbeatNextAt = HEARTBEAT_BASE, 0
end

function methods:OfferHeartbeat()
    local carrier = self.cooldown
    if not carrier or not self.active then return false end
    if self.connected then return carrier:Heartbeat(self.ring.nextSeq, self:HeartbeatFlags()) end
    local now = self:ContextNow()
    if now < (self.heartbeatNextAt or 0) then return false, "carrier heartbeat backoff" end
    local written, reason = carrier:Heartbeat(self.ring.nextSeq, self:HeartbeatFlags())
    if written then
        self.heartbeatNextAt = now + self.heartbeatBackoff
        self.heartbeatBackoff = math.min(self.heartbeatBackoff * 2, HEARTBEAT_CEILING)
    end
    return written, reason
end

-- Cleanup needs the same gate the writes do, so combat defers it to the next attempt.
function methods:ReleaseCooldown()
    local carrier = self.cooldown
    if not carrier then return true end
    local released, reason = carrier:RestoreOwned()
    if not released then self.cooldownDeferred = reason or "carrier cleanup deferred" end
    return released, reason
end

function methods:ContextNow()
    local now = self.api.GetTime and self.api.GetTime() or 0
    return finite(now, 0, 1000000000000) and now or 0
end

function methods:ContextActive()
    return self.context and (self.global.contextEnabled or self.contextOffPending) or false
end

function methods:ClearContext(status)
    self.contextPending, self.contextCurrent, self.contextDomains = nil, nil, {}
    self.contextRetryNotBefore = nil
    self.contextNextAt, self.contextStatus = self:ContextNow(), status or "Waiting for host"
end

function methods:SetContextEnabled(enabled)
    if type(enabled) ~= "boolean" then return false, "Context expects on or off" end
    if self.global.contextEnabled == enabled then return true end
    self.global.contextEnabled, self.contextOffPending = enabled, not enabled
    if not enabled then self.contextRefreshRequested = nil end
    self:ClearContext(enabled and "Waiting to share" or "Turning off")
    if self.active then
        self:Schedule("context", 0.2, self.ContextTick)
        self:Schedule("pixel", 0.2, self.PixelTick)
        if not self:InboundPaused() then self:Schedule("load", 1, self.LoadTick) end
    end
    self:Render()
    return true
end

function methods:RefreshContext()
    if not self.context or not self.global.contextEnabled then return false, "WoW context is off" end
    -- An explicit user refresh requests one complete pass. Coalesce repeated clicks
    -- behind an in-flight revision; ordinary game events never start a capture.
    self.contextRefreshRequested = true
    if not self.contextCurrent and #self.contextDomains == 0 then
        self.contextNextAt = math.min(self.contextNextAt, math.max(self:ContextNow() + 1, self.contextRetryNotBefore or 0))
    end
    if self.active and not self.timers.context then self:Schedule("context", 1, self.ContextTick) end
    return true
end

function methods:ContextStalled(reason)
    self:ClearContext(reason or "Stalled; retrying")
    self.contextNextAt = self:ContextNow() + 30
    self.contextRetryNotBefore = self.contextNextAt
    self.contextRefreshRequested = nil
    self:Render()
end

function methods:ContextTick()
    if not self.active or not self:ContextActive() then return end
    if not self.connected or self.contextProtocol ~= 4 then
        self.contextStatus = self.connected and "Unsupported host" or "Waiting for host"
    elseif self.contextPending and (self:ContextNow() - self.contextPending.createdAt >= 30
        or (self.contextPending.retryAt and self:ContextNow() >= self.contextPending.retryAt)) then
        local current = self.contextCurrent
        current.retries = (current.retries or 0) + 1
        if current.retries >= 3 then self:ContextStalled("Stalled; retrying")
        else self.contextPending, self.contextStatus = nil, "Retrying" end
    elseif not self.contextPending and not self:PendingInput() then
        local now = self:ContextNow()
        if not self.contextCurrent and #self.contextDomains == 0 and now >= self.contextNextAt then
            -- A host pull or explicit refresh requests one pass; neither arms a stream.
            local wanted = (self.contextWant or 0) > 0 and self.contextWant ~= self.contextServedWant
            if self.contextAnnounced ~= self.global.contextEnabled then
                self.contextDomains = { "state" }
            elseif wanted or self.contextRefreshRequested then
                -- Manual refresh asks for all domains and also satisfies an outstanding host want.
                local mask = self.contextRefreshRequested and 7 or (self.contextWantMask or 0)
                self.contextRefreshRequested = nil
                if wanted then self.contextServedWant = self.contextWant end
                if self.global.contextEnabled then
                    for _, entry in ipairs(contextOrder) do
                        if hasBit(mask, entry[1]) then self.contextDomains[#self.contextDomains + 1] = entry[2] end
                    end
                end
            end
            if #self.contextDomains > 0 then self.contextRetryNotBefore = nil end
        end
        if not self.contextCurrent and #self.contextDomains > 0 then
            local domain = table.remove(self.contextDomains, 1)
            local ok, parts = true, { { self.global.contextEnabled } }
            if domain ~= "state" then ok, parts = pcall(self.context.Capture, self.context, domain) end
            local valid, count = Ring.Array(parts, 10)
            if not ok or not valid or count < 1 then self:ContextStalled("Context unavailable; retrying")
            else
                self.contextRevision = self.contextRevision + 1
                self.contextCurrent = { domain = domain, parts = parts, part = 1,
                    revision = self.contextRevision, capturedAt = now }
            end
        end
        local current = self.contextCurrent
        if current then
            if self.contextNextID > 262143 or self.contextRevision > 262143 then
                self:ClearContext("Context ID limit; reload Witchcraft")
                self.contextNextAt = 1000000000000
            else
                local age = math.floor(math.max(0, now - current.capturedAt))
                local ok, text = pcall(ns.Context.Encode, { 1, current.domain, current.revision,
                    current.part, #current.parts, math.min(age, 86400), current.parts[current.part] })
                local message = { epoch = self.global.epoch, uiNonce = self.uiNonce, id = self.contextNextID, text = ok and text or nil }
                local frames = ns.Pixel.EncodeContext(message)
                if not frames then self:ContextStalled("Context too large; retrying")
                else
                    self.contextNextID = self.contextNextID + 1
                    self.contextPending = { id = message.id, epoch = message.epoch, uiNonce = message.uiNonce,
                        text = message.text, frames = frames, index = 1, sent = 0, createdAt = now }
                    self.contextStatus = self.global.contextEnabled and "Sharing" or "Turning off"
                    self:Schedule("binding", 0, self.BindingTick)
                end
            end
        end
    end
    if self:ContextActive() then self:Schedule("context", 1, self.ContextTick) end
    self:Render()
end

function methods:AcceptContext(result)
    local previousProtocol = self.contextProtocol
    if result.newEpoch then
        self:ClearContext("Waiting to share")
        self.contextPublished, self.contextUpdatedAt = {}, nil
        self.contextAnnounced, self.contextServedWant, self.contextWant, self.contextWantMask = nil, nil, nil, nil
    end
    self.contextProtocol = result.contextProtocol
    if result.contextProtocol ~= 4 then
        self:ClearContext("Unsupported host")
        self.contextOffPending = nil
        return
    end
    if self.context and not self.global.contextEnabled and (result.newEpoch or previousProtocol ~= 4) then
        self.contextOffPending = true
    end
    -- The mask travels with its id. An id that supersedes one we have not served yet
    -- folds that id's domains in. Repeated chunks retain the same accumulated domains
    -- until served, even though the host continues to send only its latest incremental mask.
    local mask = result.contextWantMask or 0
    if self.contextWant and self.contextWant ~= self.contextServedWant then
        for _, entry in ipairs(contextOrder) do
            if hasBit(self.contextWantMask or 0, entry[1]) and not hasBit(mask, entry[1]) then mask = mask + entry[1] end
        end
    end
    self.contextWant, self.contextWantMask = result.contextWant or 0, mask
    if self.contextWant > 0 and self.contextWant ~= self.contextServedWant then
        self.contextNextAt = math.min(self.contextNextAt, self:ContextNow())
    end
    self.contextNextID = math.max(self.contextNextID, (result.contextAck or 0) + 1)
    local pending, current = self.contextPending, self.contextCurrent
    if pending and current and pending.epoch == result.epoch and pending.id == result.contextAck then
        self.contextPending = nil
        current.part = current.part + 1
        current.retries = 0
        if current.part > #current.parts then
            -- The host now knows which way sharing is set, so it need not be told again.
            if current.domain == "state" then self.contextAnnounced = self.global.contextEnabled end
            if current.domain == "state" and not self.global.contextEnabled then
                self.contextOffPending, self.contextStatus = nil, "Off"
                self.contextPublished, self.contextUpdatedAt = {}, nil
                self:CancelTimer("context")
            elseif current.domain ~= "state" then
                self.contextUpdatedAt, self.contextStatus = current.capturedAt, "Sharing"
                local data = current.parts[1]
                local info = { capturedAt = current.capturedAt, status = "Shared" }
                if current.domain == "player" then
                    info.summary = (type(data[1]) == "string" and data[1] or "Character")
                        .. (type(data[3]) == "number" and (" / Level " .. data[3]) or "")
                        .. (type(data[5]) == "string" and (" / " .. data[5]) or "")
                    local available = false
                    for index = 1, 6 do if data[index] ~= false then available = true end end
                    if not available then info.status, info.summary = "Unavailable", "Unavailable"
                    elseif type(data[7]) == "table" and #data[7] > 0 then info.status = "Partial" end
                elseif current.domain == "quests" then
                    info.count, info.truncated = data[3], data[4]
                    if not data[1] then info.status = "Unavailable" end
                elseif current.domain == "errors" then
                    info.count = data[3]
                    if not data[1] then info.status, info.summary = "Unavailable", "Unavailable"
                    else info.summary = data[3] .. " stored" end
                elseif current.domain == "progress" then
                    local capped, failures = false, 0
                    if type(data[14]) == "table" then
                        for _, entry in ipairs(data[14]) do
                            if entry == "xp:cap" then capped = true
                            elseif type(entry) == "string" and not entry:find(":cap$") then failures = failures + 1 end
                        end
                    end
                    local pieces = {}
                    if type(data[1]) == "number" then pieces[#pieces + 1] = coins(data[1]) end
                    if type(data[2]) == "number" and type(data[3]) == "number" and data[3] > 0 then
                        pieces[#pieces + 1] = math.floor(data[2] / data[3] * 100) .. "% to next level"
                    elseif capped then pieces[#pieces + 1] = "XP capped" end
                    if data[5] == true and type(data[7]) == "string" then pieces[#pieces + 1] = "in " .. data[7] end
                    local available = false
                    for index = 1, 13 do if data[index] ~= false then available = true end end
                    if not available then info.status, info.summary = "Unavailable", "Unavailable"
                    else
                        info.summary = #pieces > 0 and table.concat(pieces, " / ") or "Progress"
                        if failures > 0 then info.status = "Partial" end
                    end
                end
                self.contextPublished[current.domain] = info
            end
            self.contextCurrent = nil
            if #self.contextDomains == 0 then
                -- An outstanding want is served on the next tick; nothing else schedules itself.
                if (self.contextWant or 0) > 0 and self.contextWant ~= self.contextServedWant then
                    self.contextNextAt = self:ContextNow()
                else
                    self.contextNextAt = self:ContextNow() + (self.contextRefreshRequested and 1 or 30)
                end
            end
        end
    end
    if self:ContextActive() then self:Schedule("context", 0.2, self.ContextTick) end
end

function methods:PendingInput()
    for _, message in ipairs(self.global.outbox) do
        if message.epoch == self.global.epoch then return message end
    end
end

function methods:Combat()
    return self.api.InCombatLockdown and self.api.InCombatLockdown() == true or false
end

-- Terminal updates freeze in combat unless "Keep updating in combat" is on. Reloads, resets and the
-- binding carrier still wait for combat to end, and the heartbeat still reports the real state.
function methods:InboundPaused()
    return self:Combat() and self.global.settings.combatUpdates ~= true
end

function methods:Print(message)
    if self.api.Print then self.api.Print(message) end
end

function methods:CancelTimer(kind)
    local token = self.timers[kind]
    self.timers[kind] = nil
    if token and token.handle and token.handle.Cancel then token.handle:Cancel() end
end

function methods:Schedule(kind, delay, callback)
    self:CancelTimer(kind)
    if not self.active or not self.api.NewTimer then return end
    local generation, token = self.generation, {}
    self.timers[kind] = token
    local handle = self.api.NewTimer(delay, function()
        if not self.active or self.generation ~= generation or self.timers[kind] ~= token then return end
        self.timers[kind] = nil
        callback(self)
    end)
    token.handle = handle
    if self.generation ~= generation or self.timers[kind] ~= token then
        if handle and handle.Cancel then handle:Cancel() end
    end
end

function methods:WantStream()
    return self.active and (self.visible or #self.global.outbox > 0 or self.calibrating
        or self.burstProbe ~= nil or self:ContextActive() or (self.binding and self.binding:Busy()))
end

function methods:EnsureView()
    if not self.view and self.api.CreateView then self.view = self.api.CreateView(self) end
end

function methods:Start()
    if self.active then return end
    self.active, self.visible, self.generation = true, self.global.settings.openOnLoad ~= false, self.generation + 1
    self:ResetHeartbeatBackoff()
    -- A restart re-announces the preference, so a host that missed it is told again.
    self.contextAnnounced = nil
    if self.context and not self.global.contextEnabled then self.contextOffPending = true end
    self:EnsureView()
    self:Render()
    self:Schedule("load", 1, self.LoadTick)
    self:Schedule("pixel", 0.2, self.PixelTick)
    self:Schedule("context", 1, self.ContextTick)
    if self.cooldown then self:Schedule("cooldown", 1, self.CooldownTick) end
    if self.binding and self.binding:Busy() then self:Schedule("binding", 1, self.BindingTick) end
end

function methods:Stop()
    self.active, self.visible, self.generation, self.loading = false, false, self.generation + 1, nil
    self:CancelTimer("load")
    self:CancelTimer("pixel")
    self:CancelTimer("context")
    self:CancelTimer("burst")
    self:CancelTimer("binding")
    self:CancelTimer("cooldown")
    self.burstProbe = nil
    self.contextRefreshRequested = nil
    self:ClearContext("Stopped")
    if self.binding then self.binding:Stop() end
    self:ReleaseCooldown()
    if self.view then self.view:Hide(); self.view:RenderStrip(nil, nil); self.view:RenderBurst(nil) end
end

function methods:ScrollMaximum(tab)
    for _, session in ipairs(self.sessions) do
        if session.id == tab then
            local total = #(session.history or {}) + #(session.lines or {})
            -- A host resize reaches Core before the view reports its new capacity.
            -- The view can never display more rows than the source currently has.
            return math.max(0, total - math.min(self.viewportRows or self.rows, self.rows))
        end
    end
    return 0
end

function methods:ScrollState(tab)
    return { offset = self.scroll[tab] or 0, max = self:ScrollMaximum(tab) }
end

-- Layout reports its row capacity without re-entering Render. The returned scroll
-- state lets the same render use an offset clamped for its new size or font.
function methods:SetViewportRows(rows)
    if not integer(rows, 1, 60) then return nil end
    self.viewportRows = rows
    for tab in pairs(self.scroll) do self.scroll[tab] = math.min(self.scroll[tab], self:ScrollMaximum(tab)) end
    return self:ScrollState(self.global.activeTab)
end

function methods:Snapshot()
    local stale = 0
    for _, message in ipairs(self.global.outbox) do if message.epoch ~= self.global.epoch then stale = stale + 1 end end
    local ring = self.ring:Snapshot()
    local status = self:InboundPaused() and "Paused: combat (outbound remains active)" or ring.status
    if self.stalled then status = "Waiting for the desktop; updates pause while WoW is in the background" end
    if stale > 0 then status = status .. " / " .. stale .. " stale: /witch resend to retry" end
    if self.notice then status = self.notice end
    local context = { enabled = self.global.contextEnabled, status = self.global.contextEnabled and self.contextStatus
        or (self.contextOffPending and "Turning off" or "Off"),
        age = self.contextUpdatedAt and math.floor(math.max(0, self:ContextNow() - self.contextUpdatedAt)) or nil }
    for domain, info in pairs(self.contextPublished) do
        context[domain] = { age = math.floor(math.max(0, self:ContextNow() - info.capturedAt)),
            status = info.status, summary = info.summary, count = info.count, truncated = info.truncated }
    end
    return { sessions = self.sessions, activeTab = self.global.activeTab, cols = self.cols, rows = self.rows,
        unread = { claude = self.unread.claude, codex = self.unread.codex },
        attention = { claude = self.attention.claude, codex = self.attention.codex },
        answered = { claude = self:AnswerPending("claude") ~= nil, codex = self:AnswerPending("codex") ~= nil },
        snippets = { unpack(self.global.snippets) },
        settings = (function() local copy = {}; for key, value in pairs(self.global.settings) do copy[key] = value end; return copy end)(),
        view = self.global.view, fontSize = self.global.fontSize, opacity = self.global.opacity,
        status = status, seq = ring.seq, ringSize = ring.ringSize,
        queued = #self.global.outbox, stale = stale > 0, staleCount = stale,
        combat = self:InboundPaused(), paused = self.stalled == true, epoch = self.global.epoch, connected = self.connected,
        scroll = self:ScrollState(self.global.activeTab),
        context = context, binding = self.binding and self.binding:Snapshot() or { status = "Unavailable", enabled = false },
        cooldown = self.cooldown and { status = self.cooldown.status, quarantined = self.cooldown.quarantined,
            reason = self.cooldownStartReason } or { status = "Unavailable" } }
end

function methods:Render()
    if not self.view then return end
    if self.visible and self.global.view.minimized ~= true then
        self.unread[self.global.activeTab] = false; self.attention[self.global.activeTab] = false
    end
    if self.visible then self.view:Render(self:Snapshot()); self.view:Show() else self.view:Hide() end
end

function methods:SetVisible(visible)
    if not self.active or type(visible) ~= "boolean" or self.visible == visible then return end
    self.visible = visible
    if visible then self:ResetHeartbeatBackoff() end
    self:Render()
    if self:WantStream() then
        self:Schedule("load", 1, self.LoadTick)
        self:Schedule("pixel", 0.2, self.PixelTick)
    else
        self:CancelTimer("load"); self:CancelTimer("pixel")
        if self.view then self.view:RenderStrip(nil, nil) end
    end
end

function methods:Toggle() self:SetVisible(not self.visible) end
function methods:Hide() self:SetVisible(false) end

-- Guide actions only prepare an editable prompt. They neither send terminal
-- input nor mutate host-side goals until the player chooses Send.
function Core.GuidePrompt(kind, reference, detail)
    reference = type(reference) == "string" and reference:match("^%s*(.-)%s*$") or ""
    if kind == "quest" or kind == "loot" then
        local linkKind = kind == "quest" and "quest" or "item"
        reference = reference:match("|H" .. linkKind .. ":(%d+)[^|]*|h") or reference
    end
    if #reference > 160 or not ns.Pixel.ValidText(reference) then
        return nil, "Use a name, link or ID up to 160 bytes, without control characters."
    elseif kind == "rehearse" then
        if detail and detail ~= "tank" and detail ~= "healer" and detail ~= "damage" then
            return nil, "Choose tank, healer or damage."
        end
        local role = detail and (" My chosen role is " .. detail .. ".")
            or " Ask me to choose tank, healer or damage before starting a briefing."
        if reference == "" then
            return "Show the dungeons supported by Witchcraft's local rehearsal guide and let me choose one." .. role
                .. " These are reference lessons, not verified Forever mechanics. Do not mark anything completed."
        end
        return "Help me rehearse dungeon: " .. reference .. "." .. role
            .. " Use Witchcraft's local rehearsal guide. Start with the first brief, then let me choose the next step or a quiz."
            .. " Keep quiz answers hidden until I answer or request them. Ask if the dungeon is ambiguous; state unsupported or"
            .. " unverified Forever details. Rehearsal does not prove a dungeon clear or earn a passport stamp."
    elseif kind == "nearby" then
        local where = reference ~= "" and ("in zone: " .. reference .. ".")
            or "in my current zone, using fresh character context. Ask my zone if that context is unavailable or historical."
        return "Suggest interesting detours " .. where
            .. " Use Witchcraft's local adventure guide and my personal passport. Start with spoiler-light hints and explain why"
            .. " each fits. Do not invent proximity, routes or travel times. State missing references and unverified Forever details."
    elseif kind == "passport" then
        return "Show my personal adventure passport, active campaigns and supported campaigns I can choose."
            .. " Explain which milestones are user-confirmed and which remain unknown. Only my explicit confirmation can add"
            .. " a completion stamp; a lesson, suggested detour or tracked quest objective is not proof. Do not change my passport."
    end
    if kind == "quest" then
        if reference == "" then return nil, "Enter a quest name, link or ID first." end
        detail = detail or "hint"
        local levels = {
            hint = "Give me only a small nudge. Keep the solution and story spoilers hidden.",
            details = "Explain blockers and prerequisites; keep walkthrough and story spoilers hidden.",
            solution = "I explicitly want the full available solution.",
        }
        if not levels[detail] then return nil, "Choose nudge, details or solution." end
        return "Help me with quest: " .. reference .. ". " .. levels[detail]
            .. " Use Witchcraft's local reference guide and my current character and tracked quest context."
            .. " Ask which quest step if the title is ambiguous. State unknown requirements and unverified Forever details;"
            .. " absence from tracked quests does not prove completion."
    elseif kind == "loot" then
        if reference == "" then
            return "Show my saved loot plan from the personal profile. Use Witchcraft's local reference guide and my current character context. "
                .. "Suggest the dungeon or source that advances several active goals. Keep acquired goals separate. "
                .. "State missing sources and unverified Forever availability; this guide is partial."
        end
        return "Save this item as an active loot goal in my personal profile: " .. reference .. ". Ask which item if ambiguous. "
            .. "Use Witchcraft's local reference guide and my current character context to show sources shared by my active goals. "
            .. "State missing sources and unverified Forever availability; this guide is partial. Do not invent drop rates."
    end
    return nil, "Unknown guide action."
end

function methods:OpenGuide()
    if not self.active then return false, "Witchcraft is not active." end
    self:EnsureView(); self:SetVisible(true)
    if not self.view or not self.view.TogglePanel then return false, "Guide view is unavailable." end
    if self.view.openPanel ~= "guide" then self.view:TogglePanel("guide") end
    return true
end

function methods:ComposeGuide(kind, reference, detail)
    if not self.active then return false, "Witchcraft is not active." end
    local prompt, reason = Core.GuidePrompt(kind, reference, detail)
    if not prompt then return false, reason end
    self:EnsureView(); self:SetVisible(true)
    if not self.view or not self.view.Prefill then return false, "Guide view is unavailable." end
    return self.view:Prefill(prompt)
end

-- A bounded diagnostic trace of the transport: chunk loads and refusals, carrier writes and
-- acknowledgements. It is saved with SavedVariables so it can be read after a reload, and
-- `/witch trace` prints its tail. `key` lets a repeating refusal be recorded once per change.
local TRACE_LINES = 600
function methods:Trace(text, key)
    key = key or "line"
    self.traced = self.traced or {}
    if self.traced[key] == text then return end
    self.traced[key] = text
    local log = self.global.trace
    if type(log) ~= "table" then return end
    log[#log + 1] = string.format("%.1f %s", self:ContextNow(), tostring(text):sub(1, 180))
    while #log > TRACE_LINES do table.remove(log, 1) end
end

function methods:Setting(key) return self.global.settings[key] end

-- One validated change from the Options page or a slash command, applied at once.
function methods:SetSetting(key, value)
    if not validSetting(key, value) then return false, "Invalid value for " .. tostring(key) end
    if self.global.settings[key] == value then return true end
    self.global.settings[key] = value
    if key == "minimap" and self.api.SetMinimapShown then self.api.SetMinimapShown(value) end
    if key == "combatUpdates" and value and self.active and self:Combat() then self:Schedule("load", 0.2, self.LoadTick) end
    self:Render()
    return true
end

-- The client refuses to open its Options panel in combat.
function methods:OpenSettings()
    if self:Combat() then self:Print("Witchcraft settings open after combat"); return false end
    if not self.api.OpenSettings or not self.api.OpenSettings() then
        self:Print("Witchcraft settings are in Esc > Options > AddOns > Witchcraft"); return false
    end
    return true
end

-- Keybinding actions: open and type, switch tab, interrupt the selected agent.
function methods:FocusInput()
    self:SetVisible(true)
    if self.view and self.view.FocusInput then self.view:FocusInput() end
    return true
end
function methods:NextTab() return self:SelectTab(self.global.activeTab == "claude" and "codex" or "claude") end
function methods:Interrupt() return self:Action(self.global.activeTab, "interrupt") end

-- Saved prompts for the "/" menu. They are the player's words, bounded like any prompt.
function methods:AddSnippet(text)
    text = type(text) == "string" and text:gsub("^%s+", ""):gsub("%s+$", "") or ""
    if text == "" or #text > 600 or text:find("[%z\1-\31\127]") then return false, "A snippet is 1 to 600 characters on one line" end
    if #self.global.snippets >= 20 then return false, "Twenty snippets are saved; remove one first" end
    self.global.snippets[#self.global.snippets + 1] = text
    self:Render()
    return true
end
function methods:RemoveSnippet(index)
    if type(index) ~= "number" or not self.global.snippets[index] then return false, "No snippet " .. tostring(index) end
    table.remove(self.global.snippets, index)
    self:Render()
    return true
end

function methods:SelectTab(tab)
    if tab ~= "claude" and tab ~= "codex" then return false end
    self.global.activeTab = tab
    self:Render()
    return true
end

-- Positive delta shows older rows, including live rows cropped by a short window.
function methods:Scroll(tab, delta)
    if self.scroll[tab] == nil or not finite(delta, -math.huge, math.huge) then return false end
    local offset = math.max(0, math.min(self:ScrollMaximum(tab), math.floor(self.scroll[tab] + delta)))
    if offset == self.scroll[tab] then return true end
    self.scroll[tab] = offset
    self:Render()
    return true
end

function methods:ScrollToBottom(tab)
    if self.scroll[tab] == nil then return false end
    if self.scroll[tab] == 0 then return true end
    self.scroll[tab] = 0
    self:Render()
    return true
end

function methods:SaveView(value)
    if not validView(value) then return false end
    local copy = {}
    for _, key in ipairs({ "point", "relativePoint", "x", "y", "width", "height", "minimized" }) do copy[key] = value[key] end
    self.global.view = copy
    self:Render()
    return true
end

function methods:SetFontSize(value)
    if not integer(value, 8, 20) then return false, "Font size must be 8 to 20" end
    self.global.fontSize = value
    self:Render()
    return true
end

function methods:SetOpacity(value)
    if not finite(value, 0, 100) then return false, "Background opacity must be 0 to 100 percent" end
    value = math.floor(value + 0.5)
    if self.global.opacity == value then return true end
    self.global.opacity = value
    self:Render()
    return true
end

function methods:Queue(tab, action, text)
    if not self.active or not self.connected or not epoch(self.global.epoch) then return false, "Wait for the terminal host" end
    -- Refused here, where the player sees why, rather than acknowledged by the daemon and dropped.
    for _, session in ipairs(self.sessions) do
        local stopped = session.id == tab and stoppedStatus(session.status)
        if stopped then return false, "That terminal has " .. stopped end
    end
    if #self.global.outbox >= 64 then return false, "Outbox full (64); wait for acknowledgements" end
    if self.global.nextId > 262143 then return false, "Message ID limit reached; pending messages are preserved" end
    local message = { epoch = self.global.epoch, id = self.global.nextId, tab = tab, action = action, text = text or "" }
    if not validMessage(message) then return false, "Choose a tab and enter 1 to 600 bytes without control characters" end
    local frames, reason = ns.Pixel.Encode(message)
    if not frames then return false, reason end
    self.global.outbox[#self.global.outbox + 1] = message
    -- Resume this same snapshot part under a fresh transport ID after input;
    -- its capture age must include any time the user occupies the pixel lane.
    self.contextPending = nil
    self.global.nextId = self.global.nextId + 1
    self.notice = nil
    self.ring.delay = self.ring.baseDelay
    -- Input targets the live prompt, so the reply lands where the reader is looking.
    self.scroll[message.tab] = 0
    self:Render()
    self:Schedule("pixel", 0.2, self.PixelTick)
    if self.binding then self:Schedule("binding", 0, self.BindingTick) end
    if not self:InboundPaused() then self:Schedule("load", math.min(1, self.ring.baseDelay), self.LoadTick) end
    return true
end

function methods:Send(tab, text) return self:Queue(tab, "text", text) end

-- A long or multi-line prompt crosses the carriers as ordinary text parts: newlines become LINE
-- SEPARATOR and every part but the last starts with INVISIBLE SEPARATOR, which the daemon's outbox
-- joins into one paste. Parts end on UTF-8 boundaries, and the whole prompt queues or none of it.
local LINE, MORE, PART_BYTES, MAX_PARTS = "\226\128\168", "\226\129\163", 580, 8
function methods:SendLong(tab, text)
    if type(text) ~= "string" then return false, "Nothing to send" end
    text = text:gsub("\r\n?", "\n"):gsub("[%z\1-\9\11-\31\127]", ""):gsub("^%s+", ""):gsub("%s+$", ""):gsub("\n", LINE)
    if text == "" then return false, "Nothing to send" end
    if not text:find(LINE, 1, true) and #text <= 600 then return self:Send(tab, text) end
    local parts, position = {}, 1
    while position <= #text do
        local stop = math.min(#text, position + PART_BYTES - 1)
        while stop < #text and stop > position do
            local following = text:byte(stop + 1)
            if following < 128 or following >= 192 then break end
            stop = stop - 1
        end
        parts[#parts + 1] = text:sub(position, stop); position = stop + 1
    end
    if #parts > MAX_PARTS then return false, "Too long: a prompt is at most about 4,600 bytes" end
    if not self.active or not self.connected then return false, "Wait for the terminal host" end
    if #self.global.outbox + #parts > 64 then return false, "Outbox full (64); wait for acknowledgements" end
    for i, part in ipairs(parts) do
        local ok, reason = self:Queue(tab, "text", (i < #parts and MORE or "") .. part)
        if not ok then return false, reason end
    end
    return true
end
function methods:Action(tab, action) return self:Queue(tab, action, "") end

-- Answer the menu a tab is waiting on: move from its marked option to `index`, then Enter. Only
-- keys every CLI takes are used, and the whole answer is refused unless it fits the outbox.
function methods:Choose(tab, index)
    local choices
    for _, session in ipairs(self.sessions) do
        if session.id == tab and session.state == "waiting" then
            -- A closed console keeps its last screen, menu included, but nothing typed reaches it now.
            local stopped = stoppedStatus(session.status)
            if stopped then return false, "That terminal has " .. stopped end
            choices = session.choices
        end
    end
    if not choices or type(index) ~= "number" or index ~= math.floor(index) or index < 1 or index > #choices.options then
        return false, "That choice is no longer on screen"
    end
    -- Keys still on their way, or a second click on the menu already answered, would otherwise
    -- land on whatever the terminal shows next, such as the next permission prompt.
    local busy = self:AnswerPending(tab)
    if busy then return false, busy end
    local moves = index - choices.selected
    if #self.global.outbox + math.abs(moves) + 1 > 64 then return false, "Outbox full (64); wait for acknowledgements" end
    for _ = 1, math.abs(moves) do
        local ok, reason = self:Queue(tab, moves > 0 and "down" or "up", "")
        if not ok then return false, reason end
    end
    local ok, reason = self:Queue(tab, "enter", "")
    if ok then
        self.answered[tab] = { id = self.global.outbox[#self.global.outbox].id, choices = choiceKey(choices) }
        self:Render()
    end
    return ok, reason
end

-- Why a tab's choice buttons cannot be used right now, or nil. Any of its input still queued
-- comes first. After the answer is delivered, the menu counts as answered until the terminal
-- shows a different menu or none; a changing timer line elsewhere on screen does not count.
-- An identical menu ANSWER_SETTLE seconds after delivery is a new question (the next of several
-- parallel tool calls, or the CLI ignoring the keys), since a CLI takes milliseconds to redraw.
function methods:AnswerPending(tab)
    for _, message in ipairs(self.global.outbox) do
        if message.tab == tab and message.epoch == self.global.epoch then return "Input for this tab is still on its way" end
    end
    local mark = self.answered[tab]
    if not mark then return nil end
    if mark.ackedAt and self:ContextNow() - mark.ackedAt >= ANSWER_SETTLE then self.answered[tab] = nil; return nil end
    return "Already answered; waiting for the terminal"
end

function methods:Resend()
    if not self.connected or not epoch(self.global.epoch) then return false, "Wait for the terminal host" end
    local count = 0
    for _, message in ipairs(self.global.outbox) do if message.epoch ~= self.global.epoch then count = count + 1 end end
    if self.global.nextId + count - 1 > 262143 then return false, "Message ID limit reached" end
    for _, message in ipairs(self.global.outbox) do
        if message.epoch ~= self.global.epoch then
            message.epoch, message.id = self.global.epoch, self.global.nextId
            self.global.nextId = self.global.nextId + 1
        end
    end
    table.sort(self.global.outbox, function(a, b) return a.id < b.id end)
    self.pixelFrames, self.pixelMessage, self.pixelIndex = nil, nil, nil
    self.ring.delay = self.ring.baseDelay
    self.notice = "Requeued " .. count .. " message(s) for the current host"
    self:Schedule("pixel", 0.2, self.PixelTick)
    if self.binding then self:Schedule("binding", 0, self.BindingTick) end
    if not self:InboundPaused() then self:Schedule("load", 1, self.LoadTick) end
    self:Render()
    return true
end

function methods:ReceiveChunk(payload)
    -- A generated slot runs synchronously inside LoadAddOn. Random global calls,
    -- delayed callbacks, and duplicate callbacks cannot overwrite the live screen.
    if not self.active or not self.loading or self.loading.generation ~= self.generation then return false end
    if self.loading.received then return false end
    self.loading.received = true
    local result = self.ring:OnChunk(payload)
    if not result.accepted then return false end
    self.global.nextSeq, self.global.ringSize = self.ring.nextSeq, self.ring.ringSize
    if result.placeholder then
        if self.everLinked then self.stalled, self.ring.delay = true, math.min(self.ring.delay, PAUSED_RETRY) end
        self.connected, self.contextProtocol = false, nil
        self:ClearContext("Waiting for host"); self:Render(); return true
    end
    local global = self.global
    global.epoch, global.ack, global.reloadAwaitHost = result.epoch, result.ack, false
    global.nextId = math.max(global.nextId, result.ack + 1)
    if self.binding then
        local accepted, kind = self.binding:AcceptHost(result)
        if accepted and kind == "probe" then self:Print("Witchcraft binding carrier proved host decode, ACK, and exact cleanup") end
    end
    self:AcceptCooldownHost(result)
    local retained = {}
    for _, message in ipairs(global.outbox) do
        if message.epoch ~= result.epoch or message.id > result.ack then retained[#retained + 1] = message end
    end
    global.outbox = retained
    for _, session in ipairs(result.sessions) do
        local id, text = session.id, screenText(session.lines)
        -- A new host session is a new terminal: an answer recorded for the old one does not carry over.
        local mark = self.answered[id]
        if mark and result.newEpoch then self.answered[id] = nil
        elseif mark then
            if not mark.ackedAt and (result.ack or 0) >= mark.id then
                mark.ackedAt = self:ContextNow()
                -- Nothing else may render once the settle time passes, so the buttons would stay away.
                self:Schedule("answer-" .. id, ANSWER_SETTLE, self.Render)
            end
            if mark.ackedAt and (session.state ~= "waiting" or choiceKey(session.choices) ~= mark.choices) then self.answered[id] = nil end
        end
        if result.newEpoch or self.screenText[id] == nil then
            self.unread[id] = false
        elseif text ~= self.screenText[id] then
            -- A terminal redraw is output activity, not proof that an assistant
            -- has completed a response. Only an expanded visible tab is read.
            self.unread[id] = not (self.visible and global.view.minimized ~= true and global.activeTab == id)
        end
        self.screenText[id] = text
        -- A tab that starts waiting on a choice, or stops working, wants the player unless they are
        -- already looking at it. A new host session sets the baseline without announcing it.
        local previous, now = self.agentStates[id], session.state
        local looking = self.visible and global.view.minimized ~= true and global.activeTab == id
        if not result.newEpoch and previous and now ~= previous and not looking then
            local kind = now == "waiting" and "waiting" or (now == "idle" and previous == "working" and "done") or nil
            local settings = global.settings
            if kind == "done" and settings.alertFinished == false then kind = nil end
            if kind then
                self.attention[id] = kind
                local notice, sound = settings.alertText ~= false, settings.alertSound ~= false
                if (notice or sound) and self.view and self.view.Alert then self.view:Alert(id, kind, { text = notice, sound = sound }) end
            end
        end
        if now ~= "waiting" and self.attention[id] == "waiting" then self.attention[id] = false end
        self.agentStates[id] = now
    end
    self.sessions, self.cols, self.rows = result.sessions, result.cols, result.rows
    -- A reader parked in history keeps its own rows: every line that left the daemon's viewport
    -- since the last chunk pushes the window one row further from the bottom. A counter that went
    -- backwards is a daemon that started counting again, and moves nothing.
    for _, session in ipairs(result.sessions) do
        local id, scrolled = session.id, session.scrolled or 0
        if self.scroll[id] and self.scroll[id] > 0 and scrolled > (self.scrolledAt[id] or 0) then
            self.scroll[id] = self.scroll[id] + (scrolled - self.scrolledAt[id])
        end
        self.scrolledAt[id] = scrolled
    end
    for tab in pairs(self.scroll) do self.scroll[tab] = math.min(self.scroll[tab], self:ScrollMaximum(tab)) end
    self.connected, self.notice, self.everLinked, self.stalled = true, nil, true, false
    self:ResetHeartbeatBackoff()
    self:AcceptContext(result)
    self:Render()
    return true
end

function methods:MaybeReload()
    if not self.active or self:Combat() or self.reloading then return false end
    if self.ring.accepted == 0 or self.global.reloadAwaitHost then
        self.notice = "Ring exhausted without a fresh host. Start host, then /witch reset"
        self:Render()
        return false
    end
    self:Print("Witchcraft ring exhausted; reloading once outside combat")
    self.global.reloadAwaitHost, self.reloading = true, true
    self:CancelTimer("load")
    self:OfferHeartbeat()
    if self.api.ReloadUI then self.api.ReloadUI() end
    return true
end

function methods:LoadTick()
    if not self:WantStream() or self.reloading then return end
    if self:InboundPaused() then self:Render(); return end
    if self.ring:Exhausted() then self:MaybeReload(); return end
    local seq, name = self.ring:Next()
    local generation = self.generation
    self.loading = { generation = generation, seq = seq }
    local ok, loaded = false, false
    if self.api.LoadAddOn then ok, loaded = pcall(self.api.LoadAddOn, name) end
    if not self.active or self.generation ~= generation then return end
    if loaded ~= true and self.api.IsAddOnLoaded then
        local queried, result = pcall(self.api.IsAddOnLoaded, name)
        loaded = queried and result == true
    end
    if not self.active or self.generation ~= generation then return end
    self.loading = nil
    -- Before Consumed overwrites it, the ring's status names why a loaded slot was not accepted.
    local refused = self.ring.nextSeq == seq
    if refused then
        self:Trace(string.format("slot %d %s: %s", seq, loaded and "refused" or "not loaded", tostring(self.ring.status)))
    else self:Trace(string.format("slot %d accepted", seq)) end
    self.ring:Consumed(seq, loaded == true)
    -- A slot the host has not written yet, after a live session, means it cannot hear this client:
    -- WoW is in the background and the strip is unreadable. That is a pause, not an error, and the
    -- next slot is tried soon so the link returns within a couple of seconds of coming back.
    if refused and loaded == true and self.everLinked then
        self.stalled, self.ring.delay = true, math.min(self.ring.delay, PAUSED_RETRY)
    end
    if not ok then self.notice = "Chunk load failed; retrying safely" end
    self.global.nextSeq, self.global.ringSize = self.ring.nextSeq, self.ring.ringSize
    self:OfferHeartbeat()
    self:Render()
    if self:WantStream() then
        self:Schedule("load", self.ring.delay, self.LoadTick)
    else
        self:CancelTimer("pixel")
        if self.view then self.view:RenderStrip(nil, nil) end
    end
end

function methods:PixelTick()
    if not self:WantStream() then
        if self.view then self.view:RenderStrip(nil, nil) end
        return
    end
    local colors
    if self.calibrating then
        colors = ns.Pixel.Calibration()
    else
        local message = self:PendingInput()
        if message then
            local key = message.epoch .. ":" .. message.id
            if self.pixelMessage ~= key then
                self.pixelMessage, self.pixelFrames, self.pixelIndex = key, ns.Pixel.Encode(message), 1
            end
            if self.pixelFrames then
                colors = self.pixelFrames[self.pixelIndex]
                self.pixelIndex = self.pixelIndex % #self.pixelFrames + 1
            end
        else
            self.pixelMessage, self.pixelFrames, self.pixelIndex = nil, nil, nil
            local pending = self.contextPending
            -- The strip stands aside while the cooldown carrier owns the context lane, as the
            -- binding lane already does; otherwise both send the same snapshot.
            if pending and not pending.retryAt and self:ContextNow() - pending.createdAt < 30
                and self.connected and self.contextProtocol == 4 and not self:CooldownActive() then
                colors = pending.frames[pending.index]
                pending.index, pending.sent = pending.index % #pending.frames + 1, pending.sent + 1
                if pending.sent >= #pending.frames * 3 then pending.retryAt = self:ContextNow() + 10 end
            end
        end
    end
    local heartbeat = ns.Pixel.Heartbeat(self.global.epoch or "00000000", self.ring.nextSeq, self:HeartbeatFlags(), self.uiNonce)
    if self.view then self.view:RenderStrip(colors, heartbeat) end
    self:Schedule("pixel", 0.2, self.PixelTick)
end

function methods:BindingTick()
    if not self.active or not self.binding or self.binding.quarantined then return end
    if not self:Combat() and self.binding.enabled and not self.binding.active and not self.binding.outstanding then
        local message = self:PendingInput()
        if message then self.binding:OfferInput(message)
        elseif self.contextPending and not self:CooldownActive() then
            self.binding:OfferContext({ epoch = self.contextPending.epoch, uiNonce = self.contextPending.uiNonce,
                id = self.contextPending.id, text = self.contextPending.text })
        end
    end
    self.binding:Pump(self.ring.nextSeq)
    if self.binding:Busy() or self.binding.enabled then self:Schedule("binding", 1, self.BindingTick) end
end

function methods:StopBurstProbe()
    self:CancelTimer("burst")
    self.burstProbe = nil
    if self.view then self.view:RenderBurst(nil) end
end

function methods:BurstTick()
    local probe = self.burstProbe
    if not self.active or not probe then return end
    self:EnsureView()
    if self.view then self.view:RenderBurst(probe.pages[probe.page]) end
    probe.page = probe.page % #probe.pages + 1
    self:Schedule("burst", probe.dwell, self.BurstTick)
end

function methods:StartBurstProbe(milliseconds, corrupt)
    if not self.active then return false, "Witchcraft is not active" end
    if milliseconds == nil then milliseconds = 1000 end
    if not integer(milliseconds, 200, 2000) then return false, "Burst dwell expects 200-2000 milliseconds" end
    local hostEpoch = epoch(self.global.epoch) and self.global.epoch or self.uiNonce
    local pages, reason = ns.Pixel.BurstProbe(hostEpoch, self.uiNonce, corrupt == true)
    if not pages then return false, reason or "Could not build burst probe" end
    self:CancelTimer("burst")
    self.burstProbe = { pages = pages, page = 1, dwell = milliseconds / 1000, corrupt = corrupt == true }
    self:BurstTick()
    self:Schedule("pixel", 0.2, self.PixelTick)
    return true
end

function methods:OnEvent(event)
    if not self.active then return end
    if event == "UPDATE_BINDINGS" then
        if self.binding then self.binding:OnBindingsChanged() end
    elseif event == "PLAYER_REGEN_DISABLED" then
        -- No heartbeat is offered here: the carrier's gate refuses every write in combat.
        -- With "keep updating in combat" on, the load timer is the only thing that re-arms
        -- itself, so it keeps running; the setting is read rather than InCombatLockdown, which
        -- may not be true yet inside this event.
        if self.global.settings.combatUpdates ~= true then self:CancelTimer("load") end
    elseif event == "PLAYER_REGEN_ENABLED" then
        if self.resetRequested then self:Reset(); return end
        self:OfferHeartbeat()
        if self:WantStream() then self:Schedule("load", 1, self.LoadTick) end
        if self.binding and (self.binding:Busy() or self.binding.enabled) then self:Schedule("binding", 0, self.BindingTick) end
    end
    self:Render()
end

function methods:Reset()
    if self:Combat() then self.resetRequested = true; self:Print("Witchcraft reset waits until combat ends"); return false end
    self.resetRequested, self.global.reloadAwaitHost, self.reloading = nil, false, true
    self:CancelTimer("load")
    self:OfferHeartbeat()
    if self.api.ReloadUI then self.api.ReloadUI() end
    return true
end

-- /witch errors prints the stored count and the newest entry; /witch errors clear empties the store.
function methods:ListErrors(arg)
    if not self.errors then self:Print("Lua error capture is unavailable"); return end
    if arg == "clear" then self.errors:Clear(); self:Print("Errors cleared"); return end
    local list = self.errors:Newest()
    if #list == 0 then self:Print("No Lua errors stored"); return end
    local newest = list[1]
    local reloads = (self.errors.session or 0) - (newest.session or 0)
    self:Print(string.format("Lua errors: %d stored; newest (%s x%d, %s):", #list, newest.kind, newest.count,
        reloads == 0 and "this session" or (reloads .. " reload" .. (reloads == 1 and "" or "s") .. " ago")))
    self:Print(newest.message)
    if newest.stack[1] then self:Print(newest.stack[1]) end
end

function methods:HandleSlash(input)
    self:ResetHeartbeatBackoff()
    local command, arg = (input or ""):match("^%s*(%S*)%s*(.-)%s*$")
    command = command:lower()
    if command == "" then self:Toggle()
    elseif command == "guide" then
        local ok, reason = self:OpenGuide(); if not ok then self:Print(reason) end
    elseif command == "quest" then
        if arg == "" then
            local ok, reason = self:OpenGuide(); if not ok then self:Print(reason) end
        else
            local mode, reference = arg:match("^(%S+)%s+(.+)$")
            local details = { nudge = "hint", hint = "hint", details = "details", solution = "solution" }
            local detail = mode and details[mode:lower()]
            local ok, reason = self:ComposeGuide("quest", detail and reference or arg, detail or "hint")
            if not ok then self:Print(reason) end
        end
    elseif command == "loot" then
        local ok, reason = self:ComposeGuide("loot", arg); if not ok then self:Print(reason) end
    elseif command == "rehearse" then
        local first, rest = arg:match("^(%S+)%s*(.-)%s*$")
        local role = first and first:lower()
        if role ~= "tank" and role ~= "healer" and role ~= "damage" then role = nil end
        local ok, reason = self:ComposeGuide("rehearse", role and rest or arg, role)
        if not ok then self:Print(reason) end
    elseif command == "nearby" then
        local ok, reason = self:ComposeGuide("nearby", arg); if not ok then self:Print(reason) end
    elseif command == "passport" then
        local ok, reason = self:ComposeGuide("passport", ""); if not ok then self:Print(reason) end
    elseif command == "snippet" or command == "snippets" then
        local action, rest = arg:match("^(%S*)%s*(.-)%s*$")
        action = (action or ""):lower()
        if action == "add" then
            local ok, reason = self:AddSnippet(rest); self:Print(ok and ("Snippet " .. #self.global.snippets .. " saved") or reason)
        elseif action == "remove" then
            local ok, reason = self:RemoveSnippet(tonumber(rest)); self:Print(ok and "Snippet removed" or reason)
        else
            if #self.global.snippets == 0 then self:Print("No snippets. /witch snippet add <prompt>") end
            for i, snippet in ipairs(self.global.snippets) do self:Print(i .. ". " .. snippet) end
        end
    elseif command == "trace" then
        local log = self.global.trace
        if #log == 0 then self:Print("Trace is empty") end
        for i = math.max(1, #log - 24), #log do self:Print(log[i]) end
    elseif command == "errors" then
        self:ListErrors(arg)
    elseif command == "settings" or command == "options" then
        self:OpenSettings()
    elseif command == "size" then
        local ok, reason = self:SetFontSize(tonumber(arg)); if not ok then self:Print(reason) end
    elseif command == "opacity" then
        local ok, reason = self:SetOpacity(tonumber(arg)); if not ok then self:Print(reason) end
    elseif command == "context" then
        if arg == "on" or arg == "off" then self:SetContextEnabled(arg == "on")
        elseif arg == "refresh" then local ok, reason = self:RefreshContext(); if not ok then self:Print(reason) end
        else self:Print("WoW context: " .. self:Snapshot().context.status .. "; /witch context on|off|refresh") end
    elseif command == "hz" then
        local ok, reason = self.ring:SetHz(tonumber(arg))
        if ok then self.global.hz = tonumber(arg) else self:Print(reason) end
    elseif command == "calibrate" then
        self.calibrating = arg ~= "off"
        self:Schedule("pixel", 0.2, self.PixelTick)
    elseif command == "burstprobe" then
        if arg == "off" then
            self:StopBurstProbe(); self:Print("Burst carrier probe hidden")
        else
            local corrupt, dwell = arg == "corrupt", tonumber(arg)
            if arg == "" or corrupt then dwell = 1000 end
            if arg ~= "" and not corrupt and dwell == nil then
                self:Print("Burst dwell expects 200-2000 milliseconds, corrupt, or off")
            else
                local ok, reason = self:StartBurstProbe(dwell, corrupt)
                if ok then
                    self:Print("Burst carrier probe active; run witchcraft burst-probe, then /witch burstprobe off")
                else self:Print(reason) end
            end
        end
    elseif command == "bindprobe" then
        if not self.binding then self:Print("Binding carrier APIs are unavailable")
        else
            local ok, reason = self.binding:Probe(self.uiNonce)
            if ok then
                self:Print("Binding carrier canary armed; one verified-empty key will be restored after host ACK")
                self:Schedule("binding", 0, self.BindingTick)
                self:Schedule("load", 0.2, self.LoadTick)
            else self:Print(reason) end
        end
    elseif command == "reset" or command == "reload" then self:Reset()
    elseif command == "resend" then
        local ok, reason = self:Resend(); if not ok then self:Print(reason) end
    elseif command == "status" then
        local snapshot = self:Snapshot()
        self:Print(string.format("Witchcraft %s / %s / ring %d/%d / queued %d / host %s / UI %s", BUILD,
            snapshot.status, snapshot.seq, snapshot.ringSize, snapshot.queued, self.global.epoch or "none", self.uiNonce))
        local detail = snapshot.cooldown.reason or snapshot.cooldown.quarantined
        local cooldown = snapshot.cooldown.status .. (detail and (" (" .. detail .. ")") or "")
        self:Print(string.format("Witchcraft lanes: binding %s | cooldown %s", snapshot.binding.status or "?", cooldown))
    else
        self:Print("/witch | guide | quest [nudge|details|solution] <name/id> | loot [name/id]"
            .. " | rehearse [tank|healer|damage] [dungeon] | nearby [zone] | passport"
            .. " | size 8-20 | opacity 0-100 | context on|off|refresh | hz 0.125-2"
            .. " | calibrate [off] | burstprobe [200-2000|corrupt|off] | bindprobe | status | resend | reset")
    end
end

-- AceAddon invokes this at our own SavedVariables initialization boundary.
if LibStub then
    local Witchcraft = LibStub("AceAddon-3.0"):NewAddon("Witchcraft", "AceConsole-3.0")
    ns.Addon = Witchcraft
    -- Kept off the addon object: GetAddon("Witchcraft") is public to every addon, and the controller
    -- queues terminal input. (Other addons can still drive Witchcraft's UI; see PROTOCOL.md.)
    local controller
    function Witchcraft:OnInitialize()
        self:RegisterChatCommand("witch", "HandleSlash")
        -- The addon was Familiar until 2026-09-24; its old command keeps working.
        self:RegisterChatCommand("fam", "HandleSlash")
        local valid, reason = Persistence.Validate(_G.WitchcraftDB)
        if not valid then self.storageError = reason; self:Print(reason .. "; database preserved, Witchcraft disabled"); return end
        -- Keep schema explicit: AceDB removes values equal to declared defaults
        -- at logout, so an owned schema marker must not itself be a default.
        self.db = LibStub("AceDB-3.0"):New("WitchcraftDB", { global = {} }, true)
        local addon, settingsCategory = self, nil
        controller = Core.New(self.db.global, {
            -- The Options page and the minimap button belong to the addon object; Core reaches them here.
            OpenSettings = function()
                local panel = _G.Settings
                if not settingsCategory or not (panel and panel.OpenToCategory) then return false end
                panel.OpenToCategory(settingsCategory); return true
            end,
            SetMinimapShown = function(shown)
                if addon.minimapButton then if shown then addon.minimapButton:Show() else addon.minimapButton:Hide() end end
            end,
            NewTimer = function(delay, callback) return C_Timer.NewTimer(delay, callback) end,
            LoadAddOn = function(name)
                local loader = (C_AddOns and C_AddOns.LoadAddOn) or LoadAddOn
                if loader then return loader(name) end
                return false
            end,
            IsAddOnLoaded = function(name)
                local query = (C_AddOns and C_AddOns.IsAddOnLoaded) or IsAddOnLoaded
                return query and query(name) or false
            end,
            InCombatLockdown = function() return InCombatLockdown and InCombatLockdown() or false end,
            ReloadUI = function() ReloadUI() end,
            Print = function(message) self:Print(message) end,
            CreateView = function(owner) return ns.View.Create(owner) end,
            GetTime = function() return GetTime() end,
            GetBindingAction = function(key) return GetBindingAction(key) end,
            SetBinding = function(key, action) return SetBinding(key, action) end,
            SaveBindings = function(bindingSet) return SaveBindings(bindingSet) end,
            GetCurrentBindingSet = function() return GetCurrentBindingSet() end,
        })
        settingsCategory = ns.Options and ns.Options.Register(controller)
        _G.BINDING_HEADER_WITCHCRAFT, _G.BINDING_NAME_WITCHCRAFT_TOGGLE = "Witchcraft", "Toggle terminal window"
        _G.BINDING_NAME_WITCHCRAFT_FOCUS = "Open and type a prompt"
        _G.BINDING_NAME_WITCHCRAFT_NEXTTAB = "Switch between Claude and Codex"
        _G.BINDING_NAME_WITCHCRAFT_INTERRUPT = "Interrupt the selected agent"
    end
    function Witchcraft:OnEnable()
        if not controller then return end
        if not self.events then
            self.events = CreateFrame("Frame")
            self.events:SetScript("OnEvent", function(_, event) controller:OnEvent(event) end)
        end
        self.events:RegisterEvent("PLAYER_REGEN_DISABLED")
        self.events:RegisterEvent("PLAYER_REGEN_ENABLED")
        self.events:RegisterEvent("UPDATE_BINDINGS")
        controller:Start()
        if not self.minimapButton then self.minimapButton = ns.MinimapButton.Create(function() self:Toggle() end) end
        if self.minimapButton then
            if controller:Setting("minimap") ~= false then self.minimapButton:Show() else self.minimapButton:Hide() end
        end
    end
    function Witchcraft:OnDisable()
        if self.events then self.events:UnregisterAllEvents() end
        if self.minimapButton then self.minimapButton:Hide() end
        if controller then controller:Stop() end
    end
    function Witchcraft:Toggle() if controller then controller:Toggle() end end
    function Witchcraft:FocusInput() if controller then controller:FocusInput() end end
    function Witchcraft:NextTab() if controller then controller:NextTab() end end
    function Witchcraft:Interrupt() if controller then controller:Interrupt() end end
    function Witchcraft:HandleSlash(input)
        if controller then controller:HandleSlash(input) else self:Print(self.storageError or "Witchcraft is not initialized") end
    end
    function Witchcraft_ReceiveChunk(payload)
        return controller and controller:ReceiveChunk(payload) or false
    end
end
