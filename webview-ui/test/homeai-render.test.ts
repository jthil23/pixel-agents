import assert from 'node:assert/strict';

import { test } from 'vitest';

import { createHomeAiState } from '../src/homeai/homeAiState.js';
import { renderHomeAiLayer } from '../src/homeai/renderHomeAi.js';
import type { OfficeLayout } from '../src/office/types.js';
interface DrawnText {
  text: string;
  width: number;
  fontPx: number;
}

test('overlay text scales with zoom and clips to nameplate, board, and cabinet widths', () => {
  const drawn: DrawnText[] = [];
  const ctx = {
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    imageSmoothingEnabled: true,
    textAlign: 'start' as CanvasTextAlign,
    textBaseline: 'alphabetic' as CanvasTextBaseline,
    save() {},
    restore() {},
    fillRect() {},
    strokeRect() {},
    measureText(this: { font: string }, text: string) {
      const fontPx = Number.parseFloat(this.font);
      return { width: text.length * fontPx } as TextMetrics;
    },
    fillText(this: { font: string }, text: string) {
      const fontPx = Number.parseFloat(this.font);
      drawn.push({ text, width: text.length * fontPx, fontPx });
    },
  } as unknown as CanvasRenderingContext2D;

  const state = createHomeAiState();
  state.active = true;
  state.rooms = { 'Server Room': 'An exceptionally long server room name' };
  state.sol = { reachable: true, groups: [{ name: 'Extremelylonggroupname', monitors: [] }] };
  state.stats = {
    date: '2026-09-27',
    spendByModel: {},
    openclawTokens: 0,
    toolCalls: 0,
    busiestAgent: 'A sufficiently long agent name',
    cronOk: 123456,
    cronFailed: 123456,
  };
  const areaTiles = Array.from({ length: 90 }, () => 'Server Room');
  for (let col = 0; col < 5; col++) areaTiles[col] = 'Break Room';
  for (let col = 5; col < 10; col++) areaTiles[col] = 'Mailroom';
  const layout = {
    cols: 10,
    rows: 9,
    areaTiles,
    furniture: [{ type: 'WHITEBOARD', col: 0, row: 0 }],
  } as unknown as OfficeLayout;

  renderHomeAiLayer({
    ctx,
    state,
    layout,
    characters: [],
    offsetX: 0,
    offsetY: 0,
    zoom: 0.5,
    width: 200,
    height: 200,
    now: 1000,
  });

  assert.ok(drawn.some((entry) => entry.text.endsWith('…')));
  assert.ok(drawn.some((entry) => entry.text === 'Break Room'));
  assert.ok(drawn.some((entry) => entry.text === 'Mailroom'));
  assert.ok(drawn.some((entry) => entry.text === 'Server Room'));
  const boardLines = drawn.filter(
    (entry) =>
      ['TODAY', 'waiting for data…'].includes(entry.text) ||
      /^(\$|busy:|claw |cron |SOL )/.test(entry.text),
  );
  assert.ok(boardLines.length > 0);
  assert.ok(boardLines.every((entry) => entry.width <= 68 * 0.5));
  const cabinetLabel = drawn.find((entry) => entry.text.endsWith('…') && entry.width <= 20 * 0.5);
  assert.ok(cabinetLabel);
  const roomNameplate = drawn.find(
    (entry) => entry.text.endsWith('…') && entry.width <= (160 - 6) * 0.5 && entry.width > 20 * 0.5,
  );
  assert.ok(drawn.some((entry) => entry.fontPx === 3));
  assert.ok(drawn.some((entry) => entry.fontPx === 2));
  assert.ok(roomNameplate);
  assert.ok(drawn.some((entry) => entry.fontPx <= 3));
});
