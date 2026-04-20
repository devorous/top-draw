# k6 Stress Testing

This directory contains k6 load testing scripts for the Top Draw WebSocket server.

## Test Files

| File | Description | VUs | Duration |
|------|-------------|-----|----------|
| `stress_test.js` | Basic stress test | 20 | 30s |
| `stress_test2.js` | Staged ramp-up test | 0→40→0 | 30s total |
| `medium_stress_test.js` | Medium load with realistic drawing | 8 | 1m |
| `hard_stress_test.js` | Heavy load with realistic drawing | 20 | 1m |

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
4. Choose the test type:
   - **medium** - Runs only the medium stress test (8 VUs)
   - **hard** - Runs only the hard stress test (20 VUs)
   - **all** - Runs all four test files

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

| File | Description | Status |
|------|-------------|--------|
| `puppeteer/single_stroke_pixel_test.js` | 1 user, 1 stroke, pixel stability | ✅ Passing | 0.000% |
| `puppeteer/two_user_pixel_test.js` | 2 users, 1 stroke, sync comparison | ✅ Passing | 0.000% |
| `puppeteer/three_user_concurrent_pixel_test.js` | 3 users concurrent, pairwise pixel comparison | ✅ Passing | 0.007-0.014% |
| `puppeteer/basic_sync_test.js` | Simplified baseline: draw & join sync | ✅ Passing | Hash match |
| `puppeteer/region_restore_sync_test.js` | Region restore + late-joiner sync (validates race condition fix) | ✅ Passing | Hash match |
| `puppeteer/sequential_brush_sync_test.js` | 3 users draw sequentially (eliminates ordering issues) | Ready | N/A |
| `puppeteer/multi_user_brush_sync_test.js` | 3 users draw concurrently with detailed diagnostics | Ready | N/A |
| `puppeteer/diagnostic_sync_test.js` | Multi-user concurrent drawing with full state comparison | Ready | N/A |
| `puppeteer/dual_user_sync_test.js` | Original: 2 bots, multiple strokes, all tools | ✅ Passing | Hash match |
| `puppeteer/tool_sync_suite.js` | Multi-tool synchronization | Pending | N/A |

## Running Tests Locally

### Quick Start

```bash
# Start dev server first (if not already running)
npm run dev

# In another terminal, run any test
node testing/puppeteer/basic_sync_test.js         # Start here - baseline sync test
node testing/puppeteer/region_restore_sync_test.js # Validates region restore race fix
node testing/puppeteer/dual_user_sync_test.js      # Extended: multiple strokes, all tools
```

### Test Progression

**Phase 1: Baseline (✅ passing)**
- `puppeteer/basic_sync_test.js` - User A draws 3 strokes, User B joins → validate hash match
- `puppeteer/region_restore_sync_test.js` - Async region restore + late joiner → validate race fix
- Validates: Core sync mechanism, async operations don't break sync

**Phase 2: Multi-User Diagnostics (Ready to run)**
- `puppeteer/sequential_brush_sync_test.js` - 3 users draw **sequentially** (eliminates ordering variance)
- `puppeteer/multi_user_brush_sync_test.js` - 3 users draw **concurrently** with per-user stroke tracking
- `puppeteer/diagnostic_sync_test.js` - 3 users with detailed state comparison (canvas hash + stroke counts + per-user breakdown)
- Validates: Multi-user sync under different concurrency patterns
- Shows: Which users diverge, where divergence occurs

**Phase 3: Tool Variety (Pending)**
- `puppeteer/tool_sync_suite.js` - Multiple users, all drawing tools (brush, pen, line, rect, etc.)
- Validates: Tool-specific sync paths work across users

**Phase 4: Server-Side Validator (Future)**
- Puppeteer instance on server acts as "canonical canvas"
- Periodically validates all clients match server-side render

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

Use the `basic_sync_test.js` as a template:

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
    // See basic_sync_test.js for full implementation
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
