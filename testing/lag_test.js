import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const broadcastLatency = new Trend('broadcast_latency');

export const options = {
  vus: 20,
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
  if (fields.s !== undefined) parts.push(new Uint8Array([0x28, ...encodeVarint(fields.s)])); // s = 5 (5 << 3 | 0 = 40 -> 0x28)
  if (fields.l !== undefined) parts.push(new Uint8Array([0x30, ...encodeVarint(fields.l)]));
  if (fields.n !== undefined) {
    const nameBytes = new Uint8Array(Array.from(fields.n).map(c => c.charCodeAt(0)));
    parts.push(new Uint8Array([0x5A, ...encodeVarint(nameBytes.length)]));
    parts.push(nameBytes);
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

const T = { CONNECT: 0, MM: 10, MD: 11, MU: 12, CS: 14, CT: 15, CHD: 45 };
const Tool = { BRUSH: 0, ERASE: 2 };

export default function () {
  const url = 'ws://127.0.0.1:8000';
  let sessionIndex = -1;

  const res = ws.connect(url, {}, function (socket) {
    socket.on('open', function () {
      socket.sendBinary(buildMsg({ t: T.CONNECT, n: `VU_${__VU}` }));
      
      let x = Math.random() * 1920;
      let y = Math.random() * 1080;

      socket.setInterval(function () {
        if (sessionIndex === -1) return;

        const tool = Math.random() > 0.2 ? Tool.BRUSH : Tool.ERASE;
        socket.sendBinary(buildMsg({ t: T.CT, u: sessionIndex, l: tool }));

        // Randomize size (100 to 5000 -> 1px to 50px)
        const size = Math.floor(Math.random() * 4900) + 100;
        socket.sendBinary(buildMsg({ t: T.CS, u: sessionIndex, s: size }));

        if (tool === Tool.BRUSH) {
          // Varied hardness: 70% chance of low (0-20%), 30% chance of any (0-100%)
          const hardness = Math.random() < 0.7 
            ? Math.floor(Math.random() * 2000) 
            : Math.floor(Math.random() * 10000);
          socket.sendBinary(buildMsg({ t: T.CHD, u: sessionIndex, hd: hardness }));
        }

        socket.sendBinary(buildMsg({ t: T.MD, u: sessionIndex }));

        for (let i = 0; i < 10; i++) {
          let points = [];
          for(let j=0; j<3; j++) { // Batch 3 points per MM
            x += (Math.random() - 0.5) * 10;
            y += (Math.random() - 0.5) * 10;
            points.push(x, y);
          }
          // Include timestamp in MM to measure broadcast lag (if we receive it back)
          // Note: Server currently excludes sender from broadcast, so we'll see OTHERS' lag
          socket.sendBinary(buildMsg({ t: T.MM, u: sessionIndex, ps: points, stroke_ts: Date.now() }));
          sleep(0.05);
        }

        socket.sendBinary(buildMsg({ t: T.MU, u: sessionIndex }));
        sleep(Math.random() * 1 + 0.5);
      }, 500);
    });

    socket.on('binaryMessage', function (data) {
      const view = new Uint8Array(data);
      
      let t = -1;
      let u = -1;
      let ts = -1;
      
      let offset = 0;
      while(offset < view.length) {
        // Decode Tag as Varint
        let tag = 0;
        let shift = 0;
        while(true) {
          let b = view[offset++];
          tag += (b & 0x7F) * Math.pow(2, shift);
          if (!(b & 0x80)) break;
          shift += 7;
        }
        let fieldNum = tag >> 3;
        let wireType = tag & 0x07;
        
        if (fieldNum === 1) { // t
          let val = 0;
          let s = 0;
          while(true) {
            let b = view[offset++];
            val += (b & 0x7F) * Math.pow(2, s);
            if (!(b & 0x80)) break;
            s += 7;
          }
          t = val;
        } else if (fieldNum === 2) { // u
          let val = 0;
          let s = 0;
          while(true) {
            let b = view[offset++];
            val += (b & 0x7F) * Math.pow(2, s);
            if (!(b & 0x80)) break;
            s += 7;
          }
          u = val;
        } else if (fieldNum === 46) { // stroke_ts
          let val = 0;
          let s = 0;
          while(true) {
            let b = view[offset++];
            val += (b & 0x7F) * Math.pow(2, s);
            if (!(b & 0x80)) break;
            s += 7;
          }
          ts = val;
        } else {
          // Skip other fields
          if (wireType === 0) { while(view[offset++] & 0x80); }
          else if (wireType === 1) { offset += 8; }
          else if (wireType === 2) { 
            let len = 0;
            let s = 0;
            while(true) {
              let b = view[offset++];
              len += (b & 0x7F) * Math.pow(2, s);
              if (!(b & 0x80)) break;
              s += 7;
            }
            offset += len; 
          }
          else if (wireType === 5) { offset += 4; }
        }
      }

      if (t === T.CONNECT && u !== -1 && sessionIndex === -1) {
          sessionIndex = u;
      }

      if (ts !== -1 && u !== sessionIndex) {
        broadcastLatency.add(Date.now() - ts);
      }
    });

    socket.on('error', (e) => console.log('WebSocket Error: ', e.error()));
    socket.setTimeout(() => socket.close(), 60000);
  });

  check(res, { 'Connected': (r) => r && r.status === 101 });
}
