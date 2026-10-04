-- Witchcraft protocol v1: bounded pure pixel encoding; the controller owns timers and rendering.
local _, ns = ...
local Pixel = {}
ns.Pixel = Pixel

local floor = math.floor
local ACTIONS = { text = 0, enter = 1, interrupt = 2, escape = 3, up = 4, down = 5 }
local TABS = { claude = 1, codex = 2 }
local MAX_ID, MAX_TEXT = 262143, 600
local BURST_ROWS, BURST_TEXT = 22, 560
local BURST_TOKEN = "WITCHCRAFT-BURST-PROBE|"

local function integer(value, minimum, maximum)
    return type(value) == "number" and value >= minimum and value <= maximum and value == floor(value)
end

local function epochValue(value, allowZero)
    if type(value) ~= "string" or #value ~= 8 or not value:match("^[%da-fA-F]+$") then return nil end
    if value == "00000000" and not allowZero then return nil end
    return value:lower()
end

-- Validate code points before sending. Lua 5.1 strings are bytes, not implicitly UTF-8.
local function validText(text)
    if type(text) ~= "string" or #text > MAX_TEXT then return false end
    local position = 1
    while position <= #text do
        local first = text:byte(position)
        local count, code, minimum
        if first < 128 then count, code, minimum = 1, first, 0
        elseif first >= 194 and first <= 223 then count, code, minimum = 2, first - 192, 128
        elseif first >= 224 and first <= 239 then count, code, minimum = 3, first - 224, 2048
        elseif first >= 240 and first <= 244 then count, code, minimum = 4, first - 240, 65536
        else return false end
        if position + count - 1 > #text then return false end
        for offset = 1, count - 1 do
            local byte = text:byte(position + offset)
            if byte < 128 or byte > 191 then return false end
            code = code * 64 + byte - 128
        end
        if code < minimum or code > 1114111 or (code >= 55296 and code <= 57343)
            or code < 32 or (code >= 127 and code <= 159) then return false end
        position = position + count
    end
    return true
end

Pixel.ValidText = validText

local function rgb(value)
    return { floor(value / 16) * 85, floor(value / 4) % 4 * 85, value % 4 * 85 }
end

