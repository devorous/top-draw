console.log("desde client.js");
proto_ws= window.location.protocol=="https:" ? "wss" : "ws"; 
//A: el proto de websocket tiene que ser seguro si el de la página es seguro

ws= new WebSocket(proto_ws+"://"+window.location.hostname);
//A: nos conectamos al mismo servidor de donde bajo la página (asi nos lo da glitch)

ws.onmessage( m => console.log("WS LLEGO",m) );
ws.send("Hola!")
