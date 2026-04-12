import test from 'node:test';
import assert from 'node:assert/strict';

import { CompositeTileGrid } from '../src/canvas/CompositeTileGrid.js';

test('marks a single tile from a small dirty rect', () => {
  const grid = new CompositeTileGrid(100, 100, 32);
  grid.clear();
  grid.markRect(10, 10, 10, 10);

  assert.deepEqual(grid.consumeDirtyRects(), [
    { x: 0, y: 0, width: 32, height: 32 }
  ]);
});

test('merges matching tile runs across adjacent rows', () => {
  const grid = new CompositeTileGrid(128, 128, 32);
  grid.clear();
  grid.markRect(0, 0, 64, 32);
  grid.markRect(0, 32, 64, 32);

  assert.deepEqual(grid.consumeDirtyRects(), [
    { x: 0, y: 0, width: 64, height: 64 }
  ]);
});

test('clips merged rects to the board bounds', () => {
  const grid = new CompositeTileGrid(100, 100, 32);
  grid.clear();
  grid.markRect(90, 90, 20, 20);

  assert.deepEqual(grid.consumeDirtyRects(), [
    { x: 64, y: 64, width: 36, height: 36 }
  ]);
});

test('returns full redraw when forceFull is set', () => {
  const grid = new CompositeTileGrid(96, 96, 32);

  assert.equal(grid.consumeDirtyRects(), null);
});

test('falls back to full redraw when tile coverage is too high', () => {
  const grid = new CompositeTileGrid(64, 64, 32);
  grid.clear();
  grid.markRect(0, 0, 64, 32);

  assert.equal(grid.consumeDirtyRects(), null);
});

