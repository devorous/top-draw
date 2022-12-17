
  

var users = [];

var userID = Math.floor(Math.random() * 999999);
var boards = $("#boards")[0];

var board = $("#board")[0];
var topBoard = $("#topBoard")[0];
var cursor = $(".cursor.self")[0];
var cursor_circle = cursor.children[0].children[0];
var text = $(".name.self")[0];

var userlistEntry = $(".userEntry.self")[0];

text.innerHTML = userID.toString();


var boardDim=[480,240];

var height = document.body.scrollHeight;
var width  = document.body.scrollWidth;

boards.style.height=boardDim[0].toString()+"px";
boards.style.width=boardDim[1].toString()+"px";

board.height=boardDim[0];
board.width=boardDim[1];

topBoard.height=boardDim[0];
topBoard.width=boardDim[1];


var size = 10;

var ctx = board.getContext("2d");
var ctx2 = topBoard.getContext("2d");


ctx.globalCompositeOperation="source-over";
ctx.imageSmoothingQuality = "high";
ctx2.imageSmoothingQuality = "high";
ctx.lineCap = "round";

var gimpData = null;

var current_line = [];

var connected=false;


var icons={
  brush:$("<img src='/images/brush-icon.svg' />")[0],
  text:$("<img src='/images/text-icon.svg' />")[0],
  erase:$("<img src='/images/eraser-icon.svg' />")[0]
}

//set default values for your user list entry
userlistEntry.children[0].appendChild(icons.brush);
userlistEntry.children[2].innerHTML=userID;


var self = {
  x: 0,
  y: 0,
  lastx: null,
  lasty: null,
  size: 10,
  color: "#000",
  tool: "brush",
  text: "",
  mousedown: false,
  username:"",
  context:ctx2,
  board:board,
  id: userID,
};

// Add self  to beginning of users array:
users.push(self);




/* - - - - - - - - - -
   Setup Websocket:
  - - - - - - - - - - */

// Match websocket protocol to page protocol (ws/http or wss/https):
var wsProtocol = window.location.protocol == "https:" ? "wss" : "ws";

// Set up new websocket connection to server
var socket = new WebSocket(
  `${wsProtocol}://${window.location.hostname}:${window.location.port}`
);

// Log successful connection
socket.onopen = function () {
  send({ command: "connect", userdata: self, id: userID });
  console.log("Websocket connected!");
  connected = true;
};

socket.addEventListener("message", (m) => {
  var data = JSON.parse(m.data);

  switch (data.command) {
    case "currentUsers":
      //updating list of users with new users
      var current_ids = [];
      for (var i = 0; i < users.length; i++) {
        if (current_ids.indexOf(users[i].id) == -1) {
          current_ids.push(users[i].id);
        }
      }
      //getting all the current ids to check for duplicates
      for (var i = 0; i < data.users.length; i++) {
        var user = data.users[i];
        if (
          current_ids.indexOf(data.users[i].id) == -1 &&
          data.users[i].id != userID
        ) {
          users.push(data.users[i].userdata);
          drawUser(data.users[i].userdata, data.users[i].id);
        }
      }
      break;
    case "connect":
      break;
    case "userLeft":
      //when a user leaves, update the user list and remove the users DOM objects
      
      var objs = $("." + data.id.toString());
      for(var i=0;i<objs.length;i++){
        if(objs[i]){
          objs[i].remove();
        }
      }

      users = users.filter((userdata) => {
        return userdata.id != data.id;
      });
      break;

    case "broadcast":
      recieve(data);
  }
});

function send(data) {
  socket.send(JSON.stringify(data)); 
}

