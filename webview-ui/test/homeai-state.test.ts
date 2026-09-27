import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  applyHomeAiMessage,
  createHomeAiState,
  CRON_FIRE_MS,
  EFFECT_MS,
  pruneEffects,
} from '../src/homeai/homeAiState.js';

const NOW = 1_000_000;

test('first home-ai message activates the mode once; upstream messages are not handled', () => {
  const s = createHomeAiState();
  assert.deepEqual(applyHomeAiMessage(s, { type: 'agentToolDone', id: 1 }, NOW), {
    handled: false,
  });
  assert.deepEqual(
    applyHomeAiMessage(s, { type: 'ambientSun', phase: 'dusk', elevation: -3 }, NOW),
    { handled: true, firstActivation: true },
  );
  assert.deepEqual(s.sun, { phase: 'dusk', elevation: -3 });
  assert.deepEqual(
    applyHomeAiMessage(s, { type: 'ambientSun', phase: 'night', elevation: null }, NOW),
    { handled: true },
  );
});

test('tool starts request a clack but stay unhandled so upstream still animates', () => {
  assert.deepEqual(
    applyHomeAiMessage(
      createHomeAiState(),
      { type: 'agentToolStart', id: 1, toolId: 't', status: 's' },
      NOW,
    ),
    { handled: false, sound: 'clack' },
  );
});

test('timed effects expire; confetti dings; alarms klaxon; advice replaces the previous badge', () => {
  const s = createHomeAiState();
  assert.equal(
    applyHomeAiMessage(s, { type: 'officeEffect', effect: 'confetti', agentId: 5 }, NOW).sound,
    'ding',
  );
  assert.equal(
    applyHomeAiMessage(
      s,
      { type: 'officeEffect', effect: 'alarm', groupName: 'Media', reason: 'Plex down' },
      NOW,
    ).sound,
    'klaxon',
  );
  applyHomeAiMessage(
    s,
    { type: 'officeEffect', effect: 'advice', agentId: 6, severity: 'nit' },
    NOW,
  );
  applyHomeAiMessage(
    s,
    { type: 'officeEffect', effect: 'advice', agentId: 6, severity: 'blocker' },
    NOW,
  );
  assert.deepEqual(
    s.effects.filter((e) => e.kind === 'advice').map((e) => e.severity),
    ['blocker'],
  );
  assert.equal(pruneEffects(s, NOW + EFFECT_MS.confetti + 1), true);
  assert.deepEqual(s.effects.map((e) => e.kind).sort(), ['advice', 'alarm']);
  pruneEffects(s, NOW + EFFECT_MS.alarm + 1);
  assert.deepEqual(s.effects, []);
});

test('doze/wake toggle the dozing set; cron failures burn for 24 h', () => {
  const s = createHomeAiState();
  applyHomeAiMessage(s, { type: 'officeEffect', effect: 'doze', agentId: 3 }, NOW);
  assert.ok(s.dozing.has(3));
  applyHomeAiMessage(s, { type: 'officeEffect', effect: 'wake', agentId: 3 }, NOW);
  assert.ok(!s.dozing.has(3));
  applyHomeAiMessage(s, { type: 'officeEffect', effect: 'cronFailed', agentId: 9 }, NOW);
  assert.equal(s.cronFireUntil.get(9), NOW + CRON_FIRE_MS);
  pruneEffects(s, NOW + CRON_FIRE_MS + 1);
  assert.equal(s.cronFireUntil.has(9), false);
});

test('transcript links open only for the agent whose panel is open', () => {
  const s = createHomeAiState();
  s.panel = { kind: 'agent', agentId: 7 };
  assert.equal(
    applyHomeAiMessage(s, { type: 'transcriptLink', agentId: 8, url: 'https://x' }, NOW).openUrl,
    undefined,
  );
  assert.equal(
    applyHomeAiMessage(s, { type: 'transcriptLink', agentId: 7, url: 'https://y' }, NOW).openUrl,
    'https://y',
  );
  applyHomeAiMessage(s, { type: 'transcriptLink', agentId: 7, reason: 'not hosted' }, NOW);
  assert.deepEqual(s.links.get(7), { reason: 'not hosted' });
});

test('projectRooms maps area labels to project names; agentClosed clears per-agent state and its panel', () => {
  const s = createHomeAiState();
  applyHomeAiMessage(
    s,
    { type: 'projectRooms', rooms: [{ label: 'Project Room 1', projectName: 'Home-AI' }] },
    NOW,
  );
  assert.deepEqual(s.rooms, { 'Project Room 1': 'Home-AI' });
  applyHomeAiMessage(s, { type: 'officeEffect', effect: 'doze', agentId: 4 }, NOW);
  s.panel = { kind: 'agent', agentId: 4 };
  assert.deepEqual(applyHomeAiMessage(s, { type: 'agentClosed', id: 4 }, NOW), { handled: false });
  assert.ok(!s.dozing.has(4));
  assert.equal(s.panel, null);
});
