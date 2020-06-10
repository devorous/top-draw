const express = require('express');
const app = express();
app.use(express.static('public'));

const server = app.listen(process.env.PORT, function() {
  console.log('Your app is listening on port ' + server.address().port);
});


var WebSocket= require('ws');
var wss= new WebSocket.Server({ server });
wss.broadcast = function broadcast(data) { //U: Broadcast to all.
  console.log("MANDO A TODOS ...", data);
  wss.clients.forEach(function each(client) {
    if (client.readyState === WebSocket.OPEN) { client.send(data); }
  });
};

wss.on('connection', function connection(ws) {
  ws.on('message', function incoming(data) { //U: Broadcast to everyone else.
    console.log("LLEGO ...", data);
    wss.broadcast(data);
  });
});
