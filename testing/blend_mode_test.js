import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const broadcastLatency = new Trend('broadcast_latency_blend');

export const options = {
  vus: 8,
  duration: '1m',
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
  if (fields.n !== undefined) {
    const nameBytes = new Uint8Array(Array.from(fields.n).map(c => c.charCodeAt(0)));
    parts.push(new Uint8Array([0x5A, ...encodeVarint(nameBytes.length)]));
    parts.push(nameBytes);
  }
  if (fields.bm !== undefined) {
    const bmBytes = new Uint8Array(Array.from(fields.bm).map(c => c.charCodeAt(0)));
    parts.push(new Uint8Array([0xEA, 0x02, ...encodeVarint(bmBytes.length)])); // bm = 45 (45 << 3 | 2 = 362 -> 0xEA 0x02)
    parts.push(bmBytes);
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

const T = { CONNECT: 0, MM: 10, MD: 11, MU: 12, CS: 14, CT: 15, CC: 16, SHOW_CURSOR: 28, CHD: 45, CBM: 59 };
const Tool = { BRUSH: 0 };
const BlendModes = [
  'source-over', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 
  'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion'
];

export default function () {
  sleep(Math.random() * 2);

  const url = 'ws://127.0.0.1:8000';
  let sessionIndex = -1;

  const res = ws.connect(url, {}, function (socket) {
    socket.on('open', function () {
      socket.sendBinary(buildMsg({ t: T.CONNECT, n: `BLEND_VU_${__VU}` }));
      
      const margin = 50;
      let x = Math.random() * (1920 - 2 * margin) + margin;
      let y = Math.random() * (1080 - 2 * margin) + margin;
      let dx = (Math.random() - 0.5) * 8;
      let dy = (Math.random() - 0.5) * 8;
      
      let state = Math.floor(Math.random() * 70);
      let stateTicks = 0;
      let cycleLength = 60 + Math.floor(Math.random() * 20);
      let nextPropertyChange = Math.floor(Math.random() * 3) * cycleLength; 

      socket.setInterval(function() {
        if (sessionIndex === -1) return;

        if (state === 0) {
          socket.sendBinary(buildMsg({ t: T.MM, u: sessionIndex, ps: [x, y] }));
          socket.sendBinary(buildMsg({ t: T.SHOW_CURSOR, u: sessionIndex }));
          
          if (stateTicks >= nextPropertyChange) {
            const r = Math.floor(Math.random() * 256);
            const g = Math.floor(Math.random() * 256);
            const b = Math.floor(Math.random() * 256);
            const color = (r << 24) | (g << 16) | (b << 8) | 0xFF; 
            
            socket.sendBinary(buildMsg({ t: T.CC, u: sessionIndex, c: color }));
            // Low Hardness (0-10%)
            socket.sendBinary(buildMsg({ t: T.CHD, u: sessionIndex, hd: Math.floor(Math.random() * 1001) }));
            socket.sendBinary(buildMsg({ t: T.CS, u: sessionIndex, s: Math.floor(Math.random() * 2000) + 500 }));
            
            // Random Blend Mode
            const mode = BlendModes[Math.floor(Math.random() * BlendModes.length)];
            socket.sendBinary(buildMsg({ t: T.CBM, u: sessionIndex, bm: mode }));

            nextPropertyChange = stateTicks + (Math.floor(Math.random() * 3) + 2) * cycleLength;
          }
        } 
        else if (state === 1) {
          socket.sendBinary(buildMsg({ t: T.MD, u: sessionIndex }));
        }
        else if (state <= cycleLength - 5) {
          dx += (Math.random() - 0.5) * 4;
          dy += (Math.random() - 0.5) * 4;
          dx = Math.max(-12, Math.min(12, dx));
          dy = Math.max(-12, Math.min(12, dy));
          x += dx; y += dy;

          if (x < margin) { x = margin; dx *= -1; }
          if (x > 1920 - margin) { x = 1920 - margin; dx *= -1; }
          if (y < margin) { y = margin; dy *= -1; }
          if (y > 1080 - margin) { y = 1080 - margin; dy *= -1; }

          socket.sendBinary(buildMsg({ t: T.MM, u: sessionIndex, ps: [x, y], stroke_ts: Date.now() }));
        } 
        else if (state === cycleLength - 4) {
          socket.sendBinary(buildMsg({ t: T.MU, u: sessionIndex }));
        }

        state++;
        stateTicks++;
        if (state > cycleLength) {
           state = 0;
           cycleLength = 60 + Math.floor(Math.random() * 30);
        } 
      }, 12); 
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
    socket.setTimeout(() => socket.close(), 55000);
  });

  check(res, { 'Connected': (r) => r && r.status === 101 });
}
