#!/usr/bin/env node
/**
 * @fileoverview Does CDP network emulation actually reach WebSocket frames?
 *
 * WHY THIS EXISTS. `Network.emulateNetworkConditions` is the obvious lever for a
 * latency harness, and it is documented in terms of "network conditions" without
 * saying which traffic it governs. Chrome's throttling has historically been
 * applied in the resource-loading path, which WebSocket frames do not travel
 * through once the connection is upgraded — so the setting can be accepted,
 * report success, and change nothing about the traffic under test. A harness
 * built on that assumption would apply no lag at all while printing plausible
 * numbers, which is the same silent-no-op failure as the empty-observer bug in
 * replay_multiuser_edge_suite and the unloadable brush payloads before it.
 *
 * So: measure, don't assume. This is deliberately self-contained — its own echo
 * server, its own blank page — so nothing about Top Draw's client can confound
 * the answer.
 *
 * WHAT IT MEASURES, each against its own baseline in the same page:
 *   handshake   time to WebSocket 'open' (the HTTP upgrade — the part most
 *               likely to be throttled even if frames are not)
 *   frame RTT   echo round-trip on an ESTABLISHED connection, which is what a
 *               lag harness for this project actually needs
 *   throughput  echo RTT for a large payload under a bandwidth cap, which tests
 *               the other half of emulateNetworkConditions
 *   cpu         frame RTT under Emulation.setCPUThrottlingRate, as a control:
 *               it should NOT move the wire RTT much, because it slows the
 *               renderer rather than the network
 *
 * Usage:  node testing/devtools/ws_latency_probe.mjs [--headed] [--latency=200]
 */

import puppeteer from 'puppeteer';
import { WebSocketServer } from 'ws';

let HEADLESS = true;
let LATENCY_MS = 200;
let CPU_RATE = 6;
let PINGS = 25;
for (const a of process.argv.slice(2)) {
  if (a === '--headed') HEADLESS = false;
  else if (a.startsWith('--latency=')) LATENCY_MS = Number(a.slice(10));
  else if (a.startsWith('--cpu=')) CPU_RATE = Number(a.slice(6));
  else if (a.startsWith('--pings=')) PINGS = Number(a.slice(8));
  else { console.error(`Unknown flag: ${a}`); process.exit(2); }
}

const median = (xs) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Echo server: replies to every frame immediately, so RTT is pure transport. */
function startEchoServer() {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    wss.on('connection', (ws) => {
      ws.on('message', (buf, isBinary) => ws.send(buf, { binary: isBinary }));
    });
    wss.on('listening', () => resolve({ wss, port: wss.address().port }));
  });
}

/**
 * In-page: open a socket, ping-pong `n` times, return per-ping RTTs plus the
 * handshake time. Payload size is configurable so the bandwidth cap can be
 * tested separately from the latency setting.
 */
async function measure(page, port, { n, bytes = 8 }) {
  return page.evaluate(async (port, n, bytes) => {
    const t0 = performance.now();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.binaryType = 'arraybuffer';
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('ws error'));
      setTimeout(() => rej(new Error('ws open timeout')), 20000);
    });
    const handshake = performance.now() - t0;

    const payload = new Uint8Array(bytes);
    const rtts = [];
    for (let i = 0; i < n; i++) {
      const s = performance.now();
      await new Promise((res) => {
        ws.onmessage = () => res();
        ws.send(payload);
      });
      rtts.push(performance.now() - s);
      // Space the pings so a queued burst can't be mistaken for low latency.
      await new Promise((r) => setTimeout(r, 20));
    }
    ws.close();
    return { handshake, rtts };
  }, port, n, bytes);
}

