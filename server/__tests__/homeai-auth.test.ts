// server/__tests__/homeai-auth.test.ts
import * as http from 'node:http';
import * as net from 'node:net';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { AgentStateStore } from '../src/agentStateStore.js';
import {
  allowedHosts,
  COOKIE_NAME,
  hashPasscode,
  issueCookie,
  originAllowed,
  readCookie,
  verifyCookie,
  verifyPasscode,
} from '../src/homeai/auth.js';
import { createHttpServer } from '../src/httpServer.js';

const SECRET = 'f'.repeat(64);
const NOW = Date.parse('2026-09-27T15:00:00Z');

describe('auth primitives', () => {
  it('hashes and verifies passcodes', () => {
    const stored = hashPasscode('correct horse');
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(verifyPasscode('correct horse', stored)).toBe(true);
    expect(verifyPasscode('wrong', stored)).toBe(false);
    expect(verifyPasscode('x', null)).toBe(false);
  });

  it('issues cookies that expire after 30 days and reject tampering', () => {
    const c = issueCookie(SECRET, NOW);
    expect(verifyCookie(c, SECRET, NOW + 1000)).toBe(true);
    expect(verifyCookie(c, SECRET, NOW + 31 * 86_400_000)).toBe(false);
    expect(verifyCookie(`${c}x`, SECRET, NOW)).toBe(false);
    expect(verifyCookie(c, 'e'.repeat(64), NOW)).toBe(false);
    expect(readCookie(`a=1; ${COOKIE_NAME}=${c}; b=2`, COOKIE_NAME)).toBe(c);
    const validExpiry = issueCookie(SECRET, NOW).split('.')[0];
    expect(verifyCookie(`${validExpiry}.${'a'.repeat(42)}é`, SECRET, NOW)).toBe(false);
    expect(verifyCookie(`${issueCookie(SECRET, NOW)}.extra`, SECRET, NOW)).toBe(false);
  });

  it('builds the host allowlist and checks origins strictly', () => {
    const allowed = allowedHosts(3100, { hostname: 'JT-PC', addresses: ['192.168.1.50'] });
    expect([...allowed].sort()).toEqual([
      '127.0.0.1:3100',
      '192.168.1.50:3100',
      'jt-pc:3100',
      'localhost:3100',
    ]);
    expect(originAllowed('http://192.168.1.50:3100', allowed)).toBe(true);
    expect(originAllowed('http://evil.example:3100', allowed)).toBe(false);
    expect(originAllowed(undefined, allowed)).toBe(false);
  });
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

function request(
  port: number,
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: opts.method ?? 'GET',
        path: opts.path ?? '/',
        headers: opts.headers,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function wsOutcome(port: number, headers: Record<string, string>): Promise<'open' | 'rejected'> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    ws.on('open', () => {
      ws.close();
      resolve('open');
    });
    ws.on('unexpected-response', () => resolve('rejected'));
    ws.on('error', () => resolve('rejected'));
    ws.on('close', () => resolve('rejected'));
  });
}

