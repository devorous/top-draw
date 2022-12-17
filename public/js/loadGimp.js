function loadGimpBrush(file){

  // Load the .gih file using the FileReader API
  var fileReader = new FileReader();
  fileReader.onload = function() {
    // Parse the .gih file to extract the brush frames
    var frames = parseGihFile(fileReader.result);

    // Get the canvas element and its drawing context
    var canvas = document.getElementById('board');
    var ctx = canvas.getContext('2d');

    // Draw the brush frames on the canvas
    var frameIndex = 0;
    setInterval(function() {
      ctx.drawImage(frames[frameIndex], 0, 0);
      frameIndex = (frameIndex + 1) % frames.length;
    }, 1000 / 24); // 24 fps
  };

  //fileReader.readAsArrayBuffer(gihFile);


}


function parseGihFile(data) {
  // Use a DataView to read the binary data in the file
  var view = new DataView(data);

  // Extract the metadata from the file
  var magicNumber = view.getUint32(0); // Should be "GIMP"
  var numFrames = view.getUint32(4);
  var width = view.getUint32(8);
  var height = view.getUint32(12);

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