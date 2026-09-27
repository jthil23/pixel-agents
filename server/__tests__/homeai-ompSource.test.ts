import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { OfficeBridge } from '../src/homeai/officeBridge.js';
import { ACTIVE_WINDOW_MS, folderOf, OmpSource } from '../src/homeai/ompSource.js';
import type { MailroomKind, SessionEvent, SourceSink, TrackedAgent } from '../src/homeai/types.js';

const NOW = Date.parse('2026-09-27T15:00:00Z');
const header = (id: string, cwd: string) =>
  [
    JSON.stringify({
      type: 'title',
      v: '1',
      title: `T-${id}`,
      source: 'auto',
      updatedAt: '2026-09-27T14:59:00Z',
      pad: ' '.repeat(80),
    }),
    JSON.stringify({
      type: 'session',
      version: '3',
      id,
      cwd,
      title: `T-${id}`,
      timestamp: '2026-09-27T14:59:00Z',
    }),
  ].join('\n');
const call = (id: string, name = 'read') =>
  JSON.stringify({
    type: 'message',
    timestamp: '2026-09-27T14:59:10Z',
    message: { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: {} }] },
  });
const setMtime = (file: string, ms: number) => fs.utimesSync(file, ms / 1000, ms / 1000);

class RecordingSink implements SourceSink {
  upserts: TrackedAgent[] = [];
  applied: { key: string; kinds: string[]; replay: boolean }[] = [];
  removed: string[] = [];
  upsertAgent(a: TrackedAgent) {
    this.upserts.push(a);
  }
  applyEvents(key: string, events: SessionEvent[], replay: boolean) {
    this.applied.push({ key, kinds: events.map((e) => e.kind), replay });
  }
  removeAgent(key: string) {
    this.removed.push(key);
  }
  mailroom(_k: string, _kind: MailroomKind, _p: 'start' | 'end', _f: boolean) {}
}

