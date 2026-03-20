// src/workers/pixels.worker.js
// Uses the Rust/wasm-pack compiled WASM module (src/wasm_output/ddraw_wasm.js)
import init, { stackblur_rgba, stackblur_rgba_glitch, has_content } from '../wasm_output/ddraw_wasm.js';

let initPromise = null;

function ensureWasm() {
    if (!initPromise) {
        initPromise = init().then(() => {
            console.log('[pixels.worker] Rust WASM module loaded');
        });
    }
    return initPromise;
}

self.onmessage = async (e) => {
    const { type, data, width, height, radius, useGlitch, id } = e.data;

    await ensureWasm();

    if (type === 'BLUR') {
        let result;
        if (useGlitch) {
            console.log('[pixels.worker] Using stackblur_rgba_glitch, radius:', radius);
            result = stackblur_rgba_glitch(data, width, height, radius);
        } else {
            console.log('[pixels.worker] Using stackblur_rgba, radius:', radius);
            result = stackblur_rgba(data, width, height, radius);
        }
        self.postMessage({ id, type: 'BLUR_RESULT', result }, [result.buffer]);

    } else if (type === 'CHECK_CONTENT') {
        const result = has_content(data);
        self.postMessage({ id, type: 'CHECK_CONTENT_RESULT', result });
    }
};
