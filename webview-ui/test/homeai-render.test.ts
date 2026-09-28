import assert from 'node:assert/strict';

import { test } from 'vitest';

import { confettiParticles } from '../src/homeai/geometry.js';
import { createHomeAiState } from '../src/homeai/homeAiState.js';
import { BEACON_OFF } from '../src/homeai/pixelArt.js';
import { renderHomeAiLayer } from '../src/homeai/renderHomeAi.js';
import type { Character, OfficeLayout } from '../src/office/types.js';
interface DrawnText {
  text: string;
  width: number;
  fontPx: number;
  color: string;
}

test('Home-AI signs, whiteboard, and cabinet labels stay legible and fit at proportional zoom', () => {
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
  const cols = 45;
  const rows = 22;
  const areaTiles = Array.from({ length: cols * rows }, (_, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    if (row < 2 || row > 10) return null;
    if (col >= 1 && col <= 21) return 'Break Room';
    if (col >= 23 && col <= 32) return 'Mailroom';
    if (col >= 34 && col <= 43) return 'Server Room';
    return null;
  });
  const layout = {
    cols,
    rows,
    areaTiles,
    furniture: [
      { type: 'WHITEBOARD', col: 9, row: 0 },
      { type: 'COFFEE_TABLE', col: 14, row: 6 },
    ],
  } as unknown as OfficeLayout;

  const renderAtZoom = (zoom: number, reachable = true) => {
    state.sol.reachable = reachable;
    const drawn: DrawnText[] = [];
    const rectangles: { x: number; y: number; width: number; height: number; fillStyle: string }[] =
      [];
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
      fillRect(this: { fillStyle: string }, x: number, y: number, width: number, height: number) {
        rectangles.push({ x, y, width, height, fillStyle: this.fillStyle });
      },
      strokeRect() {},
      measureText(this: { font: string }, text: string) {
        const fontPx = Number.parseFloat(this.font);
        return { width: text.length * fontPx * 0.7 } as TextMetrics;
      },
      fillText(this: { font: string; fillStyle: string }, text: string) {
        const fontPx = Number.parseFloat(this.font);
        drawn.push({ text, width: text.length * fontPx * 0.7, fontPx, color: this.fillStyle });
      },
    } as unknown as CanvasRenderingContext2D;

    const boxes = renderHomeAiLayer({
      ctx,
      state,
      layout,
      characters: [],
      offsetX: 0,
      offsetY: 0,
      zoom,
      width: 200,
      height: 200,
      now: 1000,
    });
    return { drawn, rectangles, boxes };
  };

  const low = renderAtZoom(0.5);
  const high = renderAtZoom(1);
  const fontSize = (drawn: DrawnText[], text: string) => {
    const entry = drawn.find((candidate) => candidate.text === text);
    assert.ok(entry, `expected ${JSON.stringify(text)} to be drawn`);
    return entry.fontPx;
  };

  const roomNameplate = low.drawn.find(
    (entry) => entry.text.startsWith('An exceptionally') && entry.text.endsWith('…'),
  );
  assert.ok(roomNameplate);
  assert.ok(roomNameplate.width <= (10 * 16 - 6 * 1.75) * 0.5);
  assert.equal(fontSize(high.drawn, 'Break Room'), 11);
  assert.equal(fontSize(high.drawn, 'TODAY'), 9);
  assert.equal(fontSize(high.drawn, 'Extrem'), 7);
  assert.ok(
    Math.abs(fontSize(high.drawn, 'Break Room') - fontSize(low.drawn, 'Break Room') * 2) <= 1,
  );
  assert.ok(Math.abs(fontSize(high.drawn, 'TODAY') - fontSize(low.drawn, 'TODAY') * 2) <= 1);
  assert.ok(Math.abs(fontSize(high.drawn, 'Extrem') - fontSize(low.drawn, 'Extrem') * 2) <= 1);

  const board = low.rectangles.find((rect) => rect.x === 72 && rect.y === 16);
  assert.ok(board);
  assert.equal(board.width, 72 * 1.75 * 0.5);
  assert.equal(board.height, (2 + 5 * 5.5 + 5 + 1.5) * 1.75 * 0.5);
  const boardLeft = board.x / 0.5;
  const boardTop = board.y / 0.5;
  const boardRight = boardLeft + board.width / 0.5;
  const boardBottom = boardTop + board.height / 0.5;
  assert.ok(boardLeft >= 16 && boardRight <= 22 * 16);
  assert.ok(boardTop >= 2 * 16 && boardBottom <= 6 * 16);
  const boardLines = low.drawn.filter(
    (entry) =>
      ['TODAY', 'waiting for data…'].includes(entry.text) ||
      /^(\$|busy:|claw |cron |SOL )/.test(entry.text),
  );
  assert.equal(boardLines.length, 6);
  assert.ok(boardLines.every((entry) => entry.width <= 68 * 1.75 * 0.5));

  const cabinetBox = low.boxes[0];
  const cabinetLabel = low.drawn.find((entry) => entry.text === 'Extrem');
  assert.ok(cabinetLabel);
  assert.ok(cabinetLabel.width <= cabinetBox.labelWidth * 0.5);
  assert.ok(cabinetBox.labelWidth > cabinetBox.w);
  const cabinetLabelCenter = (cabinetBox.x + cabinetBox.w / 2) * 0.5;
  const cabinetLabelTop = (cabinetBox.y + cabinetBox.h + 1) * 0.5;
  const roomSignBackground = low.rectangles.find((rect) => rect.y === 17);
  assert.ok(roomSignBackground);
  assert.ok(
    low.rectangles.some(
      (rect) =>
        rect.fillStyle === roomSignBackground.fillStyle &&
        rect.y === cabinetLabelTop &&
        rect.x < cabinetLabelCenter &&
        rect.x + rect.width > cabinetLabelCenter &&
        rect.width <= cabinetBox.labelWidth * 0.5,
    ),
    'a fitted dark backing matching the room nameplate sits behind each cabinet label',
  );
  const offline = renderAtZoom(1, false);
  assert.equal(fontSize(offline.drawn, 'NO SIGNAL'), 11);
  const noSignal = offline.rectangles.find((rect) => rect.y === 156 && rect.width < 90);
  assert.ok(noSignal);
  assert.ok(noSignal.x >= 34 * 16 && noSignal.x + noSignal.width <= 44 * 16);
  assert.ok(noSignal.y + noSignal.height <= 11 * 16);
});

