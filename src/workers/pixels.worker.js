// src/workers/pixels.worker.js
// Uses the Rust/wasm-pack compiled WASM module (src/wasm/ddraw_wasm.js)
import init, { stackblur_rgba, stackblur_rgba_glitch, has_content, find_content_bounds } from '../wasm/ddraw_wasm.js';

let wasmReady = false;
let initPromise = null;

function ensureWasm() {
    if (!initPromise) {
        initPromise = init().then(() => {
            wasmReady = true;
        }).catch(() => {
            wasmReady = false;
        });
    }
    return initPromise;
}

self.onmessage = async (e) => {
    const { type, data, width, height, radius, useGlitch, id } = e.data;

    // Handle status query before WASM is needed
    if (type === 'GET_STATUS') {
        await ensureWasm();
        self.postMessage({
            id,
            type: 'STATUS_RESULT',
            result: { wasmReady, mode: wasmReady ? 'WASM' : 'JS' }
        });
        return;
    }

    await ensureWasm();

    if (type === 'BLUR') {
        const result = useGlitch
            ? stackblur_rgba_glitch(data, width, height, radius)
            : stackblur_rgba(data, width, height, radius);
        self.postMessage({ id, type: 'BLUR_RESULT', result }, [result.buffer]);

    } else if (type === 'CHECK_CONTENT') {
        const result = has_content(data);
        self.postMessage({ id, type: 'CHECK_CONTENT_RESULT', result });

    } else if (type === 'FIND_BOUNDS') {
        const bounds = find_content_bounds(data, width, height);
        const result = bounds[0] >= 0
            ? { x: bounds[0], y: bounds[1], width: bounds[2], height: bounds[3] }
            : null;
        self.postMessage({ id, type: 'FIND_BOUNDS_RESULT', result });
    }
};
