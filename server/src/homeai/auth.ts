// server/src/homeai/auth.ts
import * as crypto from 'node:crypto';
import * as os from 'node:os';

import type { FastifyInstance } from 'fastify';

export const COOKIE_NAME = 'po_session';
export const COOKIE_MAX_AGE_S = 30 * 24 * 3600;
const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_MS = 10 * 60_000;

export interface HomeAiAuthOptions {
  allowed: Set<string>;
  cookieSecret: string;
  passcodeHash: () => string | null;
  now: () => number;
}

export function allowedHosts(
  port: number,
  extra: { hostname?: string; addresses?: string[] } = {},
): Set<string> {
  const names = new Set<string>([
    'localhost',
    '127.0.0.1',
    (extra.hostname ?? os.hostname()).toLowerCase(),
  ]);
  const addresses =
    extra.addresses ??
    Object.values(os.networkInterfaces())
      .flat()
      .filter((a): a is os.NetworkInterfaceInfo => !!a && a.family === 'IPv4')
      .map((a) => a.address);
  for (const a of addresses) names.add(a);
  return new Set([...names].map((n) => `${n}:${port}`));
}

export const hostAllowed = (host: string | undefined, allowed: Set<string>): boolean =>
  !!host && allowed.has(host.toLowerCase());

export function originAllowed(origin: string | undefined, allowed: Set<string>): boolean {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && allowed.has(u.host.toLowerCase());
  } catch {
    return false;
  }
}

export function hashPasscode(pass: string): string {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(pass, salt, 32).toString('hex')}`;
}

export function verifyPasscode(pass: string, stored: string | null): boolean {
  if (!stored) return false;
  const [alg, saltHex, hashHex] = stored.split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  return crypto.timingSafeEqual(
    crypto.scryptSync(pass, Buffer.from(saltHex, 'hex'), expected.length),
    expected,
  );
}

const hmac = (secret: string, data: string) =>
  crypto.createHmac('sha256', secret).update(data).digest('base64url');

export function issueCookie(secret: string, now: number): string {
  const exp = String(now + COOKIE_MAX_AGE_S * 1000);
  return `${exp}.${hmac(secret, exp)}`;
}

export function verifyCookie(value: string | undefined, secret: string, now: number): boolean {
  const match = /^(\d{13,})\.([A-Za-z0-9_-]{43})$/.exec(value ?? '');
  if (!match) return false;
  const [, exp, mac] = match;
  if (!(Number(exp) > now)) return false;
  const actual = Buffer.from(mac, 'base64url');
  const expected = Buffer.from(hmac(secret, exp), 'base64url');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

/* eslint-disable pixel-agents/no-inline-colors -- login page styling is required inline. */
const loginPage = (message = '') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pixel Office</title>
<style>body{background:#1d1830;color:#eee;font:16px monospace;display:grid;place-items:center;min-height:100vh;margin:0}
form{background:#2b2440;padding:24px;border:4px solid #151020}input,button{font:inherit;padding:8px;margin-top:8px;width:100%}
p{color:#ff8a80;min-height:1em}</style></head>
<body><form method="post" action="/login"><h1>Pixel Office</h1><label>Passcode<input type="password" name="passcode" autofocus autocomplete="current-password"></label>
<p>${message}</p><button type="submit">Enter</button></form></body></html>`;
/* eslint-enable pixel-agents/no-inline-colors */

export function installHomeAiAuth(app: FastifyInstance, o: HomeAiAuthOptions): void {
  const failures = new Map<string, number[]>();
  const recentFailures = (ip: string) => {
    const now = o.now();
    for (const [address, times] of failures) {
      const recent = times.filter((t) => now - t < LOGIN_WINDOW_MS);
      if (recent.length === 0) failures.delete(address);
      else failures.set(address, recent);
    }
    return failures.get(ip) ?? [];
  };

  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    },
  );

  app.addHook('onRequest', async (req, reply) => {
    if (!hostAllowed(req.headers.host, o.allowed))
      return reply.code(421).type('text/plain').send('misdirected request');
    const path = req.url.split('?')[0];
    const isPublicRoute =
      (path === '/api/health' && (req.method === 'GET' || req.method === 'HEAD')) ||
      (path === '/login' && (req.method === 'GET' || req.method === 'POST'));
    const safeMethod = req.method === 'GET' || req.method === 'HEAD';
    const isUpgrade = (req.headers.upgrade ?? '').toLowerCase() === 'websocket';
    if ((isUpgrade || !safeMethod) && !originAllowed(req.headers.origin, o.allowed)) {
      return reply.code(403).type('text/plain').send('forbidden origin');
    }
    if (isPublicRoute) return;
    if (verifyCookie(readCookie(req.headers.cookie, COOKIE_NAME), o.cookieSecret, o.now())) return;
    if (!isUpgrade && req.method === 'GET' && (req.headers.accept ?? '').includes('text/html'))
      return reply.redirect('/login');
    return reply.code(401).type('text/plain').send('unauthorized');
  });

  app.get('/login', async (_req, reply) => reply.type('text/html').send(loginPage()));

  app.post('/login', async (req, reply) => {
    const ip = req.ip;
    const recent = recentFailures(ip);
    if (recent.length >= LOGIN_MAX_FAILURES) {
      return reply
        .code(429)
        .type('text/html')
        .send(loginPage('Too many attempts. Try again in 10 minutes.'));
    }
    const pass = (req.body as Record<string, string> | undefined)?.passcode ?? '';
    if (!verifyPasscode(pass, o.passcodeHash())) {
      failures.set(ip, [...recent, o.now()]);
      return reply.code(401).type('text/html').send(loginPage('Wrong passcode.'));
    }
    failures.delete(ip);
    reply.header(
      'Set-Cookie',
      `${COOKIE_NAME}=${issueCookie(o.cookieSecret, o.now())}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}`,
    );
    return reply.redirect('/');
  });
}
