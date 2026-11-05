// Wire order is stable: binding uses zero-based IDs, pixels use one-based IDs.
export const AGENT_TABS = Object.freeze(['claude', 'codex', 'copilot']);
export const AGENT_TITLES = Object.freeze({ claude: 'Claude', codex: 'Codex', copilot: 'Copilot' });

export function selectAgentCommands(config = {}, options = {}, child = []) {
  const initialTab = options.tab ?? options.only ?? 'claude';
  if (options.only && options.tab && options.only !== options.tab) throw new Error('--tab must match --only when one terminal is started');
  const commands = { claude: { file: 'claude', args: [] }, codex: { file: 'codex', args: [] }, ...config.commands };
  if ((options.withCopilot || initialTab === 'copilot') && !commands.copilot) commands.copilot = { file: 'copilot', args: [] };
  if (options.only) for (const tab of AGENT_TABS) if (tab !== options.only) commands[tab] = null;
  if (child.length) commands[initialTab] = { file: child[0], args: child.slice(1) };
  for (const entry of Object.values(commands)) {
    if (entry && (typeof entry.file !== 'string' || !Array.isArray(entry.args ?? []) || (entry.args ?? []).some(arg => typeof arg !== 'string'))) {
      throw new Error('Terminal commands require an executable file and an array of arguments');
    }
  }
  return { commands, initialTab };
}