test('expired effects and cron-fire timestamps are not rendered before pruning', () => {
  let fillRectCalls = 0;
  const ctx = {
    imageSmoothingEnabled: true,
    save() {},
    restore() {},
    fillRect() {
      fillRectCalls++;
    },
  } as unknown as CanvasRenderingContext2D;
  const state = createHomeAiState();
  state.active = true;
  state.effects.push({ kind: 'confetti', agentId: 1, startedAt: 1, until: 2501 });
  const characters = [{ id: 1, x: 12, y: 12 }] as unknown as Character[];
  const layout = {
    cols: 4,
    rows: 4,
    areaTiles: Array(16).fill(''),
    furniture: [],
  } as unknown as OfficeLayout;

  renderHomeAiLayer({
    ctx,
    state,
    layout,
    characters,
    offsetX: 0,
    offsetY: 0,
    zoom: 1,
    width: 64,
    height: 64,
    now: 2502,
  });
  assert.equal(fillRectCalls, 0);
  assert.equal(state.effects.length, 1);

  state.effects = [];
  state.cronFireUntil.set(1, 86_400_000);
  layout.furniture = [{ uid: 'clock', type: 'CLOCK', col: 0, row: 0 }];
  renderHomeAiLayer({
    ctx,
    state,
    layout,
    characters: [],
    offsetX: 0,
    offsetY: 0,
    zoom: 1,
    width: 64,
    height: 64,
    now: 86_400_000,
  });
  assert.equal(fillRectCalls, 0);
});

test('confetti continues at the last rendered position after its agent disappears', () => {
  const particles: [number, number][] = [];
  const ctx = {
    imageSmoothingEnabled: true,
    save() {},
    restore() {},
    fillRect(x: number, y: number) {
      particles.push([x, y]);
    },
  } as unknown as CanvasRenderingContext2D;
  const state = createHomeAiState();
  state.active = true;
  state.effects.push({ kind: 'confetti', agentId: 7, startedAt: 100, until: 2600 });
  const layout = {
    cols: 4,
    rows: 4,
    areaTiles: Array(16).fill(''),
    furniture: [],
  } as unknown as OfficeLayout;
  const render = (characters: Character[], now: number) =>
    renderHomeAiLayer({
      ctx,
      state,
      layout,
      characters,
      offsetX: 0,
      offsetY: 0,
      zoom: 1,
      width: 64,
      height: 64,
      now,
    });

  render([{ id: 7, x: 12, y: 50 } as unknown as Character], 100);
  particles.length = 0;
  render([], 600);

  const expected = confettiParticles(12, 20, 500, 100)[0];
  assert.deepEqual(particles[0], [expected.x, expected.y]);
  assert.ok(particles.length > 0);

  particles.length = 0;
  render([], 2600);
  assert.equal(particles.length, 0);
});

test('a grouped alarm stops turning its cabinet red at exact expiry before pruning', () => {
  const filled: string[] = [];
  const ctx = {
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    imageSmoothingEnabled: true,
    textAlign: 'start' as CanvasTextAlign,
    save() {},
    restore() {},
    strokeRect() {},
    fillText() {},
    measureText(text: string) {
      return { width: text.length } as TextMetrics;
    },
    fillRect(this: { fillStyle: string }) {
      filled.push(this.fillStyle);
    },
  } as unknown as CanvasRenderingContext2D;
  const state = createHomeAiState();
  state.active = true;
  state.sol = { reachable: true, groups: [{ name: 'Core', monitors: [] }] };
  state.effects.push({
    kind: 'alarm',
    agentId: 0,
    groupName: 'Core',
    startedAt: 101,
    until: 10_101,
  });
  const layout = {
    cols: 8,
    rows: 6,
    areaTiles: Array(48).fill('Server Room'),
    furniture: [],
  } as unknown as OfficeLayout;
  const args = {
    ctx,
    state,
    layout,
    characters: [],
    offsetX: 0,
    offsetY: 0,
    zoom: 1,
    width: 128,
    height: 96,
    now: 10_100,
  };

  renderHomeAiLayer(args);
  assert.ok(filled.includes(BEACON_OFF.palette.r));

  filled.length = 0;
  args.now = 10_101;
  renderHomeAiLayer(args);
  assert.equal(state.effects.length, 1);
  assert.ok(!filled.includes(BEACON_OFF.palette.r));
});
