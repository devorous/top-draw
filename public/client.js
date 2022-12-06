/* - - - - - - - - - -
Game variable storage:
  - - - - - - - - - - */


// user location storage, add yourself to start:


var users = [];

var userID = Math.floor(Math.random() * 999999);

var board = $("#board")[0];

var height = board.height;
var width = board.width;

var ctx = board.getContext("2d");

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
  send({command:"connect",id:userID});
  console.log("Websocket connected!");
};

socket.onmessage = function(m){
  console.log("recieved message: ")
  console.log(m.data);
};

function send(data){
  socket.send(JSON.stringify(data));
}


board.addEventListener('mousemove', function(e){
  //console.log(e);
  if(mousedown){
    var pos = {x:e.layerX,y:e.layerY};
    if(current_line.slice(-1)[0] !=pos){
      ctx.lineTo(e.layerX,e.layerY);
      ctx.stroke();
      current_line.push(pos);
    }
  }
})

board.addEventListener('mousedown', function(e){
  mousedown = true;
  ctx.beginPath();
  ctx.moveTo(e.layerX,e.LayerY);
  console.log(e);
});

board.addEventListener('mouseup', function(e){
  mousedown = false;
  
  
  var line = {path:current_line,id:userID};
  console.log("line to draw: ");
  console.log(line);   
  console.log(e);
});

board.addEventListener('wheel', function(e){
  e.preventDefault();
  if(e.deltaY>0){
    console.log("scrolled down")
  }
  else{
    console.log("scrolled up");
  }
});