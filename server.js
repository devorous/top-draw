// server.js
// where your node app starts

// init project
const express = require('express');
const app = express();

// we've started you off with Express, 
// but feel free to use whatever libs or frameworks you'd like through `package.json`.

// http://expressjs.com/en/starter/static-files.html
app.use(express.static('public'));

// http://expressjs.com/en/starter/basic-routing.html
app.get('/', function(request, response) {
  response.sendFile(__dirname + '/views/index.html');
});

// listen for requests :)
const listener = app.listen(process.env.PORT, function() {
  console.log('Your app is listening on port ' + listener.address().port);
});

var WebSocket= require('ws');
var wss= new WebSocket.Server({ port: PORT_WS });
wss.broadcast = function broadcast(data) { //U: Broadcast to all.
  console.log("MANDO A TODOS ...", data);
  wss.clients.forEach(function each(client) {
    if (client.readyState === WebSocket.OPEN) { client.send(data); }
  });
};

wss.on('connection', function connection(ws) {
  ws.on('message', function incoming(data) { //U: Broadcast to everyone else.
    console.log("LLEGO ...", data);
    wss.clients.forEach(function each(client) {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    });
  });
});
