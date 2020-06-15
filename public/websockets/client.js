// Match websocket protocol to page protocol (ws/http or wss/https):
var wsProtocol= window.location.protocol=="https:" ? "wss" : "ws"; 

var connection = new WebSocket(`${wsProtocol}://${window.location.hostname}`);

connection.onopen = function() {
  console.log("Websocket connected!");
}

var messages = [];
connection.onmessage = function(message) {
  console.log("New Message:");
  console.log(message);
  var parsedMessage = JSON.parse(message.data)
  console.log("Parsed Message Data:");
  console.log(parsedMessage);
  
  // Find player index in players array:
  var playerIds = players.map(i => i.color);
  var playerIndex = playerIds.indexOf(message.color);
  
  // If we haven't seen player before, add to players array:
  if (playerIndex === -1) {
    players.push(parsedMessage);
  }
  
  // If 
  
  
  //messages.push(JSON.parse(message.data));
  //document.getElementById("messages-list").innerHTML = messages.map(i => `<li>${i.de}: ${i.texto}</li>`).join("");
}

setTimeout(() => {
  connection.send(JSON.stringify({x: 100, y: 150, color: "#0000FF"}));
}, 1000)



/* - - - - - - - - - -
   Simple game:
- - - - - - - - - - */

// Set up canvas
var c = document.getElementById("myCanvas");
var ctx = c.getContext("2d");

// Generate random color for player color, also used for unique id
const playerColor = randomColor();

// Players location storage, add yourself to start:
var players = [
  {x: 10, y: 10, color: playerColor} 
]

document.getElementById("player-color").style.backgroundColor = playerColor;

function randomColor() {
  let color = "#";
  let values = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "A", "B", "C", "D", "E", "F"];
  color += values[Math.floor(Math.random() * values.length)];
  color += values[Math.floor(Math.random() * values.length)];
  color += values[Math.floor(Math.random() * values.length)];
  return color;
}

function gameLoop() {
  // Clear canvas
  ctx.clearRect(0, 0, 200, 200);
  // Redraw each player based on updated position
  for (var i in players) {
    var player = players[i];
    ctx.beginPath();
    ctx.arc(player.x, player.y, 10, 0, 2 * Math.PI);
    ctx.fillStyle = player.color;
    ctx.fill();
    ctx.stroke();

    // Detect player going past boundries
    if (player.x > 190) {
      player.x = 190;
    }
    if (player.x < 10) {
      player.x = 10;
    }
    if (player.y > 190) {
      player.y = 190;
    }
    if (player.y < 10) {
      player.y = 10;
    }
  }
}

// Start game loop, run 30 times per second
setInterval(gameLoop, 1000/30);

document.addEventListener('keydown', detectKeyPress.bind(this, players[0]));

function detectKeyPress(player, e) {
  const speed = 5;
  switch(e.code) {
    case "ArrowUp":
      player.y -= speed;
      break;
    case "ArrowLeft":
      player.x -= speed;
      break;
    case "ArrowDown":
      player.y += speed;
      break;
    case "ArrowRight":
      player.x += speed;
      break;
  }
}