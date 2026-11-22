-- Prompt protocol 1. A group stays intact in the saved outbox until the host reports
-- its terminal write. The transport cursor may move independently through that group.
local _, ns = ...
local Prompts = {}
ns.Prompts = Prompts
-- Older hosts consume unknown control requests without typing their contents.
local CONTROL, MORE, LINE = "\226\129\162", "\226\129\163", "\226\128\168"
local PREFIX = CONTROL .. "P"
local PART_BYTES, MAX_PARTS = 580, 8

function Prompts.Reserved(text)
    return text:sub(1, 3) == CONTROL or text:sub(1, 3) == MORE or text:find(LINE, 1, true) ~= nil
end

function Prompts.Parts(text)
    if type(text) ~= "string" then return nil, "Nothing to send" end
    text = text:gsub("\r\n?", "\n")
    if not text:find("%S") then return nil, "Nothing to send" end
    if #text > 4640 then return nil, "Too long: a prompt is at most 4,640 bytes" end
    -- Escape the escape character as well, so literal separators and Unicode survive.
    local encoded = text:gsub("~", "~~"):gsub("\n", "~n")
    local parts, pos = {}, 1
    while pos <= #encoded do
        local stop = math.min(#encoded, pos + PART_BYTES - 1)
        while stop < #encoded and encoded:byte(stop + 1) >= 128 and encoded:byte(stop + 1) < 192 do
            stop = stop - 1
            if stop < pos then return nil, "Prompt contains invalid UTF-8" end
        end
        local body = encoded:sub(pos, stop)
        if not ns.Pixel.ValidText(body) then return nil, "Prompt contains invalid UTF-8 or a control character" end
        parts[#parts + 1], pos = body, stop + 1
        if #parts > MAX_PARTS then return nil, "Too long: a prompt must fit eight encoded parts" end
    end
    return parts
end

function Prompts.Frame(first, index, count, body)
    return PREFIX .. string.format("%05x%d%d:", first, index, count) .. body
end

function Prompts.Read(message)
    if message.action ~= "text" or message.text:sub(1, #PREFIX) ~= PREFIX then return nil end
    local first, index, count, body = message.text:match("^" .. PREFIX .. "(%x%x%x%x%x)([1-8])([1-8]):(.+)$")
    if not first then return nil end
    first, index, count = tonumber(first, 16), tonumber(index), tonumber(count)
    if not first or first < 1 or first + count - 1 > 262143 or index > count or first + index - 1 ~= message.id then return nil end
    return first, index, count, body
end

function Prompts.Text(bodies)
    return (table.concat(bodies):gsub("~(.)", function(value) return value == "n" and "\n" or value end))
end

-- Verify the identity and adjacency of every saved part before reconstructing a draft.
function Prompts.Group(outbox, member)
    local first, _, count = Prompts.Read(member)
    if not first then return nil end
    local bodies, rows = {}, {}
    for _, message in ipairs(outbox) do
        if message.id >= first and message.id < first + count then
            local group, part, total, body = Prompts.Read(message)
            if not message.prompt or message.tab ~= member.tab or message.epoch ~= member.epoch
                or group ~= first or total ~= count or part ~= #bodies + 1 then return nil end
            bodies[#bodies + 1], rows[message] = body, true
        end
    end
    if #bodies == count then return Prompts.Text(bodies), rows end
end

function Prompts.LegacyText(text)
    if text:sub(1, #MORE) == MORE then text = text:sub(#MORE + 1) end
    return (text:gsub(LINE, "\n"))
end
