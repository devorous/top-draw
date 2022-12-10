window.onload =(e) =>{
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
ctx.imageSmoothingQuality = "high";

var current_line = [];

var connected=false;


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
  id: userID,
};

// Add self player to beginning of players array:
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
      //when a user leaves, update the user list and remove the cursor by ID class
      users = users.filter((userdata) => {
        return userdata.id != data.id;
      });
      var div = $("." + data.id.toString())[0];
      if (div) {
        div.remove();
      }
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
      break;

    case "Md":
      user.lastx = user.x;
      user.lasty = user.y;
      var pos = { x: user.x, y: user.y };
      if (user.tool == "brush") {
        ctx.lineCap = "round";
        drawLine(pos, pos, user);
      }
      if (user.tool == "text" && user.text != "") {
        drawText(user);
        user.text = "";
        var input = $("." + user.id.toString() + " .textInput")[0];
        input.innerHTML = "";
      }
      user.mousedown = true;
      break;

    case "Mu":
      if (user.tool == "brush") {
        ctx.stroke();
      }
      user.mousedown = false;
      break;

    case "ChS":
      //change the size
      updateUser(user, data, ["size"]);
      var userText = $("." + user.id.toString() + " .text")[0];

      userText.style.fontSize = (data.size + 5).toString() + "px";
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
      updateUser()
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
  var user = getUser(userID);
  user.x = e.layerX - 100;
  user.y = e.layerY - 100;

  //set your cursor pos
  cursor.style.left = user.x + "px";
  cursor.style.top = user.y + "px";

  send({ command: "broadcast", type: "Mm", x: user.x, y: user.y, id: userID });
  var lastpos = { x: user.lastx, y: user.lasty };
  var pos = { x: self.x, y: self.y };
  if (lastpos.x == null) {
    lastpos = pos;
  }
  if (user.mousedown && user.tool == "brush") {
    drawLine(pos, lastpos, user);
  }
});

board.addEventListener("mousedown", function (e) {
  var user = getUser(userID);
  user.lastx = user.x;
  user.lasty = user.y;
  self.mousedown = true;
  send({ command: "broadcast", type: "Md", id: userID });

  if (user.tool == "brush") {
    ctx.fillStyle=user.color;
    ctx.beginPath();
    ctx.lineCap = "round";
    ctx.lineWidth = user.size * 2;
    ctx.moveTo(e.layerX, e.layerY);
    ctx.lineTo(e.layerX, e.layerY);
    ctx.stroke();
  }

  if (user.tool == "text" && user.text != "") {
    drawText(user);
    user.text = "";
    var input = $(".textInput.self")[0];
    input.innerHTML = "";
  }
});

board.addEventListener("mouseup", function (e) {
  self.mousedown = false;
  send({ command: "broadcast", type: "Mu", id: userID });
  var line = { path: current_line, id: userID };
  current_line = [];
});

board.addEventListener("wheel", function (e) {
  var text = $(".text.self")[0];
  e.preventDefault();
  var step = 1;
  if (size <= 1) {
    step = 0.1;
  } else if (size <= 5) {
    step = 0.5;
  } else if (size < 30) {
    step = 1;
  } else {
    step = 2;
  }
  if (e.deltaY > 0) {
    //scrolling down
    if (size - 1 > 0) {
      size = size - step;
      cursor_circle.setAttribute("r", size);

      text.style.fontSize = (size + 5).toString() + "px";

      ctx.lineWidth = size * 2;
      self.size = size;
      send({ command: "broadcast", type: "ChS", size: size, id: userID });
    }
  } else {
    //scrolling up
    if (size < 101) {
      size = size + step;
      cursor_circle.setAttribute("r", size);

      text.style.fontSize = (size + 5).toString() + "px";

      ctx.lineWidth = size * 2;
      self.size = size;
      send({ command: "broadcast", type: "ChS", size: size, id: userID });
    }
  }
});

document.addEventListener("keydown", function (e) {
  send({ command: "broadcast", type: "kp", key: e.key, id: self.id });
  var user = getUser(self.id);
  if (self.tool == "text") {
    var input = $(".textInput.self")[0];

    if (e.key.length == 1) {
      input.innerHTML = input.innerHTML + e.key;
      user.text = user.text + e.key;
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

function drawLine(pos, lastpos, user) {
  ctx.lineWidth = user.size * 2;
  //ctx.translate(0.5, 0.5);
  ctx.beginPath();
  console.log(user);
  ctx.fillStyle=user.color;
  ctx.moveTo(lastpos.x + 100, lastpos.y + 100);
  ctx.lineTo(pos.x + 100, pos.y + 100);
  ctx.stroke();
  current_line.push(pos);
  user.lastx = pos.x;
  user.lasty = pos.y;
}

function drawText(user) {
  var size = (user.size + 5).toString();
  ctx.fillStyle = "#000";
  ctx.font = size + "px sans-serif";
  ctx.fillText(user.text, user.x + 105, user.y + 92 + user.size + 5);
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

function updateColor(hex,id){
  var user = getUser(id);
  updateUser(user,{color:hex},['color']);
}

function moveCursor(data) {
  var id = data.id.toString();
  var x = data.x;
  var y = data.y;
  var cursor = document.getElementsByClassName(id)[0];
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

brushBtn.addEventListener("click", function () {
  var user = getUser(userID);
  var index = users.indexOf(user);
  users[index].tool = "brush";
  send({ command: "broadcast", type: "ChT", tool: "brush", id: self.id });
  $(".text.self")[0].style.display = "none";
  $(".circle.self")[0].style.display = "block";
});

textBtn.addEventListener("click", function () {
  var user = getUser(userID);
  var index = users.indexOf(user);
  users[index].tool = "text";
  send({ command: "broadcast", type: "ChT", tool: "text", id: self.id });
  $(".text.self")[0].style.display = "block";
  $(".circle.self")[0].style.display = "none";
});

function clearBoard() {
  console.log("clearing board");
  ctx.fillStyle = "#FFF";
  ctx.fillRect(0, 0, 400, 400);
}

function drawUser(data, id) {
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
              console.log(color.rgba);
              var rgba = color.rgba;
              self.color=rgba;
              getUser(userID).color=rgba;
              if(connected==true){
                send({command:"broadcast",type:"ChC",color:rgba,id:userID});
              }
            },
          });
  
}