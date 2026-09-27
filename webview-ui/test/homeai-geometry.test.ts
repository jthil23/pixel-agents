/* eslint-disable pixel-agents/no-inline-colors -- These assertions pin the required LED palette values. */
import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  areaBounds,
  cabinetBoxes,
  confettiParticles,
  hitCabinet,
  ledColor,
  phaseTint,
  statsLines,
} from '../src/homeai/geometry.js';

const layout = {
  cols: 4,
  areaTiles: [null, 'Server Room', 'Server Room', null, null, 'Server Room', 'Server Room', null],
};

test('areaBounds spans every tile with the label', () => {
  assert.deepEqual(areaBounds(layout, 'Server Room'), {
    minCol: 1,
    minRow: 0,
    maxCol: 2,
    maxRow: 1,
  });
  assert.equal(areaBounds(layout, 'Nope'), null);
});

test('cabinets line up left to right inside the room and are hit-testable', () => {
  const groups = [
    { name: 'Core', monitors: [] },
    { name: 'Media', monitors: [] },
  ];
  const boxes = cabinetBoxes({ minCol: 34, minRow: 2, maxCol: 43, maxRow: 10 }, groups);
  assert.deepEqual(
    boxes.map((b) => b.groupName),
    ['Core', 'Media'],
  );
  assert.equal(boxes[1].x - boxes[0].x, boxes[0].w + 12);
  assert.ok(boxes[1].x + boxes[1].w <= 44 * 16);
  assert.equal(hitCabinet(boxes, boxes[1].x + 1, boxes[1].y + 1), 'Media');
  assert.equal(hitCabinet(boxes, boxes[0].x - 1, boxes[0].y), null);
});

test('stats lines summarise the day', () => {
  assert.deepEqual(statsLines(null), ['TODAY', 'waiting for data…']);
  assert.deepEqual(
    statsLines({
      date: '2026-09-27',
      spendByModel: { opus: 10.5, luna: 1.9 },
      openclawTokens: 1234,
      toolCalls: 214,
      busiestAgent: 'Home-AI roadmap planning',
      cronOk: 5,
      cronFailed: 1,
      solUptime24h: 0.9912,
    }),
    [
      'TODAY',
      '$12.40 · 214 tools',
      'busy: Home-AI road…',
      'claw 1.2k tok',
      'cron 5 ok / 1 fail',
      'SOL 99.1% up',
    ],
  );
});

test('confetti is deterministic, bursts upward, then falls', () => {
  const a = confettiParticles(100, 100, 300, 7);
  assert.deepEqual(a, confettiParticles(100, 100, 300, 7));
  assert.equal(a.length, 30);
  const meanY = (ps: { y: number }[]) => ps.reduce((s, p) => s + p.y, 0) / ps.length;
  assert.ok(meanY(a) < 100);
  assert.ok(meanY(confettiParticles(100, 100, 2400, 7)) > meanY(a));
});

test('tints and LED colours follow phase and monitor state', () => {
  assert.equal(phaseTint('day'), null);
  assert.match(String(phaseTint('night')), /^rgba\(/);
  assert.equal(ledColor('down', true, true), '#ff3b30');
  assert.equal(ledColor('up', true, false), '#1b5e20');
  assert.equal(ledColor('up', false, true), '#6b6b6b');
});
/* eslint-enable pixel-agents/no-inline-colors */
