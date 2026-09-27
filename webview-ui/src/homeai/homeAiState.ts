export type SunPhase = 'day' | 'golden' | 'dusk' | 'night';
export type MonitorState = 'up' | 'flapping' | 'pending' | 'maintenance' | 'down' | 'unknown';
export interface SolBeat {
  status: number;
  ping: number | null;
  time: string;
}
export interface SolMonitor {
  id: number;
  name: string;
  state: MonitorState;
  uptime24h?: number | null;
  beats: SolBeat[];
}
export interface SolGroup {
  name: string;
  monitors: SolMonitor[];
}
export interface OfficeStats {
  date: string;
  spendByModel: Record<string, number>;
  openclawTokens: number;
  toolCalls: number;
  busiestAgent?: string | null;
  cronOk: number;
  cronFailed: number;
  solUptime24h?: number | null;
}
export interface AgentDetail {
  agentId: number;
  title: string;
  source: 'omp' | 'openclaw';
  role: string;
  model: string;
  costUsd: number;
  contextTokens: number;
  recentTools: { status: string; done: boolean; isError: boolean }[];
  canOpenTranscript: boolean;
}
export type TimedEffect = 'confetti' | 'alarm' | 'envelope' | 'phone' | 'clock' | 'advice';
export const EFFECT_MS: Record<TimedEffect, number> = {
  confetti: 2500,
  alarm: 10_000,
  envelope: 2000,
  phone: 3000,
  clock: 2000,
  advice: 10_000,
};
export const CRON_FIRE_MS = 24 * 3_600_000;
export interface ActiveEffect {
  kind: TimedEffect;
  agentId?: number;
  groupName?: string;
  severity?: string;
  reason?: string;
  startedAt: number;
  until: number;
}
export type Panel =
  { kind: 'agent'; agentId: number } | { kind: 'cabinet'; groupName: string } | null;
export type Sound = 'clack' | 'ding' | 'klaxon';

export interface HomeAiState {
  active: boolean;
  sol: { reachable: boolean; groups: SolGroup[] };
  sun: { phase: SunPhase; elevation: number | null };
  stats: OfficeStats | null;
  /** Area label → project folder shown on the room sign. */
  rooms: Record<string, string>;
  effects: ActiveEffect[];
  dozing: Set<number>;
  cronFireUntil: Map<number, number>;
  details: Map<number, AgentDetail>;
  links: Map<number, { url?: string; reason?: string }>;
  panel: Panel;
}

export interface ApplyResult {
  handled: boolean;
  sound?: Sound;
  openUrl?: string;
  firstActivation?: boolean;
}

const HOME_AI_TYPES = new Set([
  'ambientSol',
  'ambientSun',
  'officeStats',
  'officeEffect',
  'projectRooms',
  'agentDetail',
  'transcriptLink',
]);

export function createHomeAiState(): HomeAiState {
  return {
    active: false,
    sol: { reachable: false, groups: [] },
    sun: { phase: 'day', elevation: null },
    stats: null,
    rooms: {},
    effects: [],
    dozing: new Set(),
    cronFireUntil: new Map(),
    details: new Map(),
    links: new Map(),
    panel: null,
  };
}

export function applyHomeAiMessage(
  s: HomeAiState,
  msg: Record<string, unknown>,
  now: number,
): ApplyResult {
  const type = msg.type;
  if (type === 'agentToolStart') return { handled: false, sound: 'clack' };
  if (type === 'agentClosed') {
    const id = Number(msg.id);
    s.dozing.delete(id);
    s.details.delete(id);
    s.links.delete(id);
    s.cronFireUntil.delete(id);
    if (s.panel?.kind === 'agent' && s.panel.agentId === id) s.panel = null;
    return { handled: false };
  }
  if (typeof type !== 'string' || !HOME_AI_TYPES.has(type)) return { handled: false };

  const res: ApplyResult = { handled: true };
  if (!s.active) {
    s.active = true;
    res.firstActivation = true;
  }
  const agentId = typeof msg.agentId === 'number' ? msg.agentId : undefined;
  switch (type) {
    case 'ambientSol':
      s.sol = {
        reachable: msg.reachable === true,
        groups: Array.isArray(msg.groups) ? (msg.groups as SolGroup[]) : [],
      };
      break;
    case 'ambientSun':
      s.sun = {
        phase: msg.phase as SunPhase,
        elevation: typeof msg.elevation === 'number' ? msg.elevation : null,
      };
      break;
    case 'officeStats':
      s.stats = msg as unknown as OfficeStats;
      break;
    case 'projectRooms':
      s.rooms = Object.fromEntries(
        ((msg.rooms as { label: string; projectName: string }[] | undefined) ?? []).map((r) => [
          r.label,
          r.projectName,
        ]),
      );
      break;
    case 'agentDetail':
      if (agentId !== undefined) s.details.set(agentId, msg as unknown as AgentDetail);
      break;
    case 'transcriptLink': {
      if (agentId === undefined) break;
      const link = {
        ...(typeof msg.url === 'string' ? { url: msg.url } : {}),
        ...(typeof msg.reason === 'string' ? { reason: msg.reason } : {}),
      };
      s.links.set(agentId, link);
      if (link.url && s.panel?.kind === 'agent' && s.panel.agentId === agentId)
        res.openUrl = link.url;
      break;
    }
    case 'officeEffect': {
      const effect = String(msg.effect);
      if (effect === 'doze' && agentId !== undefined) s.dozing.add(agentId);
      else if (effect === 'wake' && agentId !== undefined) s.dozing.delete(agentId);
      else if (effect === 'cronFailed' && agentId !== undefined)
        s.cronFireUntil.set(agentId, now + CRON_FIRE_MS);
      else if (effect in EFFECT_MS) {
        const kind = effect as TimedEffect;
        if (kind === 'advice')
          s.effects = s.effects.filter((e) => !(e.kind === 'advice' && e.agentId === agentId));
        s.effects.push({
          kind,
          ...(agentId !== undefined ? { agentId } : {}),
          ...(typeof msg.groupName === 'string' ? { groupName: msg.groupName } : {}),
          ...(typeof msg.severity === 'string' ? { severity: msg.severity } : {}),
          ...(typeof msg.reason === 'string' ? { reason: msg.reason } : {}),
          startedAt: now,
          until: now + EFFECT_MS[kind],
        });
        if (kind === 'confetti') res.sound = 'ding';
        if (kind === 'alarm') res.sound = 'klaxon';
      }
      break;
    }
  }
  return res;
}

/** Drops expired effects and cron fires; returns true when anything changed. */
export function pruneEffects(s: HomeAiState, now: number): boolean {
  const before = s.effects.length + s.cronFireUntil.size;
  s.effects = s.effects.filter((e) => e.until > now);
  for (const [id, until] of s.cronFireUntil) if (until <= now) s.cronFireUntil.delete(id);
  return before !== s.effects.length + s.cronFireUntil.size;
}
