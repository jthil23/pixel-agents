import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { localDate, StatsAggregator } from '../src/homeai/statsAggregator.js';

const NOW = new Date(2026, 8, 27, 15, 0, 0).getTime();
const TODAY = new Date(2026, 8, 27, 10, 0, 0).toISOString();
const YESTERDAY = new Date(2026, 8, 26, 10, 0, 0).toISOString();
const msg = (at: string, message: Record<string, unknown>) =>
  JSON.stringify({ type: 'message', timestamp: at, message });
const write = (file: string, lines: string[]) => {
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  fs.utimesSync(file, NOW / 1000, NOW / 1000);
};

describe('StatsAggregator', () => {
  it("counts today's tool calls, omp spend by model, OpenClaw tokens and cron results without double counting", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'homeai-stats-'));
    const ompDir = path.join(home, 'omp', '--G--Home-AI--');
    const ocDir = path.join(home, 'oc', 'main', 'sessions');
    fs.mkdirSync(ompDir, { recursive: true });
    fs.mkdirSync(ocDir, { recursive: true });
    write(path.join(ompDir, 's.jsonl'), [
      JSON.stringify({
        type: 'session',
        id: 's',
        cwd: 'G:\\Home-AI',
        title: 'Busy one',
        timestamp: TODAY,
      }),
      msg(YESTERDAY, {
        role: 'assistant',
        model: 'opus',
        usage: { cost: { total: 9 } },
        content: [{ type: 'toolCall', id: 'old', name: 'read', arguments: {} }],
      }),
      msg(TODAY, {
        role: 'assistant',
        model: 'opus',
        usage: { cost: { total: 1.5 } },
        content: [
          { type: 'toolCall', id: 'a', name: 'read', arguments: {} },
          { type: 'toolCall', id: 'b', name: 'bash', arguments: {} },
        ],
      }),
    ]);
    write(path.join(ocDir, 'r.jsonl'), [
      msg(TODAY, {
        role: 'assistant',
        model: 'claude-opus-5',
        usage: { totalTokens: 1000, cost: { total: 0 } },
        content: [],
      }),
    ]);
    write(path.join(ocDir, 'r.trajectory.jsonl'), [
      JSON.stringify({
        type: 'session.started',
        sessionKey: 'agent:main:cron:j',
        ts: TODAY,
        data: { trigger: 'cron' },
      }),
      JSON.stringify({
        type: 'session.ended',
        sessionKey: 'agent:main:cron:j',
        ts: TODAY,
        data: { status: 'error' },
      }),
    ]);
    const agg = new StatsAggregator({
      ompRoot: path.join(home, 'omp'),
      openclawRoot: path.join(home, 'oc'),
      openclawAgents: ['main'],
      now: () => NOW,
    });
    expect(agg.refresh(0.97)).toEqual({
      date: localDate(NOW),
      spendByModel: { opus: 1.5 },
      openclawTokens: 1000,
      toolCalls: 2,
      busiestAgent: 'Busy one',
      cronOk: 0,
      cronFailed: 1,
      solUptime24h: 0.97,
    });
    expect(agg.refresh(0.97).toolCalls).toBe(2);
  });
});
