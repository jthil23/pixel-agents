import { type FetchFn, getJson } from './solSource.js';

export type SunPhase = 'day' | 'golden' | 'dusk' | 'night';

export function phaseFor(elevation: number): SunPhase {
  if (elevation > 6) return 'day';
  if (elevation >= 0) return 'golden';
  if (elevation >= -6) return 'dusk';
  return 'night';
}

export function clockPhase(d: Date): SunPhase {
  const h = d.getHours();
  return h >= 7 && h < 19 ? 'day' : 'night';
}

export class SunSource {
  constructor(
    private readonly o: {
      haUrl: string;
      token: string | undefined;
      fetch: FetchFn;
      now: () => number;
    },
  ) {}

  async poll(): Promise<{ phase: SunPhase; elevation: number | null }> {
    const fallback = { phase: clockPhase(new Date(this.o.now())), elevation: null };
    if (!this.o.token) return fallback;
    try {
      const body = (await getJson(
        this.o.fetch,
        `${this.o.haUrl.replace(/\/$/, '')}/api/states/sun.sun`,
        {
          Authorization: `Bearer ${this.o.token}`,
        },
      )) as { attributes?: { elevation?: unknown } };
      const elevation = body.attributes?.elevation;
      return typeof elevation === 'number' ? { phase: phaseFor(elevation), elevation } : fallback;
    } catch {
      return fallback;
    }
  }
}
