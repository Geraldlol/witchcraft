import test from 'node:test';
import assert from 'node:assert/strict';
import { agentState, readChoices, unmark } from '../src/agent-state.js';

const pad = rows => [...Array.from({ length: 30 }, () => ''), ...rows];

test('a Claude Code permission prompt is a waiting menu with its marked option', () => {
  const result = agentState(pad([
    ' Bash command',
    '   npm test',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    "   2. Yes, and don't ask again for npm test",
    '   3. No, and tell Claude what to do differently (esc)',
  ]));
  assert.equal(result.state, 'waiting');
  assert.deepEqual(result.choices.options, ['Yes', "Yes, and don't ask again for npm test",
    'No, and tell Claude what to do differently (esc)']);
  assert.equal(result.choices.selected, 1);
});

test('a Codex approval with the cursor moved and a wrapped description still reads as one menu', () => {
  const choices = readChoices(pad([
    'Would you like to run the following command?',
    '  1. Yes, proceed (y)',
    '› 2. Yes, and don\'t ask again for this command (p)',
    '     applies to commands starting with git',
    '  3. No, and tell Codex what to do differently (esc)',
  ]));
  assert.deepEqual(choices, { options: ['Yes, proceed (y)', "Yes, and don't ask again for this command (p)",
    'No, and tell Codex what to do differently (esc)'], selected: 2 });
});

test('a numbered list in an answer, with no selection marker, is not a question', () => {
  const result = agentState(pad(['Route notes', '  1. Finish the nearby objective.', '  2. Follow the road north.',
    '  3. Return when the bags are full.', '', '❯ ']));
  assert.equal(result.state, 'idle');
  assert.equal(result.choices, undefined);
});

test('the interrupt hint means working; colour runs and pipes are read as plain text', () => {
  assert.equal(unmark('|cff66d4bdgreen|r text ||pipe||'), 'green text |pipe|');
  assert.deepEqual(agentState(pad(['✶ Processing… (12s)', '|cff808080  esc to interrupt|r'])), { state: 'working' });
  assert.deepEqual(agentState(pad(['❯ ', '  ⏵⏵ auto mode on (shift+tab to cycle)'])), { state: 'idle' });
  assert.deepEqual(agentState(undefined), { state: 'idle' });
});

test('a menu above the bottom rows, a broken sequence, or more than nine options are bounded', () => {
  const old = ['❯ 1. Yes', '  2. No', ...Array.from({ length: 25 }, (_, index) => `line ${index}`)];
  assert.equal(readChoices(old), undefined, 'only the bottom twenty rows are read');
  assert.equal(readChoices(['❯ 1. Yes', '  3. No']), undefined, 'numbers must follow in order');
  const long = readChoices(['❯ 1. a', ...Array.from({ length: 11 }, (_, index) => `  ${index + 2}. option`)]);
  assert.equal(long.options.length, 9);
  assert.equal(readChoices(['❯ 1. ' + 'x'.repeat(100), '  2. y']).options[0].length, 60, 'labels are bounded');
});
