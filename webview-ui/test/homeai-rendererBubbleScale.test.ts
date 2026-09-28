import assert from 'node:assert/strict';

import { test, vi } from 'vitest';

const { cacheCalls } = vi.hoisted(() => ({
  cacheCalls: [] as { sprite: unknown; zoom: number }[],
}));

vi.mock('../src/office/sprites/spriteCache.js', () => ({
  getCachedSprite: (sprite: unknown, zoom: number) => {
    cacheCalls.push({ sprite, zoom });
    return { width: 16 * zoom, height: 24 * zoom } as HTMLCanvasElement;
  },
  getOutlineSprite: (sprite: unknown) => sprite,
}));

import { createCharacter } from '../src/office/engine/characters.js';
import { renderFrame } from '../src/office/engine/renderer.js';
import { BUBBLE_PERMISSION_SPRITE } from '../src/office/sprites/spriteData.js';

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
    cacheCalls.length = 0;
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
    const bubbleCall = cacheCalls.find((call) => call.sprite === BUBBLE_PERMISSION_SPRITE);
    assert.ok(bubbleCall, `permission bubble should be cached at zoom ${zoom}`);
    const s = bubbleCall.zoom;
    assert.ok(Number.isInteger(s) && s > zoom && s >= zoom * 1.5 - 0.5);
  }
});
