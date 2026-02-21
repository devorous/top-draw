import ws from 'k6/ws';
import { check } from 'k6';

export const options = {
  vus: 20,
  duration: '30s',
};

/**
 * Builds a valid Protobuf Msg for type MM (Mouse Move)
 * @param {number} userId - The user session index
 * @param {number} pointCount - How many floats to send in 'ps'
 */
function buildDrawingBuffer(userId, pointCount) {
  const floatSize = 4;
  const psLength = pointCount * floatSize;
  
  const headerSize = 6; 
  const buf = new ArrayBuffer(headerSize + psLength);
  const view = new DataView(buf);
  const uint8 = new Uint8Array(buf);

  // Field 1: t = 10 (MM)
  uint8[0] = 0x08;
  uint8[1] = 0x0A; // T.MM is 10 [cite: 3]

  // Field 2: u = userId
  uint8[2] = 0x10;
  uint8[3] = userId; // 

  // Field 3: ps (repeated float)
  uint8[4] = 0x1A; // Tag 3, wire type 2 
  uint8[5] = psLength; // The EXACT length byte

  // Fill ps with dummy coordinates (100.0, 200.0, etc.)
  for (let i = 0; i < pointCount; i++) {
    view.setFloat32(headerSize + (i * floatSize), 100.0 + i, true); // Little-endian
  }

  return buf;
}

export default function () {
  const url = 'ws://127.0.0.1:8000';

  const res = ws.connect(url, {}, function (socket) {
    socket.on('open', function () {
      const joinPacket = new Uint8Array([0x08, 0x00, 0x10, __VU]);
      socket.sendBinary(joinPacket.buffer);
      socket.setInterval(function () {
        
        const sizes = [4, 10, 30];
        const randomSize = sizes[Math.floor(Math.random() * sizes.length)];
        
        const buffer = buildDrawingBuffer(1, randomSize);
        socket.sendBinary(buffer);
      }, 100);
    });

    socket.on('error', (e) => console.log('WebSocket Error: ', e.error()));

    socket.setTimeout(() => socket.close(), 10000);
  });

  check(res, { 'Connected': (r) => r && r.status === 101 });
}