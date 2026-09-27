export type FetchFn = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type MonitorState = 'up' | 'flapping' | 'pending' | 'maintenance' | 'down' | 'unknown';
export interface SolBeat {
  status: number;
  ping: number | null;
  time: string;
}
export interface SolMonitor {
  id: number;
  name: string;
  state: MonitorState;
  uptime24h: number | null;
  beats: SolBeat[];
}
export interface SolSnapshot {
  reachable: boolean;
  groups: { name: string; monitors: SolMonitor[] }[];
}
export interface SolPollResult {
  snapshot: SolSnapshot;
  newlyDown: { groupName: string; monitorName: string }[];
}

export const HTTP_TIMEOUT_MS = 5000;
const HOUR_MS = 3_600_000;
const FLAP_TRANSITIONS = 3;
const KEEP_BEATS = 20;

type Rec = Record<string, unknown>;

export function kumaTime(t: string): number {
  return Date.parse(`${t.replace(' ', 'T')}Z`);
}

export function monitorState(beats: SolBeat[], now: number): MonitorState {
  if (beats.length === 0) return 'unknown';
  const last = beats[beats.length - 1].status;
  if (last === 0) return 'down';
  if (last === 3) return 'maintenance';
  if (last === 2) return 'pending';
  let downs = 0;
  for (let i = 1; i < beats.length; i++) {
    if (
      beats[i].status === 0 &&
      beats[i - 1].status === 1 &&
      now - kumaTime(beats[i].time) <= HOUR_MS
    ) {
      downs++;
    }
  }
  return downs >= FLAP_TRANSITIONS ? 'flapping' : 'up';
}

export async function getJson(
  fetchFn: FetchFn,
  url: string,
  headers?: Record<string, string>,
): Promise<unknown> {
  const res = await fetchFn(url, {
    ...(headers ? { headers } : {}),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

export class SolSource {
  private last: SolSnapshot = { reachable: false, groups: [] };
  private lastSuccessful: SolSnapshot = { reachable: false, groups: [] };
  private polled = false;

  constructor(
    private readonly o: { baseUrl: string; slug: string; fetch: FetchFn; now: () => number },
  ) {}

  async poll(): Promise<SolPollResult> {
    const base = this.o.baseUrl.replace(/\/$/, '');
    let next: SolSnapshot;
    try {
      const [page, hb] = (await Promise.all([
        getJson(this.o.fetch, `${base}/api/status-page/${this.o.slug}`),
        getJson(this.o.fetch, `${base}/api/status-page/heartbeat/${this.o.slug}`),
      ])) as [Rec, Rec];
      const heartbeats = (hb.heartbeatList ?? {}) as Record<string, SolBeat[]>;
      const uptimes = (hb.uptimeList ?? {}) as Record<string, unknown>;
      const now = this.o.now();
      next = {
        reachable: true,
        groups: ((page.publicGroupList ?? []) as Rec[]).map((g) => ({
          name: String(g.name ?? ''),
          monitors: ((g.monitorList ?? []) as Rec[]).map((m) => {
            const id = Number(m.id);
            const beats = heartbeats[String(id)] ?? [];
            const uptime = uptimes[`${id}_24`];
            return {
              id,
              name: String(m.name ?? id),
              state: monitorState(beats, now),
              uptime24h: typeof uptime === 'number' ? uptime : null,
              beats: beats.slice(-KEEP_BEATS).map((b) => ({
                status: b.status,
                ping: typeof b.ping === 'number' ? b.ping : null,
                time: b.time,
              })),
            };
          }),
        })),
      };
    } catch {
      next = {
        reachable: false,
        groups: this.last.groups.map((g) => ({
          ...g,
          monitors: g.monitors.map((m) => ({ ...m, state: 'unknown' as const })),
        })),
      };
    }
    const newlyDown: SolPollResult['newlyDown'] = [];
    if (next.reachable) {
      if (this.polled) {
        const prev = new Map(
          this.lastSuccessful.groups.flatMap((g) =>
            g.monitors.map((m) => [m.id, m.state] as const),
          ),
        );
        for (const g of next.groups) {
          for (const m of g.monitors) {
            if (m.state === 'down' && prev.get(m.id) !== 'down')
              newlyDown.push({ groupName: g.name, monitorName: m.name });
          }
        }
      }
      this.lastSuccessful = next;
      this.polled = true;
    }
    this.last = next;
    return { snapshot: next, newlyDown };
  }

  uptimeMean(): number | null {
    const values = this.last.groups
      .flatMap((g) => g.monitors.map((m) => m.uptime24h))
      .filter((v): v is number => v !== null);
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  }
}
