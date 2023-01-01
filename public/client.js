var height = document.body.scrollHeight;
var width  = document.body.scrollWidth;
var boardDim=[540,960];


var users = [];

var userID = Math.floor(Math.random() * 999999);
var boards = $("#boards")[0];

var board = $("#board")[0];
var topBoard = $("#topBoard")[0];

var cursorsSvg=$("#cursorsSvg")[0];
cursorsSvg.height=height;
cursorsSvg.width=width;

var cursor = $(".cursor.self")[0];
var cursor_circle = $(".circle.self")[0];

cursor_circle.height=200+"px";
cursor_circle.width=200+"px";

var userlistEntry = $(".userEntry.self")[0];
var userlistName = $(".listUser.self")[0];






var defaultZoom = Math.round(0.9*$("#boardContainer").width()/boardDim[1]*100)/100 
console.log("zoom: ",defaultZoom);
var zoom = defaultZoom;
zoomBoard(zoom,0,0);
var defaultPanX = 25-50*(1-zoom)*10
var defaultPanY = 50//50+50*(1-zoom)*10

var panX = defaultPanX;
var panY = defaultPanY;
moveBoard(panX,panY);



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

var joinBtn = $("#joinBtn")[0];
var usernameInput = $("#usernameInput")[0];

var brushBtn = $("#brushBtn")[0];
var textBtn = $("#textBtn")[0];
var eraseBtn = $("#eraseBtn")[0];
var gimpBtn = $("#gimpBtn")[0];

var clearBtn = $("#clearBtn")[0];
var resetBtn = $("#resetBtn")[0];

clearBtn.addEventListener("click", function () {
  clearBoard();
  send({ command: "broadcast", type: "clear", id: userID });
});

resetBtn.addEventListener("click",function(){
  resetBoard();
})


var blendMode = $("#blendMode")[0];

/*
//for user later on btn clicks, to hide and show these options
var gimpPreview = $("#gimpImage")[0];
var gimpInput = $("#gimp-file-input")[0];
gimpPreview.style.display="none";
gimpInput.style.display="none";
*/

//set default values for your user list entry
userlistEntry.children[0].appendChild(icons.brush.cloneNode());
userlistName.innerHTML=userID;


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
  panning: false,
  username:"",
  context:ctx2,
  board:board,
  id: userID,
  gBrush: null,
  blendMode: "source-over",
  currentLine: [],
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
      
    case "pan":
      user.panning=data.value;
      break;
      
    case "Mm":
      
      
      //if user has no lastpos, make it the current pos
      if (user.lastx == null) {
        user.lastx = data.x;
        user.lasty = data.y;
      }
      moveCursor(data,user);
      updateUser(user, data, ["x", "y"]);
      var pos = { x: user.x, y: user.y };
      var lastpos = { x: user.lastx, y: user.lasty };
      if(!user.panning){
        if (user.mousedown && user.tool == "brush") {
          drawLine(pos, lastpos, user);
          user.currentLine.push(pos);
          drawLineArray(user.currentLine,user.context,user)
        }
        if(user.mousedown && user.tool == "erase"){
          erase(pos.x,pos.y,lastpos.x,lastpos.y,user.size*2);
        }
        if(user.mousedown && user.tool == "gimp" && user.gBrush){
          drawGimp(user,pos);
        }
      }
      user.lastx=data.x;
      user.lasty=data.y;
      break;

    case "Md":
      user.lastx = user.x;
      user.lasty = user.y;
      
      user.spaceIndex=0;
      
      var pos = { x: user.x, y: user.y };
      if (user.tool == "brush" && !user.panning) {
        
        //ctx.lineCap = "round";
        //ctx.beginPath();
        
        user.currentLine.push(pos);
        //drawLine(pos, pos, user);
      }
      if (user.tool == "text" && user.text != "") {
        drawText(user);
        user.text = "";
        var input = $("." + user.id.toString() + " .textInput")[0];
        input.innerHTML = "";
      }
      if(user.tool == "erase" && !user.panning){
        erase(pos.x,pos.y,pos.x,pos.y,user.size*2);
      }
      if(user.tool =="gimp" && user.gBrush && !user.panning){
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
        ctx2.clearRect(0,0,boardDim[1],boardDim[0]);
        user.context.clearRect(0,0,boardDim[1],boardDim[0]);
      }
      user.currentLine=[];
      user.mousedown = false;
      break;

    case "ChSi":
      //change the size
      updateUser(user, data, ["size"]);
      var userText = $("." + user.id.toString() + " .text")[0];
      userText.style.fontSize = (data.size + 5).toString() + "px";
      
      var userCtx = user.context;
      if(user.mousedown){
        ctx.stroke();
      }
      ctx.beginPath();
      ctx2.clearRect(0,0,boardDim[1],boardDim[0]);
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
  

  var x = e.offsetX; //x position within the element.
  var y = e.offsetY;  //y position within the element.
  
  
  var user = getUser(userID);
  user.x = x;
  user.y = y;
  //set your cursor pos
  cursor.style.left = e.pageX-100 + "px";
  cursor.style.top = e.pageY-100 + "px";
  
  send({ command: "broadcast", type: "Mm", x: user.x, y: user.y, id: userID });
  var lastpos = { x: user.lastx, y: user.lasty };
  var pos = { x: self.x, y: self.y };
  if (lastpos.x == null) {
    lastpos = pos;
  }
  if(user.panning && user.mousedown){
    panX = panX + e.movementX
    panY = panY + e.movementY 
    moveBoard(panX,panY);
  }
  if(!user.panning){
    if (user.mousedown && user.tool == "brush") {
      drawLine(pos, lastpos, user);
      current_line.push(pos);
      //ctx2.beginPath();
      ctx2.clearRect(0,0,boardDim[1],boardDim[0]);
      drawLineArray(current_line, ctx2, user);

      //get distance between points, rounded to two decimal places
      line_length += manhattanDistance(pos,lastpos);
    }
    if (user.mousedown && user.tool == "erase"){
      erase(pos.x,pos.y,lastpos.x,lastpos.y,user.size*2);
    }
    if(user.mousedown && user.gBrush && user.tool == "gimp"){
      drawGimp(user,pos);
    }
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

  if (user.tool == "brush" && !user.panning) {
    current_line.push(pos);
    drawDot(pos,ctx,user);
    drawDot(pos,userCtx,user);
  }
  
  if (user.tool == "text" && user.text != "") {
    drawText(user);
    user.text = "";
    var input = $(".textInput.self")[0];
    input.innerHTML = "";
  }
  
  if (user.tool == "erase" && !user.panning){
    erase(pos.x,pos.y,user.lastx,user.lasty,user.size*2);
  }
  if(user.tool == "gimp" && !user.panning ){
    if(user.gBrush){
      drawGimp(user,pos);
    }
  }
});

