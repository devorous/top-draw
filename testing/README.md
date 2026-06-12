# k6 Stress Testing

This directory contains k6 load testing scripts for the Top Draw WebSocket server.

## Test Files

Load tiers come in a plain variant (independent VUs) and an `_ordered` variant
(VUs draw in a coordinated sequence, useful for ordering/sync checks):

| File | Description |
|------|-------------|
| `low_stress_test.js` / `low_ordered_stress_test.js` | Light load |
| `medium_stress_test.js` / `medium_ordered_stress_test.js` | Medium load with realistic drawing |
| `high_stress_test.js` / `high_ordered_stress_test.js` | Heavy load with realistic drawing |
| `multiroom_stress_test.js` | Load spread across multiple rooms |
| `selection_stress_test.js` | Selection/transform-focused load |

Older one-off harnesses (`stress_test.js`, `stress_test2.js`, `hard_stress_test.js`, etc.)
have been retired to `testing/legacy/` and are no longer maintained.

## Running Tests Locally

### Against Local Server

```bash
# Start your local server first
npm run server

# Then run any test (uses localhost by default)
k6 run testing/medium_stress_test.js
```

### Against Koyeb Server

```bash
# Use the -e flag to set the target URL
k6 run -e TARGET_URL=wss://top-draw.koyeb.app testing/medium_stress_test.js
```

## Running Tests via GitHub Actions

1. Go to the **Actions** tab in your GitHub repository
2. Select **k6 Stress Tests** from the workflow list
3. Click **Run workflow**
4. Choose the test file from the dropdown (`.github/workflows/k6-stress.yml`):
   `multiroom_stress_test` (default), `low_stress_test`, `low_ordered_stress_test`,
   `medium_stress_test`, `medium_ordered_stress_test`, `high_stress_test`,
   `high_ordered_stress_test`.

The workflow will automatically target your Koyeb server (`wss://top-draw.koyeb.app`).

## Test Results

After tests complete:
- Results are displayed in the GitHub Actions logs
- Artifacts (JSON/HTML reports) are uploaded and can be downloaded from the workflow run page
- Look for metrics like:
  - `broadcast_latency_med` / `broadcast_latency_fast` - Message round-trip times
  - `ws_connecting` - Connection time
  - `ws_session_duration` - How long connections lasted
  - `iterations` - Number of complete test cycles

## Environment Variables

All tests support the `TARGET_URL` environment variable:

- **Not set**: Defaults to `ws://127.0.0.1:8000` (local development)
- **Set to Koyeb**: Use `wss://top-draw.koyeb.app` (production testing)

The difference between `ws://` and `wss://`:
- `ws://` - Unencrypted WebSocket (local only)
- `wss://` - Secure WebSocket with SSL (required for HTTPS-hosted servers like Koyeb)

## Metrics Explained

### broadcast_latency
How long it takes for a drawing stroke message to be broadcast to other users. Lower is better.

- **Good**: < 50ms
- **Acceptable**: 50-100ms
- **Slow**: > 100ms

### Connection Success Rate
Percentage of successful WebSocket connections. Should be close to 100%.

### Iterations
How many complete drawing cycles each virtual user completed. More iterations = more stable performance.

---

# Puppeteer Integration Tests

Multi-user synchronization tests using Puppeteer headless browser automation. These verify real multi-client scenarios including rendering, state propagation, and edge cases.

The Puppeteer scripts now live in [testing/puppeteer](testing/puppeteer). The root `testing` folder is reserved for k6 stress tests and other non-browser harnesses.

## Test Files

| File | Description |
|------|-------------|
| `puppeteer/comprehensive_sync_suite.js` (via `npm run test:sync`) | Multi-user, all tools × multiple settings, concurrent draws + stroke-flood. Compares per-stroke bbox pixels. |
| `puppeteer/visual_regression_suite.js` | Pinned-baseline regression test for tool rendering (single-user). Baselines in `testing/baselines/`. |
| `puppeteer/region_restore_sync_test.js` | Region restore + late-joiner sync (validates async race condition fix) |
| `puppeteer/history_region_restore_sync_test.js` | History menu snapshot apply + late-joiner sync |

## Running Tests Locally

