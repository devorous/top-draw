// HTTP Server:
const express = require("express");
const app = express();

// This will serve the static files in the /public folder on our server
app.use(express.static("public"));

const server = app.listen(process.env.PORT, function() {
  console.log("Your app is listening on port " + server.address().port);
});




// Websocket Server:
// We are using the external library 'ws' to set up the websockets on the server
// https://www.npmjs.com/package/ws
// In our code this is stored in the variable WebSocket.
var WebSocket = require("ws");

// Connect our Websocket server to our server variable to serve requests on the same port:
var wsServer = new WebSocket.Server({ server });

// This function will send a message to all clients connected to the websocket:
function broadcast(data) {
  wsServer.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

// This outer function will run each time the Websocket
// server connects to a new client:
wsServer.on("connection", ws => {
  // We will store the id for this connection in the id property.
  ws.id = "";

  // This function will run every time the server recieves a message with that client.
  ws.on("message", data => {
    // Broadcast the received message back to all clients.
    console.log("Message Received:");
    console.log(data);
    ws.id = JSON.parse(data).color;
    console.log("from connection Id:", ws.id);
    broadcast(data);
  });

  ws.on("close", () => {
    console.log("Disconnected:", ws.id);
    // Here you could send a message to other clients that
    // this client has disconnected.
  });
});
