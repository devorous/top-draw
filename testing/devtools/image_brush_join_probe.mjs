#!/usr/bin/env node
/**
 * Wire-level probe for "a joiner rebuilds every image-brush stroke with the
 * drawer's CURRENT brush".
 *
 * No browser: bot A draws two strokes with brush A and two with brush B through
 * a raw socket, bot B then joins and every inbound frame it receives is decoded
 * and printed in order. If the join tail is right, B sees brushA before A's
 * strokes and brushB before B's strokes — if it is wrong, the brush frames are
 * missing or bunched at one end.
 *
 * Runs its own server on a spare port so it cannot disturb a dev session.
 *
 *   node testing/devtools/image_brush_join_probe.mjs
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';
import protobuf from 'protobufjs';
import { T } from '../../shared/MessageTypes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const PORT = Number(process.env.PROBE_PORT || 8137);
const ROOM = `brushprobe_${Date.now()}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const NAME_BY_T = Object.fromEntries(Object.entries(T).map(([k, v]) => [v, k]));

/** A brush payload shaped like the client's _buildImageBrushPayload output. */
function brushPayload(name, pixel) {
  return JSON.stringify({
    type: 'image',
    brushName: name,
    fileName: `${name}.png`,
    width: 1,
    height: 1,
    colorMode: 'original',
    // 1x1 PNG; the byte differs per brush so the frames are distinguishable.
    gimpUrl: `data:image/png;base64,${pixel}`,
  });
}

const BRUSHES = {
  A: brushPayload('BRUSH_A', 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  B: brushPayload('BRUSH_B', 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='),
};

async function main() {
  const root = await protobuf.load(path.join(ROOT, 'public', 'messages.proto'));
  const Msg = root.lookupType('Msg');
  const encode = (obj) => Msg.encode(Msg.create(obj)).finish();
  const decode = (buf) => Msg.decode(new Uint8Array(buf));

  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog = [];
  server.stdout.on('data', d => serverLog.push(String(d)));
  server.stderr.on('data', d => serverLog.push(String(d)));

  const url = `ws://127.0.0.1:${PORT}/?room=${ROOM}`;
  const openSocket = async (label) => {
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const ws = new WebSocket(url);
        await new Promise((res, rej) => {
          ws.once('open', res);
          ws.once('error', rej);
        });
        return ws;
      } catch {
        await sleep(250);
      }
    }
    throw new Error(`${label}: server never accepted a connection on ${PORT}`);
  };

  let failed = false;
  try {
    // ── Drawer ────────────────────────────────────────────────────────────
    const a = await openSocket('drawer');
    const sendA = (m) => a.send(encode(m));
    sendA({ t: T.CONNECT, n: 'DRAWER' });
    await sleep(500);
    sendA({ t: T.SYNC_REQUEST });
    await sleep(500);

    sendA({ t: T.CT, l: 3 }); // Tool.IMAGE_BRUSH
    sendA({ t: T.CS, s: 3000 });
    sendA({ t: T.CC, c: 0xff0000ff });

    const stroke = (x) => {
      sendA({ t: T.MD, ps: [x * 10, 1000] });
      sendA({ t: T.MM, ps: [(x + 20) * 10, 1200] });
      sendA({ t: T.MU });
    };

    sendA({ t: T.GMP, g: BRUSHES.A });
    await sleep(150);
    stroke(20); await sleep(120);
    stroke(60); await sleep(120);

    sendA({ t: T.GMP, g: BRUSHES.B });
    await sleep(150);
    stroke(100); await sleep(120);
    stroke(140); await sleep(300);

    // ── Joiner ────────────────────────────────────────────────────────────
    const b = await openSocket('joiner');
    const inbound = [];
    b.on('message', (buf) => {
      // Frames may be concatenated by the server's outbox batching.
      let offset = 0;
      const bytes = new Uint8Array(buf);
      while (offset < bytes.length) {
        const reader = protobuf.Reader.create(bytes.subarray(offset));
        let msg;
        try {
          msg = Msg.decode(reader);
        } catch {
          break;
        }
        offset += reader.pos;
        let label = NAME_BY_T[msg.t] || `T${msg.t}`;
        if (msg.t === T.GMP || msg.t === T.GPT || msg.t === T.IMAGE_TOOL) {
          const raw = msg.g || msg.imageToolData || '';
          const m = /"brushName":"([^"]+)"/.exec(raw);
          label += `(${m ? m[1] : `${raw.length}b`})`;
        }
        inbound.push(label);
        if (reader.pos === 0) break;
      }
    });
    b.send(encode({ t: T.CONNECT, n: 'JOINER' }));
    await sleep(600);
    b.send(encode({ t: T.SYNC_REQUEST }));
    await sleep(2500);

    // ── Report ────────────────────────────────────────────────────────────
    const interesting = inbound.filter(l => /^(GMP|MD|MM|MU|CT|SYNC_METADATA|SYNC_COMPLETE|BOARD_SNAPSHOT_RESTORE)/.test(l));
    console.log('');
    console.log('Joiner inbound (drawing-relevant frames, in order):');
    console.log('  ' + interesting.join(' -> '));

    // Everything before SYNC_METADATA is connect-time state (the drawer's
    // CURRENT brush, from sendImageToolStateToClient). The TAIL is what this
    // probe is about, so the skeleton starts after it.
    const metaAt = interesting.indexOf('SYNC_METADATA');
    const tail = metaAt >= 0 ? interesting.slice(metaAt + 1) : interesting;
    const order = tail.filter(l => l.startsWith('GMP') || l === 'MD');
    console.log('');
    console.log('Tail brush/stroke skeleton:');
    console.log('  ' + order.join(' -> '));

    const brushA = tail.filter(l => l.includes('BRUSH_A')).length;
    const brushB = tail.filter(l => l.includes('BRUSH_B')).length;
    const mds = tail.filter(l => l === 'MD').length;
    console.log('');
    console.log(`tail brushA frames=${brushA} brushB frames=${brushB} MD=${mds}`);

    const expected = ['GMP(BRUSH_A)', 'MD', 'MD', 'GMP(BRUSH_B)', 'MD', 'MD'];
    const problems = [];
    if (mds !== 4) problems.push(`expected 4 replayed strokes, saw ${mds}`);
    if (brushA < 1) problems.push('brush A was never replayed - its strokes rebuild with the current brush');
    if (brushB < 1) problems.push('brush B was never replayed');
    if (brushA > 1 || brushB > 1) problems.push('a brush was re-sent per stroke instead of once per run');
    if (order.join(',') !== expected.join(',')) {
      problems.push(`skeleton is [${order.join(', ')}], expected [${expected.join(', ')}]`);
    }
    if (problems.length) {
      failed = true;
      console.log('\nFAIL:');
      for (const p of problems) console.log('  - ' + p);
    } else {
      console.log('\nPASS: each brush precedes exactly the strokes drawn with it.');
    }

    a.close();
    b.close();
  } finally {
    server.kill();
    if (failed || process.env.SHOW_SERVER_LOG) {
      console.log('\n--- server log ---');
      console.log(serverLog.join('').split('\n').filter(l => /Sync|Brush|Error/i.test(l)).join('\n'));
    }
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
