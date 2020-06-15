// HTTP Server:
const express = require('express');
const app = express();

// This will serve the static files in the /public folder on our server
app.use(express.static('public'));



// Long polling endpoint:

// Because using a long polling strategy we can't actively
// send data to clients, we need to store the player data on the server:

var players = [];

app.get("/poll", (req, res) => {
  
  
  
  
  
  
})







const server = app.listen(process.env.PORT, function() {
  console.log('Your app is listening on port ' + server.address().port);
});



// Websocket Server:
// We are using the external library 'ws' to set up the websockets on the server
// https://www.npmjs.com/package/ws
// In our code this is stored in the variable WebSocket.
var WebSocket = require('ws');

// Connect our Websocket server to our server variable to serve requests on the same port:
var wsServer = new WebSocket.Server({ server });

// This function will send a message to all clients connected to the websocket:
function broadcast(data) {
  wsServer.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
};

// This outer function will run each time the Websocket
// server connects to a new client:
wsServer.on('connection', function connection(ws) {
  
  // This function will run every time the server recieves a message with that client.
  ws.on('message', function incoming(data) {
    // Broadcast the received message back to all clients.
    console.log("Message Received:");
    console.log(data);
    broadcast(data);
  });
  
});