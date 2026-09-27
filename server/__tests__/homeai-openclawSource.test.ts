import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { classifyRun, openclawKey, OpenClawSource } from '../src/homeai/openclawSource.js';
import type { MailroomKind, SessionEvent, SourceSink, TrackedAgent } from '../src/homeai/types.js';

const NOW = Date.parse('2026-09-27T15:00:00Z');
const traj = (type: string, sessionKey: string, data: Record<string, unknown>) =>
  JSON.stringify({ type, sessionKey, data, ts: '2026-09-27T14:59:00Z' });
const touch = (file: string) => fs.utimesSync(file, (NOW - 1000) / 1000, (NOW - 1000) / 1000);

class Sink implements SourceSink {
  upserts: TrackedAgent[] = [];
  applied: { key: string; kinds: string[]; replay: boolean }[] = [];
  mail: [string, MailroomKind, string, boolean][] = [];
  upsertAgent(a: TrackedAgent) {
    this.upserts.push(a);
  }
  applyEvents(key: string, e: SessionEvent[], replay: boolean) {
    this.applied.push({ key, kinds: e.map((x) => x.kind), replay });
  }
  removeAgent() {}
  mailroom(key: string, kind: MailroomKind, phase: 'start' | 'end', failed: boolean) {
    this.mail.push([key, kind, phase, failed]);
  }
}

describe('classifyRun', () => {
  it('maps hook → phone, cron or heartbeat → clock, everything else → envelope', () => {
    expect(classifyRun('agent:main:hook:x', 'cron')).toBe('phone');
    expect(classifyRun('agent:main:cron:x', 'cron')).toBe('clock');
    expect(classifyRun('agent:main:main', 'heartbeat')).toBe('clock');
    expect(classifyRun('agent:main:discord:c', 'user')).toBe('envelope');
  });
});

