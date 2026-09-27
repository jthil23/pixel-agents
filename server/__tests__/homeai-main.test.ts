import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import * as homeAiMain from '../src/homeai/main.js';

describe('Home-AI main scheduling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('logs rejected scheduled jobs instead of emitting unhandled rejections', async () => {
    vi.useFakeTimers();
    const error = new Error('poll failed');
    const onUnhandled = vi.fn();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.on('unhandledRejection', onUnhandled);
    try {
      const timer = homeAiMain.guardedInterval(() => Promise.reject(error), 10, 'SOL poll');
      await vi.advanceTimersByTimeAsync(10);
      expect(log).toHaveBeenCalledWith('[Pixel Office] SOL poll failed:', error);
      expect(onUnhandled).not.toHaveBeenCalled();
      clearInterval(timer);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('logs synchronous failures from scheduled jobs', async () => {
    vi.useFakeTimers();
    const error = new Error('discovery failed');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const timer = homeAiMain.guardedInterval(
      () => {
        throw error;
      },
      10,
      'session discovery',
    );

    await vi.advanceTimersByTimeAsync(10);
    expect(log).toHaveBeenCalledWith('[Pixel Office] session discovery failed:', error);
    clearInterval(timer);
  });

  it('does not overlap a scheduled job while its previous run is pending', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    let active = 0;
    let maximumActive = 0;
    let calls = 0;
    const timer = homeAiMain.guardedInterval(
      () => {
        calls++;
        active++;
        maximumActive = Math.max(maximumActive, active);
        return new Promise<void>((resolve) => {
          release = () => {
            active--;
            resolve();
          };
        });
      },
      10,
      'slow job',
    );

    await vi.advanceTimersByTimeAsync(50);
    expect(calls).toBe(1);
    expect(maximumActive).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toBe(2);
    expect(maximumActive).toBe(1);
    clearInterval(timer);
    release();
  });

  it('writes the missing-passcode startup error to the requested log file', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'homeai-no-passcode-'));
    const logFile = path.join(home, 'x.log');
    const cli = path.resolve(process.cwd(), '../dist/cli.js');
    try {
      const result = spawnSync(process.execPath, [cli, '--home-ai', '--log', logFile], {
        encoding: 'utf8',
        env: { ...process.env, USERPROFILE: home, HOME: home },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('No passcode set');
      expect(fs.readFileSync(logFile, 'utf8')).toContain('No passcode set');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
