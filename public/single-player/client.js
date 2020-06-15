/* - - - - - - - - - -
   Simple game:
- - - - - - - - - - */

// Set up canvas
var c = document.getElementById("myCanvas");
var ctx = c.getContext("2d");

// Generate random color for player color, also used for unique id
const playerColor = randomColor();

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

// Players location storage, add yourself to start:
var players = [{ x: 10, y: 10, color: playerColor }];

// Show player which color they are
document.getElementById("player-color").style.backgroundColor = playerColor;



function gameLoop() {
  // Redraw each player based on updated position
  for (var i in players) {
    var player = players[i];
    ctx.clearRect(0, 0, 200, 200);
    ctx.beginPath();
    ctx.arc(player.x, player.y, 10, 0, 2 * Math.PI);
    ctx.fillStyle = playerColor;
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
setInterval(gameLoop, 1000 / 30);

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
}
