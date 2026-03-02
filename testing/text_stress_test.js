import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const broadcastLatency = new Trend('broadcast_latency_text');

export const options = {
  vus: 8,
  duration: '30s',
};

function encodeVarint(value) {
  let bytes = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7F) | 0x80);
    value = Math.floor(value / 128);
  }
  bytes.push(value);
  return bytes;
}

function buildMsg(fields) {
  let parts = [];
  if (fields.t !== undefined) parts.push(new Uint8Array([0x08, ...encodeVarint(fields.t)]));
  if (fields.u !== undefined) parts.push(new Uint8Array([0x10, ...encodeVarint(fields.u)]));
  if (fields.ps !== undefined) {
    const floatSize = 4;
    const psLength = fields.ps.length * floatSize;
    parts.push(new Uint8Array([0x1A, ...encodeVarint(psLength)]));
    const psData = new ArrayBuffer(psLength);
    const view = new DataView(psData);
    for (let i = 0; i < fields.ps.length; i++) {
      view.setFloat32(i * floatSize, fields.ps[i], true);
    }
    parts.push(new Uint8Array(psData));
  }
  if (fields.s !== undefined) parts.push(new Uint8Array([0x28, ...encodeVarint(fields.s)]));
  if (fields.l !== undefined) parts.push(new Uint8Array([0x30, ...encodeVarint(fields.l)]));
  if (fields.c !== undefined) {
    const b = new ArrayBuffer(4);
    new DataView(b).setUint32(0, fields.c, true);
    parts.push(new Uint8Array([0x3D, ...new Uint8Array(b)]));
  }
  if (fields.k !== undefined) {
    const kBytes = new Uint8Array(Array.from(fields.k).map(c => c.charCodeAt(0)));
    parts.push(new Uint8Array([0x52, ...encodeVarint(kBytes.length)]));
    parts.push(kBytes);
  }
  if (fields.n !== undefined) {
    const nameBytes = new Uint8Array(Array.from(fields.n).map(c => c.charCodeAt(0)));
    parts.push(new Uint8Array([0x5A, ...encodeVarint(nameBytes.length)]));
    parts.push(nameBytes);
  }
  if (fields.g !== undefined) {
    const gBytes = new Uint8Array(Array.from(fields.g).map(c => c.charCodeAt(0)));
    parts.push(new Uint8Array([0x62, ...encodeVarint(gBytes.length)]));
    parts.push(gBytes);
  }
  if (fields.hd !== undefined) parts.push(new Uint8Array([0xE0, 0x01, ...encodeVarint(fields.hd)]));
  if (fields.stroke_ts !== undefined) {
    parts.push(new Uint8Array([0xF0, 0x02, ...encodeVarint(fields.stroke_ts)]));
  }

  let totalLength = parts.reduce((acc, p) => acc + p.length, 0);
  let result = new Uint8Array(totalLength);
  let offset = 0;
  for (let p of parts) {
    result.set(p, offset);
    offset += p.length;
  }
  return result.buffer;
}

const T = { CONNECT: 0, MM: 10, MD: 11, MU: 12, CT: 15, KP: 19, MSG: 22, SHOW_CURSOR: 28 };
const Tool = { BRUSH: 0, TEXT: 1 };

