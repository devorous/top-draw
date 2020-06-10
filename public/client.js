var messages = [];

console.log("desde client.js");
var proto_ws= window.location.protocol=="https:" ? "wss" : "ws"; 
//A: el proto de websocket tiene que ser seguro si el de la página es seguro

var ws = new WebSocket(proto_ws+"://"+window.location.hostname);
//A: nos conectamos al mismo servidor de donde bajo la página (asi nos lo da glitch)
ws.onmessage= m => console.log("WS LLEGO",m) 

ws.onopen= () => {
ws.send(JSON.stringify({de: "anonimo", texto: "hola!"}));
console.log("WS listo, envia con ws.send('mi mensaje')");
}

ws.onmessage= m => {
  console.log("WS LLEGO",m);
  messages.push(JSON.parse(m.data));
  console.log(messages);
  document.getElementById("messages-list").innerHTML = messages.map(i => `<li>${i.de}: ${i.texto}</li>`).join("");
}

setTimeout(() => {
  ws.send(JSON.stringify({de: "Example Name", texto: "test"}));
}, 1000)