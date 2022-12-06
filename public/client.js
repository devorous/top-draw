/* - - - - - - - - - -
Game variable storage:
  - - - - - - - - - - */


// user location storage, add yourself to start:
var users = [];

var self = {
  x: 0,
  y: 0,
  color: "black"
};

// Add self player to beginning of players array:
users.unshift(self);


/* - - - - - - - - - -
   Setup Websocket:
  - - - - - - - - - - */

// Match websocket protocol to page protocol (ws/http or wss/https):
var wsProtocol = window.location.protocol == "https:" ? "wss" : "ws";

// Set up new websocket connection to server
var socket = new WebSocket(`${wsProtocol}://${window.location.hostname}:${window.location.port}`);

// Log successful connection
socket.onopen = function() {
  socket.send(JSON.stringify({id:Math.floor(Math.random() * 999999)}));
  console.log("Websocket connected!");
};

var board = $("#board");
board.onmousemove(
)

