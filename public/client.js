

var users = [];

var userID = Math.floor(Math.random() * 999999);

var board = $("#board")[0];
var cursor = $(".cursor.self")[0];
var cursor_circle = cursor.children[0].children[0];
var text = $(".name.self")[0];
text.innerHTML = userID.toString();
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
users.push(self);


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
  console.log("Websocket connected!");
};

socket.addEventListener("message", (m) => {
  var data = JSON.parse(m.data);

  switch(data.command){
    case 'currentUsers':
        //updating list of users with new users
        var current_ids = [];
        for(var i=0;i<users.length;i++){
          if(current_ids.indexOf(users[i].id)==-1){
            current_ids.push(users[i].id);
          }
        }
        //getting all the current ids to check for duplicates
        for(var i=0;i<data.users.length;i++){
          if(current_ids.indexOf(data.users[i].id) == -1 && data.users[i].id != userID){
              users.push(data.users[i].userdata);
              drawUser(data.users[i].userdata,data.users[i].id);
              console.log("adding: "+JSON.stringify(data.users[i].userdata));
          }
        }
        break
    case 'connect':
      break
    case 'userLeft':
      //when a user leaves, update the user list and remove the cursor by ID class
      users = users.filter(userdata =>{
        return userdata.id != data.id;
      });
      var div = $("."+data.id.toString())[0];
      if(div){
        div.remove();
      }
      break
      
    case 'broadcast':
      recieve(data);
  }
});


function send(data){
  socket.send(JSON.stringify(data));
}

function recieve(data){
  //process broadcast events
  switch(data.type){
      
    case 'clear':
        clearBoard();
      break
      
    case 'Mm':
      moveCursor(data);
      updateUser(data,['x','y']);
      break
      
    case 'Md':
      
      break
      
    case 'Mu':
      
      break
      
    case 'ChS':
      updateUser(data,['size']);
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
  if(size<=5){
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
      send({command:"broadcast",type:"ChS",size:size,id:userID});
    }
  }
  else{
    console.log("scrolled up");
    if(size <101 ){
      size=size+step;
      cursor_circle.setAttribute("r",size);
      ctx.lineWidth=size*2;
      self.size=size;
      send({command:"broadcast",type:"ChS",size:size,id:userID});
    }
  }
});



function moveCursor(data){
  
  var id=data.id.toString();
  var x = data.x;
  var y = data.y;
  var cursor = document.getElementsByClassName(id)[0];
  cursor.style.left=x.toString()+'px';
  cursor.style.top=y.toString()+'px';
}

function updateUser(data,fields){
  console.log("update user data: ");
  console.log(data);
  for(var i=0;i<users.length;i++){
    if(users[i].id==data.id){
      for(var j=0;j<fields.length;j++){
        var val = fields[j];
        users[i][val]=data[val];
      }
    }
  }
  
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

function drawUser(data,id){
  
  var div = $('<div></div>')[0];
  div.setAttribute("class","cursor "+id.toString());

  var svg = document.createElementNS('http://www.ww3.org/2000/svg', 'svg');
  svg.setAttribute("height","202px");
  svg.setAttribute("width","202px");
  var circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circle.setAttribute("class",id.toString());
  circle.setAttribute("stroke","grey");
  circle.setAttribute("stroke-width","1");
  circle.setAttribute("fill","none");
  circle.setAttribute("cx","100");
  circle.setAttribute("cy","100");
  circle.setAttribute("r","10");
  circle.setAttribute("height","auto");
  var cursors = $(".cursors")[0];
  var text = $("<text>"+id.toString()+"</text>")[0];
  text.setAttribute("class","name "+id.toString());
  svg.appendChild(circle);
  div.appendChild(svg);
  div.appendChild(text);
  cursors.appendChild(div);

}
