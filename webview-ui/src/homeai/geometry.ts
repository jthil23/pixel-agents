/* eslint-disable pixel-agents/no-inline-colors -- These colors define the Home-AI overlay palette. */
import { TILE_SIZE } from '../constants.js';
import type { MonitorState, OfficeStats, SolGroup, SunPhase } from './homeAiState.js';

export interface Bounds {
  minCol: number;
  minRow: number;
  maxCol: number;
  maxRow: number;
}
export interface CabinetBox {
  groupName: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Particle {
  x: number;
  y: number;
  color: string;
}

export const CABINET_W = 20;
export const CABINET_H = 44;
const CABINET_GAP = 12;
const CONFETTI_COUNT = 30;
const CONFETTI_COLORS = ['#ff5252', '#ffd740', '#69f0ae', '#40c4ff', '#e040fb', '#ffffff'];
const GRAVITY = 160;

export function areaBounds(
  layout: { cols: number; areaTiles?: Array<string | null> },
  label: string,
): Bounds | null {
  let b: Bounds | null = null;
  (layout.areaTiles ?? []).forEach((l, i) => {
    if (l !== label) return;
    const c = i % layout.cols;
    const r = Math.floor(i / layout.cols);
    b = b
      ? {
          minCol: Math.min(b.minCol, c),
          minRow: Math.min(b.minRow, r),
          maxCol: Math.max(b.maxCol, c),
          maxRow: Math.max(b.maxRow, r),
        }
      : { minCol: c, minRow: r, maxCol: c, maxRow: r };
  });
  return b;
}

export function cabinetBoxes(bounds: Bounds, groups: SolGroup[]): CabinetBox[] {
  const x0 = bounds.minCol * TILE_SIZE + 8;
  const y0 = bounds.minRow * TILE_SIZE + 14;
  return groups.map((g, i) => ({
    groupName: g.name,
    x: x0 + i * (CABINET_W + CABINET_GAP),
    y: y0,
    w: CABINET_W,
    h: CABINET_H,
  }));
}

export function hitCabinet(boxes: CabinetBox[], wx: number, wy: number): string | null {
  const hit = boxes.find((b) => wx >= b.x && wx < b.x + b.w && wy >= b.y && wy < b.y + b.h);
  return hit ? hit.groupName : null;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const compact = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(1)}k`
      : String(n);

export function statsLines(stats: OfficeStats | null): string[] {
  if (!stats) return ['TODAY', 'waiting for data…'];
  const spend = Object.values(stats.spendByModel).reduce((a, b) => a + b, 0);
  return [
    'TODAY',
    `$${spend.toFixed(2)} · ${stats.toolCalls} tools`,
    `busy: ${stats.busiestAgent ? clip(stats.busiestAgent, 13) : '—'}`,
    `claw ${compact(stats.openclawTokens)} tok`,
    `cron ${stats.cronOk} ok / ${stats.cronFailed} fail`,
    `SOL ${typeof stats.solUptime24h === 'number' ? `${(stats.solUptime24h * 100).toFixed(1)}%` : '—'} up`,
  ];
}

function rand(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function confettiParticles(
  cx: number,
  cy: number,
  elapsedMs: number,
  seed: number,
): Particle[] {
  const r = rand(seed);
  const s = elapsedMs / 1000;
  return Array.from({ length: CONFETTI_COUNT }, (_, i) => {
    const angle = Math.PI * (0.15 + 0.7 * r());
    const speed = 60 + 80 * r();
    return {
      x: cx + Math.cos(angle) * speed * s,
      y: cy - Math.sin(angle) * speed * s + 0.5 * GRAVITY * s * s,
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
    };
  });
}

export function phaseTint(phase: SunPhase): string | null {
  switch (phase) {
    case 'golden':
      return 'rgba(255,170,60,0.12)';
    case 'dusk':
      return 'rgba(90,60,150,0.22)';
    case 'night':
      return 'rgba(10,15,50,0.45)';
    default:
      return null;
  }
}

export function ledColor(state: MonitorState, reachable: boolean, blinkOn: boolean): string {
  if (!reachable || state === 'unknown') return '#6b6b6b';
  switch (state) {
    case 'down':
      return '#ff3b30';
    case 'flapping':
    case 'pending':
      return '#ffb300';
    case 'maintenance':
      return '#40c4ff';
    default:
      return blinkOn ? '#39ff14' : '#1b5e20';
  }
}
/* eslint-enable pixel-agents/no-inline-colors */
