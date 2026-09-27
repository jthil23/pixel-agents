import type { AreaDefinition, ColorValue, OfficeLayout, PlacedFurniture } from '../office/types.js';
import { TileType } from '../office/types.js';

export const HOME_AI_COLS = 45;
export const HOME_AI_ROWS = 22;

/** Footprints copied from the bundled furniture manifests (fp W×H). */
export const FOOTPRINT: Record<string, { w: number; h: number; wall?: boolean }> = {
  DESK_FRONT: { w: 3, h: 2 },
  PC_FRONT_OFF: { w: 1, h: 2 },
  CUSHIONED_BENCH: { w: 1, h: 1 },
  COFFEE_TABLE: { w: 2, h: 2 },
  PLANT: { w: 1, h: 2 },
  WHITEBOARD: { w: 2, h: 2, wall: true },
  CLOCK: { w: 1, h: 2, wall: true },
  BOOKSHELF: { w: 2, h: 1, wall: true },
};

/* eslint-disable pixel-agents/no-inline-colors -- These area colors are specified by the Home-AI layout brief. */
export const HOME_AI_AREAS: AreaDefinition[] = [
  { label: 'Project Room 1', color: '#4c9be8' },
  { label: 'Project Room 2', color: '#7bd389' },
  { label: 'Project Room 3', color: '#e8663d' },
  { label: 'Project Room 4', color: '#c77dff' },
  { label: 'Mailroom', color: '#f7c948' },
  { label: 'Server Room', color: '#3fb9c9' },
  { label: 'Break Room', color: '#9a8c7a' },
];
/* eslint-enable pixel-agents/no-inline-colors */

interface Room {
  label: string;
  c0: number;
  c1: number;
  r0: number;
  r1: number;
  floor: number;
}

// Row 0 is void (overhang for wall-mounted items), row 1 is the top wall, rows 2-10 are the upper band,
// row 11 is the divider wall, rows 12-20 are the project rooms, and row 21 is the bottom wall.
const ROOMS: Room[] = [
  { label: 'Break Room', c0: 1, c1: 21, r0: 2, r1: 10, floor: TileType.FLOOR_7 },
  { label: 'Mailroom', c0: 23, c1: 32, r0: 2, r1: 10, floor: TileType.FLOOR_1 },
  { label: 'Server Room', c0: 34, c1: 43, r0: 2, r1: 10, floor: TileType.FLOOR_9 },
  { label: 'Project Room 1', c0: 1, c1: 10, r0: 12, r1: 20, floor: TileType.FLOOR_1 },
  { label: 'Project Room 2', c0: 12, c1: 21, r0: 12, r1: 20, floor: TileType.FLOOR_1 },
  { label: 'Project Room 3', c0: 23, c1: 32, r0: 12, r1: 20, floor: TileType.FLOOR_1 },
  { label: 'Project Room 4', c0: 34, c1: 43, r0: 12, r1: 20, floor: TileType.FLOOR_1 },
];

/** Door gaps (floor tiles cut into walls). */
const DOORS: Array<[number, number]> = [
  // divider row 11 → one door into each project room
  [5, 11],
  [6, 11],
  [16, 11],
  [17, 11],
  [27, 11],
  [28, 11],
  [38, 11],
  [39, 11],
  // upper band vertical walls
  [22, 5],
  [22, 6],
  [33, 5],
  [33, 6],
  // project room vertical walls
  [11, 15],
  [11, 16],
  [22, 15],
  [22, 16],
  [33, 15],
  [33, 16],
];

function workstation(uid: string, col: number, row: number): PlacedFurniture[] {
  return [
    { uid: `${uid}-desk`, type: 'DESK_FRONT', col, row },
    { uid: `${uid}-pc`, type: 'PC_FRONT_OFF', col: col + 1, row },
    { uid: `${uid}-seat`, type: 'CUSHIONED_BENCH', col: col + 1, row: row + 2 },
  ];
}

function firstColor(layout: OfficeLayout, tile: number): ColorValue | null {
  const i = layout.tiles.findIndex((t) => t === tile);
  return i >= 0 ? (layout.tileColors?.[i] ?? null) : null;
}

export function buildHomeAiLayout(defaultLayout: OfficeLayout): OfficeLayout {
  const cols = HOME_AI_COLS;
  const rows = HOME_AI_ROWS;
  const tiles: number[] = new Array(cols * rows).fill(TileType.VOID);
  const tileColors: Array<ColorValue | null> = new Array(cols * rows).fill(null);
  const areaTiles: Array<string | null> = new Array(cols * rows).fill(null);
  const set = (c: number, r: number, t: number) => {
    tiles[r * cols + c] = t;
    tileColors[r * cols + c] = firstColor(defaultLayout, t);
  };

  for (let r = 1; r < rows; r++) for (let c = 0; c < cols; c++) set(c, r, TileType.WALL);
  for (const room of ROOMS) {
    for (let r = room.r0; r <= room.r1; r++) {
      for (let c = room.c0; c <= room.c1; c++) {
        set(c, r, room.floor);
        areaTiles[r * cols + c] = room.label;
      }
    }
  }
  for (const [c, r] of DOORS) set(c, r, TileType.FLOOR_1);

  const furniture: PlacedFurniture[] = [];
  ROOMS.filter((room) => room.label.startsWith('Project Room')).forEach((room, i) => {
    furniture.push(
      ...workstation(`p${i + 1}a`, room.c0 + 1, room.r0 + 1),
      ...workstation(`p${i + 1}b`, room.c0 + 5, room.r0 + 1),
      ...workstation(`p${i + 1}c`, room.c0 + 1, room.r0 + 5),
      ...workstation(`p${i + 1}d`, room.c0 + 5, room.r0 + 5),
    );
  });
  furniture.push(
    ...workstation('mail-a', 24, 4),
    ...workstation('mail-b', 28, 4),
    { uid: 'mail-clock', type: 'CLOCK', col: 27, row: 0 },
    { uid: 'mail-plant', type: 'PLANT', col: 31, row: 8 },
    { uid: 'break-board', type: 'WHITEBOARD', col: 9, row: 0 },
    { uid: 'break-shelf', type: 'BOOKSHELF', col: 3, row: 1 },
    { uid: 'break-table', type: 'COFFEE_TABLE', col: 14, row: 6 },
    { uid: 'break-plant', type: 'PLANT', col: 20, row: 3 },
  );

  return {
    version: 1,
    cols,
    rows,
    layoutRevision: 1,
    tiles: tiles as OfficeLayout['tiles'],
    tileColors,
    furniture,
    pets: [],
    areas: HOME_AI_AREAS,
    areaTiles,
  };
}
