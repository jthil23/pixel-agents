import { TILE_SIZE } from '../constants.js';
import type { Character, OfficeLayout } from '../office/types.js';
import {
  areaBounds,
  type CabinetBox,
  cabinetBoxes,
  confettiParticles,
  ledColor,
  phaseTint,
  statsLines,
} from './geometry.js';
import { EFFECT_MS, type HomeAiState, type SolGroup } from './homeAiState.js';
import {
  BEACON_OFF,
  BEACON_ON,
  CLOCK_ICON,
  drawBitmap,
  ENVELOPE,
  FIRE,
  PHONE,
} from './pixelArt.js';

export interface HomeAiRenderArgs {
  ctx: CanvasRenderingContext2D;
  state: HomeAiState;
  layout: OfficeLayout;
  characters: Iterable<Character>;
  offsetX: number;
  offsetY: number;
  zoom: number;
  width: number;
  height: number;
  now: number;
}

const FONT = (px: number) => `${Math.round(px)}px 'FS Pixel Sans', monospace`;
const HEAD_OFFSET = 30;
/* eslint-disable pixel-agents/no-inline-colors -- Canvas layer colors are the documented Home-AI overlay palette. */
const OVERLAY_PALETTE = {
  advice: { nit: '#40c4ff', concern: '#ffb300', blocker: '#ff3b30' } as Record<string, string>,
  sleep: '#e0e0ff',
  text: '#111',
  signBackground: '21,16,32',
  signText: '#f5e6c8',
  board: '#f4f1e8',
  wood: '#5d4037',
  ink: '#263238',
  cabinet: '#1c1f26',
  cabinetAlarm: '#7f0000',
  cabinetBorder: '#455a64',
  blade: '#2e3440',
  smoke: '160,160,160',
  label: '#b0bec5',
  vignette: '255,23,68',
};

export function renderHomeAiLayer(a: HomeAiRenderArgs): CabinetBox[] {
  const { ctx, state, layout, zoom, now } = a;
  if (!state.active) return [];
  const px = (wx: number) => a.offsetX + wx * zoom;
  const py = (wy: number) => a.offsetY + wy * zoom;
  const blinkOn = Math.floor(now / 500) % 2 === 0;
  ctx.save();
  ctx.imageSmoothingEnabled = false;

  // Room signs
  for (const [label, name] of Object.entries(state.rooms)) {
    const b = areaBounds(layout, label);
    if (!b) continue;
    drawSign(
      ctx,
      px(((b.minCol + b.maxCol + 1) / 2) * TILE_SIZE),
      py(b.minRow * TILE_SIZE + 2),
      name,
      zoom,
      (b.maxCol - b.minCol + 1) * TILE_SIZE * zoom - 6 * zoom,
    );
  }

  // Server room cabinets
  let boxes: CabinetBox[] = [];
  const server = areaBounds(layout, 'Server Room');
  if (server) {
    boxes = cabinetBoxes(server, state.sol.groups);
    const alarmed = new Set(
      state.effects.filter((e) => e.kind === 'alarm' && e.groupName).map((e) => e.groupName),
    );
    boxes.forEach((box, i) =>
      drawCabinet(
        ctx,
        box,
        state.sol.groups[i],
        state.sol.reachable,
        alarmed.has(box.groupName) && blinkOn,
        blinkOn,
        now,
        px,
        py,
        zoom,
      ),
    );
    if (!state.sol.reachable)
      drawSign(
        ctx,
        px(((server.minCol + server.maxCol + 1) / 2) * TILE_SIZE),
        py(server.maxRow * TILE_SIZE - 4),
        'NO SIGNAL',
        zoom,
        (server.maxCol - server.minCol + 1) * TILE_SIZE * zoom - 6 * zoom,
        0.6,
      );
  }

  // Whiteboard stats
  const board = layout.furniture.find((f) => f.type === 'WHITEBOARD');
  if (board)
    drawBoard(
      ctx,
      px(board.col * TILE_SIZE),
      py(board.row * TILE_SIZE + 4),
      statsLines(state.stats),
      zoom,
    );

  // Mailroom clock fire
  const clock = layout.furniture.find((f) => f.type === 'CLOCK');
  if (clock && [...state.cronFireUntil.values()].some((u) => u > now)) {
    drawBitmap(
      ctx,
      FIRE,
      px(clock.col * TILE_SIZE + 5),
      py(clock.row * TILE_SIZE + (blinkOn ? 2 : 3)),
      zoom,
    );
  }

  // Per-character overlays
  for (const ch of a.characters) {
    const hx = ch.x;
    const hy = ch.y - HEAD_OFFSET;
    if (state.dozing.has(ch.id)) {
      const drift = (now / 60) % 12;
      ctx.fillStyle = OVERLAY_PALETTE.sleep;
      ctx.font = FONT(6 * zoom);
      ctx.fillText('z', px(hx + 6), py(hy - drift / 2));
      ctx.fillText('Z', px(hx + 9), py(hy - 6 - drift / 2));
    }
    for (const e of state.effects) {
      if (e.agentId !== ch.id) continue;
      const t = now - e.startedAt;
      const p = Math.min(1, t / EFFECT_MS[e.kind]);
      switch (e.kind) {
        case 'confetti':
          for (const part of confettiParticles(hx, hy, t, e.startedAt)) {
            ctx.fillStyle = part.color;
            ctx.fillRect(px(part.x), py(part.y), zoom, zoom);
          }
          break;
        case 'envelope':
          drawBitmap(ctx, ENVELOPE, px(hx - 60 * (1 - p) - 4), py(hy - 40 * (1 - p) - 8), zoom);
          break;
        case 'phone':
          drawBitmap(ctx, PHONE, px(hx - 3 + Math.sin(t / 25)), py(hy - 10), zoom);
          break;
        case 'clock':
          drawBitmap(ctx, CLOCK_ICON, px(hx - 3), py(hy - 10), zoom);
          break;
        case 'advice':
          ctx.fillStyle = OVERLAY_PALETTE.advice[e.severity ?? 'nit'] ?? OVERLAY_PALETTE.advice.nit;
          ctx.fillRect(px(hx + 5), py(hy - 8), 5 * zoom, 7 * zoom);
          ctx.fillStyle = OVERLAY_PALETTE.text;
          ctx.font = FONT(6 * zoom);
          ctx.fillText('!', px(hx + 6.5), py(hy - 2));
          break;
        case 'alarm':
          if (blinkOn) drawBitmap(ctx, BEACON_ON, px(hx - 3), py(hy - 12), zoom);
          break;
      }
    }
  }

  // Day/night tint
  const tint = phaseTint(state.sun.phase);
  if (tint) {
    ctx.fillStyle = tint;
    ctx.fillRect(0, 0, a.width, a.height);
  }

  // Global alarm beacon + vignette
  if (state.effects.some((e) => e.kind === 'alarm')) {
    drawBitmap(ctx, blinkOn ? BEACON_ON : BEACON_OFF, a.width - 12 * zoom, 6 * zoom, zoom * 1.5);
    if (blinkOn) {
      ctx.strokeStyle = `rgba(${OVERLAY_PALETTE.vignette},0.55)`;
      ctx.lineWidth = 6 * zoom;
      ctx.strokeRect(0, 0, a.width, a.height);
    }
  }
  ctx.restore();
  return boxes;
}

