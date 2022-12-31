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