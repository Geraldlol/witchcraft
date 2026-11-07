import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fengari from 'fengari';
import luaparse from 'luaparse';

const addon = new URL('../../../Witchcraft/', import.meta.url);

test('addon files remain Lua 5.1 compatible', () => {
  for (const file of fs.readdirSync(addon).filter(file => file.endsWith('.lua'))) {
    assert.doesNotThrow(() => luaparse.parse(fs.readFileSync(new URL(file, addon), 'utf8'), { luaVersion: '5.1' }), file);
  }
});

test('Lua controller keeps Copilot as a tab setting, cycles tabs and accepts old and new snapshots', () => {
  const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  function run(source) {
    const result = lauxlib.luaL_dostring(state, to_luastring(source));
    assert.equal(result, lua.LUA_OK, result === lua.LUA_OK ? undefined : to_jsstring(lua.lua_tostring(state, -1)));
  }
  try {
    run('ns = {}');
    for (const file of ['Ring.lua', 'Pixel.lua', 'Binding.lua', 'Core.lua']) {
      run(`(function(...)\n${fs.readFileSync(new URL(file, addon), 'utf8')}\nend)("Witchcraft", ns)`);
    }
    run(`
      local raw = { global = { activeTab = "copilot", outbox = {
        { epoch = "1234abcd", id = 1, tab = "copilot", action = "text", text = "hello" }
      } } }
      assert(ns.Persistence.Validate(raw))
      local controller = ns.Core.New(raw.global, { UINonce = function() return "abcdef12" end })
      -- The Copilot tab is a setting that defaults off: a saved selection on it moves to the first shown tab.
      assert(controller.global.activeTab == "claude", "a saved Copilot selection moves off the hidden tab")
      assert(controller.scroll.copilot == 0)
      controller:NextTab(); assert(controller.global.activeTab == "codex")
      controller:NextTab(); assert(controller.global.activeTab == "claude", "Copilot is skipped while its tab setting is off")
      unpack = unpack or table.unpack
      assert(#controller:Snapshot().tabs == 2)
      assert(not controller:SelectTab("copilot"), "a hidden tab cannot be selected")
      assert(controller:SetSetting("tabCopilot", true))
      assert(#controller:Snapshot().tabs == 3)
      controller:NextTab(); assert(controller.global.activeTab == "codex")
      controller:NextTab(); assert(controller.global.activeTab == "copilot")
      assert(not controller:SelectTab("unknown"))
      local function session(id) return { id = id, title = id, status = "running", lines = { id } } end
      local copied = ns.Ring.Sessions({ session("copilot"), session("claude"), session("codex") }, 40)
      assert(copied and copied[1].id == "claude" and copied[3].id == "copilot")
      assert(ns.Ring.Sessions({ session("codex"), session("claude") }, 40))
      assert(not ns.Ring.Sessions({ session("copilot"), session("claude") }, 40))
      assert(not ns.Ring.Sessions({ session("claude"), session("codex"), session("codex") }, 40))
      assert(not ns.Ring.Sessions({ session("claude"), session("codex"), session("unknown") }, 40))
      assert(ns.Pixel.Encode({ epoch = "1234abcd", id = 1, tab = "copilot", action = "text", text = "hello" }))
    `);
  } finally { lua.lua_close(state); }
});
