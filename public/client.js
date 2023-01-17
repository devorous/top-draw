$("#overlay").hide()



var height = document.body.scrollHeight;
var width  = document.body.scrollWidth;
var boardDim=[1280,1280];

var mirror = false;
var connected = false;

var mLine = $(".mirrorLine")[0];
mLine.setAttribute("x1",boardDim[1]/2)
mLine.setAttribute("y1",0)
mLine.setAttribute("x2",boardDim[1]/2)
mLine.setAttribute("y2",boardDim[0])
mLine.style.display="none";

var users = [];

var userID = Math.floor(Math.random() * 9999999);
var boards = $("#boards")[0];

var board = $("#board")[0];
var topBoard = $("#topBoard")[0];

var cursorsSvg=$("#cursorsSvg")[0];

var cursor = $(".cursor.self")[0];
var cursor_circle = $(".circle.self")[0];
var cursor_square = $(".square.self")[0];


var userlistEntry = $(".userEntry.self")[0];
var userlistName = $(".listUser.self")[0];


var currentWidth = $("#boardContainer").width()*0.95;
var currentHeight = $("#boardContainer").height()*0.95-30; //30 is the height of the buttons bar
var defaultZoom = Math.round(currentWidth/boardDim[1]*1000)/1000 

var defaultPanX = currentWidth*0.05/2;
var defaultPanY = currentHeight/2-boardDim[0]*defaultZoom/2+30;


if(defaultZoom > Math.round(currentHeight/boardDim[0]*1000)/1000){
  
  defaultZoom = Math.round(currentHeight/boardDim[0]*1000)/1000 
  
  defaultPanX = currentWidth/2-boardDim[1]*defaultZoom/2;
  defaultPanY = currentHeight*0.05/2+30;
  
  
}

var panX = defaultPanX;
var panY = defaultPanY;
var zoom = defaultZoom;

boards.style.transformOrigin = "top left";

moveBoard(panX,panY);
boards.style.scale = zoom;


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
ctx2.lineCap= "round";
ctx2.lineJoin= "round";
ctx.lineCap = "round";
ctx.lineJoin= "round";


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
var mirrorBtn = $("#mirrorBtn")[0];
var mirrorText = $(".mirrorOption")[0];

clearBtn.addEventListener("click", function () {
  clearBoard();
  send({ command: "broadcast", type: "clear", id: userID });
});

resetBtn.addEventListener("click",function(){
  resetBoard();
})

mirrorBtn.addEventListener("click",function(){
  console.log("clicky");
  mirror = !mirror;
  if(mirror){
    mirrorText.text="ON";
  }
  else{
    mirrorText.text="OFF";
  }
  send({command: "broadcast", type: "mirror", id: userID});
})

var blendMode = $("#blendMode")[0];