### Quick Start

```bash
# Start dev server first (if not already running)
npm run dev

# Comprehensive sync suite (preferred for sync regression)
npm run test:sync

# Pinned-baseline visual regression
node testing/puppeteer/visual_regression_suite.js

# Region-restore race condition tests
node testing/puppeteer/region_restore_sync_test.js
node testing/puppeteer/history_region_restore_sync_test.js
```

## Diagnostic Output & Interpretation

When running multi-user tests, you'll see detailed diagnostics like:

```
📊 CANVAS STATES:

  1. user_0:
     Hash: 995189771
     Strokes: 15
     Strokes by user: {"0": 5, "1": 5, "2": 5}
     Strokes: 15
     Strokes by user: {"0": 5, "1": 5, "2": 5}
  Canvas Hashes Match: ❌
  Stroke Counts Match: ✅
```

- **Root cause**: Likely stroke **ordering** or **blending mode** difference, not message loss

### Diagnosis Guide

| Symptom | Likely Cause | Investigation |
|---------|-------------|-----------------|
| Canvas hashes diverge but stroke counts match | Rendering order or blend mode difference | Compare pixel data visually (fail_*.png screenshots) |
| Stroke counts diverge between users | Message loss or sync gap | Check WebSocket logs for dropped messages |
| Per-user stroke counts don't match | One user's strokes not propagating | Verify broadcast_message → relay → deliver logic |
| Sequential test passes, concurrent fails | Race condition in message ordering | Reduce concurrent drawing or add sync delays |
| All tests pass locally, fail on server | Network latency or message buffering | Increase propagation timeouts, test on actual network |

## Test Output

Tests report:
- **✅ SUCCESS**: All clients rendered identical canvas (hash match)
- **❌ FAILURE**: State divergence detected; screenshots saved as `fail_*.png`
- Detailed logs include sync timings, user join order, and state comparisons

## Environment Variables

- `TARGET_URL`: App URL (default: `http://localhost:3000/go/`)
- `HEADLESS`: Set to `false` to see browser windows during test (default: `true`)

## Adding New Tests

Use `region_restore_sync_test.js` as a template for narrow scenario tests, or extend `comprehensive_sync_suite.js` if your case fits the tool × settings matrix.

1. Create `new YourTest()` class with `async run()` method
2. Use `spawnBot(i)` to create Puppeteer instances
3. Call bot methods to manipulate the canvas: `drawStroke()`, `getCanvasHash()`, etc.
4. Compare canvas hashes with `getCanvasHash(bot)`
5. Exit with code 0 (pass) or 1 (fail)

### Test Template

```javascript
class YourTest {
  constructor() {
    this.bots = [];
  }

  async spawnBot(i) {
    // See region_restore_sync_test.js for full implementation
  }

  async drawStroke(bot, x1, y1, x2, y2, color) {
    // Simulate user drawing via JavaScript events
  }

  async getCanvasHash(bot) {
    // Compute canvas hash for comparison
  }

  async run() {
    // 1. Spawn bots
    // 2. Perform actions
    // 3. Compare results
    // 4. Exit with 0 (pass) or 1 (fail)
  }
}

new YourTest().run().catch(err => {
  console.error(err);
  process.exit(1);
});
```

### Key Utilities

**Drawing**: `drawStroke(bot, x1, y1, x2, y2, color)` — Simulates a brush stroke from (x1,y1) to (x2,y2)

**Verification**: `getCanvasHash(bot)` — Computes a simple hash of all canvas pixels; matching hashes = identical renderings

**Timing**: Puppeteer tests are async; use `await new Promise(r => setTimeout(r, ms))` to wait for propagation

### Common Patterns

**Wait for other user actions**:
```javascript
await new Promise(r => setTimeout(r, 2000)); // 2s propagation buffer
```

**Compare multiple users**:
```javascript
const hashes = await Promise.all(
  this.bots.map(bot => this.getCanvasHash(bot))
);
const allMatch = hashes.every(h => h === hashes[0]);
```

**Debug: Take screenshots on failure**:
```javascript
for (const bot of this.bots) {
  await bot.page.screenshot({ path: `debug_${bot.name}.png` });
}
```
