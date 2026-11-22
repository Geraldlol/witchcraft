local ns, test, equal = ...
local Pixel = ns.Pixel

local function message(overrides)
    local item = { epoch = "0123abcd", id = 1, tab = "claude", action = "text", text = "hello" }
    for key, value in pairs(overrides or {}) do item[key] = value end
    return item
end

local function values(colors)
    local result = {}
    for i, color in ipairs(colors) do result[i] = color[1] / 85 * 16 + color[2] / 85 * 4 + color[3] / 85 end
    return result
end

test("pixel: fixed Lua/Node interoperability vector and literal pipes", function()
    local frames = assert(Pixel.Encode(message({ id = 262143, tab = "codex", text = "hi |T" })))
    local expected = {
        { 51, 63, 63, 63, 0, 11, 12, 3, 4, 50, 12, 54, 5, 34, 24, 54, 16, 50, 12, 6, 32, 49 },
        { 51, 63, 63, 63, 1, 36, 26, 18, 1, 60, 21, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 21 },
    }
    equal(#frames, 2)
    for n, frame in ipairs(frames) do
        equal(#frame, 22)
        for i, value in ipairs(values(frame)) do equal(value, expected[n][i]) end
    end
end)

test("pixel: UTF-8 limits, all actions and unexhausted IDs", function()
    equal(#assert(Pixel.Encode(message({ text = string.rep("x", 600) }))), 56)
    assert(Pixel.Encode(message({ text = "Привіт 🌕 |T \\\"" })))
    for _, action in ipairs({ "enter", "interrupt", "escape", "up", "down" }) do
        equal(#assert(Pixel.Encode(message({ action = action, text = "" }))), 1)
        equal(Pixel.Encode(message({ action = action, text = "no" })), nil)
    end
    for _, id in ipairs({ 0, -1, 262144, 1.5, math.huge }) do equal(Pixel.Encode(message({ id = id })), nil) end
end)

test("pixel: reject malformed UTF-8, terminal controls and unknown routes", function()
    local invalid = { string.rep("x", 601), "line\nnext", "\027[2J", "\127", "\194\128", "\192\175",
        "\237\160\128", "\244\144\128\128", "\240\128", "\128", "\0" }
    for _, text in ipairs(invalid) do equal(Pixel.Encode(message({ text = text })), nil) end
    for _, text in ipairs(invalid) do equal(Pixel.ValidText(text), false) end
    equal(Pixel.ValidText("Привіт 🌕"), true)
    equal(Pixel.Encode(message({ epoch = "00000000" })), nil)
    equal(Pixel.Encode(message({ tab = "unknown" })), nil)
    equal(Pixel.Encode(message({ action = "execute" })), nil)
    equal(Pixel.Encode(message({ text = false })), nil)
end)

test("pixel: heartbeat is one binary epoch/nonce cursor frame", function()
    local frame = assert(Pixel.Heartbeat("89ABCDEF", 9999, 3, "10203040"))
    local symbols = values(frame)
    equal(#symbols, 22); equal(symbols[1], 51)
    equal(symbols[2] + symbols[3] + symbols[4], 0); equal(symbols[5], 0); equal(symbols[6], 43)
    local bytes, bits, accumulator = {}, 0, 0
    for i = 7, 21 do
        accumulator, bits = accumulator * 64 + symbols[i], bits + 6
        if bits >= 8 then
            bits = bits - 8
            bytes[#bytes + 1] = math.floor(accumulator / 2 ^ bits)
            accumulator = accumulator % 2 ^ bits
        end
    end
    local expected = { 137, 171, 205, 239, 16, 32, 48, 64, 39, 15, 3 }
    for i, byte in ipairs(bytes) do equal(byte, expected[i]) end
    equal(Pixel.Heartbeat("bad", 1), nil); equal(Pixel.Heartbeat("0123abcd", 0), nil)
    equal(Pixel.Heartbeat("0123abcd", 1, 4), nil); equal(Pixel.Heartbeat("0123abcd", 1, 0, "bad"), nil)
    equal(Pixel.Heartbeat("0123abcd", 1, false), nil)
    assert(Pixel.Heartbeat("00000000", 1))
    assert(Pixel.Heartbeat("0123abcd", 10000, 2, "12345678"))
    assert(Pixel.Heartbeat("0123abcd", 65535))
    equal(Pixel.Heartbeat("0123abcd", 65536), nil)
end)

test("pixel: queue repeats head until exact epoch ACK and bounds input", function()
    local queue = Pixel.New({ maxPending = 2 })
    equal(queue:Queue(message()), true)
    equal(queue:Queue(message({ id = 2, tab = "codex" })), true)
    equal(queue:Queue(message({ id = 3 })), false)
    local first, second = queue:Next(), queue:Next()
    equal(queue:Next(), first); equal(queue:Next(), second)
    equal(queue:Ack(2, "0123abcd"), false); equal(queue:Ack(1, "ffffffff"), false)
    equal(queue:Ack(1, "0123abcd"), true); equal(queue:Pending(), 1)
    equal(queue:Ack(2, "0123abcd"), true); equal(queue:Next(), nil)
    equal(queue:Queue(message({ id = 2 })), false, "no ID reuse after ACK")
    equal(queue:Queue(message({ id = 3, epoch = "ffffffff" })), false)
    queue:Clear(); equal(queue:Pending(), 0)
    equal(queue:Queue(message({ id = 1, epoch = "ffffffff" })), true)
end)

test("pixel: queued frame snapshots survive caller mutation and IDs never wrap", function()
    local queue, item = Pixel.New(), message({ id = 262143 })
    equal(queue:Queue(item), true)
    item.id, item.text = 1, "modified"
    equal(values(queue:Next())[2], 63)
    equal(queue:Ack(262143, "0123abcd"), true)
    equal(queue:Queue(item), false)
    queue:Clear(); equal(queue:Next(), nil)
end)

test("pixel: calibration preserves the proven 22-cell color pattern", function()
    local colors = Pixel.Calibration()
    equal(#colors, 22)
    equal(colors[1][1], 255); equal(colors[2][2], 255); equal(colors[3][3], 255)
    equal(colors[6][1], 0); equal(colors[6][3], 85)
    equal(colors[7][1], 85); equal(colors[7][2], 0); equal(colors[7][3], 170)
    equal(colors[22][1], 255); equal(colors[22][2], 0); equal(colors[22][3], 255)
    colors[1][1] = 0; equal(Pixel.Calibration()[1][1], 255, "caller does not share calibration storage")
end)

test("pixel: burst probe is deterministic, paginated and black-padded", function()
    local expectedText = string.rep("WITCHCRAFT-BURST-PROBE|", 27):sub(1, 560)
    local text = Pixel.BurstProbeText()
    equal(text, expectedText); equal(#text, 560)

    local frames = assert(Pixel.EncodeContext({
        epoch = "0123abcd", uiNonce = "89abcdef", id = 262143, text = text,
    }))
    equal(#frames, 53)
    local pages = assert(Pixel.BurstPages(frames))
    equal(#pages, 3)
    for _, page in ipairs(pages) do
        equal(#page, 22)
        for _, row in ipairs(page) do equal(#row, 22) end
    end

    equal(values(pages[1][1])[1], 50); equal(values(pages[1][1])[5], 0)
    equal(values(pages[2][1])[5], 22); equal(values(pages[3][1])[5], 44)
    equal(values(pages[3][9])[5], 52)
    for row = 10, 22 do
        for _, value in ipairs(values(pages[3][row])) do equal(value, 0) end
    end

    pages[1][1][1][1] = 0
    equal(frames[1][1][1], 255, "pagination snapshots caller frames")
end)

test("pixel: corrupt burst probe changes one owned checksum frame only", function()
    local clean = assert(Pixel.BurstProbe("0123abcd", "89abcdef", false))
    local corrupt = assert(Pixel.BurstProbe("0123abcd", "89abcdef", true))
    equal(#clean, 3); equal(#corrupt, 3)
    equal(values(clean[1][1])[1], 50); equal(values(corrupt[1][1])[1], 50)
    equal(values(clean[1][1])[7] == values(corrupt[1][1])[7], false)
    for page = 1, 3 do
        for row = 1, 22 do
            for cell = 1, 22 do
                if not (page == 1 and row == 1 and cell == 7) then
                    local a, b = clean[page][row][cell], corrupt[page][row][cell]
                    equal(a[1], b[1]); equal(a[2], b[2]); equal(a[3], b[3])
                end
            end
        end
    end
end)