board.addEventListener("mouseup", function (e) {
  var user = getUser(userID);
  self.mousedown = false;
  user.mousedown = false;
  if(user.tool=="brush" && !user.panning ){
    ctx.stroke();
    ctx2.beginPath();
    ctx2.clearRect(0,0,boardDim[1],boardDim[0]);
    
  }
  
  send({ command: "broadcast", type: "Mu", id: userID });
  var line = { path: current_line, id: userID };
  current_line = [];
  line_length = 0;
});



board.addEventListener("mouseout",function(e){
  var user = getUser(userID);
  self.mousedown = false;
  user.mousedown = false;
  if(user.tool=="brush" && !user.panning ){
    ctx.stroke();
    ctx2.beginPath();
    ctx2.clearRect(0,0,boardDim[1],boardDim[0]);
    
  }
  
  send({ command: "broadcast", type: "Mu", id: userID });
  var line = { path: current_line, id: userID };
  current_line = [];
  line_length = 0;
  
});

board.addEventListener("wheel", function (e) {
  e.preventDefault();
  var user = getUser(userID);
  
  if(user.panning){
    var zoomStep = 0.1; 
    if(e.deltaY > 0){
      if(zoom-zoomStep > 0.2){
        zoom-=zoomStep
        var zoomPos = {x:user.x,y:user.y};
        zoomBoard(zoom,zoomPos);
      }
      //scrolling down
      
    }
    if(e.deltaY < 0){
      //scrolling up
      if(zoom+zoomStep < 3)
      zoom+=zoomStep
      var zoomPos = {x:user.x,y:user.y}; 
      zoomBoard(zoom,zoomPos);
    }
  }
  if(!user.panning){
    var sizeSlider = $(".slider.size")[0];
    var size = Number(sizeSlider.value);

    var text = $(".text.self")[0];

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
  }
});

