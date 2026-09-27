import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  expandHome,
  homeAiConfigPath,
  loadHomeAiConfig,
  saveHomeAiConfig,
} from '../src/homeai/config.js';

const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'homeai-cfg-'));

describe('home-ai config', () => {
  it('creates the file with defaults and a persistent cookie secret on first load', () => {
    const home = tempHome();
    const first = loadHomeAiConfig(home);
    expect(fs.existsSync(homeAiConfigPath(home))).toBe(true);
    expect(first.listen).toEqual({ host: '0.0.0.0', port: 3100 });
    expect(first.cookieSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(first.passcodeHash).toBeNull();
    expect(loadHomeAiConfig(home).cookieSecret).toBe(first.cookieSecret);
  });

  it('keeps user overrides and fills missing nested defaults', () => {
    const home = tempHome();
    fs.mkdirSync(path.dirname(homeAiConfigPath(home)), { recursive: true });
    fs.writeFileSync(
      homeAiConfigPath(home),
      JSON.stringify({ listen: { port: 4000 }, cookieSecret: 'a'.repeat(64) }),
    );
    const cfg = loadHomeAiConfig(home);
    expect(cfg.listen).toEqual({ host: '0.0.0.0', port: 4000 });
    expect(cfg.sol.kumaUrl).toBe('http://192.168.1.103:3001');
    expect(cfg.cookieSecret).toBe('a'.repeat(64));
  });

  it('round-trips the passcode hash', () => {
    const home = tempHome();
    saveHomeAiConfig({ ...loadHomeAiConfig(home), passcodeHash: 'scrypt$aa$bb' }, home);
    expect(loadHomeAiConfig(home).passcodeHash).toBe('scrypt$aa$bb');
  });

  it('expands ~ against the given home', () => {
    expect(expandHome('~/.omp/agent/sessions', '/h')).toBe(path.join('/h', '.omp/agent/sessions'));
    expect(expandHome('/abs/x', '/h')).toBe('/abs/x');
  });
});
