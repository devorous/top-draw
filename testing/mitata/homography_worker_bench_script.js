import './node_shim.js';
import { parentPort } from 'worker_threads';
import { Homography } from '../../src/utils/homography.js';

parentPort.on('message', (data) => {
  const { sourceData, width, height, srcPoints, dstPoints } = data;
  
  const homography = new Homography('projective', width, height);
  homography.setImage({ data: sourceData, width, height });
  homography.setReferencePoints(srcPoints, dstPoints);
  
  const result = homography.warp();
  
  parentPort.postMessage({ 
    data: result.data, 
    width: result.width, 
    height: result.height 
  }, [result.data.buffer]);
});
