

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
ctx.imageSmoothingQuality ="high";

var current_line = [];


var test = "test";

var self = {
  x: 0,
  y: 0,
  lastx:null,
  lasty:null,
  size:10,
  color: "black",
  tool:"brush",
  text:"",
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
  var user = getUser(data.id);
  switch(data.type){
      
    case 'clear':
        clearBoard();
      break
      
    case 'Mm':
      moveCursor(data);
      //if user has no lastpos, make it the current pos
      if(user.lastx==null){
        user.lastx = data.x;
        user.lasty = data.y;
      }
      updateUser(user, data,['x','y']);
      var pos = {x:user.x,y:user.y};
      var lastpos = {x:user.lastx,y:user.lasty};
      if(user.mousedown){
        drawLine(pos,lastpos,user);
      }
      break
      
    case 'Md':
      ctx.lineCap="round";
      user.lastx=user.x;
      user.lasty=user.y;
      var pos = {x:user.x,y:user.y};
      drawLine(pos,pos,user);
      user.mousedown=true;
      break
      
    case 'Mu':
      ctx.stroke();
      user.mousedown=false;
      break
      
    case 'ChS':
      //change the size
      updateUser(user, data,['size']);
      break
      
    case 'ChT':
      //change the tool
      updateUser(user,data,['tool']);
      var userText = $("."+user.id.toString()+" text")[0];
      var userCircle = $("."+user.id.toString()+" circle")[0];
      if(data.tool=="brush"){
        userText.style.display="none";
        userCircle.style.display="block";
      }
      if(data.tool=="text"){
        userText.style.display="block";
        userCircle.style.display="none";
      }
      break
    case 'kp':
      //keypress
      if(user.tool=="text"){
        updateText(data.key,user);
      }
  }
}

function getUser(id){
  var user = users.filter( a =>{
    return a.id==id;
  })[0];
  return user
}


board.addEventListener('mousemove', function(e){
  var user = getUser(userID);
  user.x = e.layerX-100
  user.y = e.layerY-100
  
  //set your cursor pos
  cursor.style.left=user.x+"px";
  cursor.style.top=user.y+"px";

  send({command:"broadcast",type:"Mm",x:user.x,y:user.y,id:userID});
  var lastpos = {x:user.lastx,y:user.lasty};
  var pos = {x:self.x,y:self.y};
  if(lastpos.x==null){
    lastpos=pos;
  }
  if(user.mousedown){
    drawLine(pos,lastpos,user);
  }
})

board.addEventListener('mousedown', function(e){
  var user = getUser(userID);
  user.lastx=user.x;
  user.lasty=user.y;
  self.mousedown = true;
  send({command:"broadcast",type:"Md", id:userID})
  ctx.beginPath();
  ctx.lineCap="round";
  ctx.moveTo(e.layerX,e.layerY);
  ctx.lineTo(e.layerX,e.layerY);
});

board.addEventListener('mouseup', function(e){
  self.mousedown = false;
  ctx.stroke();
  send({command:"broadcast", type:"Mu",id:userID})
  var line = {path:current_line,id:userID};
  current_line=[];
});

board.addEventListener('wheel', function(e){
  e.preventDefault();
  var step=1;
  if(size<=1){
    step=0.1;
  }
  else if(size<=5){
    step=0.5;
  }
  else{
    step=1;
  }
  if(e.deltaY>0){
    //scrolling down
    if(size-1 > 0){
      size=size-step;
      cursor_circle.setAttribute("r",size);
      ctx.lineWidth=size;
      self.size=size;
      send({command:"broadcast",type:"ChS",size:size,id:userID});
    }
  }
  else{
    //scrolling up
    if(size <101 ){
      size=size+step;
      cursor_circle.setAttribute("r",size);
      ctx.lineWidth=size;
      self.size=size;
      send({command:"broadcast",type:"ChS",size:size,id:userID});
    }
  }
});

document.addEventListener("keydown", function(e){
  send({command:"broadcast",type:"kp",key:e.key,id:self.id});
  if(self.tool=="text"){
    
    var input = $(".textInput.self")[0];
    
    if(e.key.length==1){
      input.innerHTML=input.innerHTML+e.key;
    }
    
    switch(e.key){
      case "Enter":
        input.innerHTML="";
        break
      case "Backspace":
        if(input.innerHTML){
          input.innerHTML = input.innerHTML.slice(0,-1);
        }
    }
    
  }
});


function drawLine(pos,lastpos,user){
  ctx.lineWidth=user.size*2;
  //ctx.translate(0.5, 0.5);
  ctx.beginPath();
  ctx.moveTo(user.lastx+100,user.lasty+100);
  ctx.lineTo(user.x+100,user.y+100);
  ctx.stroke();
  current_line.push(pos);
  user.lastx=pos.x;
  user.lasty=pos.y
}

function updateText(key,user){
  console.log(user)
  var input = $("."+user.id.toString()+" textInput")[0];
  if(key.length==1){
    input.innerHTML=input.innerHTML+key;
  }
  switch(key){
      
    case "Enter":
      input.innerHTML="";
      break
      
    case "Backspace":
      if(input.innerHTML){
        input.innerHTML = input.innerHTML.slice(0,-1);
      }
      break
      
      
  }
}

function moveCursor(data){
  
  var id=data.id.toString();
  var x = data.x;
  var y = data.y;
  var cursor = document.getElementsByClassName(id)[0];
  cursor.style.left=x.toString()+'px';
  cursor.style.top=y.toString()+'px';
}

function updateUser(user,data,fields){

    for(var i=0;i<fields.length;i++){
      var val = fields[i];
      user[val] = data[val];
    }
  
}


var clearBtn = $("#clearBtn")[0];
clearBtn.addEventListener("click",function(){
  clearBoard();
  send({command:"broadcast",type:"clear",id:userID});
});

var brushBtn = $("#brushBtn")[0];
var textBtn = $("#textBtn")[0];

brushBtn.addEventListener("click", function(){
  self.tool="brush";
  send({command:"broadcast",type:"ChT",tool:"brush",id:self.id});
  $(".text.self")[0].style.display="none";
  $(".circle.self")[0].style.display="block";
});

textBtn.addEventListener("click",function(){
  self.tool="text";
  send({command:"broadcast",type:"ChT",tool:"text",id:self.id});
  $(".text.self")[0].style.display="block";
  $(".circle.self")[0].style.display="none";
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
  var name = $("<text>"+id.toString()+"</text>")[0];
  name.setAttribute("class","name "+id.toString());
  var text = $("<text></text>")[0];
  text.setAttribute("class","text "+id.toString());
  var line = $("<text>|</text>")[0];
  var textinput = $("<text></text>")[0];
  textinput.setAttribute("class","textInput "+id.toString());
  text.appendChild(line);
  text.appendChild(textinput);
  
  svg.appendChild(circle);
  div.appendChild(svg);
  div.appendChild(name);
  div.append(text);
  
  cursors.appendChild(div);
  
//<text class="text self"><text>|</text><text class="textinput self">this is text</text></text>
}
