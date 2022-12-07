

var users = [];

var userID = Math.floor(Math.random() * 999999);

var board = $("#board")[0];
var cursor = $(".cursor.self")[0];
var cursor_circle = cursor.children[0].children[0];
var height = board.height;
var width = board.width;
var size = 10;

var ctx = board.getContext("2d");
ctx.lineWidth=size*2;
ctx.translate(0.5, 0.5);
ctx.imageSmoothingQuality ="high";

var current_line = [];


var test = "test";

var self = {
  x: 0,
  y: 0,
  size:10,
  color: "black",
  mousedown: false,
  id:userID
};

// Add self player to beginning of players array:
users.unshift(self);


/* - - - - - - - - - -
   Setup Websocket:
  - - - - - - - - - - */

// Match websocket protocol to page protocol (ws/http or wss/https):
var wsProtocol = window.location.protocol == "https:" ? "wss" : "ws";

// Set up new websocket connection to server
var socket = new WebSocket(`${wsProtocol}://${window.location.hostname}:${window.location.port}`);

// Log successful connection
socket.onopen = function() {
  send({command:"connect",userdata:self,id:userID});
  send({command:"getusers", id:userID});
  console.log("Websocket connected!");
};

socket.addEventListener("message", (m) => {
  var data = JSON.parse(m.data);

  
  switch(data.command){
    case 'connect':
      users.push(data.userdata);
      drawUser(data);
      console.log("adding: "+data.userdata);
      break
    case 'broadcast':
      broadcast(data);
  }
});


function send(data){
  socket.send(JSON.stringify(data));
}

function broadcast(data){
  console.log("broadcasting :"+JSON.stringify(data));
  console.log("data");
  switch(data.type){
    case 'users':
      for(var i=0;i<data.users.length;i++){
        if(data.id != self.id){
          users.push(data.users[i]);
          drawUser(data.users[i]);
        }
      }
      break
    case 'clear':
        clearBoard();
      break
    case 'Mm':
      moveCursor(data.id,data.x,data.y);
      break
    case 'Md':
      
      break
    case 'Mu':
      
      break
      
  }
}




board.addEventListener('mousemove', function(e){
  self.x = e.layerX-100
  self.y = e.layerY-100
  cursor.style.left=self.x+"px";
  cursor.style.top=self.y+"px";
  send({command:"broadcast",type:"Mm",x:self.x,y:self.y,id:userID});
  if(self.mousedown){
    var pos = {x:e.layerX,y:e.layerY};
    if(current_line.slice(-1)[0] !=pos ){
      ctx.lineTo(e.layerX,e.layerY);
      ctx.stroke();
      current_line.push(pos);
    }
  }
})

board.addEventListener('mousedown', function(e){
  self.mousedown = true;
  send({command:"broadcast",type:"Md", id:userID})
  ctx.beginPath();
  ctx.lineCap="round";
  ctx.moveTo(e.layerX,e.LayerY);
  console.log(e);
});

board.addEventListener('mouseup', function(e){
  self.mousedown = false;
  send({command:"broadcast", type:"Mu",id:userID})
  var line = {path:current_line,id:userID};
  if(line){
    console.log("line to draw: ");
    console.log(line);   
  }
  current_line=[];
  console.log(e);
});

board.addEventListener('wheel', function(e){
  e.preventDefault();
  var step=1;
  if(size<5){
    step=0.5;
  }
  else{
    step=1;
  }
  if(e.deltaY>0){
    console.log("scrolled down")
    if(size-1 > 0){
      size=size-step;
      cursor_circle.setAttribute("r",size);
      ctx.lineWidth=size*2;
      self.size=size;
    }
  }
  else{
    console.log("scrolled up");
    if(size <101 ){
      size=size+step;
      cursor_circle.setAttribute("r",size);
      ctx.lineWidth=size*2;
      self.size=size;
    }
  }
});

function drawLine(line){
  
}

function moveCursor(id, x, y){
  var c = $("."+id.toString())[0];
}

var btn = $("#clearBtn")[0];
btn.addEventListener("click",function(){
  clearBoard();
  send({command:"broadcast",type:"clear",id:userID});
});

function clearBoard(){
  console.log("clearing board");
  ctx.fillStyle="#FFF";
  ctx.fillRect(0,0,400,400)
}

function drawUser(user, id){
  var data = user.userdata;
  console.log("this is the data: "+JSON.stringify(user));
  var div = $('<div></div>')[0];
  div.setAttribute("class","cursor "+user.id.toString());
  div.setAttribute("left","0px");
  div.setAttribute("right","0px");
  var svg = $('<svg height="202" width="202"></svg>')[0];
  var circle = $('<circle stroke="grey" stroke-width="1" fill="none" cx="100" cy="100" r="10"></circle>');
  var cursors = $(".cursors");
  svg.append(circle);
  div.appendChild(svg);
  cursors.append(div);

}
/*

        <div class="cursor self">
          <svg height="202" width="202">
            <circle
              stroke="grey"
              stroke-width="1"
              fill="none"
              cx="100"
              cy="100"
              r="10" >  
            </circle>
          </svg>
        </div>
      
      */