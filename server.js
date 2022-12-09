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

//keep track of the current users
var current_users = []; 

// This function will send a message to all clients connected to the websocket:
function broadcast(data) {
  
  wsServer.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && data.id != client.id) {
      client.send(JSON.stringify(data));
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
    data = JSON.parse(data);
    
    switch(data.command){
        
      case 'connect':
        console.log("Message Received: ", data);
        ws.id = data.id;
        console.log("from connection Id:", ws.id);
        
        var user = data;
        delete user.command
        current_users.push(user);
        broadcast({command:"currentUsers",users:current_users});
        console.log("current users: "+current_users.length+" "+JSON.stringify(current_users));
        
        //save user to list of current users in room
        //when somebody joins, send them this list..
        break
      case 'broadcast':
        broadcast(data);
        break
        
    }

    
  });

  ws.on("close", () => {
    console.log("Disconnected:", ws.id);
    broadcast({command:"userLeft",id:ws.id});
    current_users = current_users.filter(userdata =>{
      return userdata.id != ws.id;
    });
    console.log("current users: "+current_users);
    
    
  });
});