//for user later on btn clicks, to hide and show these options
var gimpPreview = $("#gimpImage")[0];
var gimpInput = $("#gimp-file-input")[0];
gimpPreview.style.display="none";
gimpInput.style.display="none";


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
  smoothing:3,
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
  lineLength:0,
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
          var listName = $("."+user.id.toString()+".listUser")[0];
          var name = user.userdata.username;
          if(name==""){
            name = user.id;
          }
          listName.innerHTML = name;
          console.log("user in room: ",user);
          console.log("the username: ",user.userdata.username);
          userCol.style.backgroundColor = user.color;
          if(user.tool=="brush"){
            userTool.appendChild(icons.brush);
          }
          if(user.tool!="gimp"){
            $("."+user.id.toString()+".square")[0].style.display="none";
          }
        }
      }
      break;
    case "boardSettings":
      mirror = data.settings.mirror;
      if(mirror){
        mirrorText.value = "ON";
      }
      else{
        mirrorText.value= "OFF";
      }
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
      user.panning = data.value;
      break;
      
    case "Mm":
      
      //if user has no lastpos, make it the current pos
      if (user.lastx == null) {
        user.lastx = data.x;
        user.lasty = data.y;
      }
      
      updateUser(user, data, ["x", "y"]);
      var pos = { x: user.x, y: user.y };
      var lastpos = { x: user.lastx, y: user.lasty };
      
      moveCursor(data,user);
      
      if(!user.panning){

        if (user.mousedown && user.tool == "brush") {
          user.currentLine.push(pos);
          user.context.clearRect(0,0,boardDim[1],boardDim[0]);
        
          drawLineArray(user.currentLine,user.context,user);
          
          if(mirror){
            var nLine = mirrorLine(user.currentLine);
            drawLineArray(nLine,user.context,user);
          }
        }
        if(user.mousedown && user.tool == "erase"){
          erase(pos.x,pos.y,lastpos.x,lastpos.y,user.size*2);
          if(mirror){
            var width=boardDim[1];
            erase(width-pos.x,pos.y,width-lastpos.x,lastpos.y,user.size*2);
          }
        }
        if(user.mousedown && user.tool == "gimp" && user.gBrush){
          drawGimp(user,pos);
        }
      }
      user.lastx = data.x;
      user.lasty = data.y;
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
        drawDot(pos, ctx, user);
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
      
      user.mousedown = true;
      break;

    case "Mu":
      if (user.tool == "brush" && !user.panning) {
  
        drawLineArray(user.currentLine, ctx, user);  
        if(mirror){
          var nLine = mirrorLine(user.currentLine);
          drawLineArray(nLine,ctx,user);
        }
        
        user.context.clearRect(0,0,boardDim[1],boardDim[0]);
      }
      user.currentLine=[];
      user.mousedown = false;
      break;

    case "ChSi":
      //change the size
      
      if(user.mousedown && user.tool=="brush"){
        
        ctx2.stroke();
        user.context.stroke();
        user.context.clearRect(0,0,boardDim[1],boardDim[0]);
        user.context.beginPath();
        
                  
        drawLineArray(user.currentLine, ctx, user);
        if(mirror){
          var nLine = mirrorLine(user.currentLine);
          drawLineArray(nLine,ctx,user);
        }
        
      }
      
      if(user.mousedown){
        user.currentLine=[];
        pos = {x:user.x,y:user.y};
        user.currentLine.push(pos);
      }
      
      updateUser(user, data, ["size"]);
      var userText = $("." + user.id.toString() + " .text")[0];
      userText.style.fontSize = (data.size + 5).toString() + "px";
      var userCircle = $("."+user.id.toString()+".circle")[0];
      userCircle.setAttribute("r",user.size);
      var userCtx = user.context;
      var userSquare = $("."+user.id.toString()+".square")[0];
      userSquare.setAttribute("height",user.size*2);
      userSquare.setAttribute("width",user.size*2);
      break;
      
    case "ChSp":
      //change the spacing
      updateUser(user,data,["spacing"]);
      break;
      
    case "ChBl":
      //change the blend mode
      updateUser(user,data,["blendMode"]);
      break;
      
      
    case "ChNa":
      var name = data.name;
      user.username = name;
      var nameText = $("."+user.id.toString()+" .name")[0];
      var listName = $("."+user.id.toString()+" .listUser")[0];
      console.log("user list: ",$(".listUser"));
      nameText.innerHTML = name;
      listName.innerHTML = name;
      break;
      
      
    case "ChT":
      //change the tool
      console.log("changing tool: ");
      console.log(data);
      updateUser(user, data, ["tool"]);
      var userText = $("." + user.id.toString() + " .text")[0];
      var userCircle = $("."+user.id.toString()+".circle")[0];
      var userSquare = $("."+user.id.toString()+".square")[0];
      if (data.tool == "brush") {
        userText.style.display = "none";
        userCircle.style.display = "block";
        userSquare.style.display="none";
      }
      if (data.tool == "text") {
        userText.style.display = "block";
        userCircle.style.display = "none";
        userSquare.style.display="none";
      }
      if (data.tool == "erase") {
        userText.style.display = "none";
        userCircle.style.display = "block";
        userSquare.style.display="none";
      }
      if (data.tool == "gimp") {
        userText.style.display = "none";
        userCircle.style.display = "none";
        userSquare.style.display="block";
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
      break;
      case "mirror":
        mirror = !mirror;
        if(mirror){
          mirrorText.text="ON";
        }
        else{
          mirrorText.text="OFF";
        }
      break;
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
  cursor.style.left = x-100 + "px";
  cursor.style.top = y-100 + "px";

  cursor_circle.setAttribute("cx",x);
  cursor_circle.setAttribute("cy",y);
  cursor_square.setAttribute("x",x-user.size);
  cursor_square.setAttribute("y",y-user.size);  
  var lastpos = { x: user.lastx, y: user.lasty };
  var pos = { x: user.x, y: user.y };
  
  
  
  
  
  send({ command: "broadcast", type: "Mm", x: user.x, y: user.y, id: userID });
  
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
      
      //ctx2.clearRect(0,0,boardDim[1],boardDim[0]);
      
      var numPoints = Math.round(user.lineLength/10);

      
      ctx2.beginPath();
      drawLineArray(user.currentLine,ctx2,user);
      user.currentLine.push(pos);
      if(mirror){
        var nLine = mirrorLine(user.currentLine);
        drawLineArray(nLine,ctx2,user);
      }

      //get distance between points, rounded to two decimal places
      user.lineLength += manhattanDistance(pos,lastpos);
    }
    if (user.mousedown && user.tool == "erase"){
      erase(pos.x,pos.y,lastpos.x,lastpos.y,user.size*2);
      if(mirror){
            var width=boardDim[1];
            erase(width-pos.x,pos.y,width-lastpos.x,lastpos.y,user.size*2);
      }
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
  user.mousedown = true;
  user.spaceIndex = 0;

  if (user.tool == "brush" && !user.panning) {
    user.currentLine.push(pos);

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
  
  if(user.tool=="brush" && !user.panning ){

    if(user.lineLength==0){
      var pos = {x:user.x,y:user.y};
      drawDot(pos,ctx,user);
    }
    console.log(user.lineLength);
    

    drawLineArray(user.currentLine, ctx, user);
    
    if(mirror){
        var nLine = mirrorLine(user.currentLine);
        drawLineArray(nLine,ctx,user);
    }
    
    
    //ctx.stroke();
    //ctx2.beginPath();
    ctx2.clearRect(0,0,boardDim[1],boardDim[0]);
    
    
  }
  user.mousedown = false;
  send({ command: "broadcast", type: "Mu", id: userID });
  var line = { path: user.currentLine, id: userID };
  
  
  user.currentLine = [];
  user.lineLength = 0;
});



