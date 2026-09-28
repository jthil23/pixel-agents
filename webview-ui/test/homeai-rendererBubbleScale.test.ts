import assert from 'node:assert/strict';

import { test, vi } from 'vitest';

const { cacheScales } = vi.hoisted(() => ({ cacheScales: [] as number[] }));

vi.mock('../src/office/sprites/spriteCache.js', () => ({
  getCachedSprite: (_sprite: unknown, zoom: number) => {
    cacheScales.push(zoom);
    return { width: 16 * zoom, height: 24 * zoom } as HTMLCanvasElement;
  },
  getOutlineSprite: (sprite: unknown) => sprite,
}));

import { createCharacter } from '../src/office/engine/characters.js';
import { renderFrame } from '../src/office/engine/renderer.js';

test('speech bubbles use integer pixel scales at every supported zoom', () => {
  const ctx = {
    clearRect() {},
    drawImage() {},
    save() {},
    restore() {},
  } as unknown as CanvasRenderingContext2D;
  const character = createCharacter(1, 0, null, null);
  character.bubbleType = 'permission';

  for (let zoom = 1; zoom <= 10; zoom++) {
    cacheScales.length = 0;
    renderFrame(
      ctx,
      100,
      100,
      [],
      [],
      [character],
      zoom,
      0,
      0,
      undefined,
      undefined,
      undefined,
      0,
      0,
    );
    const bubbleScale = cacheScales.at(-1);
    assert.equal(bubbleScale, Math.max(zoom + 1, Math.round(zoom * 1.5)));
    assert.ok(Number.isInteger(bubbleScale));
  }
});
