import * as fs from 'node:fs';
import * as path from 'node:path';

import { JsonlTail } from './jsonlTail.js';
import { ACTIVE_WINDOW_MS } from './ompSource.js';
import { createSessionParser, type SessionParser } from './sessionParser.js';
import type { MailroomKind, SourceSink } from './types.js';

export const openclawKey = (agent: string): string => `openclaw:${agent}`;

/** sessionKey is `agent:<id>:<kind>:…`; kind ∈ cron | hook | discord | main (observed). */
export function classifyRun(sessionKey: string, trigger: string | undefined): MailroomKind {
  const kind = sessionKey.split(':')[2];
  if (kind === 'hook') return 'phone';
  if (kind === 'cron' || trigger === 'heartbeat') return 'clock';
  return 'envelope';
}

interface Tail {
  file: string;
  agentKey: string;
  trajectory: boolean;
  tail: JsonlTail;
  parser: SessionParser;
  historical: boolean;
  primed: boolean;
  lastDataAt: number;
}

export class OpenClawSource {
  private readonly tails = new Map<string, Tail>();
  private startedAt = 0;

  constructor(
    private readonly o: { root: string; agents: string[]; sink: SourceSink; now: () => number },
  ) {}

  start(): void {
    this.startedAt = this.o.now();
    for (const agent of this.o.agents) {
      this.o.sink.upsertAgent({
        key: openclawKey(agent),
        source: 'openclaw',
        role: 'openclaw',
        name: agent,
        folderName: 'OpenClaw',
      });
    }
  }

  discover(): void {
    const now = this.o.now();
    for (const agent of this.o.agents) {
      const dir = path.join(this.o.root, agent, 'sessions');
      let names: string[];
      try {
        names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const name of names) {
        const file = path.join(dir, name);
        if (this.tails.has(file)) continue;
        let mtime: number;
        try {
          mtime = fs.statSync(file).mtimeMs;
        } catch {
          continue;
        }
        if (now - mtime > ACTIVE_WINDOW_MS) continue;
        this.tails.set(file, {
          file,
          agentKey: openclawKey(agent),
          trajectory: name.endsWith('.trajectory.jsonl'),
          tail: new JsonlTail(file),
          parser: createSessionParser(),
          kind: undefined,
          historical: mtime < this.startedAt,
          primed: false,
          lastDataAt: mtime,
        });
      }
    }
  }

  poll(): void {
    const now = this.o.now();
    for (const t of this.tails.values()) {
      const lines = t.tail.read();
      if (lines === null) {
        this.tails.delete(t.file);
        continue;
      }
      const replay = !t.primed && t.historical;
      if (lines.length > 0 && t.primed) t.lastDataAt = now;
      if (t.trajectory) {
        this.applyTrajectory(t, lines, replay);
      } else if (lines.length > 0 || replay) {
        const events = lines
          .flatMap((l) => t.parser.parseLine(l))
          .filter((e) => e.kind !== 'header' && e.kind !== 'title' && e.kind !== 'sessionExit');
        this.o.sink.applyEvents(t.agentKey, events, replay);
      }
      t.primed = true;
      if (now - t.lastDataAt > ACTIVE_WINDOW_MS) this.tails.delete(t.file);
    }
  }

  private applyTrajectory(t: Tail, lines: string[], replay: boolean): void {
    for (const line of lines) {
      let rec: { type?: unknown; sessionKey?: unknown; data?: Record<string, unknown> };
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const data = rec.data ?? {};
      const sessionKey = typeof rec.sessionKey === 'string' ? rec.sessionKey : '';
      if (rec.type === 'session.started') {
        t.kind = classifyRun(
          sessionKey,
          typeof data.trigger === 'string' ? data.trigger : undefined,
        );
        if (!replay) this.o.sink.mailroom(t.agentKey, t.kind, 'start', false);
      } else if (rec.type === 'session.ended' && !replay) {
        this.o.sink.mailroom(
          t.agentKey,
          t.kind ?? classifyRun(sessionKey, undefined),
          'end',
          data.status !== 'success',
        );
      }
    }
  }
}
