/** @fileoverview Worker script for performing homography warps in a separate thread during benchmarks. */

import './node_shim.js';
import { parentPort } from 'worker_threads';
import { Homography } from '../../src/utils/homography.js';

/**
 * Handles incoming messages from the main thread, performs a homography warp, and posts the result back.
 */
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
