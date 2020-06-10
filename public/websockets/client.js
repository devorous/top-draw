var messages = [];

// Match websocket protocol to page protocol (ws/http or wss/https):
var wsProtocol= window.location.protocol=="https:" ? "wss" : "ws"; 

var ws = new WebSocket(`${wsProtocol}://${window.location.hostname}`);

ws.onopen = function() {
  console.log("Websocket connected!");
}

ws.onmessage = function(message) {
  console.log("New Message:");
  console.log(message);
  messages.push(JSON.parse(message.data));
  document.getElementById("messages-list").innerHTML = messages.map(i => `<li>${i.de}: ${i.texto}</li>`).join("");
}

setTimeout(() => {
  ws.send(JSON.stringify({de: "Example Name", texto: "test"}));
}, 1000)