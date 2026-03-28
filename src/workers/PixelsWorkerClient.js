// src/workers/PixelsWorkerClient.js
export class PixelsWorkerClient {
    constructor() {
        this.worker = new Worker(new URL('./pixels.worker.js', import.meta.url), { type: 'module' });
        this.promises = new Map();
        this.msgId = 0;

        this.worker.onmessage = (e) => {
            const { id, result, type, error } = e.data;
            if (this.promises.has(id)) {
                if (type && type.endsWith('_ERROR')) {
                    this.promises.get(id).reject(new Error(error || 'Worker error'));
                } else {
                    this.promises.get(id).resolve(result);
                }
                this.promises.delete(id);
            }
        };
    }

    /**
     * Sends a blur request to the Rust WASM worker.
     * @param {Uint8ClampedArray} data - RGBA pixel data
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {number} radius - Blur radius
     * @param {boolean} [useGlitch=false] - Use glitch blur variant
     * @returns {Promise<Uint8Array>} Blurred pixel data
     */
    blur(data, width, height, radius, useGlitch = false) {
        return new Promise((resolve, reject) => {
            const id = this.msgId++;
            this.promises.set(id, { resolve, reject });

            // Transfer the buffer to the worker
            const pixelData = new Uint8Array(data.buffer);
            this.worker.postMessage({
                type: 'BLUR',
                id, data: pixelData, width, height, radius, useGlitch
            }, [pixelData.buffer]);
        });
    }

    /**
     * Check if pixel data contains any non-transparent pixels.
     * Uses WASM for fast scanning.
     * @param {Uint8ClampedArray} data - RGBA pixel data
     * @returns {Promise<boolean>} True if content exists
     */
    hasContent(data) {
        return new Promise((resolve, reject) => {
            const id = this.msgId++;
            this.promises.set(id, { resolve, reject });

            const pixelData = new Uint8Array(data.buffer.slice(0));
            this.worker.postMessage({
                type: 'CHECK_CONTENT',
                id, data: pixelData
            }, [pixelData.buffer]);
        });
    }

    /**
     * Find the bounding box of non-transparent content.
     * Uses WASM for fast scanning.
     * @param {Uint8ClampedArray} data - RGBA pixel data
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @returns {Promise<{x: number, y: number, width: number, height: number}|null>}
     */
    findContentBounds(data, width, height) {
        return new Promise((resolve, reject) => {
            const id = this.msgId++;
            this.promises.set(id, { resolve, reject });

            const pixelData = new Uint8Array(data.buffer.slice(0));
            this.worker.postMessage({
                type: 'FIND_BOUNDS',
                id, data: pixelData, width, height
            }, [pixelData.buffer]);
        });
    }

    /**
     * Get worker status (WASM loaded or JS fallback).
     * @returns {Promise<{wasmReady: boolean, mode: 'WASM'|'JS'}>}
     */
    getStatus() {
        return new Promise((resolve, reject) => {
            const id = this.msgId++;
            this.promises.set(id, { resolve, reject });
            this.worker.postMessage({ type: 'GET_STATUS', id });
        });
    }
}
