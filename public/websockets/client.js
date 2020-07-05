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

var keyState = {
  ArrowLeft: false,
  ArrowRight: false,
  ArrowUp: false,
  ArrowDown: false
}

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

    // Redraw each player
    for (var i in players) {
      var player = players[i];

      // If player is you, move based on keys
      if (i === "0") {
        const speed = 5;
        // Update player position:
        for (let i in keyState) {
          if (keyState[i]) {
            switch (i) {
              case "ArrowLeft":
                player.x -= speed;
                break;
              case "ArrowRight":
                player.x += speed;
                break;
              case "ArrowUp":
                player.y -= speed;
                break;
              case "ArrowDown":
                player.y += speed;
                break;
            }
          }
        }

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

        // Send new position to server:
        connection.send(
          JSON.stringify({ x: player.x, y: player.y, color: player.color })
        );
      }

      ctx.beginPath();
      ctx.arc(player.x, player.y, 10, 0, 2 * Math.PI);
      ctx.fillStyle = player.color;
      ctx.fill();
      ctx.stroke();
    }

    requestAnimationFrame(gameLoop);
  }


  document.addEventListener("keydown", detectKeyPress.bind(this, players[0], true));
  document.addEventListener("keyup", detectKeyPress.bind(this, players[0], false));
  
  // Screen buttons
  const buttons = ["ArrowUp", "ArrowLeft", "ArrowRight", "ArrowDown"];
  buttons.forEach(i => {
    let el = document.getElementById(i)
    el.addEventListener("touchstart", detectKeyPress.bind(this, players[0], true, {code: i}));
    el.addEventListener("touchend", detectKeyPress.bind(this, players[0], false, {code: i}));
    el.addEventListener("mousedown", detectKeyPress.bind(this, players[0], true, {code: i}));
    el.addEventListener("mouseup", detectKeyPress.bind(this, players[0], false, {code: i}));
  });
  
  function detectKeyPress(player, setAs, e) {
    switch (e.code) {
      case "ArrowUp":
      case "ArrowLeft":
      case "ArrowDown":
      case "ArrowRight":
        keyState[e.code] = setAs;
        break;
    }
  }

  gameLoop();
}


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