board.addEventListener("mouseout",function(e){
  var user = getUser(userID);
  
  /*
  user.mousedown = false;
  if(user.tool=="brush" && !user.panning ){
    ctx.stroke();
    ctx2.beginPath();
    ctx2.clearRect(0,0,boardDim[1],boardDim[0]);
    
  }
  
  send({ command: "broadcast", type: "Mu", id: userID });
  var line = { path: current_line, id: userID };
  current_line = [];
  user.lineLength = 0;
  
  
  */
  
});

board.addEventListener("wheel", function (e) {
  e.preventDefault();
  var user = getUser(userID);
  
  if(user.panning){
    var zoomStep = 0.1; 
    if(e.deltaY > 0){
      if(zoom-zoomStep > 0.2){
        zoom-=zoomStep
        //the zoom pos is the relative position on the canvas
        var zoomPos = {x:e.layerX,y:e.layerY};
        zoomBoard(zoom,zoomPos);
      }
      //scrolling down
      
    }
    if(e.deltaY < 0){
      //scrolling up
      if(zoom+zoomStep < 3)
      zoom+=zoomStep
      //the zoom pos is the relative position on the canvas
      var zoomPos = {x:e.layerX,y:e.layerY}; 
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
        if(user.mousedown && user.tool=="brush"){

          ctx2.clearRect(0,0,boardDim[1],boardDim[0]);
          ctx2.beginPath();
          
          drawLineArray(user.currentLine, ctx, user);
          
          if(mirror){
            var nLine = mirrorLine(user.currentLine);
            drawLineArray(nLine,ctx,user);
          }
          
          
          
          
          user.currentLine=[];
          user.lineLength=0;
          
          var pos = {x:user.x,y:user.y};
          user.currentLine.push(pos);
        }

        size = size - step;

        size = Math.round(size * 100) / 100;
        cursor_circle.setAttribute("r", size);
        cursor_square.setAttribute("width",size*2);
        cursor_square.setAttribute("height",size*2);
        cursor_square.setAttribute("x",user.x-size);
        cursor_square.setAttribute("y",user.y-size);

        text.style.fontSize = (size + 5).toString() + "px";

        ctx.lineWidth = size * 2;
        user.size = size;

        sizeSlider.value=size;

        send({ command: "broadcast", type: "ChSi", size: size, id: userID });

      }
    } else {
      //scrolling up
      if (size+2 < 100) {
        if(user.mousedown && user.tool=="brush"){

          ctx2.clearRect(0,0,boardDim[1],boardDim[0]);
          ctx2.beginPath();
          
          drawLineArray(user.currentLine, ctx, user);
          
          if(mirror){
            var nLine = mirrorLine(user.currentLine);
            drawLineArray(nLine,ctx,user);
          }
          
          
          
          user.currentLine=[];
          user.lineLength=0;
          
          var pos = {x:user.x,y:user.y};
          user.currentLine.push(pos);
          
          
        }
        size = size + step;

        size = Math.round(size * 100) / 100;


        cursor_circle.setAttribute("r", size);
        cursor_square.setAttribute("width",size*2);
        cursor_square.setAttribute("height",size*2);
        cursor_square.setAttribute("x",user.x-size);
        cursor_square.setAttribute("y",user.y-size);
        
        text.style.fontSize = (size + 5).toString() + "px";

        ctx.lineWidth = size * 2;
        user.size = size;

        sizeSlider.value=size;

        send({ command: "broadcast", type: "ChSi", size: size, id: userID });
      }
    }
  }
});

