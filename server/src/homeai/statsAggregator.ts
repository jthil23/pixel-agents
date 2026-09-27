import * as fs from 'node:fs';
import * as path from 'node:path';

import { JsonlTail } from './jsonlTail.js';
import { classifyRun } from './openclawSource.js';
import { createSessionParser, type SessionParser } from './sessionParser.js';
import type { MailroomKind } from './types.js';

export interface StatsSnapshot {
  date: string;
  spendByModel: Record<string, number>;
  openclawTokens: number;
  toolCalls: number;
  busiestAgent: string | null;
  cronOk: number;
  cronFailed: number;
  solUptime24h: number | null;
}

export function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const startOfLocalDay = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

interface FileState {
  tail: JsonlTail;
  parser: SessionParser;
  source: 'omp' | 'openclaw';
  trajectory: boolean;
  runKind: MailroomKind | undefined;
  name: string;
  isRoot: boolean;
  lastSize: number;
  contribution: Contribution;
}

interface Contribution {
  toolCalls: number;
  spendByModel: Record<string, number>;
  openclawTokens: number;
  cronOk: number;
  cronFailed: number;
}

const MAX_WALK_DEPTH = 6;

export class StatsAggregator {
  private day = '';
  private files = new Map<string, FileState>();
  private spendByModel: Record<string, number> = {};
  private openclawTokens = 0;
  private toolCalls = 0;
  private cronOk = 0;
  private cronFailed = 0;

  constructor(
    private readonly o: {
      ompRoot: string;
      openclawRoot: string;
      openclawAgents: string[];
      now: () => number;
    },
  ) {}

  refresh(solUptime: number | null): StatsSnapshot {
    const now = this.o.now();
    const day = localDate(now);
    if (day !== this.day) this.reset(day);
    const midnight = startOfLocalDay(now);
    this.discover(midnight);
    for (const [file, st] of this.files) {
      let size: number;
      try {
        size = fs.statSync(file).size;
      } catch {
        this.files.delete(file);
        continue;
      }
      if (size < st.lastSize) {
        this.subtract(st.contribution);
        st.tail = new JsonlTail(file);
        st.parser = createSessionParser();
        st.runKind = undefined;
        st.contribution = {
          toolCalls: 0,
          spendByModel: {},
          openclawTokens: 0,
          cronOk: 0,
          cronFailed: 0,
        };
      }
      const lines = st.tail.read();
      if (lines === null) {
        this.files.delete(file);
        continue;
      }
      st.lastSize = size;
      for (const line of lines) {
        if (st.trajectory) this.countTrajectory(st, line, midnight);
        else this.countSession(file, st, line, midnight);
      }
    }
    let busiestAgent: string | null = null;
    let best = 0;
    for (const st of this.files.values()) {
      if (st.contribution.toolCalls > best) {
        best = st.contribution.toolCalls;
        busiestAgent = st.name;
      }
    }
    return {
      date: day,
      spendByModel: { ...this.spendByModel },
      openclawTokens: this.openclawTokens,
      toolCalls: this.toolCalls,
      busiestAgent,
      cronOk: this.cronOk,
      cronFailed: this.cronFailed,
      solUptime24h: solUptime,
    };
  }

  private reset(day: string): void {
    this.day = day;
    this.files = new Map();
    this.spendByModel = {};
    this.openclawTokens = 0;
    this.toolCalls = 0;
    this.cronOk = 0;
    this.cronFailed = 0;
  }

  private subtract(contribution: Contribution): void {
    this.toolCalls -= contribution.toolCalls;
    this.openclawTokens -= contribution.openclawTokens;
    this.cronOk -= contribution.cronOk;
    this.cronFailed -= contribution.cronFailed;
    for (const [model, amount] of Object.entries(contribution.spendByModel)) {
      this.spendByModel[model] = (this.spendByModel[model] ?? 0) - amount;
      if (this.spendByModel[model] === 0) delete this.spendByModel[model];
    }
  }

  private discover(midnight: number): void {
    const walk = (dir: string, depth: number, source: 'omp' | 'openclaw') => {
      if (depth > MAX_WALK_DEPTH) return;
      let items: fs.Dirent[];
      try {
        items = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const it of items) {
        const full = path.join(dir, it.name);
        if (it.isDirectory()) {
          walk(full, depth + 1, source);
          continue;
        }
        if (!it.isFile() || !it.name.endsWith('.jsonl') || this.files.has(full)) continue;
        let stat: fs.Stats;
        try {
          stat = fs.statSync(full);
          if (stat.mtimeMs < midnight) continue;
        } catch {
          continue;
        }
        this.files.set(full, {
          tail: new JsonlTail(full),
          parser: createSessionParser(),
          source,
          trajectory: it.name.endsWith('.trajectory.jsonl'),
          runKind: undefined,
          name: path.basename(full, '.jsonl'),
          isRoot: source === 'omp' && depth === 1,
          lastSize: stat.size,
          contribution: {
            toolCalls: 0,
            spendByModel: {},
            openclawTokens: 0,
            cronOk: 0,
            cronFailed: 0,
          },
        });
      }
    };
    walk(this.o.ompRoot, 0, 'omp');
    for (const agent of this.o.openclawAgents)
      walk(path.join(this.o.openclawRoot, agent, 'sessions'), 0, 'openclaw');
  }

  private countSession(_file: string, st: FileState, line: string, midnight: number): void {
    for (const ev of st.parser.parseLine(line)) {
      if (
        ev.kind === 'title' &&
        st.source === 'omp' &&
        st.isRoot &&
        !st.name.startsWith('__advisor')
      )
        st.name = ev.title;
      if (ev.kind !== 'title' && (Date.parse(ev.at) || 0) < midnight) continue;
      if (ev.kind === 'toolStart') {
        this.toolCalls += 1;
        st.contribution.toolCalls += 1;
      } else if (ev.kind === 'usage') {
        if (st.source === 'omp') {
          this.spendByModel[ev.model] = (this.spendByModel[ev.model] ?? 0) + ev.costUsd;
          st.contribution.spendByModel[ev.model] =
            (st.contribution.spendByModel[ev.model] ?? 0) + ev.costUsd;
        } else {
          this.openclawTokens += ev.totalTokens;
          st.contribution.openclawTokens += ev.totalTokens;
        }
      }
    }
  }

  private countTrajectory(st: FileState, line: string, midnight: number): void {
    let rec: { type?: unknown; sessionKey?: unknown; ts?: unknown; data?: Record<string, unknown> };
    try {
      rec = JSON.parse(line);
    } catch {
      return;
    }
    const data = rec.data ?? {};
    const key = typeof rec.sessionKey === 'string' ? rec.sessionKey : '';
    if (rec.type === 'session.started')
      st.runKind = classifyRun(key, typeof data.trigger === 'string' ? data.trigger : undefined);
    if (rec.type !== 'session.ended') return;
    if ((typeof rec.ts === 'string' ? Date.parse(rec.ts) : 0) < midnight) return;
    if ((st.runKind ?? classifyRun(key, undefined)) !== 'clock') return;
    if (data.status === 'success') {
      this.cronOk += 1;
      st.contribution.cronOk += 1;
    } else {
      this.cronFailed += 1;
      st.contribution.cronFailed += 1;
    }
  }
}
