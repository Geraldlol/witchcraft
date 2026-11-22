-- Exact-build qualification gate for the optional production cooldown carrier. It writes the
-- player's Cooldown Viewer settings, so an unchecked build keeps it off. The dormant AddOns-state
-- prototype reads this gate only if a harness loads it; it is absent from the production TOC, is
-- not imported or started by the production daemon, and is not runtime-qualified.
-- 71037 moved the cooldown pin from 70205 on 2026-11-22. Build-matched Forever UI source changed
-- from e3ecc27b64d30fdc735a3f6579b866858f9f9df1 to 734f065329cff4992835b01a84f210a297db91b6;
-- the production Cooldown Viewer, encoding, key-binding and chunk-loading calls are unchanged.
-- The inspected AddOns enable-state APIs are also unchanged. The user confirmed the production
-- cooldown carrier working in game on this exact build. The daemon reads this file.
local _, ns = ...
local Evidence = { version = "1.60.1", build = "71037", interface = 16001 }
ns.Evidence = Evidence

function Evidence.Label() return Evidence.version .. "." .. Evidence.build end

-- Returns true, or false and the observed "version.build" ("unknown" when it cannot be read).
function Evidence.Check(buildInfo)
    if type(buildInfo) ~= "function" then return false, "unknown" end
    local ok, version, build, _, interface = pcall(buildInfo)
    if not ok or type(version) ~= "string" or build == nil then return false, "unknown" end
    local observed = version .. "." .. tostring(build)
    if version ~= Evidence.version or tostring(build) ~= Evidence.build
        or tonumber(interface) ~= Evidence.interface then return false, observed end
    return true
end