function drawSign(
  ctx: CanvasRenderingContext2D,
  cx: number,
  y: number,
  text: string,
  zoom: number,
  maxTextWidth: number,
  alpha = 0.85,
): void {
  ctx.font = FONT(6 * zoom);
  const label = fitText(ctx, text, maxTextWidth);
  const w = ctx.measureText(label).width + 6 * zoom;
  ctx.fillStyle = `rgba(${OVERLAY_PALETTE.signBackground},${alpha})`;
  ctx.fillRect(cx - w / 2, y, w, 9 * zoom);
  ctx.fillStyle = OVERLAY_PALETTE.signText;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(label, cx, y + 1.5 * zoom);
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let prefix = text;
  while (prefix.length > 0 && ctx.measureText(`${prefix}…`).width > maxWidth) {
    prefix = prefix.slice(0, -1);
  }
  return ctx.measureText(`${prefix}…`).width <= maxWidth ? `${prefix}…` : '';
}

function drawBoard(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  lines: string[],
  zoom: number,
): void {
  const w = 72 * zoom;
  const h = (lines.length * 6 + 4) * zoom;
  ctx.fillStyle = OVERLAY_PALETTE.board;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = OVERLAY_PALETTE.wood;
  ctx.lineWidth = zoom;
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = OVERLAY_PALETTE.ink;
  ctx.font = FONT(5 * zoom);
  ctx.textBaseline = 'top';
  lines.forEach((line, i) =>
    ctx.fillText(fitText(ctx, line, 68 * zoom), x + 2 * zoom, y + (2 + i * 6) * zoom),
  );
  ctx.textBaseline = 'alphabetic';
}

function drawCabinet(
  ctx: CanvasRenderingContext2D,
  box: CabinetBox,
  group: SolGroup | undefined,
  reachable: boolean,
  flash: boolean,
  blinkOn: boolean,
  now: number,
  px: (x: number) => number,
  py: (y: number) => number,
  zoom: number,
): void {
  ctx.fillStyle = flash ? OVERLAY_PALETTE.cabinetAlarm : OVERLAY_PALETTE.cabinet;
  ctx.fillRect(px(box.x), py(box.y), box.w * zoom, box.h * zoom);
  ctx.strokeStyle = OVERLAY_PALETTE.cabinetBorder;
  ctx.lineWidth = zoom;
  ctx.strokeRect(px(box.x), py(box.y), box.w * zoom, box.h * zoom);
  const monitors = group?.monitors ?? [];
  const bladeH = Math.max(2, Math.floor((box.h - 4) / Math.max(1, monitors.length)));
  monitors.forEach((m, i) => {
    const by = box.y + 2 + i * bladeH;
    ctx.fillStyle = OVERLAY_PALETTE.blade;
    ctx.fillRect(px(box.x + 2), py(by), (box.w - 4) * zoom, (bladeH - 1) * zoom);
    ctx.fillStyle = ledColor(
      m.state,
      reachable,
      (blinkOn && i % 2 === 0) || (!blinkOn && i % 2 === 1),
    );
    ctx.fillRect(px(box.x + box.w - 5), py(by), 2 * zoom, Math.max(1, bladeH - 1) * zoom);
  });
  if (reachable && monitors.some((m) => m.state === 'down')) {
    for (let k = 0; k < 3; k++) {
      const t = ((now / 900 + k / 3) % 1) * 16;
      ctx.fillStyle = `rgba(${OVERLAY_PALETTE.smoke},${0.5 - t / 40})`;
      ctx.fillRect(px(box.x + 6 + k * 3), py(box.y - 4 - t), 3 * zoom, 3 * zoom);
    }
  }
  ctx.fillStyle = OVERLAY_PALETTE.label;
  ctx.font = FONT(4 * zoom);
  ctx.textAlign = 'center';
  ctx.fillText(
    fitText(ctx, (group?.name ?? '').split(' ')[0].slice(0, 6), box.w * zoom),
    px(box.x + box.w / 2),
    py(box.y + box.h + 6),
  );
  ctx.textAlign = 'start';
}
/* eslint-enable pixel-agents/no-inline-colors */
