var messages = [];

// Match websocket protocol to page protocol (ws/http or wss/https):
var wsProtocol= window.location.protocol=="https:" ? "wss" : "ws"; 

var connection = new WebSocket(`${wsProtocol}://${window.location.hostname}`);

connection.onopen = function() {
  console.log("Websocket connected!");
}

connection.onmessage = function(message) {
  console.log("New Message:");
  console.log(message);
  messages.push(JSON.parse(message.data));
  document.getElementById("messages-list").innerHTML = messages.map(i => `<li>${i.de}: ${i.texto}</li>`).join("");
}

setTimeout(() => {
  connection.send(JSON.stringify({de: "Example Name", texto: "test"}));
}, 1000)