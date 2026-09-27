import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { Writable } from 'node:stream';
import { format } from 'node:util';

import { AgentStateStore } from '../agentStateStore.js';
import { buildAssetCache } from '../assetReload.js';
import { readConfig, writeConfig } from '../configPersistence.js';
import { FileStateAdapter } from '../fileStateAdapter.js';
import { createHttpServer } from '../httpServer.js';
import { allowedHosts, hashPasscode } from './auth.js';
import { createHomeAiClientHooks } from './clientHooks.js';
import { expandHome, homeAiConfigPath, loadHomeAiConfig, saveHomeAiConfig } from './config.js';
import { ALARM_COOLDOWN_MS, OfficeBridge } from './officeBridge.js';
import { OmpSource } from './ompSource.js';
import { OpenClawSource } from './openclawSource.js';
import { createRedactor } from './redact.js';
import { RoomAssigner } from './roomAssigner.js';
import { SolSource } from './solSource.js';
import { StatsAggregator } from './statsAggregator.js';
import { SunSource } from './sunSource.js';
import { execFileText, transcriptLinkFor } from './transcriptLinks.js';

const FILE_POLL_MS = 500;
const DISCOVER_MS = 3000;
const TICK_MS = 10_000;
const STATS_MS = 60_000;
const SUN_MS = 10 * 60_000;
const MIN_PASSCODE_LENGTH = 8;

/** Redirects console output to an append-only log file (used when run headless by Task Scheduler). */
function logToFile(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const stream = fs.createWriteStream(file, { flags: 'a' });
  for (const level of ['log', 'warn', 'error'] as const) {
    console[level] = (...args: unknown[]) => {
      stream.write(`${new Date().toISOString()} ${level.toUpperCase()} ${format(...args)}\n`);
    };
  }
}

export async function runHomeAi(distRoot: string, argv: string[]): Promise<void> {
  const logIndex = argv.indexOf('--log');
  if (logIndex >= 0 && argv[logIndex + 1]) logToFile(path.resolve(argv[logIndex + 1]));
  const cfg = loadHomeAiConfig();
  if (!cfg.passcodeHash) {
    console.error('[Pixel Office] No passcode set. Run: node dist/cli.js set-passcode');
    process.exit(1);
  }
  console.log(
    `[Pixel Office] HA token ${process.env[cfg.sun.tokenEnv] ? 'present' : 'missing'} (${cfg.sun.tokenEnv})`,
  );
  const now = () => Date.now();
  const ompRoot = expandHome(cfg.omp.sessionsRoot);
  const openclawRoot = expandHome(cfg.openclaw.agentsRoot);

  const store = new AgentStateStore();
  store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
  const bridge = new OfficeBridge({ store, redact: createRedactor(), now });
  const omp = new OmpSource({
    root: ompRoot,
    roomActivityDays: cfg.omp.roomActivityDays,
    sink: bridge,
    now,
  });
  const openclaw = new OpenClawSource({
    root: openclawRoot,
    agents: cfg.openclaw.agents,
    sink: bridge,
    now,
  });
  const sol = new SolSource({ baseUrl: cfg.sol.kumaUrl, slug: cfg.sol.statusPage, fetch, now });
  const sun = new SunSource({
    haUrl: cfg.sun.haUrl,
    token: process.env[cfg.sun.tokenEnv],
    fetch,
    now,
  });
  const stats = new StatsAggregator({
    ompRoot,
    openclawRoot,
    openclawAgents: cfg.openclaw.agents,
    now,
  });
  const rooms = new RoomAssigner({
    load: () => readConfig().standalone.areaMappings,
    save: (m) => {
      const c = readConfig();
      c.standalone.areaMappings = m;
      writeConfig(c);
    },
    broadcast: (m) => store.broadcast(m),
  });

  const latest = new Map<string, Record<string, unknown>>();
  const publish = (m: Record<string, unknown>) => {
    latest.set(String(m.type), m);
    store.broadcast(m);
  };
  const hooks = createHomeAiClientHooks({
    bridge,
    latest: () => [...rooms.latest(), ...latest.values()],
    link: (sessionId) => transcriptLinkFor(sessionId, execFileText),
  });

  const { app, port } = await createHttpServer({
    embedded: false,
    host: cfg.listen.host,
    port: cfg.listen.port,
    token: crypto.randomUUID(),
    store,
    staticDir: path.join(distRoot, 'webview'),
    assetCache: await buildAssetCache(distRoot, readConfig().externalAssetDirectories),
    homeAi: hooks,
    homeAiAuth: {
      allowed: allowedHosts(cfg.listen.port),
      cookieSecret: cfg.cookieSecret,
      passcodeHash: () => loadHomeAiConfig().passcodeHash,
      now,
    },
  });

  const solAlarmAt = new Map<string, number>();
  const pollSol = async () => {
    const r = await sol.poll();
    publish({ type: 'ambientSol', ...r.snapshot });
    for (const d of r.newlyDown) {
      const key = `${d.groupName}/${d.monitorName}`;
      if (now() - (solAlarmAt.get(key) ?? Number.NEGATIVE_INFINITY) < ALARM_COOLDOWN_MS) continue;
      solAlarmAt.set(key, now());
      bridge.effect({ effect: 'alarm', groupName: d.groupName, reason: `${d.monitorName} down` });
    }
  };
  const pollSun = async () => publish({ type: 'ambientSun', ...(await sun.poll()) });
  const pollStats = () => publish({ type: 'officeStats', ...stats.refresh(sol.uptimeMean()) });
  const discover = () => {
    rooms.update(omp.discover());
    openclaw.discover();
  };
  const pollFiles = () => {
    omp.poll();
    openclaw.poll();
  };

  openclaw.start();
  discover();
  pollFiles();
  await Promise.all([pollSol(), pollSun()]);
  pollStats();

  const timers = [
    setInterval(pollFiles, FILE_POLL_MS),
    setInterval(discover, DISCOVER_MS),
    setInterval(() => bridge.tick(), TICK_MS),
    setInterval(pollStats, STATS_MS),
    setInterval(() => void pollSol(), cfg.sol.pollSeconds * 1000),
    setInterval(() => void pollSun(), SUN_MS),
  ];

  console.log(
    `\n  Pixel Office running on http://${cfg.listen.host}:${port} (LAN; passcode required)\n`,
  );
  const shutdown = () => {
    for (const t of timers) clearInterval(t);
    void app.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function ask(rl: readline.Interface, prompt: string): Promise<string> {
  process.stdout.write(prompt);
  return new Promise((resolve) => rl.question('', resolve));
}

export async function runSetPasscode(): Promise<void> {
  const silent = new Writable({ write: (_chunk, _enc, cb) => cb() });
  const rl = readline.createInterface({ input: process.stdin, output: silent, terminal: true });
  const first = await ask(rl, 'New passcode: ');
  const second = await ask(rl, '\nRepeat passcode: ');
  rl.close();
  process.stdout.write('\n');
  if (first.length < MIN_PASSCODE_LENGTH || first !== second) {
    console.error(`Passcodes must match and be at least ${MIN_PASSCODE_LENGTH} characters.`);
    process.exit(1);
  }
  saveHomeAiConfig({ ...loadHomeAiConfig(), passcodeHash: hashPasscode(first) });
  console.log(`Passcode saved to ${homeAiConfigPath()}`);
}
