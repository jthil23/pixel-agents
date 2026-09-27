import { describe, expect, it } from 'vitest';

import { MAILROOM, PROJECT_ROOMS, RoomAssigner } from '../src/homeai/roomAssigner.js';

const activity = [
  { folderName: 'A', lastActive: 5 },
  { folderName: 'B', lastActive: 4 },
  { folderName: 'C', lastActive: 3 },
  { folderName: 'D', lastActive: 2 },
  { folderName: 'E', lastActive: 1 },
];

describe('RoomAssigner', () => {
  it('gives the four most recent folders a room each, shares rooms for the rest, keeps user mappings, and maps OpenClaw to the Mailroom', () => {
    let saved: Record<string, string[]> = {};
    const sent: Record<string, unknown>[] = [];
    const r = new RoomAssigner({
      load: () => ({ Custom: ['Break Room'], Stale: [PROJECT_ROOMS[2]] }),
      save: (m) => (saved = m),
      broadcast: (m) => sent.push(m),
    });
    r.update(activity);
    expect(saved).toEqual({
      Custom: ['Break Room'],
      OpenClaw: [MAILROOM],
      A: [PROJECT_ROOMS[0]],
      B: [PROJECT_ROOMS[1]],
      C: [PROJECT_ROOMS[2]],
      D: [PROJECT_ROOMS[3]],
      E: [...PROJECT_ROOMS],
    });
    expect(sent).toEqual([
      { type: 'areaMappingsLoaded', mappings: saved },
      {
        type: 'projectRooms',
        rooms: ['A', 'B', 'C', 'D'].map((projectName, i) => ({
          label: PROJECT_ROOMS[i],
          projectName,
        })),
      },
    ]);
    r.update(activity);
    expect(sent).toHaveLength(2);
    expect(r.latest()).toEqual(sent);
  });
});
