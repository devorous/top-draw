// HTTP Server:
const express = require("express");
const app = express();


// This will serve the static files in the /public folder on our server
app.use(express.static("public"));

const server = app.listen(process.env.PORT, function () {
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
var currentUsers = [];
var boardSettings = {
  mirror: false,
}

// This function will send a message to all clients connected to the websocket:
function broadcast(data) {
  updateUser(data);
  wsServer.clients.forEach((client) => {
    if(data.id === client.id && data.command === "connected"){
      client.send(JSON.stringify(data));
    }
    if (client.readyState === WebSocket.OPEN && data.id != client.id) {
      //send broadcasts to all users except the sending user
      client.send(JSON.stringify(data));
    }
  });
}

// This outer function will run each time the Websocket
// server connects to a new client:
wsServer.on("connection", (ws,req) => {
  console.log(req.socket.remoteAddress);
  // We will store the id for this connection in the id property.
  ws.id = "";
  // This function will run every time the server recieves a message with that client.
  ws.on("message", (data) => {
    
    data = JSON.parse(data);

    switch (data.command) {
      case "connect":
        
        ws.id = data.id;
        var user = data;
        delete user.command;
        currentUsers.push(user);
        
        broadcast({ command: "currentUsers", users: currentUsers });
        broadcast({command: "boardSettings", settings: boardSettings});
        //save user to list of current users in room
        //when somebody joins, send them this list of users and board settings 
        
        broadcast({command: "connected",id: data.id})
        //tell the user they are connected so they can join


        break;
      case "broadcast":
        broadcast(data);
        // Broadcast the received message back to all clients.
        break;
    }
  });

  ws.on("close", () => {
    console.log("Disconnected: ", ws.id);
    broadcast({ command: "userLeft", id: ws.id });
    currentUsers = currentUsers.filter((userdata) => {
      return userdata.id != ws.id;
    });
    console.log("current users: ");
    for(var i=0;i<currentUsers.length;i++){
      console.log(currentUsers[i]);
    }
    if(currentUsers.length==0){
      // reset board settings to default
      boardSettings.mirror=false;
    }
  });
});

function getUser(id) {
  var user = currentUsers.filter((a) => {
    return a.id == id;
  })[0];
  return user;
}

function updateUser(data) {
  var user = getUser(data.id);
  if (user) {
    var userdata = user.userdata;

    switch (data.type) {
      case "Mm":
        userdata.x = data.x;
        userdata.y = data.y;
        userdata.lastx = data.lastx;
        userdata.lasty = data.lasty;
        break;
      case "Md":
        userdata.mousedown = true;
        break;
      case "Mu":
        userdata.mousedown = false;
        if(userdata.tool=="text"){
          userdata.text="";
        }
        break;
      case "ChSi":
        userdata.size = data.size;
        break;
      case "ChNa":
        userdata.username = data.name;
        break;
      case "ChT":
        userdata.tool = data.tool;
        userdata.text="";
        break;
      case "ChC":
        userdata.color = data.color;
        break;
      case "ChP":
        userdata.pressure = data.pressure;
        break;
        
      case "kp":
        var key = data.key;
        if (key.length == 1) {
          userdata.text = userdata.text + key;
        }
        switch (key) {
          case "Enter":
            userdata.text = "";
            break;

          case "Backspace":
            if (userdata.text) {
              userdata.text = userdata.text.slice(0, -1);
            }
            break;
        }
        break;
      case "mirror":
        boardSettings.mirror = !boardSettings.mirror;
    }
  }
}
