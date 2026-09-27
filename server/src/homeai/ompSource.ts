import * as fs from 'node:fs';
import * as path from 'node:path';

import { JsonlTail } from './jsonlTail.js';
import { createSessionParser, type SessionParser } from './sessionParser.js';
import type { AgentRole, SessionEvent, SourceSink } from './types.js';

export const ACTIVE_WINDOW_MS = 60 * 60_000;
const MAX_DEPTH = 4;
const DAY_MS = 86_400_000;
/** Enough for the padded title record plus the session record. */
const HEADER_SCAN_BYTES = 64 * 1024;

export interface OmpSourceOptions {
  root: string;
  roomActivityDays: number;
  sink: SourceSink;
  now: () => number;
}

export interface RoomActivity {
  folderName: string;
  lastActive: number;
}

interface Tracked {
  key: string;
  role: AgentRole;
  parentKey?: string;
  depth: number;
  tail: JsonlTail;
  parser: SessionParser;
  pending: SessionEvent[];
  registered: boolean;
  lastDataAt: number;
}

export function folderOf(cwd: string): string {
  return (
    cwd
      .split(/[\\/]+/)
      .filter(Boolean)
      .pop() ?? cwd
  );
}

function mtimeMs(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function dirents(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export class OmpSource {
  private readonly tracked = new Map<string, Tracked>();
  /** key → mtime at retirement; a retired file is only re-tracked after it changes. */
  private readonly retired = new Map<string, number>();
  private readonly headerCwd = new Map<string, string>();

  constructor(private readonly o: OmpSourceOptions) {}

  /** Tracks active transcripts and returns project-folder activity for the last N days. */
  discover(): RoomActivity[] {
    const now = this.o.now();
    const rooms = new Map<string, number>();
    for (const projectDir of dirents(this.o.root).filter((d) => d.isDirectory())) {
      const dir = path.join(this.o.root, projectDir.name);
      for (const f of dirents(dir).filter((d) => d.isFile() && d.name.endsWith('.jsonl'))) {
        this.discoverTree(path.join(dir, f.name), 'session', undefined, 0, now, rooms);
      }
    }
    return [...rooms].map(([folderName, lastActive]) => ({ folderName, lastActive }));
  }

  private discoverTree(
    file: string,
    role: AgentRole,
    parentKey: string | undefined,
    depth: number,
    now: number,
    rooms: Map<string, number>,
  ): boolean {
    const mtime = mtimeMs(file);
    if (now - mtime <= this.o.roomActivityDays * DAY_MS) {
      const cwd = this.readHeaderCwd(file);
      if (cwd) {
        const folder = folderOf(cwd);
        rooms.set(folder, Math.max(rooms.get(folder) ?? 0, mtime));
      }
    }
    let hasActiveDescendant = false;
    if (depth < MAX_DEPTH) {
      const childDir = file.slice(0, -'.jsonl'.length);
      for (const child of dirents(childDir).filter(
        (d) => d.isFile() && d.name.endsWith('.jsonl'),
      )) {
        const childFile = path.join(childDir, child.name);
        const childRole = child.name.startsWith('__advisor') ? 'advisor' : 'subagent';
        if (this.discoverTree(childFile, childRole, file, depth + 1, now, rooms)) {
          hasActiveDescendant = true;
        }
      }
    }
    const active = now - mtime <= ACTIVE_WINDOW_MS;
    if (active || hasActiveDescendant) this.track(file, role, parentKey, depth);
    return active || hasActiveDescendant;
  }

  poll(): void {
    const now = this.o.now();
    for (const t of [...this.tracked.values()].sort((a, b) => a.depth - b.depth)) {
      const lines = t.tail.read();
      if (lines === null) {
        this.drop(t);
        continue;
      }
      let justRegistered = false;
      if (lines.length > 0 && t.registered) t.lastDataAt = now;
      if (lines.length > 0 || (!t.registered && t.pending.length > 0)) {
        let events = [...t.pending, ...lines.flatMap((line) => t.parser.parseLine(line))];
        t.pending = [];
        const lastExit = events.findLastIndex((event) => event.kind === 'sessionExit');
        if (lastExit !== -1) {
          const resumedEvents = events.slice(lastExit + 1);
          const hasWorkAfterExit = resumedEvents.some(
            (event) =>
              event.kind === 'toolStart' ||
              event.kind === 'toolEnd' ||
              event.kind === 'turnEnd' ||
              event.kind === 'usage',
          );
          if (!hasWorkAfterExit) {
            this.drop(t);
            continue;
          }
          const metadata = events.filter(
            (event) => event.kind === 'header' || event.kind === 'title' || event.kind === 'init',
          );
          events = [...metadata, ...resumedEvents];
          if (t.registered) {
            this.o.sink.removeAgent(t.key);
            t.registered = false;
          }
          if (!this.register(t, events)) {
            t.pending = events;
            continue;
          }
          justRegistered = true;
          this.o.sink.applyEvents(t.key, events, true);
        } else {
          const replay = !t.registered;
          if (!t.registered && !this.register(t, events)) {
            t.pending = events;
          } else {
            justRegistered = replay;
            this.o.sink.applyEvents(t.key, events, replay);
          }
        }
      }
      if (!justRegistered && now - t.lastDataAt > ACTIVE_WINDOW_MS) this.drop(t);
    }
  }

  private register(t: Tracked, events: SessionEvent[]): boolean {
    const header = events.find(
      (e): e is Extract<SessionEvent, { kind: 'header' }> => e.kind === 'header',
    );
    if (!header) return false;
    if (t.parentKey && !this.tracked.get(t.parentKey)?.registered) return false;
    const titles = events.filter(
      (e): e is Extract<SessionEvent, { kind: 'title' }> => e.kind === 'title',
    );
    const base = path.basename(t.key, '.jsonl');
    let name: string;
    if (t.role === 'advisor')
      name = base === '__advisor' ? 'Advisor' : `Advisor (${base.slice('__advisor.'.length)})`;
    else if (t.role === 'subagent') name = base;
    else name = titles.length ? titles[titles.length - 1].title : base;
    this.o.sink.upsertAgent({
      key: t.key,
      source: 'omp',
      role: t.role,
      ...(t.parentKey ? { parentKey: t.parentKey } : {}),
      name,
      folderName: folderOf(header.cwd),
      ...(t.role === 'session' ? { sessionId: header.sessionId } : {}),
    });
    t.registered = true;
    return true;
  }

  private track(file: string, role: AgentRole, parentKey: string | undefined, depth: number): void {
    const mtime = mtimeMs(file);
    const retiredAt = this.retired.get(file);
    if (retiredAt !== undefined) {
      if (retiredAt === mtime) return;
      this.retired.delete(file);
    }
    if (!this.tracked.has(file)) {
      this.tracked.set(file, {
        key: file,
        role,
        ...(parentKey ? { parentKey } : {}),
        depth,
        tail: new JsonlTail(file),
        parser: createSessionParser(),
        pending: [],
        registered: false,
        lastDataAt: mtime,
      });
    }
  }

  private drop(t: Tracked): void {
    this.tracked.delete(t.key);
    this.retired.set(t.key, mtimeMs(t.key));
    if (t.registered) this.o.sink.removeAgent(t.key);
  }

  /** cwd from the `session` record; omp writes a `title` record first, so scan records until one is found. */
  private readHeaderCwd(file: string): string | undefined {
    const cached = this.headerCwd.get(file);
    if (cached !== undefined) return cached;
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(HEADER_SCAN_BYTES);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const text = buf.subarray(0, n).toString('utf8');
      const complete = text.slice(0, text.lastIndexOf('\n') + 1);
      for (const line of complete.split('\n')) {
        if (!line.trim()) continue;
        let rec: { type?: unknown; cwd?: unknown };
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        if (rec.type !== 'session') continue;
        if (typeof rec.cwd !== 'string') return undefined;
        this.headerCwd.set(file, rec.cwd);
        return rec.cwd;
      }
    } catch {
      // unreadable; retried on the next discover
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    return undefined;
  }
}
