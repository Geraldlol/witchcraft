local ns = {}
for _, file in ipairs({ "Evidence", "Errors", "Ring", "Pixel", "Prompts", "Binding", "LogCarrier",
    "AddonsState", "CooldownCarrier", "Context", "Options", "Minimap", "Core" }) do
    assert(loadfile("Witchcraft/" .. file .. ".lua"))("Witchcraft", ns)
end

local passed, failed = 0, 0
local function equal(actual, expected, message)
    assert(actual == expected, (message or "values differ") .. ": expected " .. tostring(expected) .. ", got " .. tostring(actual))
end
local function test(name, fn)
    local ok, err = xpcall(fn, debug.traceback)
    if ok then passed = passed + 1; print("PASS " .. name)
    else failed = failed + 1; print("FAIL " .. name .. "\n" .. err) end
end
for _, suite in ipairs({ "evidence", "errors", "error-watch", "ring", "pixel", "binding", "log-carrier",
    "addons-state", "cooldown-carrier",
    "core", "persistence", "context", "context-transport", "cooldown-transport", "options" }) do
    assert(loadfile("tests/witchcraft/" .. suite .. ".lua"))(ns, test, equal)
end
test("Witchcraft view routing, layout, keyboard, drafts, lifecycle and physical strip", function()
    assert(loadfile("tests/witchcraft/view.lua"))()()
end)
test("Witchcraft view falls back to a plain bounded edge without the stock frame layout", function()
    assert(loadfile("tests/witchcraft/view.lua"))()({ noStockFrame = true })
end)
print(string.format("WITCHCRAFT: %d passed, %d failed (Lua 5.1 + mocked WoW APIs; no client execution)", passed, failed))
assert(failed == 0, "WITCHCRAFT tests failed")
