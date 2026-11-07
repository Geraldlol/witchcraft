std = "lua51"
max_line_length = 160
unused_args = false

exclude_files = {
  ".release/**",
  "**/Libs/**",
  "docs/**",
}

globals = {
  -- Witchcraft: the exhausted-ring reload dialog registers itself
  "StaticPopupDialogs",
  -- Witchcraft: generated chunk addons call this entry point
  "Witchcraft_ReceiveChunk",
}

read_globals = {
  -- Libraries
  "LibStub",
  -- WoW API (extend as needed)
  "CreateFrame", "UIParent", "GetTime", "C_Timer", "C_AddOns",
  "IsAddOnLoadOnDemand", "LoadAddOn", "ReloadUI", "InCombatLockdown", "GetPhysicalScreenSize", "debugprofilestop",
  "StaticPopup_Show",
  "GetBindingAction", "SetBinding", "SaveBindings", "GetCurrentBindingSet",
  "UnitName", "UnitClass", "UnitRace", "UnitLevel", "GetRealmName", "GetNormalizedRealmName", "GetLocale",
  "UnitExists", "UnitIsPlayer", "UnitCanAttack", "UnitCanCooperate", "UnitFullName", "UnitGUID",
  "UnitIsUnit", "UnitInParty", "UnitInRaid", "IsInGroup", "IsInRaid", "IsInGuild",
  "LE_PARTY_CATEGORY_HOME", "LE_PARTY_CATEGORY_INSTANCE",
  "DEFAULT_CHAT_FRAME", "hooksecurefunc",
  "GetAddOnMetadata", "IsAddOnLoaded",
  "C_Map", "C_MapExplorationInfo", "CreateVector2D", "WorldMapFrame", "C_GossipInfo", "C_NamePlate", "C_ChatInfo", "C_FriendList",
  "C_MajorFactions", "GetCurrentArenaSeason", "GetCameraZoom", "issecretvalue", "canaccessvalue", "canaccesstable",
  "C_QuestLog", "GetZoneText", "GetSubZoneText",
  "GetMoney", "UnitXP", "UnitXPMax", "GetXPExhaustion", "IsInInstance", "GetInstanceInfo",
  "GetNumGroupMembers", "UnitGroupRolesAssigned", "UnitIsDeadOrGhost", "UnitIsGhost", "UnitAffectingCombat",
  "C_CooldownViewer", "C_EncodingUtil", "Enum", "GetBuildInfo", "GetTimePreciseSec",
  "issecure", "issecurevariable", "Settings",
  -- Lua extensions WoW provides
  "wipe", "strsplit", "strjoin", "strtrim", "format", "tinsert", "tremove",
  "date", "time", "debugstack", "geterrorhandler",
}
