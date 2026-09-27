import * as path from 'node:path';

import type { AgentStateStore } from '../agentStateStore.js';
import type { AgentState } from '../types.js';
import type { AgentSource, MailroomKind, SessionEvent, SourceSink, TrackedAgent } from './types.js';

export const DOZE_AFTER_MS = 2 * 60_000;
export const ERROR_BURST = 3;
export const ERROR_WINDOW_MS = 60_000;
export const ALARM_COOLDOWN_MS = 5 * 60_000;
export const CONFETTI_MIN_TOOLS = 3;
export const BUBBLE_MAX = 48;
const RECENT_TOOLS = 10;
const DEFAULT_CONTEXT_WINDOW = 200_000;
const FIRST_ID = 5000;

type Send = (m: Record<string, unknown>) => void;

export interface AgentDetailPayload {
  agentId: number;
  title: string;
  source: AgentSource;
  role: string;
  model: string;
  costUsd: number;
  contextTokens: number;
  recentTools: { status: string; done: boolean; isError: boolean }[];
  canOpenTranscript: boolean;
}

interface ToolRecord {
  toolId: string;
  toolName: string;
  status: string;
  done: boolean;
  isError: boolean;
}

interface Info {
  id: number;
  agent: TrackedAgent;
  title: string;
  roleLabel: string;
  model: string;
  costUsd: number;
  contextTokens: number;
  recent: ToolRecord[];
  active: Map<string, ToolRecord>;
  turnOpen: boolean;
  turnEnded: boolean;
  turnTools: number; // non-yield tool starts since userMessage (yield threshold)
  stopTools: number; // all tool starts since a stop/user boundary (stop threshold)
  celebrated: boolean; // prevents duplicate confetti within one turn
  errorTimes: number[];
  lastEventAt: number;
  waiting: boolean;
  dozing: boolean;
  lastAlarmAt: number;
}

export function toolStatus(
  toolName: string,
  input: Record<string, unknown>,
  intent?: string,
): string {
  if (intent) return intent;
  const base = (v: unknown) => (typeof v === 'string' ? path.basename(v) : '');
  switch (toolName) {
    case 'read':
      return `Reading ${base(input.path)}`;
    case 'edit':
      return 'Editing code';
    case 'write':
      return `Writing ${base(input.path)}`;
    case 'bash':
      return `Running: ${typeof input.command === 'string' ? input.command : ''}`;
    case 'grep':
    case 'glob':
    case 'find':
      return 'Searching';
    case 'task':
      return 'Delegating to subagents';
    case 'web_search':
      return 'Searching the web';
    case 'eval':
      return 'Running code';
    case 'ask':
      return 'Asking you';
    case 'advise':
      return 'Advising';
    default:
      return `Using ${toolName}`;
  }
}

function truncate(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > BUBBLE_MAX ? `${flat.slice(0, BUBBLE_MAX - 1)}…` : flat;
}

function makeState(
  id: number,
  a: TrackedAgent,
  lead?: { id: number; teamName: string },
): AgentState {
  return {
    id,
    sessionId: a.sessionId ?? a.key,
    terminalRef: undefined,
    isExternal: true,
    projectDir: a.folderName,
    jsonlFile: a.key,
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    isWaiting: true,
    permissionSent: false,
    hadToolsInTurn: false,
    folderName: a.folderName,
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    hookDelivered: true,
    contextTokens: 0,
    maxContextTokens: DEFAULT_CONTEXT_WINDOW,
    providerId: a.source,
    ...(lead ? { leadAgentId: lead.id, teamName: lead.teamName, agentName: a.name } : {}),
  } as AgentState;
}

export class OfficeBridge implements SourceSink {
  private readonly byKey = new Map<string, Info>();
  private readonly byId = new Map<number, Info>();
  private nextId = FIRST_ID;

  constructor(
    private readonly deps: {
      store: AgentStateStore;
      redact: (s: string) => string;
      now: () => number;
    },
  ) {}

  upsertAgent(a: TrackedAgent): void {
    if (this.byKey.has(a.key)) return;
    const id = this.nextId++;
    const parent = a.parentKey ? this.byKey.get(a.parentKey) : undefined;
    const teamName = parent ? `home-ai-${parent.id}` : undefined;
    const info: Info = {
      id,
      agent: a,
      title: this.deps.redact(a.name),
      roleLabel: a.role,
      model: '',
      costUsd: 0,
      contextTokens: 0,
      recent: [],
      active: new Map(),
      turnOpen: false,
      turnEnded: false,
      turnTools: 0,
      stopTools: 0,
      celebrated: false,
      errorTimes: [],
      lastEventAt: this.deps.now(),
      waiting: true,
      dozing: false,
      lastAlarmAt: Number.NEGATIVE_INFINITY,
    };
    this.byKey.set(a.key, info);
    this.byId.set(id, info);
    if (parent && teamName) {
      const parentState = this.deps.store.get(parent.id);
      if (parentState) {
        parentState.teamName = teamName;
        parentState.isTeamLead = true;
      }
      this.deps.store.broadcast({
        type: 'agentTeamInfo',
        id: parent.id,
        teamName,
        isTeamLead: true,
      });
    }
    this.deps.store.set(
      id,
      makeState(id, a, parent && teamName ? { id: parent.id, teamName } : undefined),
    );
  }