function recieve(data) {
  //process broadcast events
  var user = getUser(data.id);
  switch (data.type) {
    case "clear":
      clearBoard();
      break;

    case "Mm":
      moveCursor(data);
      //if user has no lastpos, make it the current pos
      if (user.lastx == null) {
        user.lastx = data.x;
        user.lasty = data.y;
      }
      updateUser(user, data, ["x", "y"]);
      var pos = { x: user.x, y: user.y };
      var lastpos = { x: user.lastx, y: user.lasty };
      if (user.mousedown && user.tool == "brush") {
        drawLine(pos, lastpos, user);
      }
      if(user.mousedown && user.tool == "erase"){
        erase(pos.x,pos.y,lastpos.x,lastpos.y,user.size*2);
      }
      user.lastx=data.x;
      user.lasty=data.y;
      break;

    case "Md":
      user.lastx = user.x;
      user.lasty = user.y;
      var pos = { x: user.x, y: user.y };
      if (user.tool == "brush") {
        
        ctx.lineCap = "round";
        ctx.beginPath();
        drawLine(pos, pos, user);
      }
      if (user.tool == "text" && user.text != "") {
        drawText(user);
        user.text = "";
        var input = $("." + user.id.toString() + " .textInput")[0];
        input.innerHTML = "";
      }
      if(user.tool == "erase"){
        erase(pos.x,pos.y,pos.x,pos.y,user.size*2);
      }
      user.mousedown = true;
      break;

    case "Mu":
      if (user.tool == "brush") {
        ctx.stroke();
        ctx2.stroke();
        ctx2.clearRect(0,0,boardDim[0],boardDim[1]);
      }
      user.mousedown = false;
      break;

    case "ChS":
      //change the size
      updateUser(user, data, ["size"]);
      var userText = $("." + user.id.toString() + " .text")[0];
      userText.style.fontSize = (data.size + 5).toString() + "px";
      
      var userCtx = user.context;
      ctx.stroke();
      ctx.beginPath();
      ctx2.clearRect(0,0,boardDim[0],boardDim[1]);
      ctx2.stroke();
      ctx2.beginPath();
          
      break;

    case "ChT":
      //change the tool
      console.log("changing tool: ");
      console.log(data);
      updateUser(user, data, ["tool"]);
      var userText = $("." + user.id.toString() + " .text")[0];
      var userCircle = $("." + user.id.toString() + " circle")[0];
      if (data.tool == "brush") {
        userText.style.display = "none";
        userCircle.style.display = "block";
      }
      if (data.tool == "text") {
        userText.style.display = "block";
        userCircle.style.display = "none";
      }
      break;
    case "ChC":
      //change color
      var input = $("." + user.id.toString() + " .textInput")[0];
      input.style.color='rgba('+user.color.toString()+')';
      updateColor(data.color,user.id);
    case "kp":
      //keypress
      if (user.tool == "text") {
        updateText(data.key, user);
      }
  }
}

function getUser(id) {
  var user = users.filter((a) => {
    return a.id == id;
  })[0];
  return user;
}

board.addEventListener("mousemove", function (e) {
  
  var rect = e.target.getBoundingClientRect();
  var x = e.clientX - rect.left; //x position within the element.
  var y = e.clientY - rect.top;  //y position within the element.
  
  
  var user = getUser(userID);
  user.x = x;
  user.y = y;
  //set your cursor pos
  cursor.style.left = user.x-100 + "px";
  cursor.style.top = user.y-100 + "px";

  send({ command: "broadcast", type: "Mm", x: user.x, y: user.y, id: userID });
  var lastpos = { x: user.lastx, y: user.lasty };
  var pos = { x: self.x, y: self.y };
  if (lastpos.x == null) {
    lastpos = pos;
  }
  
  if (user.mousedown && user.tool == "brush") {
    drawLine(pos, lastpos, user);
  }
  if (user.mousedown && user.tool == "erase"){
    erase(pos.x,pos.y,lastpos.x,lastpos.y,user.size*2);
  }
  user.lastx = user.x;
  user.lasty = user.y;
});

board.addEventListener("mousedown", function (e) {
  var user = getUser(userID);
  var userCtx = user.context;
  var pos = {x:e.layerX,y:e.layerY};
  
  send({ command: "broadcast", type: "Md", id: userID });
  user.lastx = user.x;
  user.lasty = user.y;
  self.mousedown = true;
  

  if (user.tool == "brush") {
    drawDot(pos,ctx,user);
    drawDot(pos,userCtx,user);
  }
  
  if (user.tool == "text" && user.text != "") {
    drawText(user);
    user.text = "";
    var input = $(".textInput.self")[0];
    input.innerHTML = "";
  }
  
  if (user.tool == "erase"){
    erase(pos.x,pos.y,user.lastx,user.lasty,user.size*2);
  }
});

board.addEventListener("mouseup", function (e) {
  var user = getUser(userID);
  self.mousedown = false;
  if(user.tool=="brush"){
    ctx.stroke();
    ctx2.fillStyle="#FFF";
    ctx2.beginPath();
    ctx2.clearRect(0,0,boardDim[1],boardDim[0]);
  }
  
  send({ command: "broadcast", type: "Mu", id: userID });
  var line = { path: current_line, id: userID };
  current_line = [];
});

