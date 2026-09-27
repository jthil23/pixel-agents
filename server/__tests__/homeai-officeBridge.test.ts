import { beforeEach, describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { ALARM_COOLDOWN_MS, DOZE_AFTER_MS, OfficeBridge } from '../src/homeai/officeBridge.js';
import type { SessionEvent, TrackedAgent } from '../src/homeai/types.js';

const T = '2026-09-27T14:00:00.000Z';
const session: TrackedAgent = {
  key: 'C:/s/a.jsonl',
  source: 'omp',
  role: 'session',
  name: 'Home-AI plan',
  folderName: 'Home-AI',
  sessionId: 'sid-1',
};
const scout: TrackedAgent = {
  key: 'C:/s/a/Scout.jsonl',
  source: 'omp',
  role: 'subagent',
  parentKey: session.key,
  name: 'Scout',
  folderName: 'Home-AI',
};
const start = (id: string, name = 'read', intent?: string): SessionEvent => ({
  kind: 'toolStart',
  toolId: id,
  toolName: name,
  input: { path: 'x/y.ts' },
  ...(intent ? { intent } : {}),
  at: T,
});
const end = (id: string, isError = false, name = 'read'): SessionEvent => ({
  kind: 'toolEnd',
  toolId: id,
  toolName: name,
  isError,
  at: T,
});
const stop: SessionEvent = { kind: 'turnEnd', stopReason: 'stop', at: T };

describe('OfficeBridge', () => {
  let store: AgentStateStore;
  let now: number;
  let msgs: Record<string, unknown>[];
  let bridge: OfficeBridge;
  const effects = () => msgs.filter((m) => m.type === 'officeEffect');
  const ids = () => [...store.keys()];

  beforeEach(() => {
    store = new AgentStateStore();
    now = Date.parse(T);
    msgs = [];
    store.on('broadcast', (m: Record<string, unknown>) => msgs.push(m));
    bridge = new OfficeBridge({ store, redact: (s) => s.replace('SECRET', '••'), now: () => now });
  });

  it('creates a store agent with folderName and provider id', () => {
    bridge.upsertAgent(session);
    expect(store.get(ids()[0])?.folderName).toBe('Home-AI');
    expect(store.get(ids()[0])?.providerId).toBe('omp');
  });

  it('broadcasts active status and a redacted, truncated tool status for live tool starts', () => {
    bridge.upsertAgent(session);
    const id = ids()[0];
    bridge.applyEvents(session.key, [start('t1', 'bash', `SECRET ${'x'.repeat(80)}`)], false);
    expect(msgs).toContainEqual({ type: 'agentStatus', id, status: 'active' });
    const toolStart = msgs.find((m) => m.type === 'agentToolStart')!;
    expect(toolStart.toolId).toBe('t1');
    expect(String(toolStart.status).startsWith('•• x')).toBe(true);
    expect(String(toolStart.status).length).toBeLessThanOrEqual(48);
  });

  it('links subagents to their parent as teammates', () => {
    bridge.upsertAgent(session);
    bridge.upsertAgent(scout);
    const [parentId, childId] = ids();
    expect(store.get(childId)?.leadAgentId).toBe(parentId);
    expect(store.get(childId)?.agentName).toBe('Scout');
    expect(msgs).toContainEqual(
      expect.objectContaining({ type: 'agentTeamInfo', id: parentId, isTeamLead: true }),
    );
  });

  it('fires confetti only after >= 3 tool calls in a stopped turn', () => {
    bridge.upsertAgent(session);
    bridge.applyEvents(session.key, [start('a'), end('a'), start('b'), end('b'), stop], false);
    expect(effects()).toEqual([]);
    bridge.applyEvents(
      session.key,
      [start('c'), end('c'), start('d'), end('d'), start('e'), end('e'), stop],
      false,
    );
    expect(effects()).toEqual([expect.objectContaining({ effect: 'confetti' })]);
  });

  it('suppresses effects and live tool messages during replay, ending with one snapshot', () => {
    bridge.upsertAgent(session);
    const id = ids()[0];
    bridge.applyEvents(
      session.key,
      [start('a'), end('a'), start('b'), end('b'), start('c'), end('c'), stop],
      true,
    );
    expect(effects()).toEqual([]);
    expect(msgs.filter((m) => m.type === 'agentToolStart')).toEqual([]);
    expect(msgs).toContainEqual({ type: 'agentStatus', id, status: 'waiting' });
  });

  it('raises one alarm per error burst and respects the cooldown', () => {
    bridge.upsertAgent(session);
    const burst = (p: string) => [
      start(`${p}1`),
      end(`${p}1`, true),
      start(`${p}2`),
      end(`${p}2`, true),
      start(`${p}3`),
      end(`${p}3`, true),
    ];
    bridge.applyEvents(session.key, burst('x'), false);
    bridge.applyEvents(session.key, burst('y'), false);
    expect(effects().filter((e) => e.effect === 'alarm')).toHaveLength(1);
    now += ALARM_COOLDOWN_MS + 1;
    bridge.applyEvents(session.key, burst('z'), false);
    expect(effects().filter((e) => e.effect === 'alarm')).toHaveLength(2);
  });

  it('raises an alarm for aborted turns', () => {
    bridge.upsertAgent(session);
    bridge.applyEvents(session.key, [{ kind: 'turnEnd', stopReason: 'aborted', at: T }], false);
    expect(effects()).toEqual([
      expect.objectContaining({ effect: 'alarm', reason: 'turn aborted' }),
    ]);
  });

  it('shows waiting-for-input while an ask tool is open', () => {
    bridge.upsertAgent(session);
    const id = ids()[0];
    bridge.applyEvents(session.key, [start('q', 'ask')], false);
    expect(msgs).toContainEqual({
      type: 'agentStatus',
      id,
      status: 'waiting',
      awaitingInput: true,
    });
    bridge.applyEvents(session.key, [end('q', false, 'ask')], false);
    expect(msgs.at(-1)).toEqual({ type: 'agentStatus', id, status: 'active' });
  });

  it('dozes after 2 idle minutes and wakes on the next tool', () => {
    bridge.upsertAgent(session);
    bridge.applyEvents(session.key, [start('a'), end('a'), stop], false);
    now += DOZE_AFTER_MS + 1;
    bridge.tick();
    expect(effects().at(-1)).toEqual(expect.objectContaining({ effect: 'doze' }));
    bridge.applyEvents(session.key, [start('b')], false);
    expect(effects().at(-1)).toEqual(expect.objectContaining({ effect: 'wake' }));
  });
  it('keeps an open tool turn active without a turnEnd', () => {
    bridge.upsertAgent(session);
    const id = ids()[0];
    bridge.applyEvents(session.key, [start('r'), end('r')], false);
    expect(
      bridge
        .snapshotMessages()
        .find((message) => message.type === 'agentStatus' && message.id === id),
    ).toEqual({ type: 'agentStatus', id, status: 'active' });
  });

  it('snapshots unresolved asks after their tool start', () => {
    bridge.upsertAgent(session);
    const id = ids()[0];
    bridge.applyEvents(session.key, [start('q', 'ask')], false);
    const snapshot = bridge.snapshotMessages();
    const toolIndex = snapshot.findIndex(
      (message) => message.type === 'agentToolStart' && message.id === id,
    );
    const statusIndex = snapshot.findIndex(
      (message) => message.type === 'agentStatus' && message.id === id,
    );
    expect(statusIndex).toBeGreaterThan(toolIndex);
    expect(snapshot[statusIndex]).toEqual({
      type: 'agentStatus',
      id,
      status: 'waiting',
      awaitingInput: true,
    });
  });

  it('keeps waiting for input while other tools run and after they finish', () => {
    bridge.upsertAgent(session);
    const id = ids()[0];
    bridge.applyEvents(session.key, [start('q', 'ask'), start('r', 'read')], false);
    expect(msgs.filter((message) => message.type === 'agentStatus').at(-1)).toEqual({
      type: 'agentStatus',
      id,
      status: 'waiting',
      awaitingInput: true,
    });
    bridge.applyEvents(session.key, [end('r')], false);
    expect(msgs.filter((message) => message.type === 'agentStatus').at(-1)).toEqual({
      type: 'agentStatus',
      id,
      status: 'waiting',
      awaitingInput: true,
    });
    bridge.applyEvents(session.key, [end('q', false, 'ask')], false);
    expect(msgs.filter((message) => message.type === 'agentStatus').at(-1)).toEqual({
      type: 'agentStatus',
      id,
      status: 'active',
    });
  });

  it('only dozes after turn completion and the most recent activity has been idle', () => {
    bridge.upsertAgent(session);
    now += DOZE_AFTER_MS + 1;
    bridge.tick();
    expect(effects().filter((message) => message.effect === 'doze')).toEqual([]);

    now = Date.parse(T);
    bridge.applyEvents(session.key, [stop], false);
    now += 119_000;
    bridge.applyEvents(
      session.key,
      [{ kind: 'usage', model: 'opus', costUsd: 0, totalTokens: 10, contextTokens: 10, at: T }],
      false,
    );
    now = Date.parse(T) + 120_000;
    bridge.tick();
    expect(effects().filter((message) => message.effect === 'doze')).toEqual([]);
    now = Date.parse(T) + 119_000 + DOZE_AFTER_MS + 1;
    bridge.tick();
    expect(effects().filter((message) => message.effect === 'doze')).toHaveLength(1);
  });

  it('emits advice severity for advisor advise calls', () => {
    bridge.upsertAgent(session);
    const advisor: TrackedAgent = {
      key: 'C:/s/a/__advisor.jsonl',
      source: 'omp',
      role: 'advisor',
      parentKey: session.key,
      name: 'Advisor',
      folderName: 'Home-AI',
    };
    bridge.upsertAgent(advisor);
    bridge.applyEvents(
      advisor.key,
      [
        {
          kind: 'toolStart',
          toolId: 'v',
          toolName: 'advise',
          input: { note: 'x', severity: 'concern' },
          at: T,
        },
      ],
      false,
    );
    expect(effects()).toEqual([expect.objectContaining({ effect: 'advice', severity: 'concern' })]);
  });

  it('reports detail and root session id, snapshots teams for new clients, and removes agents', () => {
    bridge.upsertAgent(session);
    bridge.upsertAgent(scout);
    const [parentId, childId] = ids();
    bridge.applyEvents(
      session.key,
      [
        { kind: 'usage', model: 'opus', costUsd: 0.5, totalTokens: 10, contextTokens: 900, at: T },
        start('a', 'read', 'Reading a'),
      ],
      false,
    );
    expect(bridge.detail(parentId)).toEqual(
      expect.objectContaining({
        title: 'Home-AI plan',
        model: 'opus',
        costUsd: 0.5,
        contextTokens: 900,
        canOpenTranscript: true,
        recentTools: [{ status: 'Reading a', done: false, isError: false }],
      }),
    );
    expect(bridge.rootSessionId(childId)).toBe('sid-1');
    expect(bridge.snapshotMessages()).toContainEqual(
      expect.objectContaining({ type: 'agentTeamInfo', id: childId, leadAgentId: parentId }),
    );
    expect(bridge.snapshotMessages()).toContainEqual(
      expect.objectContaining({ type: 'agentToolStart', id: parentId, toolId: 'a' }),
    );
    bridge.removeAgent(session.key);
    expect(store.has(parentId)).toBe(false);
  });

  it('maps mailroom starts and failed clock ends to effects', () => {
    bridge.upsertAgent({
      key: 'openclaw:main',
      source: 'openclaw',
      role: 'openclaw',
      name: 'main',
      folderName: 'OpenClaw',
    });
    bridge.mailroom('openclaw:main', 'phone', 'start', false);
    bridge.mailroom('openclaw:main', 'clock', 'end', true);
    bridge.mailroom('openclaw:main', 'envelope', 'end', true);
    expect(effects().map((e) => e.effect)).toEqual(['phone', 'cronFailed']);
  });
});
