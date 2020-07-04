/* - - - - - - - - - -
   Simple game:
- - - - - - - - - - */

// Set up canvas
var c = document.getElementById("myCanvas");
var ctx = c.getContext("2d");

// Generate random color for player color, also used for unique id
const playerColor = randomColor();

// Players location storage, add yourself to start:
var players = [{ x: 10, y: 10, color: playerColor }];

var keyState = {
  ArrowLeft: false,
  ArrowRight: false,
  ArrowUp: false,
  ArrowDown: false
}

// Show player which color they are
document.getElementById("player-color").style.backgroundColor = playerColor;



function gameLoop() {
  // Clear canvas
  ctx.clearRect(0, 0, 200, 200);

  // Redraw each player
  for (var i in players) {
    var player = players[i];

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
    
    ctx.beginPath();
    ctx.arc(player.x, player.y, 10, 0, 2 * Math.PI);
    ctx.fillStyle = playerColor;
    ctx.fill();
    ctx.stroke();
  }

  requestAnimationFrame(gameLoop);
}


document.addEventListener("keydown", detectKeyPress.bind(this, players[0], true));
document.addEventListener("keyup", detectKeyPress.bind(this, players[0], false));

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
