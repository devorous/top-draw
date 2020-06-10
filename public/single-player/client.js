var c = document.getElementById("myCanvas");
var ctx = c.getContext("2d");
ctx.beginPath();
ctx.arc(10, 10, 10, 0, 2 * Math.PI);
ctx.stroke();