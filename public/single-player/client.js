var c = document.getElementById("myCanvas");
var ctx = c.getContext("2d");
var x = 10;
var y = 10;

function gameLoop() {
  ctx.clearRect(0, 0, 200, 200);
  ctx.beginPath();
  ctx.arc(x, y, 10, 0, 2 * Math.PI);
  ctx.stroke();
  if (x > 190) {
    x = 190;
  }
  if (x < 10) {
    x = 10;
  }
  if (y > 190) {
    y = 190;
  }
  if (y < 10) {
    y = 10;
  }
  setTimeout(gameLoop, 1000/30);
}

gameLoop();

document.addEventListener('keydown', logKey);

function logKey(e) {
  const speed = 5;
  switch(e.code) {
    case "ArrowUp":
      y -= speed;
      break;
    case "ArrowLeft":
      x -= speed;
      break;
    case "ArrowDown":
      y += speed;
      break;
    case "ArrowRight":
      x += speed;
      break;
  }
}