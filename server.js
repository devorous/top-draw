// HTTP Server:
const express = require('express');
const app = express();

// This will serve the static files in the /public folder on our server
app.use(express.static('public'));

const server = app.listen(process.env.PORT, function() {
  console.log('Your app is listening on port ' + server.address().port);
});



// Websocket Server:
var WebSocket= require('ws');
var wsServer = new WebSocket.Server({ server });

// This function will send a message to all clients connected to the websocket:
wsServer.broadcast = function broadcast(data) {
  
  wsServer.clients.forEach(function (client) {
    
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
    
  });
};

wsServer.on('connection', function connection(ws) {
  ws.on('message', function incoming(data) { //U: Broadcast to everyone else.
    console.log("LLEGO ...", data);
    wsServer.broadcast(data);
  });
});
