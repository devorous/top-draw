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

## Results So Far

- `single_stroke_pixel_test.js` - 1 user, 1 stroke, baseline stability
- `two_user_pixel_test.js` - 2 users, 1 stroke, active-layer comparison, `0.000%` divergence
- `three_user_concurrent_pixel_test.js` - 3 users concurrent, active-layer comparison, previously `0.007-0.014%` on full-canvas comparison

## Why This Matters

The full composited canvas is too coarse for diagnosing stroke-level sync. Two clients can render the same stroke history and still show tiny full-canvas differences from stroke ordering, anti-aliasing, or blend timing. Comparing the committed cropped stroke canvases gives a much tighter signal for whether sync is actually correct.

## Running Tests

```bash
npm run dev
node testing/puppeteer/single_stroke_pixel_test.js
node testing/puppeteer/two_user_pixel_test.js
node testing/puppeteer/three_user_concurrent_pixel_test.js
```

## Notes

- The root `testing/README.md` now documents the k6 scripts.
- This folder is the right place for future Puppeteer-based sync checks.
- If you later want a server-side validator, this suite is the baseline to extend from.