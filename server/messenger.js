const WebSocket = require('ws');
const { MongoClient } = require('mongodb');
const http = require('http');

const PORT = process.env.PORT || 3001;
const MONGODB_URI = process.env.MONGODB_URI; // MongoDB Atlas connection string
const DB_NAME = 'ddraw_messenger';

let db;
const clients = new Map(); // userId -> WebSocket connection

async function initDB() {
  if (!MONGODB_URI) {
    console.error('MONGODB_URI is not defined in environment variables');
    process.exit(1);
  }
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  console.log('Connected to MongoDB Atlas');
}

const server = http.createServer();
const wss = new WebSocket.Server({ server });

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const userId = url.searchParams.get('userId');

  if (!userId) {
    console.log('Connection rejected: No userId provided');
    ws.close();
    return;
  }

  clients.set(userId, ws);
  console.log(`User ${userId} connected`);

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data);
      const { type, payload } = message;

      if (type === 'init_chat') {
        // Fetch last 50 messages for room_id
        const { roomId } = payload;
        const history = await db.collection('messages')
          .find({ room_id: roomId })
          .sort({ timestamp: -1 })
          .limit(50)
          .toArray();
        
        ws.send(JSON.stringify({ type: 'history', payload: history.reverse() }));
      } else if (type === 'get_inbox') {
        const { userId } = payload;
        // Aggregation to find the latest message for each room the user is in
        const inbox = await db.collection('messages').aggregate([
          { $match: { $or: [{ sender_id: userId }, { receiver_id: userId }] } },
          { $sort: { timestamp: -1 } },
          { $group: {
              _id: "$room_id",
              latestMessage: { $first: "$$ROOT" }
          }},
          { $sort: { "latestMessage.timestamp": -1 } }
        ]).toArray();

        ws.send(JSON.stringify({ type: 'inbox', payload: inbox.map(i => i.latestMessage) }));
      } else if (type === 'send_message') {
        const { room_id, sender_id, receiver_id, encrypted_content, iv } = payload;
        const msgDoc = {
          room_id,
          sender_id,
          receiver_id,
          encrypted_content,
          iv,
          timestamp: Date.now()
        };

        // Save to Atlas
        await db.collection('messages').insertOne(msgDoc);

        // Emit to receiver if online
        if (clients.has(receiver_id)) {
          clients.get(receiver_id).send(JSON.stringify({ type: 'new_message', payload: msgDoc }));
        }
        
        // Echo to sender for confirmation
        ws.send(JSON.stringify({ type: 'new_message', payload: msgDoc }));
      }
    } catch (err) {
      console.error('Message error:', err);
    }
  });

  ws.on('close', () => {
    clients.delete(userId);
    console.log(`User ${userId} disconnected`);
  });
});

initDB().then(() => {
  server.listen(PORT, () => {
    console.log(`Messenger server running on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
