import ws from 'k6/ws';
import { check } from 'k6';

export const options = {
  stages: [
    { duration: '5s', target: 40 }, 
    { duration: '20s', target: 40 }, 
    { duration: '5s', target: 0 },
  ],
};

export default function () {
  // Use environment variable or fallback to localhost
  const url = __ENV.TARGET_URL || 'ws://127.0.0.1:8000';

  const res = ws.connect(url, {}, function (socket) {
    socket.on('open', function () {
    
      
      const joinPacket = new Uint8Array([0x08, 0x00, 0x10, __VU]);
      socket.sendBinary(joinPacket.buffer);

      
      socket.setTimeout(() => {
        socket.setInterval(() => {
          // T.MM (10), u (user id), ps (points)
          const mm = new Uint8Array([0x08, 0x0A, 0x10, __VU, 0x1A, 0x08, 0x00, 0x00, 0x28, 0x41, 0x00, 0x00, 0xA4, 0x41]);
          socket.sendBinary(mm.buffer);
        }, 32); // 30fps
      }, 500);
    });

    
    socket.on('message', function (data) {
    });
  });

  check(res, { 'Connected': (r) => r && r.status === 101 });
}