describe('home-ai auth on the real server', () => {
  let port: number;
  let close: () => Promise<void>;
  let host: string;
  let origin: string;
  const cookie = () => `${COOKIE_NAME}=${issueCookie(SECRET, Date.now())}`;

  beforeAll(async () => {
    port = await freePort();
    host = `localhost:${port}`;
    origin = `http://${host}`;
    const passcodeHash = hashPasscode('letmein');
    const { app } = await createHttpServer({
      embedded: false,
      host: '127.0.0.1',
      port,
      token: 'tok',
      store: new AgentStateStore(),
      homeAiAuth: {
        allowed: allowedHosts(port, { hostname: 'jt-pc', addresses: [] }),
        cookieSecret: SECRET,
        passcodeHash: () => passcodeHash,
        now: () => Date.now(),
      },
    });
    close = () => app.close();
  });

  afterAll(async () => {
    await close();
  });

  it('rejects DNS-rebound requests from loopback with 421', async () => {
    expect((await request(port, { headers: { Host: `evil.example:${port}` } })).status).toBe(421);
  });

  it('keeps /api/health open and gates everything else, loopback included', async () => {
    expect((await request(port, { path: '/api/health', headers: { Host: host } })).status).toBe(
      200,
    );
    expect(
      (await request(port, { method: 'HEAD', path: '/api/health', headers: { Host: host } }))
        .status,
    ).toBe(200);
    expect(
      (
        await request(port, {
          method: 'POST',
          path: '/api/health',
          headers: { Host: host, Origin: origin },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(port, {
          method: 'PUT',
          path: '/login',
          headers: { Host: host, Origin: origin },
        })
      ).status,
    ).toBe(401);
    const validExpiry = issueCookie(SECRET, Date.now()).split('.')[0];
    expect(
      (
        await request(port, {
          path: '/api/x',
          headers: { Host: host, Cookie: `${COOKIE_NAME}=${validExpiry}.${'a'.repeat(42)}é` },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(port, {
          path: '/api/x',
          headers: { Host: host, Cookie: `${cookie()}.extra` },
        })
      ).status,
    ).toBe(401);
    const page = await request(port, { headers: { Host: host, Accept: 'text/html' } });
    expect(page.status).toBe(302);
    expect(page.headers.location).toBe('/login');
    expect((await request(port, { path: '/api/x', headers: { Host: host } })).status).toBe(401);
    expect((await request(port, { headers: { Host: host, Cookie: cookie() } })).status).toBe(404);
  });

  it('logs in with the passcode, requires an allowed Origin, and rate-limits failures', async () => {
    const form = { 'Content-Type': 'application/x-www-form-urlencoded', Host: host };
    expect(
      (
        await request(port, {
          method: 'POST',
          path: '/login',
          headers: form,
          body: 'passcode=letmein',
        })
      ).status,
    ).toBe(403);
    const ok = await request(port, {
      method: 'POST',
      path: '/login',
      headers: { ...form, Origin: origin },
      body: 'passcode=letmein',
    });
    expect(ok.status).toBe(302);
    expect(String(ok.headers['set-cookie'])).toMatch(
      new RegExp(`^${COOKIE_NAME}=.+HttpOnly; SameSite=Strict`),
    );
    for (let i = 0; i < 10; i++) {
      expect(
        (
          await request(port, {
            method: 'POST',
            path: '/login',
            headers: { ...form, Origin: origin },
            body: 'passcode=nope',
          })
        ).status,
      ).toBe(401);
    }
    expect(
      (
        await request(port, {
          method: 'POST',
          path: '/login',
          headers: { ...form, Origin: origin },
          body: 'passcode=letmein',
        })
      ).status,
    ).toBe(429);
    const expiredAt = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(expiredAt + 10 * 60_000 + 1);
    try {
      expect(
        (
          await request(port, {
            method: 'POST',
            path: '/login',
            headers: { ...form, Origin: origin },
            body: 'passcode=letmein',
          })
        ).status,
      ).toBe(302);
    } finally {
      clock.mockRestore();
    }
  });

  it('gates WebSocket upgrades on cookie, Host and Origin', async () => {
    expect(await wsOutcome(port, { Host: host, Origin: origin, Cookie: cookie() })).toBe('open');
    expect(await wsOutcome(port, { Host: host, Origin: origin })).toBe('rejected');
    expect(
      await wsOutcome(port, {
        Host: `evil.example:${port}`,
        Origin: `http://evil.example:${port}`,
        Cookie: cookie(),
      }),
    ).toBe('rejected');
    expect(
      await wsOutcome(port, {
        Host: host,
        Origin: `http://evil.example:${port}`,
        Cookie: cookie(),
      }),
    ).toBe('rejected');
    expect(await wsOutcome(port, { Host: host, Cookie: cookie() })).toBe('rejected');
  });
});