document.addEventListener("keydown", function (e) {
  var user = getUser(userID);
  
  //this preventDefault stops "quick search" from appearing when you press these keys
  if(e.key=="/" || e.key=="'"){
    e.preventDefault();
  }
  if(e.key==" " && user.tool!="text" && !user.panning && !user.mousedown ){
    user.panning="true"
    send({ command: "broadcast", type: "pan", value: true, id: user.id });
  }
  send({ command: "broadcast", type: "kp", key: e.key, id: user.id });
  
  if (user.tool == "text") {
    
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
    if(connected==true){
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
  }
});

document.addEventListener("keyup",function(e){
  var user = getUser(userID);
  if(e.key==" " && user.tool!="text"){
    user.panning=false;
    send({ command: "broadcast", type: "pan", value: false, id: user.id }); 
  }
});

function moveBoard(x,y){
  var boards = $("#boards")[0];
  boards.style.top = y+"px";
  boards.style.left = x+"px";
}

function zoomBoard(zoom,boardPos){
  //boardPos is the relative position of the cursor on the board {x,y}
  var user = getUser(userID);
  var boards = $("#boards")[0];
  var current_x = Number(boards.style.top.split("px")[0]);
  var current_y = Number(boards.style.left.split("px")[0]);
  
  
  var x = boardPos.x+"px";
  var y = boardPos.y+"px";
  var tOrigin = x+" "+y;
  console.log("torigin: ",tOrigin);
  
  boards.style.transformOrigin = tOrigin;
  boards.style.top = board
  boards.style.scale = zoom;

  
  
  /*
  for consistent boardname size.. but needs extra padding for small zoom
  var names = $(".name");
  for(var i=0;i<names.length;i++){
    names[i].style.scale =  1/zoom;
  }
  */
}


function mirrorLine(points){
  var width = boardDim[1];
  return points.map(point => {
    return {
      x: width - point.x,
      y: point.y
    };
  });
}








function resetBoard(){ 
  
  var boards = $("#boards")[0];
  
  boards.style.transformOrigin = "top left";
  boards.style.top = defaultPanY+"px";
  boards.style.left = defaultPanX+"px";
  boards.style.scale = defaultZoom
  
 

  zoom=defaultZoom;
  panX=defaultPanX;
  panY=defaultPanY; 
  
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
    ctx.stroke();
    
    var noAlpha = [user.color[0],user.color[1],user.color[2]];
    var alpha = user.color[3];
    topBoard.style.opacity=alpha;
    userCtx.strokeStyle='rgb('+noAlpha.toString()+')';
    userCtx.lineCap="round";
    userCtx.lineJoin="round";
    userCtx.lineWidth=user.size*2;
    userCtx.beginPath();
    userCtx.moveTo(pos.x,pos.y);
    userCtx.lineTo(pos.x,pos.y);
    userCtx.stroke();
    
    if(mirror){
      ctx.moveTo(boardDim[1]-pos.x,pos.y);
      ctx.lineTo(boardDim[1]-pos.x,pos.y);
      ctx.stroke();
      userCtx.moveTo(boardDim[1]-pos.x,pos.y);
      userCtx.lineTo(boardDim[1]-pos.x,pos.y);
      userCtx.stroke();
    }
    
    
    
    
  }
}

