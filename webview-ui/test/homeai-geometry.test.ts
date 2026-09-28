/* eslint-disable pixel-agents/no-inline-colors -- These assertions pin required LED palette values. */
import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  areaBounds,
  cabinetBoxes,
  confettiParticles,
  hitCabinet,
  HOME_AI_TEXT_SCALE,
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

test('areaBounds caches per layout identity and recomputes for a new layout', () => {
  const first = areaBounds(layout, 'Server Room');
  assert.equal(areaBounds(layout, 'Server Room'), first);

  const nextLayout = { cols: 4, areaTiles: ['Server Room', null, null, null] };
  const next = areaBounds(nextLayout, 'Server Room');
  assert.notEqual(next, first);
  assert.deepEqual(next, { minCol: 0, minRow: 0, maxCol: 0, maxRow: 0 });
});

test('cabinet label cells fit six-character names and remain inside the server room', () => {
  const groups = [
    { name: 'Core', monitors: [] },
    { name: 'Media', monitors: [] },
  ];
  const bounds = { minCol: 34, minRow: 2, maxCol: 43, maxRow: 10 };
  const boxes = cabinetBoxes(bounds, groups);
  const roomLeft = bounds.minCol * 16;
  const roomRight = (bounds.maxCol + 1) * 16;
  const roomBottom = (bounds.maxRow + 1) * 16;

  assert.deepEqual(
    boxes.map((b) => b.groupName),
    ['Core', 'Media'],
  );
  assert.equal(boxes[1].x - boxes[0].x, boxes[0].labelWidth + 2);
  for (const box of boxes) {
    const labelLeft = box.x + (box.w - box.labelWidth) / 2;
    assert.ok(box.labelWidth >= 42);
    assert.ok(labelLeft >= roomLeft);
    assert.ok(labelLeft + box.labelWidth <= roomRight);
    assert.ok(box.y + box.h + 1 + Math.ceil(9 * HOME_AI_TEXT_SCALE) <= roomBottom - 20);
  }
  assert.equal(hitCabinet(boxes, boxes[1].x + 1, boxes[1].y + 1), 'Media');
  assert.equal(hitCabinet(boxes, boxes[0].x - 1, boxes[0].y), null);
});

test('one to eight cabinets and their labels stay inside without overlap', () => {
  const bounds = { minCol: 34, minRow: 2, maxCol: 43, maxRow: 10 };
  const roomLeft = bounds.minCol * 16;
  const roomTop = bounds.minRow * 16;
  const roomRight = (bounds.maxCol + 1) * 16;
  const roomBottom = (bounds.maxRow + 1) * 16;
  const groups = Array.from({ length: 8 }, (_, i) => ({ name: `Group ${i}`, monitors: [] }));
  for (let count = 1; count <= 8; count++) {
    const boxes = cabinetBoxes(bounds, groups.slice(0, count));
    assert.equal(boxes.length, count);
    for (const box of boxes) {
      const labelLeft = box.x + (box.w - box.labelWidth) / 2;
      assert.ok(box.x >= roomLeft);
      assert.ok(box.y >= roomTop);
      assert.ok(
        box.y >= roomTop + 2 + Math.ceil(9 * HOME_AI_TEXT_SCALE) + 2,
        'cabinet begins below the server-room nameplate band',
      );
      assert.ok(box.x + box.w <= roomRight);
      assert.ok(box.y + box.h <= roomBottom);
      assert.ok(box.labelWidth >= 42);
      assert.ok(labelLeft >= roomLeft);
      assert.ok(labelLeft + box.labelWidth <= roomRight);
      assert.ok(
        box.y + box.h + 1 + Math.ceil(9 * HOME_AI_TEXT_SCALE) <= roomBottom - 20,
        'cabinet label remains inside the room',
      );
    }
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
        if (a.y < b.y) {
          assert.ok(
            a.y + a.h + 1 + Math.ceil(9 * HOME_AI_TEXT_SCALE) <= b.y,
            'cabinet label band clears cabinets in the next row',
          );
        }
        if (a.y === b.y) {
          const aLabelLeft = a.x + (a.w - a.labelWidth) / 2;
          const bLabelLeft = b.x + (b.w - b.labelWidth) / 2;
          assert.ok(
            aLabelLeft + a.labelWidth <= bLabelLeft || bLabelLeft + b.labelWidth <= aLabelLeft,
          );
        }
      }
    }
  }
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

test('tints and LED colours follow phase and every monitor state', () => {
  assert.equal(phaseTint('day'), null);
  assert.match(String(phaseTint('night')), /^rgba\(/);
  assert.equal(ledColor('down', true, true), '#ff3b30');
  assert.equal(ledColor('up', true, true), '#39ff14');
  assert.equal(ledColor('up', true, false), '#1b5e20');
  assert.equal(ledColor('flapping', true, true), '#ffb300');
  assert.equal(ledColor('flapping', true, false), '#ffb300');
  assert.equal(ledColor('pending', true, true), '#ffb300');
  assert.equal(ledColor('pending', true, false), '#ffb300');
  assert.equal(ledColor('maintenance', true, true), '#40c4ff');
  assert.equal(ledColor('maintenance', true, false), '#40c4ff');
  assert.equal(ledColor('unknown', true, true), '#6b6b6b');
  assert.equal(ledColor('unknown', true, false), '#6b6b6b');
  assert.equal(ledColor('down', false, true), '#6b6b6b');
  assert.equal(ledColor('down', false, false), '#6b6b6b');
});
/* eslint-enable pixel-agents/no-inline-colors */