export default function () {
  sleep(Math.random() * 2);

  const url = __ENV.TARGET_URL || 'ws://127.0.0.1:8000';
  let sessionIndex = -1;

  const res = ws.connect(url, {}, function (socket) {
    socket.on('open', function () {
      socket.sendBinary(buildMsg({ t: T.CONNECT, n: `TEXT_VU_${__VU}` }));
      
      const margin = 100;
      let x = Math.random() * (1920 - 2 * margin) + margin;
      let y = Math.random() * (1080 - 2 * margin) + margin;
      let dx = (Math.random() - 0.5) * 10;
      let dy = (Math.random() - 0.5) * 10;
      
      let state = 0; // 0: Idle/Move, 1: Select Tool, 2: Start Text, 3: Typing, 4: End Text, 5: Paste
      let typeBuffer = "";
      const sentences = [
        "The quick brown fox jumps over the lazy dog.",
        "Testing the text tool in k6 stress test.",
        "Pasting a long message to see how it performs.",
        "Gemini CLI is helping me write these tests.",
        "WebSockets and Protobuf are efficient!"
      ];

      socket.setInterval(function() {
        if (sessionIndex === -1) return;

        // Momentum-based movement logic
        dx += (Math.random() - 0.5) * 4;
        dy += (Math.random() - 0.5) * 4;
        dx = Math.max(-15, Math.min(15, dx));
        dy = Math.max(-15, Math.min(15, dy));
        x += dx; y += dy;

        if (x < margin) { x = margin; dx *= -1; }
        if (x > 1920 - margin) { x = 1920 - margin; dx *= -1; }
        if (y < margin) { y = margin; dy *= -1; }
        if (y > 1080 - margin) { y = 1080 - margin; dy *= -1; }

        if (state === 0) {
          // Idle movement
          socket.sendBinary(buildMsg({ t: T.MM, u: sessionIndex, ps: [x, y] }));
          socket.sendBinary(buildMsg({ t: T.SHOW_CURSOR, u: sessionIndex }));
          if (Math.random() < 0.05) state = 1;
        } 
        else if (state === 1) {
          socket.sendBinary(buildMsg({ t: T.CT, u: sessionIndex, l: Tool.TEXT }));
          state = 2;
        }
        else if (state === 2) {
          socket.sendBinary(buildMsg({ t: T.MD, u: sessionIndex, ps: [x, y] }));
          typeBuffer = sentences[Math.floor(Math.random() * sentences.length)];
          state = 3;
        }
        else if (state === 3) {
          // Send MM even during typing so cursor is visible
          socket.sendBinary(buildMsg({ t: T.MM, u: sessionIndex, ps: [x, y] }));
          if (typeBuffer.length > 0) {
            const char = typeBuffer[0];
            typeBuffer = typeBuffer.substring(1);
            socket.sendBinary(buildMsg({ t: T.KP, u: sessionIndex, k: char, stroke_ts: Date.now() }));
          } else {
            state = 4;
          }
        }
        else if (state === 4) {
          socket.sendBinary(buildMsg({ t: T.MU, u: sessionIndex }));
          state = Math.random() < 0.2 ? 5 : 0;
        }
        else if (state === 5) {
          socket.sendBinary(buildMsg({ t: T.MM, u: sessionIndex, ps: [x, y] }));
          const pasteStr = "PASTED_TEXT: " + sentences[Math.floor(Math.random() * sentences.length)];
          socket.sendBinary(buildMsg({ t: T.KP, u: sessionIndex, k: pasteStr, stroke_ts: Date.now() }));
          socket.sendBinary(buildMsg({ t: T.MSG, u: sessionIndex, g: pasteStr }));
          state = 0;
        }

      }, 60); 
    });

    socket.on('binaryMessage', function (data) {
      const view = new Uint8Array(data);
      let t = -1; let u = -1; let ts = -1;
      let offset = 0;
      while(offset < view.length) {
        let tag = 0; let shift = 0;
        while(true) {
          if (offset >= view.length) break;
          let b = view[offset++];
          tag += (b & 0x7F) * Math.pow(2, shift);
          if (!(b & 0x80)) break;
          shift += 7;
        }
        let fieldNum = tag >> 3;
        let wireType = tag & 0x07;
        
        if (fieldNum === 1) {
          let val = 0; let s = 0;
          while(true) { let b = view[offset++]; val += (b & 0x7F) * Math.pow(2, s); if (!(b & 0x80)) break; s += 7; }
          t = val;
        } else if (fieldNum === 2) {
          let val = 0; let s = 0;
          while(true) { let b = view[offset++]; val += (b & 0x7F) * Math.pow(2, s); if (!(b & 0x80)) break; s += 7; }
          u = val;
        } else if (fieldNum === 46) {
          let val = 0; let s = 0;
          while(true) { let b = view[offset++]; val += (b & 0x7F) * Math.pow(2, s); if (!(b & 0x80)) break; s += 7; }
          ts = val;
        } else {
          if (wireType === 0) { while(view[offset++] & 0x80); }
          else if (wireType === 1) { offset += 8; }
          else if (wireType === 2) { 
            let len = 0; let s = 0;
            while(true) { let b = view[offset++]; len += (b & 0x7F) * Math.pow(2, s); if (!(b & 0x80)) break; s += 7; }
            offset += len; 
          }
          else if (wireType === 5) { offset += 4; }
        }
      }
      if (t === 0 && u !== -1 && sessionIndex === -1) sessionIndex = u;
      if (ts !== -1 && u !== sessionIndex) broadcastLatency.add(Date.now() - ts);
    });

    socket.on('error', (e) => console.log('WebSocket Error: ', e.error()));
    // Close before test duration ends to ensure proper cleanup
    socket.setTimeout(() => socket.close(), 25000);
  });

  check(res, { 'Connected': (r) => r && r.status === 101 });
}
