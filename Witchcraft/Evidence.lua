-- The one client build the carriers were checked against. Both carriers write the player's real
-- game settings, so an unchecked build keeps them off; moving to a new build is this one line,
-- after the build-matched UI source shows no Cooldown Viewer, encoding or AddOns API change.
-- 69977 moved the pin from 69913: the source differs only in three login-screen files
-- (Gethe/wow-ui-source forever 70ef1b2fd7...c6e8998318). The daemon reads this file to warn at start.
-- 70205 moved the pin from 69977 on 2026-10-04: the user confirmed both carriers working in game.
local _, ns = ...
local Evidence = { version = "1.60.1", build = "70205", interface = 16001 }
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
