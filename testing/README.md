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
