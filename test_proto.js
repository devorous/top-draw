
const protobuf = require('protobufjs');

async function test() {
    const root = await protobuf.load('public/messages.proto');
    const Msg = root.lookupType('Msg');
    
    const payload = {
        t: 66, // ROOM_UPDATE
        roomBoardSize: '720p'
    };
    
    const message = Msg.create(payload);
    console.log('Message:', JSON.stringify(message));
    console.log('room_board_size:', message.room_board_size);
    console.log('roomBoardSize:', message.roomBoardSize);
    
    const buffer = Msg.encode(message).finish();
    const decoded = Msg.decode(buffer);
    console.log('Decoded:', JSON.stringify(decoded));
    console.log('Decoded roomBoardSize:', decoded.roomBoardSize);
}

test();