board.addEventListener("wheel", function (e) {
  var user = getUser(userID);

  var text = $(".text.self")[0];
  e.preventDefault();
  var step = 1;
  if (size <= 2) {
    step = 0.2;
  } else if (size < 4) {
    step = 0.6;
  } else if (size <= 30) {
    step = 1;
  } else {
    step = 2;
  }
  //if !user.mousedown // can remove this all if I fix the scroll stroke
  if(true){
    if (e.deltaY > 0) {
      //scrolling down
      if (size - 0.4 > 0) {
        if(user.mousedown){
          ctx.stroke();
          ctx.beginPath();
          ctx2.clearRect(0,0,boardDim[1],boardDim[0]);
          ctx2.stroke();
          ctx2.beginPath();
          
          current_line=[];
        }
        
        size = size - step;
        cursor_circle.setAttribute("r", size);
        size = Math.round(size * 100) / 100;

        
        
        text.style.fontSize = (size + 5).toString() + "px";
        
        ctx.lineWidth = size * 2;
        self.size = size;
        
        
        send({ command: "broadcast", type: "ChS", size: size, id: userID });

      }
    } else {
      //scrolling up
      if (size+2 < 100) {
        if(user.mousedown){
          ctx.stroke();
          ctx.beginPath();
          ctx2.clearRect(0,0,boardDim[1],boardDim[0]);
          ctx2.stroke();
          ctx2.beginPath();
          current_line=[];
        }
        size = size + step;
        size = Math.round(size * 100) / 100;
        
        
        
        cursor_circle.setAttribute("r", size);

        text.style.fontSize = (size + 5).toString() + "px";

        ctx.lineWidth = size * 2;
        self.size = size;
        
        
        
        
        send({ command: "broadcast", type: "ChS", size: size, id: userID });
      }
    }
    }
});

document.addEventListener("keydown", function (e) {
  console.log(e.target)
  send({ command: "broadcast", type: "kp", key: e.key, id: self.id });
  var user = getUser(self.id);
  if (self.tool == "text") {
    var input = $(".textInput.self")[0];
    var key = e.key
    if (e.key.length == 1) {
      if(key==" "){
        
        key="&nbsp;";
      }
      input.innerHTML = input.innerHTML + key;
      user.text = user.text + key;
    }

    switch (e.key) {
      case "Enter":
        input.innerHTML = "";
        user.text = "";
        break;
      case "Backspace":
        if (input.innerHTML) {
          input.innerHTML = input.innerHTML.slice(0, -1);
          user.text = user.text.slice(0, -1);
        }
    }
  }
});

function drawDot(pos, ctx, user){
  var userCtx = user.context;
  if (user.tool == "brush") {
    ctx.beginPath()
    ctx.strokeStyle='rgba('+user.color.toString()+')';
    ctx.lineWidth = user.size * 2;
    ctx.moveTo(pos.x,pos.y);
    ctx.lineTo(pos.x,pos.y);
    
    var noAlpha = [user.color[0],user.color[1],user.color[2]];
    var alpha = user.color[3];
    topBoard.style.opacity=alpha;
    userCtx.strokeStyle='rgb('+noAlpha.toString()+')';
    userCtx.lineCap="round";
    userCtx.lineWidth=user.size*2;
    userCtx.beginPath();
    userCtx.moveTo(pos.x,pos.y);
    userCtx.lineTo(pos.x,pos.y);
    userCtx.stroke();
  }
}

function drawLine(pos, lastpos, user) {

  var alpha = user.color[3];
  var noAlpha = [user.color[0],user.color[1],user.color[2]];
  
  topBoard.style.opacity=alpha;

  ctx2.lineCap="round";
  ctx2.lineWidth=user.size*2;
  ctx2.strokeStyle='rgb('+noAlpha.toString()+')';
  ctx2.beginPath();
  
  ctx2.moveTo(lastpos.x,lastpos.y);
  ctx2.lineTo(pos.x,pos.y);
  ctx2.stroke();
  
  ctx.lineWidth = user.size * 2;
  //ctx.translate(0.5, 0.5);
  ctx.strokeStyle='rgba('+user.color.toString()+')';
  ctx.moveTo(lastpos.x, lastpos.y);
  ctx.lineTo(pos.x, pos.y);
  current_line.push(pos);
  
  user.lastx = pos.x;
  user.lasty = pos.y;
}

function drawText(user) {
  ctx.globalCompositeOperation="source-over";
  var size = (user.size + 5).toString();
  var text = user.text.replaceAll("&nbsp;"," ");
  ctx.beginPath();
  ctx.fillStyle='rgba('+user.color.toString()+')';
  ctx.font = size + "px sans-serif";
  ctx.fillText(text, user.x + 105, user.y + 92 + user.size + 5);
  user.text="";
}

