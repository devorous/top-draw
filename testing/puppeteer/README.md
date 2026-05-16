# Puppeteer Integration Tests

This folder contains the browser-driven synchronization tests for Top Draw.

## What Changed

The Puppeteer scripts were moved out of the `testing` root into this subfolder so the top-level `testing` directory can stay focused on k6 load/stress scripts.

The tests were also updated to compare the active layer's committed stroke canvases instead of the entire composited board. That is the right unit for these checks because each committed stroke is stored as a cropped bitmap with its own `x`, `y`, `width`, and `height` bounds.

## Current Test Approach

- Capture the active layer's `strokeStack`
- Compare stroke metadata first: `userId`, bounds, blend mode, timestamp
- Read the per-stroke cropped canvas pixels
- Compare only non-transparent pixels to keep the payload small while preserving exact RGBA checks

## Current Suite

- `comprehensive_sync_suite.js` — multi-user, all tools × multiple settings, concurrent + stroke-flood. Run via `npm run test:sync`.
- `visual_regression_suite.js` — single-user pinned-baseline regression for tool rendering.
- `region_restore_sync_test.js` — region restore race condition fix.
- `history_region_restore_sync_test.js` — history snapshot apply + late joiner.

## Why This Matters

The full composited canvas is too coarse for diagnosing stroke-level sync. Two clients can render the same stroke history and still show tiny full-canvas differences from stroke ordering, anti-aliasing, or blend timing. Comparing the committed cropped stroke canvases gives a much tighter signal for whether sync is actually correct.

## Running Tests

```bash
npm run dev
npm run test:sync                                       # comprehensive suite
node testing/puppeteer/visual_regression_suite.js       # pinned-baseline regression
node testing/puppeteer/region_restore_sync_test.js
node testing/puppeteer/history_region_restore_sync_test.js
```

## Notes

- The root `testing/README.md` documents the k6 scripts.
- This folder is the right place for future Puppeteer-based sync checks.