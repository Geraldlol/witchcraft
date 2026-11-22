local ns, test, equal = ...
local Evidence = ns.Evidence

test("evidence names one checked client build and compares every part of it", function()
    equal(Evidence.Label(), Evidence.version .. "." .. Evidence.build)
    local function info(version, build, interface) return function() return version, build, "date", interface end end
    assert(Evidence.Check(info(Evidence.version, Evidence.build, Evidence.interface)))
    local ok, observed = Evidence.Check(info(Evidence.version, "69999", Evidence.interface))
    equal(ok, false); equal(observed, Evidence.version .. ".69999")
    equal(select(2, Evidence.Check(info("1.60.2", Evidence.build, Evidence.interface))), "1.60.2." .. Evidence.build)
    equal(Evidence.Check(info(Evidence.version, Evidence.build, 16002)), false, "the interface is part of the pin")
    equal(select(2, Evidence.Check(function() error("no build") end)), "unknown")
    equal(select(2, Evidence.Check(nil)), "unknown")
end)