function updateText(key, user) {
  console.log(user);
  var input = $("." + user.id.toString() + " .textInput")[0];
  if (key.length == 1) {
    input.innerHTML = input.innerHTML + key;
    user.text = user.text + key;
  }
  switch (key) {
    case "Enter":
      input.innerHTML = "";
      user.text = "";
      break;

    case "Backspace":
      if (input.innerHTML) {
        var newtext = input.innerHTML.slice(0, -1);
        input.innerHTML = newtext;
        user.text = newtext;
      }
      break;
  }
}

function erase(x1, y1, x2, y2,size) {
  ctx.lineWidth = size;
  ctx.strokeStyle = 'rgba(255,255,255,1)';
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

}


function updateColor(color,id){
  var user = getUser(id);
  updateUser(user,{color:color},['color']);
}

function moveCursor(data) {
  var id = data.id.toString();
  var x = data.x;
  var y = data.y;
  var cursor = $(".cursor"+"."+id)[0];
  cursor.style.left = x.toString() + "px";
  cursor.style.top = y.toString() + "px";
}

function updateUser(user, data, fields) {
  for (var i = 0; i < fields.length; i++) {
    var val = fields[i];
    user[val] = data[val];
  }
}

var clearBtn = $("#clearBtn")[0];
clearBtn.addEventListener("click", function () {
  clearBoard();
  send({ command: "broadcast", type: "clear", id: userID });
});

var brushBtn = $("#brushBtn")[0];
var textBtn = $("#textBtn")[0];
var eraseBtn = $("#eraseBtn")[0];

brushBtn.addEventListener("click", function () {
  ctx.globalCompositeOperation="source-over";
  var user = getUser(userID);
  var index = users.indexOf(user);
  users[index].tool = "brush";
  send({ command: "broadcast", type: "ChT", tool: "brush", id: self.id });
  $(".text.self")[0].style.display = "none";
  $(".circle.self")[0].style.display = "block";
  userlistEntry.children[0].children[0].remove();
  userlistEntry.children[0].appendChild(icons.brush);
});

textBtn.addEventListener("click", function () {
  
  ctx.globalCompositeOperation="source-over";
  var user = getUser(userID);
  var index = users.indexOf(user);
  users[index].tool = "text";
  send({ command: "broadcast", type: "ChT", tool: "text", id: self.id });
  $(".text.self")[0].style.display = "block";
  $(".circle.self")[0].style.display = "none";
  
  userlistEntry.children[0].children[0].remove();
  userlistEntry.children[0].appendChild(icons.text);
});

eraseBtn.addEventListener("click", function () {
  
  ctx.globalCompositeOperation="destination-out";
  topBoard.style.opacity=1;
  var user = getUser(userID);
  var index = users.indexOf(user);
  users[index].tool = "erase";
  send({ command: "broadcast", type: "ChT", tool: "erase", id: self.id });
  $(".text.self")[0].style.display = "none";
  $(".circle.self")[0].style.display = "block";
  
  userlistEntry.children[0].children[0].remove();
  userlistEntry.children[0].appendChild(icons.erase);
});



function clearBoard() {
  console.log("clearing board");
  ctx.fillStyle = "#FFF";
  ctx.beginPath();
  ctx.fillRect(0, 0, boardDim[1], boardDim[0]);
  ctx2.fillStyle="#FFF";
  ctx2.beginPath();
  ctx2.fillRect(0,0,boardDim[1],boardDim[0]);
}