document.addEventListener("keydown", function (e) {
  var user = getUser(self.id);
  
  //this preventDefault stops "quick search" from appearing when you press these keys
  if(e.key=="/" || e.key=="'"){
    e.preventDefault();
  }
  if(e.key==" " && user.tool!="text" && !user.panning && !user.mousedown ){
    user.panning="true"
    send({ command: "broadcast", type: "pan", value: true, id: self.id });
  }
  send({ command: "broadcast", type: "kp", key: e.key, id: self.id });
  
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

document.addEventListener("keyup",function(e){
  var user = getUser(userID);
  if(e.key==" " && user.tool!="text"){
    user.panning=false;
    send({ command: "broadcast", type: "pan", value: false, id: self.id }); 
  }
});

function moveBoard(x,y){
  var boards = $("#boards")[0];
  boards.style.top = y+"px";
  boards.style.left = x+"px";
}

function zoomBoard(zoom,boardPos){
  //boardPos is the relative position of the cursor on the board {x,y}
  console.log("changing board size to: ",zoom);
  var user = getUser(userID);
  var boards = $("#boards")[0];
  var x = boardPos.x+"px";
  var y = boardPos.y+"px";
  var tOrigin = x+" "+y;
  boards.style.transformOrigin=x+" "+y; 
  boards.style.scale = zoom;
  cursor_circle.style.transformOrigin="center";  
  cursor_circle.style.scale=zoom;  
  $(".text.self")[0].style.transformOrigin="top left";
  $(".text.self")[0].style.scale=zoom;
  $(".text.self")[0].style
}

function resetBoard(){ 
  $("#boards")[0].style.scale=defaultZoom;
  moveBoard(defaultPanX,defaultPanY);
  
}

function clearBoard() {
  ctx.beginPath();
  ctx2.beginPath();
  ctx.clearRect(0, 0, boardDim[1], boardDim[0]);
  ctx2.clearRect(0,0,boardDim[1],boardDim[0]);
}

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

//used for getting line length approximation
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
  
  //topBoard.style.opacity=alpha;
  //this doesnt work unless I draw the whole line at once, stroke breaks it
  //ctx2.globalCompositeOperation=blendMode.value;
  /*
  ctx2.lineCap="round";
  ctx2.lineWidth=user.size*2;
  ctx2.strokeStyle='rgb('+noAlpha.toString()+')';
  ctx2.beginPath();
  
  ctx2.moveTo(lastpos.x,lastpos.y);
  ctx2.lineTo(pos.x,pos.y);
  ctx2.stroke();
  */
  ctx.lineWidth = user.size * 2;
  ctx.strokeStyle='rgba('+user.color.toString()+')';
  ctx.moveTo(lastpos.x, lastpos.y);
  ctx.lineTo(pos.x, pos.y);
  
  user.lastx = pos.x;
  user.lasty = pos.y;
}

function drawLineArray(points,ctx, user){
  
  var tension = 0.5;
  var numOfSegments = 50// Math.round(line_length/20);
  //var interpolatedPoints = splineInterpolation(points, tension, numOfSegments);
  var interpolatedPoints = calcCatmullRomCurve(points, tension)
  ctx.globalCompositeOperation = user.blendMode;
  board.getContext("2d").globalCompositeOperation= user.blendMode;
  
  var alpha = user.color[3];
  var noAlpha = [user.color[0],user.color[1],user.color[2]];
  //var spacing = user.spacing;

  topBoard.style.opacity=alpha;
  ctx.strokeStyle='rgb('+noAlpha.toString()+')';
  ctx.lineWidth=user.size*2;
  
  ctx.beginPath();
  ctx.moveTo(interpolatedPoints[0].x,interpolatedPoints[0].y);
  for(var i=1;i<interpolatedPoints.length;i++){
    ctx.lineTo(interpolatedPoints[i].x,interpolatedPoints[i].y);
  }
  ctx.stroke();
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


function moveCursor(data,user) {
  var id = data.id.toString();
  var x = user.x+panX;
  var y = user.y+panY;
  console.log("moving cursor to: ",x,y);
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


joinBtn.addEventListener("click", function(){
  $("#overlay")[0].style.display="none";
  cursor.style.display="block";
  var value = usernameInput.value;
  if(value==""){
    value="Anon";
  }
  var boardName = $(".name.self")[0];
  var listName = $(".listUser.self")[0];
  boardName.innerHTML = value;
  listName.innerHTML = value;
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
  var context = userBoard.getContext("2d");
  context.lineCap="round"
  user.board = userBoard;
  user.context = context;
  

  
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

    
  }
});

/*
blendMode.addEventListener("change",function(e){
  var user = getUser(userID);
  console.log("change! ",this.value)
  var mode = this.value;
  user.blendMode = mode;
  ctx.globalCompositeOperation = mode;
  send({ command: "broadcast", type: "ChBl", blendMode: mode, id: userID });
});

*/


window.addEventListener("resize", (e) => {
  var newHeight = document.body.scrollHeight;
  var newWidth = document.body.clientWidth;
});
  




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
        self.gBrush = gihObject;
        user.gBrush = gihObject;
        
        send({command:"broadcast",type:"gimp",gimpData:gihObject,id:userID});
      }
    }

  reader.readAsArrayBuffer(file);
});  




joinBtn.click();