describe('OpenClawSource', () => {
  let dir: string;
  let sink: Sink;
  let src: OpenClawSource;
  let now: number;
  beforeEach(() => {
    now = NOW;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'homeai-oc-'));
    dir = path.join(root, 'main', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'r1.jsonl'),
      `${JSON.stringify({ type: 'session', id: 'r1', cwd: 'C:\\ws', timestamp: 't' })}\n`,
    );
    fs.writeFileSync(
      path.join(dir, 'r1.trajectory.jsonl'),
      `${traj('session.started', 'agent:main:cron:j', { trigger: 'cron' })}\n`,
    );
    for (const f of fs.readdirSync(dir)) touch(path.join(dir, f));
    sink = new Sink();
    src = new OpenClawSource({
      root: path.dirname(path.dirname(dir)),
      agents: ['main'],
      sink,
      now: () => now,
    });
  });

  it('seats one persistent character per configured agent in the OpenClaw folder', () => {
    src.start();
    expect(sink.upserts).toEqual([
      {
        key: openclawKey('main'),
        source: 'openclaw',
        role: 'openclaw',
        name: 'main',
        folderName: 'OpenClaw',
      },
    ]);
  });

  it('replays existing lines without mailroom effects, then emits live starts and failed ends', () => {
    src.start();
    src.discover();
    src.poll();
    expect(sink.mail).toEqual([]);
    expect(sink.applied).toEqual([{ key: openclawKey('main'), kinds: [], replay: true }]);

    fs.appendFileSync(
      path.join(dir, 'r1.trajectory.jsonl'),
      `${traj('session.ended', 'agent:main:cron:j', { status: 'error' })}\n`,
    );
    src.poll();
    expect(sink.mail).toEqual([[openclawKey('main'), 'clock', 'end', true]]);

    const r2 = path.join(dir, 'r2.trajectory.jsonl');
    fs.writeFileSync(r2, '');
    touch(r2);
    src.discover();
    src.poll();
    fs.appendFileSync(r2, `${traj('session.started', 'agent:main:hook:h', { trigger: 'cron' })}\n`);
    src.poll();
    expect(sink.mail.at(-1)).toEqual([openclawKey('main'), 'phone', 'start', false]);
  });

  it('emits events from trajectory files created after startup', () => {
    src.start();
    const live = path.join(dir, 'live.trajectory.jsonl');
    fs.writeFileSync(
      live,
      `${traj('session.started', 'agent:main:cron:j', { trigger: 'cron' })}\n${traj('session.ended', 'agent:main:cron:j', { status: 'error' })}\n`,
    );
    fs.utimesSync(live, (NOW + 1000) / 1000, (NOW + 1000) / 1000);

    const liveSession = path.join(dir, 'live.jsonl');
    fs.writeFileSync(
      liveSession,
      `${JSON.stringify({ type: 'session', id: 'live', cwd: 'C:\\\\ws', timestamp: 't' })}\n`,
    );
    fs.utimesSync(liveSession, (NOW + 1000) / 1000, (NOW + 1000) / 1000);
    src.discover();
    src.poll();
    expect(sink.applied).toContainEqual({ key: openclawKey('main'), kinds: [], replay: false });

    expect(sink.mail).toEqual([
      [openclawKey('main'), 'clock', 'start', false],
      [openclawKey('main'), 'clock', 'end', true],
    ]);
  });

  it('does not extend a historical tail lifetime by replaying its existing lines', () => {
    const historical = path.join(dir, 'r1.trajectory.jsonl');
    fs.utimesSync(historical, (NOW - 59 * 60_000) / 1000, (NOW - 59 * 60_000) / 1000);
    src.start();
    src.discover();
    src.poll();

    now = NOW + 2 * 60_000;
    src.poll();
    fs.appendFileSync(
      historical,
      `${traj('session.started', 'agent:main:cron:j', { trigger: 'cron' })}\n`,
    );
    src.poll();
    expect(sink.mail).toEqual([]);
  });

  it('resumes a rediscovered idle trajectory after its last read, emitting only new runs', () => {
    const file = path.join(dir, 'r1.trajectory.jsonl');
    fs.writeFileSync(
      file,
      `${traj('session.started', 'agent:main:cron:j', { trigger: 'cron' })}\n${traj('session.ended', 'agent:main:cron:j', { status: 'success' })}\n`,
    );
    fs.utimesSync(file, (NOW - 59 * 60_000) / 1000, (NOW - 59 * 60_000) / 1000);
    src.start();
    src.discover();
    src.poll();
    expect(sink.mail).toEqual([]);

    now = NOW + 2 * 60_000;
    src.poll();
    fs.appendFileSync(
      file,
      `${traj('session.started', 'agent:main:hook:h', {})}\n${traj('session.ended', 'agent:main:hook:h', { status: 'success' })}\n`,
    );
    fs.utimesSync(file, now / 1000, now / 1000);
    src.discover();
    src.poll();
    expect(sink.mail).toEqual([
      [openclawKey('main'), 'phone', 'start', false],
      [openclawKey('main'), 'phone', 'end', false],
    ]);
  });

  it('forgets retired entries when a file is deleted and recreated at the same path', () => {
    const file = path.join(dir, 'r1.trajectory.jsonl');
    const oldRecords = `${traj('session.started', 'agent:main:cron:j', { trigger: 'cron' })}\n${traj('session.ended', 'agent:main:cron:j', { status: 'success' })}\n`;
    fs.writeFileSync(file, oldRecords);
    fs.utimesSync(file, (NOW - 59 * 60_000) / 1000, (NOW - 59 * 60_000) / 1000);
    src.start();
    src.discover();
    src.poll();
    now = NOW + 2 * 60_000;
    src.poll();
    fs.unlinkSync(file);
    src.discover();
    src.poll();
    const newRecords = `${traj('session.started', 'agent:main:hook:h', {})}\n${traj('session.ended', 'agent:main:hook:h', { status: 'success' })}\n`;
    fs.writeFileSync(file, newRecords);
    fs.utimesSync(file, now / 1000, now / 1000);
    src.discover();
    src.poll();
    expect(sink.mail).toEqual([
      [openclawKey('main'), 'phone', 'start', false],
      [openclawKey('main'), 'phone', 'end', false],
    ]);
  });

  it('does not restore a retired tail older than seven days', () => {
    const file = path.join(dir, 'r1.trajectory.jsonl');
    fs.writeFileSync(
      file,
      `${traj('session.started', 'agent:main:cron:j', { trigger: 'cron' })}\n${traj('session.ended', 'agent:main:cron:j', { status: 'success' })}\n`,
    );
    fs.utimesSync(file, (NOW - 59 * 60_000) / 1000, (NOW - 59 * 60_000) / 1000);
    src.start();
    src.discover();
    src.poll();
    now = NOW + 2 * 60_000;
    src.poll();
    now += 7 * 86_400_000 + 1;
    src.discover();
    fs.appendFileSync(
      file,
      `${traj('session.started', 'agent:main:hook:h', {})}\n${traj('session.ended', 'agent:main:hook:h', { status: 'success' })}\n`,
    );
    fs.utimesSync(file, now / 1000, now / 1000);
    src.discover();
    src.poll();
    // Expired state is treated as a new file: its full current contents are live,
    // so the old cron run is emitted once alongside the appended hook run.
    expect(sink.mail).toEqual([
      [openclawKey('main'), 'clock', 'start', false],
      [openclawKey('main'), 'clock', 'end', false],
      [openclawKey('main'), 'phone', 'start', false],
      [openclawKey('main'), 'phone', 'end', false],
    ]);
  });

  it('starts fresh when a retired file shrinks below its remembered offset', () => {
    const file = path.join(dir, 'r1.trajectory.jsonl');
    fs.writeFileSync(
      file,
      `${traj('session.started', 'agent:main:cron:j', { trigger: 'cron' })}\n${traj('session.ended', 'agent:main:cron:j', { status: 'success' })}\n`,
    );
    fs.utimesSync(file, (NOW - 59 * 60_000) / 1000, (NOW - 59 * 60_000) / 1000);
    src.start();
    src.discover();
    src.poll();
    now = NOW + 2 * 60_000;
    src.poll();
    fs.writeFileSync(
      file,
      `${traj('session.started', 'agent:main:hook:h', {})}\n${traj('session.ended', 'agent:main:hook:h', { status: 'success' })}\n`,
    );
    fs.utimesSync(file, now / 1000, now / 1000);
    src.discover();
    src.poll();
    expect(sink.mail).toEqual([
      [openclawKey('main'), 'phone', 'start', false],
      [openclawKey('main'), 'phone', 'end', false],
    ]);
  });
});