//used for getting line length approximation between two points
function manhattanDistance(p1,p2){
  if(p1!=p2){
    var distance = Math.abs(p1.x - p2.x) + Math.abs(p1.y - p2.y);
    return distance
  }
}

//not currently in use
/*
function drawLine(pos, lastpos, user) {
  
  var alpha = user.color[3];
  var noAlpha = [user.color[0],user.color[1],user.color[2]];
  //var spacing = user.spacing;
  
  //topBoard.style.opacity=alpha;
  //this doesnt work unless I draw the whole line at once, stroke breaks it
  //ctx2.globalCompositeOperation=blendMode.value;
  
  ctx.lineWidth = user.size * 2;
  ctx.strokeStyle='rgba('+user.color.toString()+')';
  ctx.moveTo(lastpos.x, lastpos.y);
  ctx.lineTo(pos.x, pos.y);
  
  user.lastx = pos.x;
  user.lasty = pos.y;
}
*/


function drawLineArray(points,ctx, user){
  
  var alpha = user.color[3];
  var noAlpha = [user.color[0],user.color[1],user.color[2]];
  //var spacing = user.spacing;
  

  ctx.strokeStyle='rgba('+user.color.toString()+')';
  ctx.lineWidth=user.size*2;
  
  ctx.beginPath();
  ctx.moveTo(points[0].x,points[0].y);
  
  for(var i=1;i<points.length;i++){
    ctx.lineTo(points[i].x,points[i].y);
  }
  ctx.stroke();
}


function drawText(user) {
  ctx.globalCompositeOperation="source-over";
  var size = (user.size + 5).toString();
  var text = user.text.replaceAll("&nbsp;"," ");
  text = user.text.replaceAll("&nbsp;"," ");
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
    ctx.fillStyle='rgba('+user.color.toString()+')';
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
  var x = user.x;
  var y = user.y;
  var cursor = $(".cursor"+"."+id)[0];
  var circle = $(".circle"+"."+id)[0];
  var square = $(".square"+"."+id)[0];
  cursor.style.left = (x-100).toString() + "px";
  cursor.style.top = (y-100).toString() + "px";
  circle.setAttribute("cx",x);
  circle.setAttribute("cy",y);
  square.setAttribute("x",x-user.size);
  square.setAttribute("y",y-user.size);
}

function updateUser(user, data, fields) {
  for (var i = 0; i < fields.length; i++) {
    var val = fields[i];
    user[val] = data[val];
  }
}


