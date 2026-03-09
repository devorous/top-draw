# Layer Synchronization Test

Automated test that detects rendering discrepancies between local and remote users by spawning multiple browser instances and comparing their canvas layer data.

## What It Does

1. **Spawns 20 concurrent users** (configurable) in headless browsers
2. **Each user uses a different tool** (brush, pen, line, rectangle, circle, ink, blur, etc.)
3. **Users draw continuously** using randomized movement patterns
4. **Periodically captures layer data** from all users
5. **Compares pixel hashes** across users to detect discrepancies
6. **Reports which tools/layers have rendering differences**

## Installation

```bash
npm install
```

This will install Puppeteer (included in devDependencies).

## Usage

### Basic Test (Default Settings)

```bash
npm run test:layer-sync
```

**Default configuration:**
- 20 concurrent users
- 120 second duration
- Layer checks every 10 seconds
- Headless mode
- Connects to `http://localhost:3000`
- Room: `layer_sync_test`

### Custom Configuration

You can customize the test using environment variables:

```bash
# Run with fewer users for faster iteration
USERS=10 npm run test:layer-sync

# Run for longer duration
DURATION=300 npm run test:layer-sync

# Check layers more frequently
CHECK_INTERVAL=5 npm run test:layer-sync

# Show browser windows (helpful for debugging)
HEADLESS=false npm run test:layer-sync

# Test against production
TARGET_URL=https://yourdomain.com npm run test:layer-sync

# Use a specific room
ROOM=debug_room npm run test:layer-sync

# Combine multiple options
USERS=15 DURATION=60 CHECK_INTERVAL=5 HEADLESS=false npm run test:layer-sync
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `USERS` | `20` | Number of concurrent browser instances |
| `DURATION` | `120` | Test duration in seconds |
| `CHECK_INTERVAL` | `10` | Seconds between layer comparisons |
| `HEADLESS` | `true` | Run browsers in headless mode (set to `false` to see windows) |
| `TARGET_URL` | `http://localhost:3000` | URL of the Top Draw application |
| `ROOM` | `layer_sync_test` | Room name to join |

## Output

### During Test

```
🚀 Starting Layer Sync Test
   Users: 20
   Duration: 120s
   Check Interval: 10s
   Target: http://localhost:3000?room=layer_sync_test

✅ All 20 users connected

🔍 Performing layer check #1...
✅ All layers match!

🔍 Performing layer check #2...
❌ Found 1 discrepancies:
   Layer 0: 2 different versions
   Affected tools: brush, pen

🔍 Performing layer check #3...
✅ All layers match!
```

### Final Report

```
═══════════════════════════════════════════════════════
                   FINAL REPORT
═══════════════════════════════════════════════════════
Total checks performed: 13
Checks with discrepancies: 2
Success rate: 84.6%

Discrepancies by Tool:
  brush           3 times
  pen             2 times
  ink             1 times

Discrepancies by Layer:
  Layer 0:         2 times
  Layer 1:         1 times

Detailed Timeline:
  @ 10.2s:
    Layer 0: 2 versions among 15 users
      Version (hash: 123456): 10 users - brush_0, brush_1, pen_5, ...
      Version (hash: 789012): 5 users - pen_6, brush_3, ...
  @ 20.5s:
    Layer 1: 3 versions among 12 users
      Version (hash: 345678): 8 users - ...
      Version (hash: 901234): 3 users - ...
      Version (hash: 567890): 1 users - ...
═══════════════════════════════════════════════════════
```

## Exit Codes

- `0` - All checks passed, no discrepancies found
- `1` - Discrepancies detected (useful for CI/CD pipelines)

## How It Works

### Layer Capture

For each user, the test captures the pixel data from all 3 layer groups:
- Reads the `baseCanvas` from `LayerManager`
- Computes a hash of all non-transparent pixels
- Counts total non-transparent pixels

### Comparison Algorithm

1. Groups all layer data by layer index (0, 1, 2)
2. Within each layer, compares hashes across all users
3. If multiple unique hashes exist → discrepancy detected
4. Reports which tools produced which hash variants

### Drawing Behavior

Each user follows a random walk pattern:
- Random starting position (with margin)
- Random velocity with bounded acceleration
- Bounces off canvas edges
- Alternates between drawing strokes and moving
- Stroke length varies randomly (40-70 ticks)
- Simulates realistic pointer events with pressure

## Troubleshooting

### "Error: Failed to launch browser"

Puppeteer needs Chrome/Chromium. First time running may take a while to download.

```bash
# Linux: Install dependencies
sudo apt-get install -y chromium-browser

# Or use your system Chrome
PUPPETEER_SKIP_DOWNLOAD=true npm install puppeteer
```

### "TimeoutError: Waiting for app to initialize"

Make sure the app is running:

```bash
npm run dev
```

Then in another terminal:

```bash
npm run test:layer-sync
```

### "All users have hash 0 (empty canvas)"

Users may not be drawing. Try:
- Set `HEADLESS=false` to watch browsers
- Increase `DURATION` to allow more drawing time
- Check browser console for JavaScript errors

### Test is too slow

Reduce users or increase check interval:

```bash
USERS=10 CHECK_INTERVAL=20 npm run test:layer-sync
```

## CI/CD Integration

### GitHub Actions Example

```yaml
- name: Install dependencies
  run: npm ci

- name: Start server
  run: npm run server &

- name: Wait for server
  run: npx wait-on http://localhost:3000

- name: Run layer sync test
  run: HEADLESS=true DURATION=60 npm run test:layer-sync
```

### Expected Baseline

Currently, we expect:
- **Known issue:** Double-smoothing causes discrepancies in brush/pen tools
- **Success rate:** ~70-80% (varies based on drawing intensity)

Once the double-smoothing issue is fixed (see `docs/local_vs_remote_rendering_discrepancies.md`), we should achieve 100% success rate.

## Debugging Tips

1. **Run with visible browsers** - `HEADLESS=false` lets you watch what's happening
2. **Reduce users** - `USERS=2` for faster iteration
3. **Shorter duration** - `DURATION=30` for quick tests
4. **More frequent checks** - `CHECK_INTERVAL=5` catches issues sooner
5. **Check network tab** - Look for WebSocket message flow
6. **Check console** - JavaScript errors will appear in browser console

## Next Steps

1. **Fix double-smoothing** - Remove `applySmoothingEMA` from `RemoteUserHandler.js`
2. **Re-run test** - Should achieve 100% success rate
3. **Add to CI** - Automatically detect regressions
4. **Extend test** - Add more tools, blend modes, layer operations