describe('OmpSource', () => {
  let root: string;
  let sink: RecordingSink;
  let now: number;
  let src: OmpSource;
  let sessionFile: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'homeai-omp-'));
    const proj = path.join(root, '--G--Home-AI--');
    fs.mkdirSync(proj);
    sessionFile = path.join(proj, '2026-09-27T14-59-00-000Z_s1.jsonl');
    fs.writeFileSync(sessionFile, `${header('s1', 'G:\\Home-AI')}\n${call('t1')}\n`);
    const nested = sessionFile.slice(0, -'.jsonl'.length);
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, 'Scout.jsonl'), `${header('c1', 'G:\\Home-AI')}\n`);
    fs.writeFileSync(path.join(nested, '__advisor.jsonl'), `${header('a1', 'G:\\Home-AI')}\n`);
    for (const f of [
      sessionFile,
      path.join(nested, 'Scout.jsonl'),
      path.join(nested, '__advisor.jsonl'),
    ])
      setMtime(f, NOW - 60_000);
    sink = new RecordingSink();
    now = NOW;
    src = new OmpSource({ root, roomActivityDays: 7, sink, now: () => now });
  });

  it('derives folder names from Windows and POSIX cwd values', () => {
    expect(folderOf('G:\\Home-AI')).toBe('Home-AI');
    expect(folderOf('/home/jt/proj/')).toBe('proj');
  });
  it('registers the session before its subagent and advisor, with roles and parent keys', () => {
    src.discover();
    src.poll();
    expect(sink.upserts[0]).toEqual(
      expect.objectContaining({
        role: 'session',
        name: 'T-s1',
        folderName: 'Home-AI',
        sessionId: 's1',
        source: 'omp',
      }),
    );
    expect(sink.upserts.slice(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'subagent', name: 'Scout', parentKey: sessionFile }),
        expect.objectContaining({ role: 'advisor', name: 'Advisor', parentKey: sessionFile }),
      ]),
    );
    expect(sink.upserts.slice(1).every((u) => u.sessionId === undefined)).toBe(true);
  });
  it('replays the first batch and streams later lines live', () => {
    src.discover();
    src.poll();
    expect(sink.applied[0]).toEqual({
      key: sessionFile,
      kinds: ['title', 'header', 'title', 'toolStart'],
      replay: true,
    });
    fs.appendFileSync(sessionFile, `${call('t2')}\n`);
    src.poll();
    expect(sink.applied.at(-1)).toEqual({ key: sessionFile, kinds: ['toolStart'], replay: false });
  });
  it('removes a session on session_exit and does not re-add it until the file changes', () => {
    src.discover();
    src.poll();
    fs.appendFileSync(
      sessionFile,
      `${JSON.stringify({ type: 'custom', customType: 'session_exit', data: {}, timestamp: 'x' })}\n`,
    );
    setMtime(sessionFile, NOW - 30_000);
    src.poll();
    expect(sink.removed).toContain(sessionFile);
    src.discover();
    src.poll();
    expect(sink.upserts.filter((u) => u.key === sessionFile)).toHaveLength(1);
  });

  it('forgets deleted retired files and their cached cwd before tracking a recreated path', () => {
    src.discover();
    src.poll();
    fs.appendFileSync(
      sessionFile,
      `${JSON.stringify({ type: 'custom', customType: 'session_exit', data: {}, timestamp: 'x' })}\n`,
    );
    setMtime(sessionFile, NOW - 30_000);
    src.poll();
    fs.unlinkSync(sessionFile);
    src.discover();

    fs.writeFileSync(sessionFile, `${header('replacement', 'G:\\RecreatedFolder')}\n`);
    setMtime(sessionFile, NOW - 30_000);
    src.discover();
    src.poll();
    expect(sink.upserts.filter((agent) => agent.key === sessionFile).at(-1)?.folderName).toBe(
      'RecreatedFolder',
    );
  });
  it('walks idle agents out after the active window', () => {
    src.discover();
    src.poll();
    now = NOW + ACTIVE_WINDOW_MS + 1;
    src.poll();
    expect(sink.removed).toContain(sessionFile);
  });
  it('reports room activity within the configured days only', () => {
    const old = path.join(root, '--G--Old--');
    fs.mkdirSync(old);
    const oldFile = path.join(old, 'o.jsonl');
    fs.writeFileSync(oldFile, `${header('o', 'G:\\Old')}\n`);
    setMtime(oldFile, NOW - 8 * 86_400_000);
    expect(src.discover()).toEqual([{ folderName: 'Home-AI', lastActive: NOW - 60_000 }]);
  });
  it('does not extend an old session’s idle clock during initial replay', () => {
    setMtime(sessionFile, NOW - ACTIVE_WINDOW_MS + 60_000);
    src.discover();
    src.poll();
    expect(sink.upserts.some((agent) => agent.key === sessionFile)).toBe(true);
    now = NOW + 2 * 60_000;
    src.poll();
    expect(sink.removed).toContain(sessionFile);
  });

  it('keeps a resumed session alive when new work follows a historical session_exit', () => {
    fs.writeFileSync(sessionFile, `${header('s1', 'G:\\Home-AI')}\n`);
    setMtime(sessionFile, NOW - 60_000);
    src.discover();
    src.poll();
    fs.appendFileSync(
      sessionFile,
      `${JSON.stringify({ type: 'custom', customType: 'session_exit', data: {}, timestamp: 'x' })}\n`,
    );
    setMtime(sessionFile, NOW - 30_000);
    src.poll();
    expect(sink.removed).toContain(sessionFile);

    fs.appendFileSync(sessionFile, `${call('resumed')}\n`);
    setMtime(sessionFile, NOW - 10_000);
    src.discover();
    src.poll();
    const upsertCount = sink.upserts.filter((agent) => agent.key === sessionFile).length;
    expect(upsertCount).toBe(2);
    now = NOW + 1_000;
    src.poll();
    expect(sink.removed.filter((key) => key === sessionFile)).toHaveLength(1);
  });

  it('tracks an active child and its idle parent', () => {
    const parent = path.join(root, '--G--Home-AI--', 'idle-parent.jsonl');
    fs.writeFileSync(parent, `${header('parent', '/work/Parent')}\n`);
    setMtime(parent, NOW - ACTIVE_WINDOW_MS - 60_000);
    const child = path.join(parent.slice(0, -'.jsonl'.length), 'Scout.jsonl');
    fs.mkdirSync(path.dirname(child), { recursive: true });
    fs.writeFileSync(child, `${header('scout', '/work/Child')}\n`);
    setMtime(child, NOW - 60_000);

    src.discover();
    src.poll();

    const parentIndex = sink.upserts.findIndex((agent) => agent.key === parent);
    const childIndex = sink.upserts.findIndex((agent) => agent.key === child);
    expect(parentIndex).toBeGreaterThanOrEqual(0);
    expect(childIndex).toBeGreaterThan(parentIndex);
    expect(sink.upserts[childIndex]).toEqual(
      expect.objectContaining({ role: 'subagent', parentKey: parent }),
    );
  });

  it('includes nested transcript folders and reports the newest activity per folder', () => {
    const parent = path.join(root, '--G--Home-AI--', 'room-parent.jsonl');
    const child = path.join(parent.slice(0, -'.jsonl'.length), 'Scout.jsonl');
    fs.writeFileSync(parent, `${header('parent', '/work/Shared')}\n`);
    fs.mkdirSync(path.dirname(child), { recursive: true });
    fs.writeFileSync(child, `${header('scout', '/work/Shared')}\n`);
    setMtime(parent, NOW - 60_000);
    setMtime(child, NOW - 10_000);
    const childOnly = path.join(path.dirname(child), 'Other.jsonl');
    fs.writeFileSync(childOnly, `${header('other', '/work/Child')}\n`);
    setMtime(childOnly, NOW - 5_000);

    expect(src.discover()).toEqual(
      expect.arrayContaining([{ folderName: 'Shared', lastActive: NOW - 10_000 }]),
    );

    expect(src.discover()).toEqual(
      expect.arrayContaining([
        { folderName: 'Shared', lastActive: NOW - 10_000 },
        { folderName: 'Child', lastActive: NOW - 5_000 },
      ]),
    );
  });
  it('replays only resumed-session work after clearing pre-exit tool state', () => {
    const bridgeStore = new AgentStateStore();
    const bridge = new OfficeBridge({ store: bridgeStore, redact: (text) => text, now: () => now });
    fs.writeFileSync(sessionFile, `${header('s1', 'G:\\Home-AI')}\n${call('ask-1', 'ask')}\n`);
    setMtime(sessionFile, NOW - 60_000);
    src = new OmpSource({ root, roomActivityDays: 7, sink: bridge, now: () => now });
    src.discover();
    src.poll();
    expect(bridge.snapshotMessages()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'agentToolStart', toolName: 'ask' }),
      ]),
    );

    fs.appendFileSync(
      sessionFile,
      `${JSON.stringify({ type: 'custom', customType: 'session_exit', data: {}, timestamp: 'x' })}\n`,
    );
    setMtime(sessionFile, NOW - 30_000);
    src.poll();
    fs.appendFileSync(sessionFile, `${call('read-1')}\n`);
    setMtime(sessionFile, NOW - 10_000);
    src.discover();
    src.poll();

    const snapshot = bridge.snapshotMessages();
    const toolStarts = snapshot.filter((message) => message.type === 'agentToolStart');
    expect(toolStarts).toEqual([
      expect.objectContaining({ type: 'agentToolStart', toolId: 'read-1', toolName: 'read' }),
    ]);
    expect(snapshot).toContainEqual(
      expect.objectContaining({ type: 'agentStatus', status: 'active' }),
    );
  });
  it('re-registers from saved metadata when exit and resumed work share a batch', () => {
    const bridgeStore = new AgentStateStore();
    const bridge = new OfficeBridge({ store: bridgeStore, redact: (text) => text, now: () => now });
    fs.writeFileSync(sessionFile, `${header('s1', 'G:\\Home-AI')}\n${call('ask-1', 'ask')}\n`);
    setMtime(sessionFile, NOW - 60_000);
    src = new OmpSource({ root, roomActivityDays: 7, sink: bridge, now: () => now });
    src.discover();
    src.poll();

    fs.appendFileSync(
      sessionFile,
      `${JSON.stringify({ type: 'custom', customType: 'session_exit', data: {}, timestamp: 'x' })}\n${call('read-1')}\n`,
    );
    setMtime(sessionFile, NOW - 30_000);
    src.poll();
    let snapshot = bridge.snapshotMessages();
    expect(snapshot.filter((message) => message.type === 'agentToolStart')).toEqual([
      expect.objectContaining({ type: 'agentToolStart', toolId: 'read-1', toolName: 'read' }),
    ]);
    expect(snapshot).toContainEqual(
      expect.objectContaining({ type: 'agentStatus', status: 'active' }),
    );

    fs.appendFileSync(sessionFile, `${call('read-2')}\n`);
    setMtime(sessionFile, NOW - 10_000);
    src.poll();
    snapshot = bridge.snapshotMessages();
    expect(snapshot.filter((message) => message.type === 'agentToolStart')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'agentToolStart', toolId: 'read-1', toolName: 'read' }),
        expect.objectContaining({ type: 'agentToolStart', toolId: 'read-2', toolName: 'read' }),
      ]),
    );
  });

  it('drops an exited session when only a title change follows the exit', () => {
    src.discover();
    src.poll();
    fs.appendFileSync(
      sessionFile,
      `${JSON.stringify({ type: 'custom', customType: 'session_exit', data: {}, timestamp: 'x' })}\n`,
    );
    fs.appendFileSync(
      sessionFile,
      `${JSON.stringify({ type: 'title_change', title: 'After exit', timestamp: 'x' })}\n`,
    );
    setMtime(sessionFile, NOW - 10_000);
    src.poll();
    expect(sink.removed).toContain(sessionFile);
  });
});