joinBtn.addEventListener("click", function(e){
  connected = true;
  $("#overlay")[0].style.display="none";
  cursor.style.display="block";
  var name = usernameInput.value;
  if(name==""){
    name="Anon";
  }
  var boardName = $(".name.self")[0];
  var listName = $(".listUser.self")[0];
  boardName.innerHTML = name;
  listName.innerHTML = name;
  
  send({ command: "broadcast", type: "ChNa", name:name, id: userID });
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
  send({ command: "broadcast", type: "ChT", tool: "brush", id: user.id });
  $(".text.self")[0].style.display = "none";
  $(".circle.self")[0].style.display = "block";
  $(".square.self")[0].style.display = "none";
  gimpPreview.style.display="none";
  gimpInput.style.display="none";
  
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
  send({ command: "broadcast", type: "ChT", tool: "text", id: user.id });
  $(".text.self")[0].style.display = "block";
  $(".circle.self")[0].style.display = "none";
  $(".square.self")[0].style.display = "none";
  gimpPreview.style.display="none";
  gimpInput.style.display="none";
  
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
  send({ command: "broadcast", type: "ChT", tool: "erase", id: user.id });
  $(".text.self")[0].style.display = "none";
  $(".circle.self")[0].style.display = "block";
  $(".square.self")[0].style.display = "none";
  
  gimpPreview.style.display="none";
  gimpInput.style.display="none";
  
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
  send({ command: "broadcast", type: "ChT", tool: "gimp", id: user.id });
  $(".text.self")[0].style.display = "none";
  $(".circle.self")[0].style.display = "none";
  $(".square.self")[0].style.display = "block";
  
  gimpPreview.style.display="block";
  gimpInput.style.display="block";
    
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

  var circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  circle.setAttribute("class", "circle "+id.toString());
  circle.setAttribute("stroke", "grey");
  circle.setAttribute("stroke-width", "1");
  circle.setAttribute("fill", "none");
  circle.setAttribute("cx", "0");
  circle.setAttribute("cy", "0");
  circle.setAttribute("r", "10");
  circle.setAttribute("height", "auto");
  var square = document.createElementNS("http://www.w3.org/2000/svg","rect");
  square.setAttribute("class", "square "+id.toString());
  square.setAttribute("stroke", "grey");
  square.setAttribute("stroke-width", "1");
  square.setAttribute("fill", "none");
  square.setAttribute("x", user.x-user.size);
  square.setAttribute("y", user.y-user.size);
  square.setAttribute("r", user.size);
  square.setAttribute("height", user.size*2);
  square.setAttribute("width", user.size*2);
  var cursors = $(".cursors")[0];
  var name = id.toString();
  if(data.username){
    name = data.username;
  }
  var name = $("<text>" + name + "</text>")[0];
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
  var cursorsSvg = $("#cursorsSvg")[0];
  cursorsSvg.appendChild(circle);
  cursorsSvg.appendChild(square);
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
              user.color=rgba;
              if(connected){
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
    user.size=size;

    text.style.fontSize = (size + 5).toString() + "px";
    
  }
});


spacingSlider.addEventListener("mousemove",function(e){
  
  var user = getUser(userID);
  
  if(user.spacing != sizeSlider.value){
   
    var spacing = spacingSlider.value;

    send({ command: "broadcast", type: "ChSp", spacing: spacing, id: userID });

    
    user.spacing = spacing;
    
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
  var currentWidth = $("#boardContainer").width()*0.95;
  var currentHeight = $("#boardContainer").height()*0.95-30; //30 is the height of the buttons bar
  defaultZoom = Math.round(currentWidth/boardDim[1]*1000)/1000 
  defaultPanX = currentWidth*0.05/2;
  defaultPanY = currentHeight/2-boardDim[0]*zoom/2+30;

});
  



//Both gimp functions are found in the folder /js/parseGimp.js
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
        user.gBrush = gihObject;
        
        send({command:"broadcast",type:"gimp",gimpData:gihObject,id:userID});
      }
    }

  reader.readAsArrayBuffer(file);
});  


