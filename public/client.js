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


var boardDim=[400,240];

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
var line_length = 0;

var connected=false;


var sizeSlider = $(".slider.size")[0];
var spacingSlider = $(".slider.spacing")[0];
sizeSlider.value = size;
sizeSlider.step = 1;

var icons={
  brush:$("<img class='toolIcon' src='/images/brush-icon.svg' />")[0],
  text:$("<img class='toolIcon' src='/images/text-icon.svg' />")[0],
  erase:$("<img class='toolIcon' src='/images/eraser-icon.svg' />")[0],
  gimp:$("<img class='toolIcon' src='/images/pepper.png' />")[0]
}


var brushBtn = $("#brushBtn")[0];
var textBtn = $("#textBtn")[0];
var eraseBtn = $("#eraseBtn")[0];
var gimpBtn = $("#gimpBtn")[0];

var clearBtn = $("#clearBtn")[0];

var blendMode = $("#blendMode")[0];



//set default values for your user list entry
userlistEntry.children[0].appendChild(icons.brush.cloneNode());
userlistEntry.children[2].innerHTML=userID;


var self = {
  x: 0,
  y: 0,
  lastx: null,
  lasty: null,
  size: 10,
  spacing: 0,
  spaceIndex: 0,
  color: "#000",
  tool: "brush",
  text: "",
  mousedown: false,
  username:"",
  context:ctx2,
  board:board,
  id: userID,
  gBrush: null,
  blendMode: "source-over",
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
          current_ids.indexOf(user.id) == -1 &&
          user.id != userID
        ) {
          users.push(user.userdata);
          drawUser(user.userdata, user.id);
          var userTool = $("." + user.id.toString() + " .listTool")[0];
          var userCol = $("." + user.id.toString() + " .listColor")[0];
          userCol.style.backgroundColor = user.color;
          if(user.tool=="brush"){
            userTool.appendChild(icons.brush);
          }
        }
      }
      break;
    case "connect":
      break;
    case "userLeft":
      //when a user leaves, update the user list and remove the users DOM objects
      
      var user_objs = $("." + data.id.toString());
      for(var i=0;i<user_objs.length;i++){
        if(user_objs[i]){
          user_objs[i].remove();
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
  //process recieved broadcast events
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
      if(user.mousedown && user.tool == "gimp" && user.gBrush){
        drawGimp(user,pos);
      }
      user.lastx=data.x;
      user.lasty=data.y;
      break;

    case "Md":
      user.lastx = user.x;
      user.lasty = user.y;
      
      user.spaceIndex=0;
      
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
      if(user.tool =="gimp" && user.gBrush){
        drawGimp(user,pos);
      }
      
      ctx2.beginPath();
      ctx2.clearRect(0,0,boardDim[1],boardDim[0]);
      
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

    case "ChSi":
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
      
    case "ChSp":
      updateUser(user,data,["spacing"]);
      break;
    case "ChBl":
      updateUser(user,data,["blendMode"]);
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
      if (data.tool == "erase") {
        userText.style.display = "none";
        userCircle.style.display = "block";
      }
      if (data.tool == "gimp") {
        userText.style.display = "none";
        userCircle.style.display = "block";
      }
      var listTool = $("." + user.id.toString() + " .listTool")[0];
      var userIcon = null;
      switch(data.tool){
        case "brush":
          userIcon=icons.brush;
          break;
        case "text":
          userIcon=icons.text;
          break;
        case "erase":
          userIcon=icons.erase;
          break;
        case "gimp":
          userIcon=icons.gimp;
          break;
      }
      listTool.children[0].remove();
      listTool.append(userIcon.cloneNode());
      break;
    case "ChC":
      //change color
      var color = 'rgba('+user.color.toString()+')';
      var userText = $("." + user.id.toString() + " .text")[0];
      var listColor = $("." + user.id.toString() + " .listColor")[0];
      userText.style.color = color;
      listColor.style.backgroundColor = color;
      updateColor(data.color,user.id);
      break;
    case "kp":
      //keypress
      if (user.tool == "text") {
        updateText(data.key, user);
      }
      break;
    case "gimp":
      //load gimp brush data
      console.log(data.gimpData);
      if(data.gimpData.type=="gbr"){
        user.gBrush=data.gimpData;

        //create an image from the datastream url
        var image = new Image();
        image.src = user.gBrush.gimpUrl;
        image.height = height;
        image.width = width;
        //updates the user gbr image for drawing
        user.gBrush.image = image;
      }
      if(data.gimpData.type=="gih"){
        var images = [];
        
        var gihObject = data.gimpData;
        
        for(var i=0;i<gihObject.gBrushes.length;i++){
          
          
          var gbrObject = gihObject.gBrushes[i];
          
          var gimpImage = new Image();
          gimpImage.src = gbrObject.gimpUrl;
          gimpImage.height = height;
          gimpImage.width = width;
          images.push(gimpImage);
          
        }
        
        gihObject.type = "gih";
        gihObject.index = 0;
        gihObject.images = images;
        console.log(gihObject);
        user.gBrush = gihObject;
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
    current_line.push(pos);
    //get distance between points, rounded to two decimal places
    line_length += manhattanDistance(pos,lastpos);
  }
  if (user.mousedown && user.tool == "erase"){
    erase(pos.x,pos.y,lastpos.x,lastpos.y,user.size*2);
  }
  if(user.mousedown && user.gBrush && user.tool == "gimp"){
    drawGimp(user,pos);
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
  user.spaceIndex = 0;
  self.spaceIndex = 0;

  if (user.tool == "brush") {
    ctx2.beginPath();
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
  if(user.tool == "gimp"){
    if(user.gBrush){
      drawGimp(user,pos);
    }
  }
});

board.addEventListener("mouseup", function (e) {
  var user = getUser(userID);
  self.mousedown = false;
  user.mousedown = false;
  if(user.tool=="brush"){
    ctx.stroke();
    ctx2.stroke();
    ctx2.beginPath();
    ctx2.clearRect(0,0,boardDim[1],boardDim[0]);
    
  }
  
  send({ command: "broadcast", type: "Mu", id: userID });
  var line = { path: current_line, id: userID };
  current_line = [];
  console.log("approx line length: ",line_length);
  line_length = 0;
});

board.addEventListener("wheel", function (e) {
  
  var sizeSlider = $(".slider.size")[0];
  var size = Number(sizeSlider.value);
  
  var user = getUser(userID);

  var text = $(".text.self")[0];
  e.preventDefault();
  var step = 1;

  if (size < 2) {
    step = 0.25;
  } else if (size < 4) {
    step = 0.5;
  } else if (size <= 30) {
    step = 1;
  } else {
    step = 2;
  }
  sizeSlider.step=step;
  if (e.deltaY > 0) {
    //scrolling down
    if(size==2){
      step = 0.25;
    }
    if (size - 0.3 > 0) {
      if(user.mousedown){
        ctx.stroke();
        ctx.beginPath();
        ctx2.clearRect(0,0,boardDim[1],boardDim[0]);
        ctx2.stroke();
        ctx2.beginPath();

        current_line=[];

      }

      size = size - step;

      size = Math.round(size * 100) / 100;
      cursor_circle.setAttribute("r", size);


      text.style.fontSize = (size + 5).toString() + "px";

      ctx.lineWidth = size * 2;
      self.size = size;
      user.size = size;
      
      sizeSlider.value=size;

      send({ command: "broadcast", type: "ChSi", size: size, id: userID });

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
      user.size = size;
      
      sizeSlider.value=size;

      send({ command: "broadcast", type: "ChSi", size: size, id: userID });
    }
  }
    
});

document.addEventListener("keydown", function (e) {
  e.preventDefault();
  
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
          if(input.innerHTML.slice(-6)=='&nbsp;'){

              input.innerHTML = input.innerHTML.slice(0, -6);
              user.text = user.text.slice(0, -6);
            }
          else{
            input.innerHTML = input.innerHTML.slice(0, -1);
            user.text = input.innerHTML.slice(0, -1);
          }
        }
    }
  }
  else{
    switch(e.key){
      case "b":
        brushBtn.click();
        break;
      case "t":
        textBtn.click();
        break;
      case "e":
        eraseBtn.click();
        break;
      case "g":
        gimpBtn.click();
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

//used for getting line length approx
function manhattanDistance(pos,lastpos){
  if(pos!=lastpos){
    var distance = Math.abs(pos.x - lastpos.x) + Math.abs(pos.y - lastpos.y);
    return distance
  }
}

function drawLine(pos, lastpos, user) {

  var alpha = user.color[3];
  var noAlpha = [user.color[0],user.color[1],user.color[2]];
  //var spacing = user.spacing;

  topBoard.style.opacity=alpha;
  ctx2.globalCompositeOperation=blendMode.value;
  
  ctx2.lineCap="round";
  ctx2.lineWidth=user.size*2;
  ctx2.strokeStyle='rgb('+noAlpha.toString()+')';
  
  
  ctx2.moveTo(lastpos.x,lastpos.y);
  ctx2.lineTo(pos.x,pos.y);
  ctx2.stroke();
  
  ctx.lineWidth = user.size * 2;
  ctx.strokeStyle='rgba('+user.color.toString()+')';
  ctx.moveTo(lastpos.x, lastpos.y);
  ctx.lineTo(pos.x, pos.y);
  
  user.lastx = pos.x;
  user.lasty = pos.y;
}

function drawLineArray(posArray, user){
  var alpha = user.color[3];
  
}

function drawText(user) {
  ctx.globalCompositeOperation="source-over";
  var size = (user.size + 5).toString();
  var text = user.text.replaceAll("&nbsp;"," ");
  ctx.beginPath();
  ctx.fillStyle='rgba('+user.color.toString()+')';
  ctx.font = size + "px Newsreader, serif";
  ctx.fillText(text, user.x + 5, user.y -6 + user.size + 5);
  user.text="";
}


function drawGimp(user,pos){
  var spacingTest = true;
  if(user.spacing != 0){
    if(user.spaceIndex != 0){
      var spacingTest = false;
    }
    //increments spacing index to know when to draw
    user.spaceIndex = (user.spaceIndex+1)%user.spacing;
  }
  if(spacingTest){
    
    var size = user.size
    var gBrush = user.gBrush;
    if(gBrush.type=="gbr"){
      var height = gBrush.height;
      var width = gBrush.width;
      var image = gBrush.image;
    }
    if(gBrush.type=="gih"){
      var height = gBrush.cellheight;
      var width = gBrush.cellwidth;
      var image = gBrush.images[gBrush.index];
      //increment the animated brush by one, looping
      gBrush.index=(gBrush.index+1)%gBrush.ncells;
    }

    var ratioX = width/height;
    var ratioY = height/width;


    if(width>height){
      ratioX=1;
    }
    if(height>width){
      ratioY=1;
    }

    ctx.beginPath();
    ctx.fillStyle='rgba('+self.color.toString()+')';
    ctx.drawImage(image,(pos.x-size*ratioX),(pos.y-size*ratioY),size*2*ratioX,size*2*ratioY);
    ctx.stroke();
    
  }
}


function updateText(key, user) {
  var input = $("." + user.id.toString() + " .textInput")[0];
  if (key.length == 1) {
    if(key==" "){
        
        key="&nbsp;";
      
      }
    input.innerHTML = input.innerHTML + key;
    user.text = user.text + key;
  }
  
  switch (key) {
    case "Enter":
      input.innerHTML = "";
      user.text = "";
      break;

    case "Backspace":
      if (input.innerHTML.length>0) {
        if(input.innerHTML.slice(-6)=='&nbsp;'){

            input.innerHTML = input.innerHTML.slice(0, -6);
            user.text = user.text.slice(0, -6);
          }
        else{
          input.innerHTML = input.innerHTML.slice(0, -1);
          user.text = input.innerHTML.slice(0, -1);
        }
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
  var x = data.x-100;
  var y = data.y-100;
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



clearBtn.addEventListener("click", function () {
  clearBoard();
  send({ command: "broadcast", type: "clear", id: userID });
});

brushBtn.addEventListener("click", function () {
  var selectedTool = $(".btn.selected")[0];
  if(selectedTool != this){
    selectedTool.classList.toggle("selected");
    this.classList.toggle("selected");
  }
  
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
  var selectedTool = $(".btn.selected")[0];
  if(selectedTool != this){
    selectedTool.classList.toggle("selected");
  }
  this.classList.add("selected");
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
  var selectedTool = $(".btn.selected")[0];
  if(selectedTool != this){
    selectedTool.classList.toggle("selected");
  }
  this.classList.add("selected");
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

gimpBtn.addEventListener("click", function () {
  var selectedTool = $(".btn.selected")[0];
  if(selectedTool != this ){
    selectedTool.classList.toggle("selected");
  }
  this.classList.add("selected");
  ctx.globalCompositeOperation="source-over";
  var user = getUser(userID);
  var index = users.indexOf(user);
  users[index].tool = "gimp";
  send({ command: "broadcast", type: "ChT", tool: "gimp", id: self.id });
  $(".text.self")[0].style.display = "none";
  $(".circle.self")[0].style.display = "block";
  
  userlistEntry.children[0].children[0].remove();
  userlistEntry.children[0].appendChild(icons.gimp);
});


function clearBoard() {
  ctx.beginPath();
  ctx2.beginPath();
  ctx.clearRect(0, 0, boardDim[1], boardDim[0]);
  ctx2.clearRect(0,0,boardDim[1],boardDim[0]);

}

function drawUser(data, id) {
  var user = getUser(id);
  //create a cursor for each user with their current data from the server
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
  
  if(user.tool !="text"){
    text.style.display="none";
  }
  
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
  user.context = context[0];
  

  
  //create a user object to append to the list

  var userList = $("#userList")[0];
  
  var userEntry = $("<div></div>")[0];
  userEntry.setAttribute("class","userEntry "+id.toString());
  var ulistTool = $("<a></a>")[0];
  var userIcon = null;
  switch(data.tool){
    case "brush":
      userIcon=icons.brush;
      break;
    case "text":
      userIcon=icons.text;
      break;
    case "erase":
      userIcon=icons.erase;
      break;
    case "gimp":
      userIcon=icons.gimp;
  }
  
  ulistTool.setAttribute("class","listTool "+id.toString());
  ulistTool.appendChild(userIcon.cloneNode());
  
  var ulistColor = $("<a></a>")[0];
  ulistColor.setAttribute("class","listColor "+id.toString());
  ulistColor.style.backgroundColor='rgba('+data.color.toString()+')';

  var ulistUser = $("<text></text>")[0];
  ulistUser.setAttribute("class","listUser "+id.toString());
  ulistUser.innerHTML = id.toString();
  var ulistActive = $("<a></a>")[0];
  ulistActive.setAttribute("class","listActive "+id.toString());
  
  
  userEntry.appendChild(ulistTool);
  userEntry.appendChild(ulistColor);
  userEntry.appendChild(ulistUser);
  userEntry.appendChild(ulistActive);
  
  userList.appendChild(userEntry);
  

  
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



sizeSlider.addEventListener("mousemove",function(e){
  
  
  var user = getUser(userID);
  
  if(user.size != sizeSlider.value){
    var text = $(".text.self")[0];

    var step = 1;

    var size = sizeSlider.value;

    send({ command: "broadcast", type: "ChSi", size: size, id: userID });
    cursor_circle.setAttribute("r", size);

    ctx.lineWidth = size * 2;
    
    sizeSlider.value=size;
    self.size = size;
    user.size=size;

    text.style.fontSize = (size + 5).toString() + "px";
    
  }
});


spacingSlider.addEventListener("mousemove",function(e){
  
  var user = getUser(userID);
  
  if(user.spacing != sizeSlider.value){
   
    var spacing = spacingSlider.value;

    send({ command: "broadcast", type: "ChSp", spacing: spacing, id: userID });

    self.spacing = spacing;
    
    user.spacing=spacing;
    
    spacingSlider.value=spacing;
    console.log(spacing);

    
  }
});

blendMode.addEventListener("change",function(e){
  var user = getUser(userID);
  console.log("change! ",this.value)
  var mode = this.value;
  user.blendMode = mode;
  ctx.globalCompositeOperation = mode;
  send({ command: "broadcast", type: "ChBl", blendMode: mode, id: userID });
});





window.addEventListener("resize", (e) => {
  var newHeight = document.body.scrollHeight;
  var newWidth = document.body.clientWidth;
})
  




document.getElementById('gimp-file-input').addEventListener('change', function(event) {
  
  var user = getUser(userID);
   // Get the first selected file
  const file = event.target.files[0];
  
  var fileType = (file.name.split(".")[1]);
  // Create a FileReader
  const reader = new FileReader();

  // Set the onload handler to parse the file
  reader.onload = () => {
    // Get the ArrayBuffer from the FileReader
    const arrayBuffer = reader.result;
      if(fileType=="gbr"){
        var gbrObject = parseGbr(arrayBuffer);
        if(gbrObject){
          
          
          gbrObject.type = "gbr";
          send({command:"broadcast",type:"gimp",gimpData:gbrObject,id:userID});
         
          
          var gimpImagePreview = $("#gimpImage")[0];
          gimpImagePreview.src= gbrObject.gimpUrl;
          
          var gimpImage = new Image();
          gimpImage.src = gbrObject.gimpUrl;
          gimpImage.height = height;
          gimpImage.width = width;
          
          gbrObject.image = gimpImage;
          
          
          self.gBrush = gbrObject;
          user.gBrush = gbrObject;
        }
      }
      if(fileType=="gih"){
        var gihObject = parseGih(arrayBuffer);
        
        var images = [];
        
        
        
        for(var i=0;i<gihObject.gBrushes.length;i++){
          
          
          var gbrObject = gihObject.gBrushes[i];
          
          var gimpImage = new Image();
          gimpImage.src = gbrObject.gimpUrl;
          gimpImage.height = height;
          gimpImage.width = width;
          images.push(gimpImage);
          
        }
        var gimpImagePreview = $("#gimpImage")[0];
        gimpImagePreview.src= gihObject.gBrushes[0].gimpUrl;
        
        gihObject.type = "gih";
        gihObject.index = 0;
        gihObject.images = images;
        console.log(gihObject);
        self.gBrush = gihObject;
        user.gBrush = gihObject;
        
        send({command:"broadcast",type:"gimp",gimpData:gihObject,id:userID});
      }
    }

  reader.readAsArrayBuffer(file);
});  




//helper functions for parseGbr()
function chunkToString(chunk){
  var string="";
  for(var i=0;i<chunk.length;i++){
        var letter = String.fromCharCode(chunk[i.toString()]);
        string+=letter;
  }
  return string
}

function concatChunk(chunk){
  var hexString = ""
  for(var i=0;i<chunk.length;i++){
    var hex = chunk[i.toString()].toString(16);
    if(hex.length==1){
      hex="0"+hex;
    }
    hexString+=hex;
  }
  return hexString
}


function parseGbr(arrayBuffer){
  
  var view = new Uint8Array(arrayBuffer);
  // Create an array to hold the chunks
  var chunks = [];

  // Iterate through the view and extract the chunks
  var headerChunk = view.slice(0,4)
  var headerLength = Number("0x"+concatChunk(headerChunk));
  var chunks = [];
  for(var i=0;i<=27;i=i+4){
    var chunk = view.slice(i,i+4);
    var chunkHex = concatChunk(chunk);
    chunks.push(chunkHex);
  }
  var lastchunk = view.slice(28,headerLength-1);
  var lastchunkHex = chunkToString(lastchunk);
  chunks.push(lastchunkHex);
  
  //extract the values of the bytes in each chunk
  var headerSize = Number("0x"+chunks[0]);
  var version = Number("0x"+chunks[1]);
  var width = Number("0x"+chunks[2]);
  var height = Number("0x"+chunks[3]);
  var colorDepth = Number("0x"+chunks[4]);
  var magicNumber = chunks[5];
  var spacing = Number("0x"+chunks[6]);
  var brushName = chunks[7];
  
  var imageData = view.slice(headerLength,view.length);
  
  
  //Create an object that contains all the information about the brush
  var brushObject = {
    headerSize: headerSize,
    version: version,
    width: width,
    height: height,
    colorDepth: colorDepth,
    magicNumber: magicNumber,
    spacing: spacing,
    brushName: brushName
  };

  
  
  var gimpCanvas = document.createElement("canvas");
  gimpCanvas.height=height;
  gimpCanvas.width=width;
  var gCtx = gimpCanvas.getContext("2d");
  var gimpImageData = gCtx.createImageData(width, height);
  const gData = gimpImageData.data;
  
  //if the image is RGBA
  if(colorDepth==4){
    for (let i = 0; i < gData.length; i += 4) {
      var r = imageData[i];
      var b = imageData[i+2];
      var g = imageData[i+1];
      var a = imageData[i+3];
      gData[i] = r;    // Red value
      gData[i + 1] = g;  // Blue value
      gData[i + 2] = b;  // Green value
      gData[i + 3] = a;  // Alpha value
    }
  }
  
  //if the image is greyscale
  if(colorDepth==1){
    for(let i= 0; i < gData.length; i+=1){
      var v = imageData[i]; // greyscale value
      gData[i*4] = 255-v;    
      gData[i*4 + 1] = 255-v; 
      gData[i*4 + 2] = 255-v;  
      gData[i*4 + 3] = 255;  // Alpha value
    }
  }
  
  gCtx.putImageData(gimpImageData, 0, 0);
  
  var url = gimpCanvas.toDataURL('image/png', 1.0);
  
  brushObject.gimpUrl=url;
  
  return brushObject
}


//helper function for parseGih
function splitUint8Array(array, delimiter) {
  const chunks = [];
  let chunk = [];
  let i = 0;
  for (const value of array) {
    
    if (value === delimiter) {
      chunks.push(chunk);
      chunk = [];
      i+=1;
      if(i==2){
        break;
      }
    } else {
      chunk.push(value);
    }
  }
  if (chunk.length > 0) {
    chunks.push(chunk);
  }
  return chunks;
}


function parseGih(arrayBuffer){
  var view = new Uint8Array(arrayBuffer);
  //Limit size of .gih brush bytes to avoid lag
  if(view.length>1500000){
    alert("Too big!!");
  }
  else{
    //split off the two heading chunks by newline (10 in decimal)
    var chunks = splitUint8Array(view, 10);
    var name =  chunkToString(chunks[0]);
    var info = chunkToString(chunks[1]);

    var infoSplit = info.split(" ");
    var gihObject = {};
    for(var i=1; i<infoSplit.length; i++){
      var splits = infoSplit[i].split(":");
      var head = splits[0];
      var value = splits[1];
      if(Number(value)){
        value = Number(value);
      }
      gihObject[head]=value;
    }
    
    var data = view.slice(chunks[0].length+chunks[1].length+2);
    var colorDepth = data[19];
    var imageBytes = gihObject.cellheight*gihObject.cellwidth*colorDepth;
    

    var indices = [];
    var cellSize = 0;
    
    //an accumulator to store the indices of each image location, for slicing
    var acc = 0;
    
    for(var i=0;i<gihObject.ncells;i++){
      indices.push(acc);
      var headerChunk = data.slice(acc,acc+4);
      var headerLength = Number("0x"+concatChunk(headerChunk));
      var cellSize = imageBytes+headerLength;
      acc+= cellSize;
    }
    indices.push(acc);
    
    var brushes = [];
    
    for(var i=0;i<gihObject.ncells;i++){
      var index = indices[i];
      var current_data = data.slice(index,index+indices[i+1]);
      var current_brush = parseGbr(current_data) ;
      brushes.push(current_brush);
    }
    gihObject.gBrushes=brushes;
      return gihObject
  }
}