local function encodeFrame(id, index, payload, final, sync)
    local values = { sync or 51, floor(id / 4096), floor(id / 64) % 64, id % 64, index, #payload + (final and 32 or 0) }
    local accumulator, bits = 0, 0
    for position = 1, 11 do
        accumulator = accumulator * 256 + (payload:byte(position) or 0)
        bits = bits + 8
        while bits >= 6 do
            bits = bits - 6
            values[#values + 1] = floor(accumulator / 2 ^ bits)
            accumulator = accumulator % 2 ^ bits
        end
    end
    values[#values + 1] = accumulator * 2 ^ (6 - bits)
    local check = 0
    for i = 1, 21 do check = (check + values[i] * i) % 64 end
    values[22] = check
    local colors = {}
    for i = 1, 22 do colors[i] = rgb(values[i]) end
    return colors
end

function Pixel.Encode(message)
    if type(message) ~= "table" then return nil, "Invalid message" end
    local epoch, text = epochValue(message.epoch), message.text
    if text == nil then text = "" end
    local route = message.tab
    if route == nil then route = message.session end
    local tab, action = TABS[route], ACTIONS[message.action]
    if not epoch or not integer(message.id, 1, MAX_ID) or not tab or action == nil or not validText(text)
        or (action ~= 0 and text ~= "") then return nil, "Invalid epoch, ID, tab, action or text" end
    local body = epoch .. tab .. action .. text
    local frames = {}
    for start = 1, #body, 11 do
        frames[#frames + 1] = encodeFrame(message.id, (start - 1) / 11, body:sub(start, start + 10), start + 10 >= #body)
    end
    return frames
end

-- Context has its own sync marker and session identity. Older terminal decoders
-- discard these frames; data is never represented as a terminal action.
function Pixel.EncodeContext(message)
    if type(message) ~= "table" then return nil, "Invalid context message" end
    local epoch, nonce = epochValue(message.epoch), epochValue(message.uiNonce)
    if not epoch or not nonce or not integer(message.id, 1, MAX_ID)
        or not validText(message.text) or #message.text > 580 then return nil, "Invalid bounded context envelope" end
    local body, frames = epoch .. nonce .. message.text, {}
    for start = 1, #body, 11 do
        frames[#frames + 1] = encodeFrame(message.id, (start - 1) / 11, body:sub(start, start + 10), start + 10 >= #body, 50)
    end
    return frames
end

-- Phase 0 carrier probe. A page is twenty-two unchanged v1 frames rendered as
-- rows beneath the live two-row strip. Black rows pad only the final page.
-- Keeping the existing row checksum and frame index makes torn screenshots
-- rejectable before any row reaches the normal terminal/context assemblers.
function Pixel.BurstProbeText()
    return string.rep(BURST_TOKEN, math.ceil(BURST_TEXT / #BURST_TOKEN)):sub(1, BURST_TEXT)
end

local function copyFrame(frame)
    if type(frame) ~= "table" or #frame ~= 22 then return nil end
    local copy = {}
    for index, color in ipairs(frame) do
        if type(color) ~= "table" or #color < 3 then return nil end
        copy[index] = { color[1], color[2], color[3] }
    end
    return copy
end

local function blackFrame()
    local frame = {}
    for index = 1, 22 do frame[index] = { 0, 0, 0 } end
    return frame
end

function Pixel.BurstPages(frames)
    if type(frames) ~= "table" or #frames < 1 or #frames > 64 then return nil, "Invalid burst frames" end
    local pages = {}
    for start = 1, #frames, BURST_ROWS do
        local page = {}
        for row = 1, BURST_ROWS do
            local source = frames[start + row - 1]
            if source then
                page[row] = copyFrame(source)
                if not page[row] then return nil, "Invalid burst frame" end
            else
                page[row] = blackFrame()
            end
        end
        pages[#pages + 1] = page
    end
    return pages
end

function Pixel.BurstProbe(epoch, uiNonce, corrupt)
    local frames, reason = Pixel.EncodeContext({
        epoch = epoch, uiNonce = uiNonce, id = MAX_ID, text = Pixel.BurstProbeText(),
    })
    if not frames then return nil, reason end
    local pages = Pixel.BurstPages(frames)
    if not pages then return nil, "Could not paginate burst probe" end
    if corrupt then
        local color = pages[1][1][7]
        color[1] = (color[1] + 85) % 340
    end
    return pages
end

local function hexBytes(value)
    return (value:gsub("..", function(pair) return string.char(tonumber(pair, 16)) end))
end

function Pixel.Heartbeat(epoch, nextSeq, flags, uiNonce)
    epoch = epochValue(epoch, true)
    if flags == nil then flags = 0 end
    if uiNonce == nil then uiNonce = "00000000" end
    uiNonce = epochValue(uiNonce, true)
    if not epoch or not uiNonce or not integer(nextSeq, 1, 65535) or not integer(flags, 0, 3) then return nil, "Invalid heartbeat" end
    return encodeFrame(0, 0, hexBytes(epoch) .. hexBytes(uiNonce) .. string.char(floor(nextSeq / 256), nextSeq % 256, flags), true)
end

function Pixel.Calibration()
    local colors = { { 255, 0, 0 }, { 0, 255, 0 }, { 0, 0, 255 }, { 255, 255, 255 }, { 0, 0, 0 } }
    for i = 0, 15 do colors[#colors + 1] = { i % 4 * 85, floor(i / 4) * 85, (i + 1) % 4 * 85 } end
    colors[22] = { 255, 0, 255 }
    return colors
end

local Queue = {}
Queue.__index = Queue

function Pixel.New(options)
    options = options or {}
    local limit = options.maxPending or 32
    assert(integer(limit, 1, 64), "Invalid pixel queue bound")
    return setmetatable({ items = {}, index = 1, limit = limit, epoch = nil, lastID = 0 }, Queue)
end

function Queue:Queue(message)
    local frames, reason = Pixel.Encode(message)
    if not frames then return false, reason end
    local epoch = message.epoch:lower()
    if #self.items >= self.limit then return false, "Pixel queue is full" end
    if self.epoch and self.epoch ~= epoch then return false, "Clear the queue before changing epoch" end
    if message.id <= self.lastID then return false, "Message IDs must increase without wrapping" end
    self.epoch, self.lastID = epoch, message.id
    self.items[#self.items + 1] = { epoch = epoch, id = message.id, frames = frames }
    return true
end

function Queue:Next()
    local item = self.items[1]
    if not item then return nil end
    local colors = item.frames[self.index]
    self.index = self.index % #item.frames + 1
    return colors
end

function Queue:Ack(id, epoch)
    local item = self.items[1]
    if not item or not integer(id, 1, MAX_ID) or item.id ~= id or item.epoch ~= epochValue(epoch) then return false end
    table.remove(self.items, 1)
    self.index = 1
    return true
end

function Queue:Pending() return #self.items end

function Queue:Clear()
    self.items, self.index, self.epoch, self.lastID = {}, 1, nil, 0
end
