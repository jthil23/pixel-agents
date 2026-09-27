import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { test } from 'vitest';

import { buildHomeAiLayout, FOOTPRINT, HOME_AI_AREAS } from '../src/homeai/layoutBuilder.js';
import type { OfficeLayout } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

const defaultLayout = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'public', 'assets', 'default-layout-1.json'), 'utf8'),
) as OfficeLayout;
const layout = buildHomeAiLayout(defaultLayout);
const at = (c: number, r: number) => layout.tiles[r * layout.cols + c];
const isFloor = (t: number) => t !== TileType.WALL && t !== TileType.VOID;

function occupied(): Map<string, string> {
  const occ = new Map<string, string>();
  for (const f of layout.furniture) {
    const fp = FOOTPRINT[f.type];
    assert.ok(fp, `unknown footprint for ${f.type}`);
    if (fp.wall || f.type.startsWith('PC_')) continue; // wall items hang; PCs sit on desk surfaces
    for (let dr = 0; dr < fp.h; dr++) {
      for (let dc = 0; dc < fp.w; dc++) {
        const key = `${f.col + dc},${f.row + dr}`;
        assert.ok(!occ.has(key), `${f.type} overlaps ${occ.get(key)} at ${key}`);
        occ.set(key, f.type);
      }
    }
  }
  return occ;
}

test('keeps layout revision 1, parallel arrays and distinct area labels', () => {
  assert.equal(layout.layoutRevision, 1);
  assert.equal(layout.tiles.length, layout.cols * layout.rows);
  assert.equal(layout.tileColors?.length, layout.tiles.length);
  assert.equal(layout.areaTiles?.length, layout.tiles.length);
  const labels = HOME_AI_AREAS.map((a) => a.label);
  assert.deepEqual(new Set(labels).size, labels.length);
  for (const l of [
    'Project Room 1',
    'Project Room 2',
    'Project Room 3',
    'Project Room 4',
    'Mailroom',
    'Server Room',
    'Break Room',
  ]) {
    assert.ok(labels.includes(l), l);
    assert.ok(
      layout.areaTiles!.some((t) => t === l),
      `no tiles for ${l}`,
    );
  }
});

test('floor furniture sits on floor tiles, never overlaps, and wall items hang on a wall row', () => {
  const occ = occupied();
  for (const key of occ.keys()) {
    const [c, r] = key.split(',').map(Number);
    assert.ok(isFloor(at(c, r)), `furniture on non-floor tile ${key}`);
  }
  for (const f of layout.furniture.filter((x) => FOOTPRINT[x.type]?.wall)) {
    assert.equal(
      at(f.col, f.row + FOOTPRINT[f.type].h - 1),
      TileType.WALL,
      `${f.type} not on a wall`,
    );
  }
});

test('each project room has 4 benches and the mailroom 2, each directly below a desk and reachable from every other room', () => {
  const occ = occupied();
  const benches = layout.furniture.filter((f) => f.type === 'CUSHIONED_BENCH');
  const count = (label: string) =>
    benches.filter((b) => layout.areaTiles![b.row * layout.cols + b.col] === label).length;
  for (let i = 1; i <= 4; i++) assert.equal(count(`Project Room ${i}`), 4);
  assert.equal(count('Mailroom'), 2);
  assert.equal(count('Break Room') + count('Server Room'), 0);
  for (const b of benches)
    assert.equal(
      occ.get(`${b.col},${b.row - 1}`),
      'DESK_FRONT',
      `bench ${b.col},${b.row} has no desk above`,
    );

  // BFS over walkable floor (bench tiles are walkable targets) from the Break Room centre.
  const walk = (c: number, r: number) =>
    isFloor(at(c, r)) && (!occ.has(`${c},${r}`) || occ.get(`${c},${r}`) === 'CUSHIONED_BENCH');
  const start = { c: 10, r: 9 };
  assert.ok(walk(start.c, start.r));
  const seen = new Set([`${start.c},${start.r}`]);
  const queue = [start];
  while (queue.length) {
    const { c, r } = queue.shift()!;
    for (const [dc, dr] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const n = { c: c + dc, r: r + dr };
      const key = `${n.c},${n.r}`;
      if (
        n.c < 0 ||
        n.r < 0 ||
        n.c >= layout.cols ||
        n.r >= layout.rows ||
        seen.has(key) ||
        !walk(n.c, n.r)
      )
        continue;
      seen.add(key);
      queue.push(n);
    }
  }
  for (const b of benches)
    assert.ok(seen.has(`${b.col},${b.row}`), `bench ${b.col},${b.row} unreachable`);
});
