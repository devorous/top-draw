/* - - - - - - - - - -
Game variable storage:
  - - - - - - - - - - */

// Generate random color for player color, also used for unique id
var playerColor = randomColor();

// Players location storage, add yourself to start:
var players = [];
// Start self player at a random position between 10 and 190 on X and Y:
var self = {
  x: Math.floor(Math.random() * 180) + 10,
  y: Math.floor(Math.random() * 180) + 10,
  color: playerColor
};
// Add self player to beginning of players array:
players.unshift(self);

/* - - - - - - - - - -
   Setup Websocket:
  - - - - - - - - - - */

// Match websocket protocol to page protocol (ws/http or wss/https):
var wsProtocol = window.location.protocol == "https:" ? "wss" : "ws";

// Set up new websocket connection to server
var connection = new WebSocket(`${wsProtocol}://${window.location.hostname}:${window.location.port}`);

// Log successful connection
connection.onopen = function() {
  console.log("Websocket connected!");
  startGame();
};

// Set this function to run every time the websocket receives a message from the server:
// Each message will have data that represents a player that has moved.
connection.onmessage = function(message) {
  console.log("New Message:");
  console.log(message);
  var parsedMessageData = JSON.parse(message.data);
  console.log("Parsed Message Data:");
  console.log(parsedMessageData);

  // If player is us do nothing:
  if (parsedMessageData.color === playerColor) {
    return;
  }

  // Find player index in players array:
  var playerIds = players.map(i => i.color);
  var playerIndex = playerIds.indexOf(parsedMessageData.color);

  // If we haven't seen player before, add to players array:
  if (playerIndex === -1) {
    players.push(parsedMessageData);
  }

  // If player is already in players array, update position:
  else {
    players[playerIndex].x = parsedMessageData.x;
    players[playerIndex].y = parsedMessageData.y;
  }
};

// Game function which starts once websocket is connected:
function startGame() {
  /* - - - - - - - - - -
     Simple game:
  - - - - - - - - - - */

  // Set up canvas
  var c = document.getElementById("myCanvas");
  var ctx = c.getContext("2d");

  // Send original position to server:
  connection.send(JSON.stringify({ x: self.x, y: self.y, color: self.color }));

  // Show player which color they are
  document.getElementById("player-color").style.backgroundColor = playerColor;

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

    requestAnimationFrame(gameLoop);
  }


  document.addEventListener("keydown", detectKeyPress.bind(this, players[0]));

  function detectKeyPress(player, e) {
    const speed = 5;
    switch (e.code) {
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
    // Send new position to server:
    connection.send(
      JSON.stringify({ x: player.x, y: player.y, color: player.color })
    );
  }
}

gameLoop();

// Random color generator for player Ids
function randomColor() {
  let color = "#";
  let values = [
    "0", "1", "2", "3", "4", "5", "6", "7",
    "8", "9", "A", "B", "C", "D", "E", "F"
  ];
  color += values[Math.floor(Math.random() * values.length)];
  color += values[Math.floor(Math.random() * values.length)];
  color += values[Math.floor(Math.random() * values.length)];
  return color;
}
