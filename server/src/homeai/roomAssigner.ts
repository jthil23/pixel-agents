import type { RoomActivity } from './ompSource.js';

export const PROJECT_ROOMS = [
  'Project Room 1',
  'Project Room 2',
  'Project Room 3',
  'Project Room 4',
];
export const MAILROOM = 'Mailroom';
const MANAGED: Record<string, true> = {
  [PROJECT_ROOMS[0]]: true,
  [PROJECT_ROOMS[1]]: true,
  [PROJECT_ROOMS[2]]: true,
  [PROJECT_ROOMS[3]]: true,
  [MAILROOM]: true,
};

export class RoomAssigner {
  private lastJson = '';
  private messages: Record<string, unknown>[] = [];

  constructor(
    private readonly o: {
      load: () => Record<string, string[]>;
      save: (m: Record<string, string[]>) => void;
      broadcast: (m: Record<string, unknown>) => void;
    },
  ) {}

  update(rooms: RoomActivity[]): void {
    const sorted = [...rooms].sort((a, b) => b.lastActive - a.lastActive);
    const mappings: Record<string, string[]> = {};
    for (const [folder, labels] of Object.entries(this.o.load())) {
      if (!labels.some((l) => MANAGED[l])) mappings[folder] = labels;
    }
    mappings.OpenClaw = [MAILROOM];
    const projectRooms = sorted
      .slice(0, PROJECT_ROOMS.length)
      .map((r, i) => ({ label: PROJECT_ROOMS[i], projectName: r.folderName }));
    for (const r of projectRooms) mappings[r.projectName] = [r.label];
    for (const r of sorted.slice(PROJECT_ROOMS.length)) mappings[r.folderName] = [...PROJECT_ROOMS];

    const json = JSON.stringify([mappings, projectRooms]);
    if (json === this.lastJson) return;
    this.lastJson = json;
    this.o.save(mappings);
    this.messages = [
      { type: 'areaMappingsLoaded', mappings },
      { type: 'projectRooms', rooms: projectRooms },
    ];
    for (const m of this.messages) this.o.broadcast(m);
  }

  latest(): Record<string, unknown>[] {
    return this.messages;
  }
}
