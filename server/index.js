import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';

const PORT = process.env.WS_PORT || 3001;
const AFK_TIMEOUT = 2 * 60 * 1000; // 2 minutes in milliseconds
const AFK_CHECK_INTERVAL = 30 * 1000; // Check every 30 seconds

const server = createServer();
const wss = new WebSocketServer({ server });

const currentUsers = [];
const boardSettings = {
  mirror: false
};

function broadcast(data) {
  updateUser(data);
  wss.clients.forEach((client) => {
    if (data.id === client.id && data.command === 'connected') {
      client.send(JSON.stringify(data));
    }
    if (client.readyState === WebSocket.OPEN && data.id !== client.id) {
      client.send(JSON.stringify(data));
    }
  });
}

function broadcastToAll(data) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

function getUser(id) {
  return currentUsers.find((user) => user.id === id);
}

function updateUserActivity(userId) {
  const user = getUser(userId);
  if (user) {
    const wasAfk = user.afk;
    user.lastActivity = Date.now();
    user.afk = false;

    // If user was AFK and is now active, broadcast the change
    if (wasAfk) {
      broadcastToAll({
        command: 'broadcast',
        type: 'afkStatus',
        id: userId,
        afk: false
      });
    }
  }
}

function checkAfkUsers() {
  const now = Date.now();
  currentUsers.forEach((user) => {
    if (!user.afk && user.lastActivity && (now - user.lastActivity > AFK_TIMEOUT)) {
      user.afk = true;
      broadcastToAll({
        command: 'broadcast',
        type: 'afkStatus',
        id: user.id,
        afk: true
      });
      console.log(`User ${user.id} marked as AFK`);
    }
  });
}

// Start AFK check interval
setInterval(checkAfkUsers, AFK_CHECK_INTERVAL);

function updateUser(data) {
  const user = getUser(data.id);
  if (!user) return;

  const userdata = user.userdata;

  switch (data.type) {
    case 'Mm':
      userdata.x = data.x;
      userdata.y = data.y;
      userdata.lastx = data.lastx;
      userdata.lasty = data.lasty;
      // Update activity on mouse move
      updateUserActivity(data.id);
      break;
    case 'Md':
      userdata.mousedown = true;
      updateUserActivity(data.id);
      break;
    case 'Mu':
      userdata.mousedown = false;
      if (userdata.tool === 'text') {
        userdata.text = '';
      }
      break;
    case 'ChSi':
      userdata.size = data.size;
      break;
    case 'ChNa':
      userdata.username = data.name;
      updateUserActivity(data.id);
      break;
    case 'ChT':
      userdata.tool = data.tool;
      userdata.text = '';
      break;
    case 'ChC':
      userdata.color = data.color;
      break;
    case 'ChP':
      userdata.pressure = data.pressure;
      break;
    case 'kp':
      const key = data.key;
      if (key.length === 1) {
        userdata.text = userdata.text + key;
      }
      switch (key) {
        case 'Enter':
          userdata.text = '';
          break;
        case 'Backspace':
          if (userdata.text) {
            userdata.text = userdata.text.slice(0, -1);
          }
          break;
      }
      updateUserActivity(data.id);
      break;
    case 'mirror':
      boardSettings.mirror = !boardSettings.mirror;
      break;
    case 'chat':
      updateUserActivity(data.id);
      break;
  }
}

wss.on('connection', (ws, req) => {
  console.log('New connection from:', req.socket.remoteAddress);
  ws.id = '';

  ws.on('message', (rawData) => {
    const data = JSON.parse(rawData);

    switch (data.command) {
      case 'connect':
        ws.id = data.id;
        const user = { ...data };
        delete user.command;
        user.lastActivity = Date.now();
        user.afk = false;
        currentUsers.push(user);

        // Include AFK status in user list
        const usersWithAfk = currentUsers.map(u => ({
          ...u,
          afk: u.afk || false
        }));

        broadcast({ command: 'currentUsers', users: usersWithAfk });
        broadcast({ command: 'boardSettings', settings: boardSettings });
        broadcast({ command: 'connected', id: data.id });
        break;

      case 'broadcast':
        broadcast(data);
        break;
    }
  });

  ws.on('close', () => {
    console.log('Disconnected:', ws.id);
    broadcast({ command: 'userLeft', id: ws.id });

    const index = currentUsers.findIndex((user) => user.id === ws.id);
    if (index !== -1) {
      currentUsers.splice(index, 1);
    }

    console.log('Current users:', currentUsers.length);

    if (currentUsers.length === 0) {
      boardSettings.mirror = false;
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

server.listen(PORT, () => {
  console.log(`WebSocket server running on port ${PORT}`);
});
