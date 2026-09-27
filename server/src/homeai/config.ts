import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface HomeAiConfig {
  listen: { host: string; port: number };
  omp: { sessionsRoot: string; roomActivityDays: number };
  openclaw: { agentsRoot: string; agents: string[] };
  sol: { kumaUrl: string; statusPage: string; pollSeconds: number };
  sun: { haUrl: string; tokenEnv: string };
  passcodeHash: string | null;
  cookieSecret: string;
}

export function homeAiConfigPath(home: string = os.homedir()): string {
  return path.join(home, '.pixel-agents', 'home-ai.json');
}

export function expandHome(p: string, home: string = os.homedir()): string {
  return p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? path.join(home, p.slice(2)) : p;
}

function defaults(): HomeAiConfig {
  return {
    listen: { host: '0.0.0.0', port: 3100 },
    omp: { sessionsRoot: '~/.omp/agent/sessions', roomActivityDays: 7 },
    openclaw: { agentsRoot: '~/.openclaw/agents', agents: ['main', 'opus'] },
    sol: { kumaUrl: 'http://192.168.1.103:3001', statusPage: 'sol', pollSeconds: 30 },
    sun: { haUrl: 'http://192.168.1.103:8123', tokenEnv: 'PIXEL_OFFICE_HA_TOKEN' },
    passcodeHash: null,
    cookieSecret: crypto.randomBytes(32).toString('hex'),
  };
}

export function saveHomeAiConfig(cfg: HomeAiConfig, home: string = os.homedir()): void {
  const file = homeAiConfigPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function loadHomeAiConfig(home: string = os.homedir()): HomeAiConfig {
  const file = homeAiConfigPath(home);
  const d = defaults();
  const exists = fs.existsSync(file);
  const raw = (exists ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}) as Partial<HomeAiConfig>;
  const cfg: HomeAiConfig = {
    listen: { ...d.listen, ...raw.listen },
    omp: { ...d.omp, ...raw.omp },
    openclaw: { ...d.openclaw, ...raw.openclaw },
    sol: { ...d.sol, ...raw.sol },
    sun: { ...d.sun, ...raw.sun },
    passcodeHash: raw.passcodeHash ?? null,
    cookieSecret: raw.cookieSecret || d.cookieSecret,
  };
  if (!exists || !raw.cookieSecret) saveHomeAiConfig(cfg, home);
  return cfg;
}
