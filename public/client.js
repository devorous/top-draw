/* - - - - - - - - - -
Game variable storage:
  - - - - - - - - - - */


// user location storage, add yourself to start:
var users = [];

var userID = Math.floor(Math.random() * 999999);

var current_line = [];

var mousedown = false;

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
  socket.send(JSON.stringify({id:userID}));
  console.log("Websocket connected!");
};

var board = $("#board")[0];

board.addEventListener('mousemove', function(e){
  //console.log(e);
  if(mousedown){
    current_line.push({x:e.layerX,y:e.layerY});
  }
})

board.addEventListener('mousedown', function(e){
  mousedown = true;
  console.log(e);
});

board.addEventListener('mouseup', function(e){
  mousedown = false;
  console.log("line to draw: ");
  
  console.log(e);
})
board.addEventListener('wheel', function(e){
  e.preventDefault();
  if(e.deltaY>0){
    console.log("scrolled down")
  }
  else{
    console.log("scrolled up");
  }
})