  applyEvents(key: string, events: SessionEvent[], replay: boolean): void {
    const info = this.byKey.get(key);
    if (!info) return;
    for (const ev of events) this.applyOne(info, ev, replay);
    if (replay) this.sendState(info, (m) => this.deps.store.broadcast(m));
  }

  removeAgent(key: string): void {
    const info = this.byKey.get(key);
    if (!info) return;
    this.byKey.delete(key);
    this.byId.delete(info.id);
    this.deps.store.delete(info.id);
  }

  mailroom(key: string, kind: MailroomKind, phase: 'start' | 'end', failed: boolean): void {
    const info = this.byKey.get(key);
    if (!info) return;
    if (phase === 'start') this.effect({ effect: kind, agentId: info.id });
    else if (failed && kind === 'clock') this.effect({ effect: 'cronFailed', agentId: info.id });
  }

  tick(): void {
    const now = this.deps.now();
    for (const info of this.byId.values()) {
      if (
        info.turnEnded &&
        !info.turnOpen &&
        info.active.size === 0 &&
        !info.dozing &&
        now - info.lastEventAt >= DOZE_AFTER_MS
      ) {
        info.dozing = true;
        this.effect({ effect: 'doze', agentId: info.id });
      }
    }
  }

  effect(msg: {
    effect: string;
    agentId?: number;
    groupName?: string;
    reason?: string;
    severity?: string;
  }): void {
    this.deps.store.broadcast({ type: 'officeEffect', ...msg });
  }

  detail(agentId: number): AgentDetailPayload | null {
    const info = this.byId.get(agentId);
    if (!info) return null;
    return {
      agentId,
      title: info.title,
      source: info.agent.source,
      role: info.roleLabel,
      model: info.model,
      costUsd: info.costUsd,
      contextTokens: info.contextTokens,
      recentTools: info.recent.map(({ status, done, isError }) => ({ status, done, isError })),
      canOpenTranscript: this.rootSessionId(agentId) !== null,
    };
  }

  rootSessionId(agentId: number): string | null {
    let info = this.byId.get(agentId);
    while (info?.agent.parentKey) info = this.byKey.get(info.agent.parentKey);
    return info?.agent.source === 'omp' && info.agent.sessionId ? info.agent.sessionId : null;
  }

