import { describe, expect, it } from 'vitest';

import { kumaTime, monitorState, SolSource } from '../src/homeai/solSource.js';
import { clockPhase, phaseFor, SunSource } from '../src/homeai/sunSource.js';

const NOW = Date.parse('2026-09-27T15:00:00Z');
const beat = (status: number, minsAgo: number) => ({
  status,
  ping: 3,
  time: new Date(NOW - minsAgo * 60_000).toISOString().replace('T', ' ').replace('Z', ''),
});

describe('monitorState', () => {
  it('parses Kuma UTC times', () => {
    expect(kumaTime('2026-09-27 15:00:00.000')).toBe(NOW);
  });

  it('uses the latest status and flags >= 3 up→down transitions within 60 min as flapping', () => {
    expect(monitorState([], NOW)).toBe('unknown');
    expect(monitorState([beat(1, 2), beat(0, 1)], NOW)).toBe('down');
    expect(monitorState([beat(1, 2), beat(3, 1)], NOW)).toBe('maintenance');
    expect(monitorState([beat(1, 2), beat(2, 1)], NOW)).toBe('pending');
    expect(
      monitorState(
        [beat(1, 50), beat(0, 45), beat(1, 40), beat(0, 35), beat(1, 30), beat(0, 25), beat(1, 20)],
        NOW,
      ),
    ).toBe('flapping');
    expect(
      monitorState(
        [
          beat(1, 130),
          beat(0, 125),
          beat(1, 120),
          beat(0, 115),
          beat(1, 110),
          beat(0, 105),
          beat(1, 5),
        ],
        NOW,
      ),
    ).toBe('up');
  });
  it('counts only status-1 to status-0 transitions as flapping', () => {
    expect(
      monitorState(
        [beat(2, 7), beat(0, 6), beat(2, 5), beat(0, 4), beat(2, 3), beat(0, 2), beat(1, 1)],
        NOW,
      ),
    ).toBe('up');
    expect(
      monitorState(
        [beat(3, 7), beat(0, 6), beat(3, 5), beat(0, 4), beat(3, 3), beat(0, 2), beat(1, 1)],
        NOW,
      ),
    ).toBe('up');
  });
});

const kumaFetch = (statusFor5: number) => async (url: string) => ({
  ok: true,
  status: 200,
  json: async () =>
    url.includes('/heartbeat/')
      ? { heartbeatList: { '5': [beat(1, 2), beat(statusFor5, 1)] }, uptimeList: { '5_24': 0.98 } }
      : {
          publicGroupList: [
            { name: 'Core Infrastructure', monitorList: [{ id: 5, name: 'Home Assistant' }] },
          ],
        },
});

describe('SolSource', () => {
  it('builds groups, treats the first poll as baseline, then reports newly-down monitors once', async () => {
    let status = 1;
    const src = new SolSource({
      baseUrl: 'http://k',
      slug: 'sol',
      fetch: (u) => kumaFetch(status)(u),
      now: () => NOW,
    });
    const first = await src.poll();
    expect(first.snapshot.groups[0].monitors[0]).toEqual(
      expect.objectContaining({ id: 5, name: 'Home Assistant', state: 'up', uptime24h: 0.98 }),
    );
    expect(first.newlyDown).toEqual([]);
    status = 0;
    expect((await src.poll()).newlyDown).toEqual([
      { groupName: 'Core Infrastructure', monitorName: 'Home Assistant' },
    ]);
    expect((await src.poll()).newlyDown).toEqual([]);
    expect(src.uptimeMean()).toBe(0.98);
  });

  it('marks everything unknown and unreachable when Kuma fails, without alarms', async () => {
    let fail = false;
    const src = new SolSource({
      baseUrl: 'http://k',
      slug: 'sol',
      fetch: async (u) => {
        if (fail) throw new Error('down');
        return kumaFetch(1)(u);
      },
      now: () => NOW,
    });
    await src.poll();
    fail = true;
    const r = await src.poll();
    expect(r.snapshot.reachable).toBe(false);
    expect(r.snapshot.groups[0].monitors[0].state).toBe('unknown');
    expect(r.newlyDown).toEqual([]);
  });
  it('does not re-alarm a monitor that stayed down across a Kuma outage', async () => {
    let status = 1;
    let fail = false;
    const src = new SolSource({
      baseUrl: 'http://k',
      slug: 'sol',
      fetch: async (u) => {
        if (fail) throw new Error('down');
        return kumaFetch(status)(u);
      },
      now: () => NOW,
    });
    expect((await src.poll()).newlyDown).toEqual([]);
    status = 0;
    expect((await src.poll()).newlyDown).toEqual([
      { groupName: 'Core Infrastructure', monitorName: 'Home Assistant' },
    ]);
    fail = true;
    expect((await src.poll()).newlyDown).toEqual([]);
    fail = false;
    expect((await src.poll()).newlyDown).toEqual([]);
  });
});

describe('sun', () => {
  it('maps elevation and clock hours to phases', () => {
    expect(phaseFor(30)).toBe('day');
    expect(phaseFor(3)).toBe('golden');
    expect(phaseFor(-3)).toBe('dusk');
    expect(phaseFor(-10)).toBe('night');
    expect(clockPhase(new Date(2026, 8, 27, 12))).toBe('day');
    expect(clockPhase(new Date(2026, 8, 27, 22))).toBe('night');
  });

  it('reads sun.sun with the bearer token, and falls back to the clock without a token', async () => {
    let auth = '';
    const ok = new SunSource({
      haUrl: 'http://ha',
      token: 'tkn',
      fetch: async (_u, init) => {
        auth = init?.headers?.Authorization ?? '';
        return { ok: true, status: 200, json: async () => ({ attributes: { elevation: 3.5 } }) };
      },
      now: () => NOW,
    });
    expect(await ok.poll()).toEqual({ phase: 'golden', elevation: 3.5 });
    expect(auth).toBe('Bearer tkn');
    const noToken = new SunSource({
      haUrl: 'http://ha',
      token: undefined,
      fetch: async () => {
        throw new Error('unused');
      },
      now: () => NOW,
    });
    expect((await noToken.poll()).elevation).toBeNull();
  });
});