function drawUser(data, id) {
  var user = getUser(id);
  //draw each user with its current data from the server
  console.log("drawing user: ");
  console.log(data);
  var cursor = $("<div></div>")[0];
  cursor.setAttribute("class", "cursor " + id.toString());
  cursor.style.left = data.x.toString() + "px";
  cursor.style.top = data.y.toString() + "px";

  var svg = document.createElementNS("http://www.ww3.org/2000/svg", "svg");
  svg.setAttribute("height", "202px");
  svg.setAttribute("width", "202px");
  var circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  circle.setAttribute("class", id.toString());
  circle.setAttribute("stroke", "grey");
  circle.setAttribute("stroke-width", "1");
  circle.setAttribute("fill", "none");
  circle.setAttribute("cx", "100");
  circle.setAttribute("cy", "100");
  circle.setAttribute("r", "10");
  circle.setAttribute("height", "auto");
  var cursors = $(".cursors")[0];
  var name = $("<text>" + id.toString() + "</text>")[0];
  name.setAttribute("class", "name " + id.toString());
  var text = $("<text></text>")[0];
  text.setAttribute("class", "text " + id.toString());
  text.style.width = "400px";
  text.style.color='rgba('+data.color.toString()+')';
  text.style.fontSize = (data.size + 5).toString() + "px";
  var line = $("<text>|</text>")[0];
  var textinput = $("<text></text>")[0];
  textinput.setAttribute("class", "textInput " + id.toString());
  textinput.innerHTML = data.text;
  text.appendChild(textinput);
  text.appendChild(line);
  svg.appendChild(circle);
  cursor.appendChild(svg);
  cursor.appendChild(name);
  cursor.append(text);

  cursors.appendChild(cursor);
  
  
  var userBoards = $("#userBoards")[0];
  
  //set up the temp board for creating lines per user
  var userBoard = $("<canvas></canvas>")[0];
  userBoard.setAttribute("height",boardDim[0]);
  userBoard.setAttribute("width",boardDim[1]);
  
  
  userBoard.setAttribute("class","userBoard "+id.toString());
  userBoards.appendChild(userBoard);
  var context = [userBoard.getContext("2d"),id];
  user.board = userBoard;
  user.context=context;
}

//setup color picker
var pickerParent = $("#colorPicker")[0];
var picker = new Picker({
            parent: pickerParent,
            popup: false,
            alpha: true,
            editor: true,
            color: '#000',
            onChange: function(color) {
              var input = $(".text.self")[0];
              var user = getUser(userID);
              input.style.color='rgba('+user.color.toString()+')';
              var rgba = color.rgba;
              self.color=rgba;
              user.color=rgba;
              if(connected==true){
                send({command:"broadcast",type:"ChC",color:rgba,id:userID});
              }
              userlistEntry.children[1].style.backgroundColor='rgba('+user.color.toString()+')';
            },
          });

window.addEventListener("resize", (e) => {
  var newHeight = document.body.scrollHeight;
  var newWidth = document.body.clientWidth;
  console.log("old height, width: ",height,width);
  console.log("new height,width: ",newHeight,newWidth);
})
  

function parseGihFile(data) {
  // Use a DataView to read the binary data in the file
  var view = new DataView(data);

  // Extract the metadata from the file
  var magicNumber = view.getUint32(0); // Should be "GIMP"
  console.log("magic Number: ",magicNumber);
  var numFrames = view.getUint32(4);
  console.log("number of frames:",numFrames);
  var width = view.getUint32(8);
  console.log("width: ",width);
  var height = view.getUint32(12);
  console.log("height: ",height);

  // Extract the frame data and create image objects for each frame
  var frames = [];
  for (var i = 0; i < numFrames; i++) {
    var offset = view.getUint32(16 + i * 4);
    var frameData = data.slice(offset);
    var image = new Image();
    image.src = 'data:image/x-gimp-brush;base64,' + btoa(String.fromCharCode.apply(null, frameData));
    frames.push(image);
  }

  return frames;
}

function parseGbrFile(data) {
  // Use a DataView to read the binary data in the file
  var view = new DataView(data);

  // Extract the magic number from the file
  var magicNumber = view.getUint32(0); // Should be "GIMP"
  console.log("magic Number: ",magicNumber);
  // Extract the metadata from the file
  var unknown = view.getUint32(4);
  console.log("unknown: ",unknown);
  var width = view.getUint32(8);
  console.log("width: ",width);
  var colorDepth = view.getUint16(12);
  console.log("colorDepth: ",colorDepth);
  var height = view.getUint16(14);
  console.log("height: ",height);
  var offset = view.getUint32(16);
  console.log("offset: ",offset);

  // Extract the brush data and create an image object
  var brushData = data.slice(unknown);
  var image = new Image();
  console.log(brushData);
  
  const uint8Array = new Uint8Array(brushData);
  
  image.src =  URL.createObjectURL(new Blob([uint8Array]));
  console.log(image);
  ctx.drawImage(image,0,0);
  return image;
}



var gimpOutput = null;

document.getElementById('gimp-file-input').addEventListener('change', function(event) {
  // File selected by the user
  var file = event.target.files[0];
  var fileType = file.name.split(".")[1];
    
  var fileReader = new FileReader();
  

  var arrayBuffer = fileReader.readAsArrayBuffer(file);
  var data = new KaitaiStream(arrayBuffer);
  console.log(data);
});