  /** Upstream's webviewReady replays neither team links nor active tools; new clients get them here. */
  snapshotMessages(): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const info of this.byId.values()) {
      const state = this.deps.store.get(info.id);
      if (state?.leadAgentId !== undefined) {
        out.push({
          type: 'agentTeamInfo',
          id: info.id,
          teamName: state.teamName,
          agentName: state.agentName,
          leadAgentId: state.leadAgentId,
        });
      } else if (state?.isTeamLead) {
        out.push({
          type: 'agentTeamInfo',
          id: info.id,
          teamName: state.teamName,
          isTeamLead: true,
        });
      }
      this.sendState(info, (m) => out.push(m));
      if (info.dozing) out.push({ type: 'officeEffect', effect: 'doze', agentId: info.id });
    }
    return out;
  }

  private effectiveStatus(info: Info): { status: 'active' | 'waiting'; awaitingInput?: true } {
    if ([...info.active.values()].some((tool) => tool.toolName === 'ask')) {
      return { status: 'waiting', awaitingInput: true };
    }
    if (info.turnOpen || info.active.size > 0) return { status: 'active' };
    return { status: 'waiting' };
  }

  private sendState(info: Info, send: Send): void {
    const id = info.id;
    for (const t of info.active.values())
      send({
        type: 'agentToolStart',
        id,
        toolId: t.toolId,
        status: t.status,
        toolName: t.toolName,
      });
    send({ type: 'agentStatus', id, ...this.effectiveStatus(info) });
    if (info.contextTokens > 0) {
      send({
        type: 'agentContextUsage',
        id,
        contextTokens: info.contextTokens,
        maxContextTokens: Math.max(DEFAULT_CONTEXT_WINDOW, info.contextTokens),
      });
    }
  }

  private clearTools(info: Info, state: AgentState | undefined): void {
    info.active.clear();
    state?.activeToolIds.clear();
    state?.activeToolStatuses.clear();
    state?.activeToolNames.clear();
  }

  private applyOne(info: Info, ev: SessionEvent, replay: boolean): void {
    const { store } = this.deps;
    const id = info.id;
    const state = store.get(id);
    const live = !replay;
    const eventTime = live ? this.deps.now() : Date.parse(ev.at) || this.deps.now();
    if (ev.kind !== 'header' && ev.kind !== 'sessionExit') info.lastEventAt = eventTime;
    switch (ev.kind) {
      case 'header':
      case 'sessionExit':
        return;
      case 'userMessage':
        info.turnTools = 0;
        info.stopTools = 0;
        info.celebrated = false;
        return;
      case 'title':
        info.title = this.deps.redact(ev.title);
        return;
      case 'init':
        info.roleLabel = this.deps.redact(
          ev.modelRole ? `${ev.agent} (${ev.modelRole})` : ev.agent,
        );
        if (!info.model && ev.resolvedModel) info.model = this.deps.redact(ev.resolvedModel);
        return;
      case 'usage':
        info.model = this.deps.redact(ev.model);
        info.costUsd += ev.costUsd;
        info.contextTokens = ev.contextTokens;
        if (!info.turnEnded) {
          info.turnOpen = true;
          info.turnEnded = false;
        }
        if (live && ev.contextTokens > 0) {
          store.broadcast({
            type: 'agentContextUsage',
            id,
            contextTokens: ev.contextTokens,
            maxContextTokens: Math.max(DEFAULT_CONTEXT_WINDOW, ev.contextTokens),
          });
        }
        return;
      case 'toolStart': {
        const status = truncate(this.deps.redact(toolStatus(ev.toolName, ev.input, ev.intent)));
        const rec: ToolRecord = {
          toolId: ev.toolId,
          toolName: ev.toolName,
          status,
          done: false,
          isError: false,
        };
        info.active.set(ev.toolId, rec);
        info.recent.push(rec);
        if (info.recent.length > RECENT_TOOLS) info.recent.shift();
        if (info.turnEnded) {
          info.turnTools = 0;
          info.stopTools = 0;
          info.celebrated = false;
        }
        if (ev.toolName !== 'yield') info.turnTools += 1;
        info.stopTools += 1;
        info.waiting = false;
        info.turnOpen = true;
        info.turnEnded = false;
        state?.activeToolIds.add(ev.toolId);
        state?.activeToolStatuses.set(ev.toolId, status);
        state?.activeToolNames.set(ev.toolId, ev.toolName);
        if (state) state.isWaiting = false;
        if (!live) return;
        if (info.dozing) {
          info.dozing = false;
          this.effect({ effect: 'wake', agentId: id });
        }
        store.broadcast({
          type: 'agentToolStart',
          id,
          toolId: ev.toolId,
          status,
          toolName: ev.toolName,
        });
        store.broadcast({ type: 'agentStatus', id, ...this.effectiveStatus(info) });
        if (ev.toolName === 'advise' && info.agent.role === 'advisor') {
          this.effect({
            effect: 'advice',
            agentId: id,
            severity:
              ev.input.severity === 'nit' ||
              ev.input.severity === 'concern' ||
              ev.input.severity === 'blocker'
                ? ev.input.severity
                : 'nit',
          });
        }
        return;
      }
      case 'toolEnd': {
        const rec = info.active.get(ev.toolId);
        if (rec) {
          rec.done = true;
          rec.isError = ev.isError;
        }
        info.active.delete(ev.toolId);
        info.lastEventAt = eventTime;
        state?.activeToolIds.delete(ev.toolId);
        state?.activeToolStatuses.delete(ev.toolId);
        state?.activeToolNames.delete(ev.toolId);
        if (
          ev.toolName === 'yield' &&
          !ev.isError &&
          info.turnTools >= CONFETTI_MIN_TOOLS &&
          !info.celebrated
        ) {
          info.celebrated = true;
          if (live) this.effect({ effect: 'confetti', agentId: id });
        }
        if (!live) return;
        store.broadcast({ type: 'agentToolDone', id, toolId: ev.toolId });
        store.broadcast({ type: 'agentStatus', id, ...this.effectiveStatus(info) });
        if (ev.isError) {
          const now = this.deps.now();
          info.errorTimes = info.errorTimes.filter((t) => now - t < ERROR_WINDOW_MS);
          info.errorTimes.push(now);
          if (info.errorTimes.length >= ERROR_BURST) {
            info.errorTimes = [];
            this.alarm(info, 'tool errors');
          }
        }
        return;
      }
      case 'turnEnd': {
        const tools = info.stopTools;
        info.stopTools = 0;
        info.turnOpen = false;
        info.turnEnded = true;
        info.waiting = true;
        info.lastEventAt = eventTime;
        this.clearTools(info, state);
        const confetti =
          ev.stopReason === 'stop' && tools >= CONFETTI_MIN_TOOLS && !info.celebrated;
        if (confetti) info.celebrated = true;
        if (state) state.isWaiting = true;
        if (!live) return;
        store.broadcast({ type: 'agentToolsClear', id });
        store.broadcast({ type: 'agentStatus', id, status: 'waiting' });
        if (confetti) this.effect({ effect: 'confetti', agentId: id });
        if (ev.stopReason === 'aborted' || ev.stopReason === 'error')
          this.alarm(info, `turn ${ev.stopReason}`);
        return;
      }
    }
  }

  private alarm(info: Info, reason: string): void {
    const now = this.deps.now();
    if (now - info.lastAlarmAt < ALARM_COOLDOWN_MS) return;
    info.lastAlarmAt = now;
    this.effect({ effect: 'alarm', agentId: info.id, reason });
  }
}