async function main() {
  const { wss, port } = await startEchoServer();
  console.log(`Top Draw — CDP network-emulation reality check`);
  console.log(`echo server: ws://127.0.0.1:${port}   latency setting: ${LATENCY_MS}ms   cpu rate: ${CPU_RATE}x\n`);

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const results = {};
  try {
    const page = await browser.newPage();
    // A real (if empty) page: WebSocket needs a secure-context-ish origin and
    // about:blank has bitten this kind of probe before.
    await page.setContent('<!doctype html><title>ws probe</title>');
    const cdp = await page.createCDPSession();
    await cdp.send('Network.enable');

    const clear = async () => {
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
      });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    };

    // 1. baseline
    await clear();
    const base = await measure(page, port, { n: PINGS });
    results.baseline = { handshake: base.handshake, rtt: median(base.rtts) };

    // 2. latency emulation
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: LATENCY_MS, downloadThroughput: -1, uploadThroughput: -1,
    });
    const lat = await measure(page, port, { n: PINGS });
    results.latency = { handshake: lat.handshake, rtt: median(lat.rtts) };
    await clear();

    // 3. bandwidth cap, with a payload big enough for a 100 KB/s cap to bite
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 0, downloadThroughput: 100 * 1024, uploadThroughput: 100 * 1024,
    });
    const bw = await measure(page, port, { n: Math.min(PINGS, 10), bytes: 64 * 1024 });
    results.bandwidth = { handshake: bw.handshake, rtt: median(bw.rtts) };
    await clear();

    // 4. big payload WITHOUT the cap, so the bandwidth row has its own control
    const bwBase = await measure(page, port, { n: Math.min(PINGS, 10), bytes: 64 * 1024 });
    results.bandwidthBaseline = { handshake: bwBase.handshake, rtt: median(bwBase.rtts) };

    // 5. CPU throttling as a control on the same connection
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_RATE });
    const cpu = await measure(page, port, { n: PINGS });
    results.cpu = { handshake: cpu.handshake, rtt: median(cpu.rtts) };
    await clear();
  } finally {
    await browser.close();
    wss.close();
  }

  const row = (name, r) => `  ${name.padEnd(22)} handshake ${r.handshake.toFixed(1).padStart(8)}ms   frame RTT ${r.rtt.toFixed(2).padStart(8)}ms`;
  console.log(row('baseline', results.baseline));
  console.log(row(`latency ${LATENCY_MS}ms`, results.latency));
  console.log(row('64KB baseline', results.bandwidthBaseline));
  console.log(row('64KB @ 100KB/s cap', results.bandwidth));
  console.log(row(`cpu throttle ${CPU_RATE}x`, results.cpu));
  console.log('');

  // A round trip crosses the emulated link twice, so a working latency setting
  // should add ~2x. Accept anything above half of one crossing as "it does
  // something"; below that it is noise.
  const rttDelta = results.latency.rtt - results.baseline.rtt;
  const hsDelta = results.latency.handshake - results.baseline.handshake;
  const framesThrottled = rttDelta > LATENCY_MS * 0.5;
  const handshakeThrottled = hsDelta > LATENCY_MS * 0.5;
  const bwDelta = results.bandwidth.rtt - results.bandwidthBaseline.rtt;
  const bandwidthThrottled = bwDelta > 50;
  const cpuMovesWire = results.cpu.rtt - results.baseline.rtt > LATENCY_MS * 0.5;

  console.log(`  frame RTT   ${rttDelta >= 0 ? '+' : ''}${rttDelta.toFixed(1)}ms  → WebSocket frames ${framesThrottled ? 'ARE' : 'are NOT'} latency-throttled`);
  console.log(`  handshake   ${hsDelta >= 0 ? '+' : ''}${hsDelta.toFixed(1)}ms  → the HTTP upgrade ${handshakeThrottled ? 'IS' : 'is NOT'} latency-throttled`);
  console.log(`  64KB RTT    ${bwDelta >= 0 ? '+' : ''}${bwDelta.toFixed(1)}ms  → frames ${bandwidthThrottled ? 'ARE' : 'are NOT'} bandwidth-capped`);
  console.log(`  cpu ${CPU_RATE}x RTT ${(results.cpu.rtt - results.baseline.rtt).toFixed(1)}ms  → cpu throttling ${cpuMovesWire ? 'also moves' : 'leaves'} the wire RTT ${cpuMovesWire ? '' : 'alone (expected)'}`);
  console.log('');

  // The two halves of emulateNetworkConditions answer differently, so a single
  // yes/no verdict would be wrong whichever way it fell.
  console.log(`VERDICT: latency=${framesThrottled ? 'YES' : 'NO'}  bandwidth=${bandwidthThrottled ? 'YES' : 'NO'} (on established WS frames)`);
  if (!framesThrottled && handshakeThrottled) {
    console.log('         The `latency` setting moves the HTTP upgrade ONLY. Once the socket is');
    console.log('         upgraded, frames bypass it entirely — a harness built on `latency`');
    console.log('         would report a configured lag and apply none.');
  }
  if (bandwidthThrottled) {
    console.log('         The throughput cap DOES apply to frames, so it is the usable network');
    console.log('         lever. Note what it does and does not do for the bake-defer question:');
    console.log('         it makes a client trail the stream, but delivery stays rate-limited, so');
    console.log('         messages are not waiting in _messageQueue and getInboundQueueLength()');
    console.log('         stays near 0 — the deferral cannot see this kind of lag at all.');
    console.log('         Use CPU throttling to grow the queue (the drain is time-budgeted, so');
    console.log('         slower work per message backs it up); use the cap to make clients');
    console.log('         trail each other. They test different halves of the theory.');
  }
  console.log(JSON.stringify(results));
}

main().catch((e) => { console.error(e); process.exit(1); });
